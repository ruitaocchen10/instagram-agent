#[cfg(test)]
mod tests {
    use super::{presigned_get_url_at, reel_upload_headers, validate_r2_config, R2Config};
    use chrono::{TimeZone, Utc};

    fn config() -> R2Config {
        R2Config {
            account_id: "0123456789abcdef0123456789abcdef".into(),
            bucket_name: "socialite-staging".into(),
            jurisdiction: "default".into(),
            lifecycle_acknowledged: true,
        }
    }

    #[test]
    fn dedicated_r2_configuration_requires_lifecycle_acknowledgement() {
        let mut value = config();
        value.lifecycle_acknowledged = false;

        assert_eq!(
            validate_r2_config(&value).unwrap_err(),
            "Confirm the one-day lifecycle rule before connecting R2."
        );
    }

    #[test]
    fn presigned_get_is_scoped_to_one_object_and_does_not_expose_the_secret() {
        let at = Utc.with_ymd_and_hms(2026, 7, 22, 12, 0, 0).unwrap();
        let url = presigned_get_url_at(
            &config(),
            "ACCESS123",
            "never-show-this-secret",
            "instagram/user-7/image.jpg",
            3600,
            at,
        )
        .unwrap();

        assert!(url.starts_with("https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/socialite-staging/instagram/user-7/image.jpg?"));
        assert!(url.contains("X-Amz-Expires=3600"));
        assert!(url.contains("X-Amz-Signature="));
        assert!(!url.contains("never-show-this-secret"));
    }

    #[test]
    fn reel_upload_declares_the_exact_stream_length() {
        let headers = reel_upload_headers("token", 4_096).unwrap();

        assert_eq!(headers.get("file_size").unwrap(), "4096");
        assert_eq!(
            headers.get(reqwest::header::CONTENT_LENGTH).unwrap(),
            "4096"
        );
        assert_eq!(
            headers.get(reqwest::header::AUTHORIZATION).unwrap(),
            "OAuth token"
        );
    }
}
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use hmac::{Hmac, Mac};
use image::{metadata::Orientation, DynamicImage, GenericImageView, ImageDecoder, ImageReader};
use keyring::Entry;
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio_util::io::ReaderStream;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

const AWS_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'!')
    .add(b'"')
    .add(b'#')
    .add(b'$')
    .add(b'%')
    .add(b'&')
    .add(b'\'')
    .add(b'(')
    .add(b')')
    .add(b'*')
    .add(b'+')
    .add(b',')
    .add(b'/')
    .add(b':')
    .add(b';')
    .add(b'=')
    .add(b'?')
    .add(b'@')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct R2Config {
    pub account_id: String,
    pub bucket_name: String,
    pub jurisdiction: String,
    pub lifecycle_acknowledged: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct R2Status {
    configured: bool,
    config: Option<R2Config>,
    masked_access_key_id: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedMedia {
    asset_id: String,
    file_name: String,
    mime_type: String,
    size: u64,
    local_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedMedia {
    object_key: String,
    public_url: String,
}

#[derive(Default)]
pub struct ReelUploads(Mutex<HashMap<String, Arc<AtomicBool>>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReelUploadProgress {
    asset_id: String,
    uploaded: u64,
    total: u64,
}

const KEYRING_SERVICE: &str = "com.socialite.app";
const R2_ACCESS_KEY_ACCOUNT: &str = "r2_access_key_id";
const R2_SECRET_KEY_ACCOUNT: &str = "r2_secret_access_key";
const R2_CONFIG_FILE: &str = "r2-config.json";

fn keyring_entry(account: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, account).map_err(|error| error.to_string())
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|error| error.to_string())
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(R2_CONFIG_FILE))
}

fn load_config(app: &tauri::AppHandle) -> Result<Option<R2Config>, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let value = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let config: R2Config = serde_json::from_str(&value).map_err(|error| error.to_string())?;
    validate_r2_config(&config)?;
    Ok(Some(config))
}

fn credentials() -> Result<(String, String), String> {
    let access_key_id = keyring_entry(R2_ACCESS_KEY_ACCOUNT)?
        .get_password()
        .map_err(|error| format!("Couldn't read the R2 Access Key ID: {error}"))?;
    let secret_access_key = keyring_entry(R2_SECRET_KEY_ACCOUNT)?
        .get_password()
        .map_err(|error| format!("Couldn't read the R2 Secret Access Key: {error}"))?;
    Ok((access_key_id, secret_access_key))
}

fn masked_access_key(value: &str) -> String {
    let suffix: String = value
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    format!("••••{suffix}")
}

pub fn validate_r2_config(config: &R2Config) -> Result<(), String> {
    if config.account_id.len() != 32
        || !config
            .account_id
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("Cloudflare Account ID must be 32 hexadecimal characters.".to_string());
    }
    let valid_bucket =
        (3..=63).contains(&config.bucket_name.len())
            && config.bucket_name.chars().all(|character| {
                character.is_ascii_lowercase()
                    || character.is_ascii_digit()
                    || matches!(character, '-' | '.')
            })
            && config.bucket_name.chars().next().is_some_and(|character| {
                character.is_ascii_lowercase() || character.is_ascii_digit()
            })
            && config.bucket_name.chars().last().is_some_and(|character| {
                character.is_ascii_lowercase() || character.is_ascii_digit()
            });
    if !valid_bucket {
        return Err("R2 bucket name must be a valid lowercase bucket name.".to_string());
    }
    if !matches!(config.jurisdiction.as_str(), "default" | "eu") {
        return Err("R2 jurisdiction must be Default or European Union.".to_string());
    }
    if !config.lifecycle_acknowledged {
        return Err("Confirm the one-day lifecycle rule before connecting R2.".to_string());
    }
    Ok(())
}

fn aws_encode(value: &str) -> String {
    utf8_percent_encode(value, AWS_ENCODE_SET).to_string()
}

fn canonical_path(config: &R2Config, object_key: &str) -> Result<String, String> {
    if object_key.is_empty()
        || object_key
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("Invalid staged-media object key.".to_string());
    }
    let mut parts = Vec::with_capacity(1 + object_key.split('/').count());
    parts.push(aws_encode(&config.bucket_name));
    parts.extend(object_key.split('/').map(aws_encode));
    Ok(format!("/{}", parts.join("/")))
}

fn r2_host(config: &R2Config) -> String {
    if config.jurisdiction == "eu" {
        format!("{}.eu.r2.cloudflarestorage.com", config.account_id)
    } else {
        format!("{}.r2.cloudflarestorage.com", config.account_id)
    }
}

fn sha256_hex(value: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(value.as_ref()))
}

fn hmac(key: &[u8], value: &str) -> Result<Vec<u8>, String> {
    let mut mac = HmacSha256::new_from_slice(key).map_err(|error| error.to_string())?;
    mac.update(value.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

fn signing_key(secret: &str, date: &str) -> Result<Vec<u8>, String> {
    let date_key = hmac(format!("AWS4{secret}").as_bytes(), date)?;
    let region_key = hmac(&date_key, "auto")?;
    let service_key = hmac(&region_key, "s3")?;
    hmac(&service_key, "aws4_request")
}

fn presigned_url_at(
    method: &str,
    config: &R2Config,
    access_key_id: &str,
    secret_access_key: &str,
    object_key: &str,
    expires_seconds: u32,
    at: DateTime<Utc>,
) -> Result<String, String> {
    validate_r2_config(config)?;
    if access_key_id.trim().is_empty() || secret_access_key.trim().is_empty() {
        return Err("R2 access credentials are incomplete.".to_string());
    }
    if !(1..=604_800).contains(&expires_seconds) {
        return Err("R2 signed URL expiry must be between one second and seven days.".to_string());
    }
    let host = r2_host(config);
    let path = canonical_path(config, object_key)?;
    let date = at.format("%Y%m%d").to_string();
    let amz_date = at.format("%Y%m%dT%H%M%SZ").to_string();
    let scope = format!("{date}/auto/s3/aws4_request");
    let credential = aws_encode(&format!("{access_key_id}/{scope}"));
    let query = format!(
        "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential={credential}&X-Amz-Date={amz_date}&X-Amz-Expires={expires_seconds}&X-Amz-SignedHeaders=host"
    );
    let canonical_request =
        format!("{method}\n{path}\n{query}\nhost:{host}\n\nhost\nUNSIGNED-PAYLOAD");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical_request)
    );
    let signature = hex::encode(hmac(
        &signing_key(secret_access_key, &date)?,
        &string_to_sign,
    )?);
    Ok(format!(
        "https://{host}{path}?{query}&X-Amz-Signature={signature}"
    ))
}

#[cfg(test)]
fn presigned_get_url_at(
    config: &R2Config,
    access_key_id: &str,
    secret_access_key: &str,
    object_key: &str,
    expires_seconds: u32,
    at: DateTime<Utc>,
) -> Result<String, String> {
    presigned_url_at(
        "GET",
        config,
        access_key_id,
        secret_access_key,
        object_key,
        expires_seconds,
        at,
    )
}

fn presigned_url(
    method: &str,
    config: &R2Config,
    access_key_id: &str,
    secret_access_key: &str,
    object_key: &str,
    expires_seconds: u32,
) -> Result<String, String> {
    presigned_url_at(
        method,
        config,
        access_key_id,
        secret_access_key,
        object_key,
        expires_seconds,
        Utc::now(),
    )
}

fn managed_media_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app_data_dir(app)?.join("media");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn managed_media_path(app: &tauri::AppHandle, asset_id: &str) -> Result<PathBuf, String> {
    if asset_id.is_empty()
        || asset_id.contains(['/', '\\'])
        || Path::new(asset_id)
            .file_name()
            .and_then(|name| name.to_str())
            != Some(asset_id)
    {
        return Err("Invalid managed media ID.".to_string());
    }
    Ok(managed_media_dir(app)?.join(asset_id))
}

fn normalized_image(source: &Path, target: &Path) -> Result<(String, u64), String> {
    let reader =
        ImageReader::open(source).map_err(|error| format!("Couldn't open image: {error}"))?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|error| format!("Unsupported image: {error}"))?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder)
        .map_err(|error| format!("Unsupported image: {error}"))?;
    image.apply_orientation(orientation);
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return Err("Image dimensions are invalid.".to_string());
    }
    let ratio = width as f64 / height as f64;
    if !(0.8..=1.91).contains(&ratio) {
        return Err("Image aspect ratio must be between 4:5 and 1.91:1.".to_string());
    }
    let image = if width > 1440 {
        image.resize(1440, u32::MAX, image::imageops::FilterType::Lanczos3)
    } else {
        image
    };
    let file = fs::File::create(target).map_err(|error| error.to_string())?;
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(file, 90);
    encoder
        .encode_image(&image)
        .map_err(|error| error.to_string())?;
    let size = fs::metadata(target)
        .map_err(|error| error.to_string())?
        .len();
    if size > 8 * 1024 * 1024 {
        let _ = fs::remove_file(target);
        return Err("Normalized image exceeds Instagram's 8 MB limit.".to_string());
    }
    Ok(("image/jpeg".to_string(), size))
}

fn import_media_file(
    app: &tauri::AppHandle,
    source: &Path,
    media_type: &str,
) -> Result<ManagedMedia, String> {
    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Selected file name is not valid UTF-8.".to_string())?
        .to_string();
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let (asset_id, mime_type, size) = match media_type {
        "image" => {
            if !matches!(extension.as_str(), "jpg" | "jpeg" | "png" | "webp") {
                return Err(
                    "Choose a JPEG, PNG, or WebP image. HEIC is not supported yet.".to_string(),
                );
            }
            let asset_id = format!("{}.jpg", Uuid::new_v4());
            let target = managed_media_path(app, &asset_id)?;
            let (mime_type, size) = normalized_image(source, &target).map_err(|error| {
                let _ = fs::remove_file(&target);
                error
            })?;
            (asset_id, mime_type, size)
        }
        "reel" => {
            if !matches!(extension.as_str(), "mp4" | "mov") {
                return Err("Choose an MP4 or MOV Reel.".to_string());
            }
            let size = fs::metadata(source)
                .map_err(|error| error.to_string())?
                .len();
            if size == 0 || size > 1024 * 1024 * 1024 {
                return Err(
                    "Reel must be larger than zero bytes and no larger than 1 GB.".to_string(),
                );
            }
            let asset_id = format!("{}.{}", Uuid::new_v4(), extension);
            let target = managed_media_path(app, &asset_id)?;
            // A hard link keeps an immediate publish from duplicating a large
            // Reel. Saving/scheduling materializes an independent managed copy.
            #[cfg(unix)]
            if fs::hard_link(source, &target).is_err() {
                fs::copy(source, &target).map_err(|error| {
                    let _ = fs::remove_file(&target);
                    error.to_string()
                })?;
            }
            #[cfg(not(unix))]
            fs::copy(source, &target).map_err(|error| {
                let _ = fs::remove_file(&target);
                error.to_string()
            })?;
            let mime_type = if extension == "mov" {
                "video/quicktime"
            } else {
                "video/mp4"
            };
            (asset_id, mime_type.to_string(), size)
        }
        _ => return Err("Media type must be image or reel.".to_string()),
    };
    let local_path = managed_media_path(app, &asset_id)?;
    Ok(ManagedMedia {
        asset_id,
        file_name,
        mime_type,
        size,
        local_path: local_path.to_string_lossy().into_owned(),
    })
}

async fn put_object(
    config: &R2Config,
    access_key_id: &str,
    secret_access_key: &str,
    object_key: &str,
    content_type: &str,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let url = presigned_url(
        "PUT",
        config,
        access_key_id,
        secret_access_key,
        object_key,
        300,
    )?;
    let response = Client::new()
        .put(url)
        .header("Content-Type", content_type)
        .body(bytes)
        .send()
        .await
        .map_err(|error| format!("R2 upload failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("R2 upload returned HTTP {}.", response.status()));
    }
    Ok(())
}

async fn delete_object_with_credentials(
    config: &R2Config,
    access_key_id: &str,
    secret_access_key: &str,
    object_key: &str,
) -> Result<(), String> {
    let url = presigned_url(
        "DELETE",
        config,
        access_key_id,
        secret_access_key,
        object_key,
        300,
    )?;
    let response = Client::new()
        .delete(url)
        .send()
        .await
        .map_err(|error| format!("R2 cleanup failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("R2 cleanup returned HTTP {}.", response.status()));
    }
    Ok(())
}

#[tauri::command]
pub fn get_r2_status(app: tauri::AppHandle) -> Result<R2Status, String> {
    let config = load_config(&app)?;
    let access_key = keyring_entry(R2_ACCESS_KEY_ACCOUNT)?.get_password();
    let secret_key = keyring_entry(R2_SECRET_KEY_ACCOUNT)?.get_password();
    let configured = config.is_some() && access_key.is_ok() && secret_key.is_ok();
    let error = if config.is_some() && !configured {
        Some("R2 credentials are missing from the OS keychain.".to_string())
    } else {
        None
    };
    Ok(R2Status {
        configured,
        config,
        masked_access_key_id: access_key.ok().map(|value| masked_access_key(&value)),
        error,
    })
}

#[tauri::command]
pub async fn configure_r2(
    app: tauri::AppHandle,
    config: R2Config,
    access_key_id: String,
    secret_access_key: String,
) -> Result<R2Status, String> {
    validate_r2_config(&config)?;
    if access_key_id.trim().is_empty() || secret_access_key.trim().is_empty() {
        return Err("R2 Access Key ID and Secret Access Key are required.".to_string());
    }
    test_r2_credentials(&config, access_key_id.trim(), secret_access_key.trim()).await?;
    keyring_entry(R2_ACCESS_KEY_ACCOUNT)?
        .set_password(access_key_id.trim())
        .map_err(|error| error.to_string())?;
    keyring_entry(R2_SECRET_KEY_ACCOUNT)?
        .set_password(secret_access_key.trim())
        .map_err(|error| error.to_string())?;
    let path = config_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(
        path,
        serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    get_r2_status(app)
}

#[tauri::command]
pub fn disconnect_r2(app: tauri::AppHandle) -> Result<(), String> {
    for account in [R2_ACCESS_KEY_ACCOUNT, R2_SECRET_KEY_ACCOUNT] {
        match keyring_entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    let path = config_path(&app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn choose_local_media(
    app: tauri::AppHandle,
    media_type: String,
) -> Result<Option<ManagedMedia>, String> {
    let mut dialog = app.dialog().file();
    dialog = if media_type == "image" {
        dialog.add_filter("Images", &["jpg", "jpeg", "png", "webp"])
    } else {
        dialog.add_filter("Reels", &["mp4", "mov"])
    };
    let Some(file) = dialog.blocking_pick_file() else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || import_media_file(&app, &path, &media_type))
        .await
        .map_err(|error| format!("Local media preparation stopped: {error}"))?
        .map(Some)
}

#[tauri::command]
pub fn managed_media_path_for_preview(
    app: tauri::AppHandle,
    asset_id: String,
) -> Result<String, String> {
    let path = managed_media_path(&app, &asset_id)?;
    if !path.is_file() {
        return Err("Managed media file is missing.".to_string());
    }
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn delete_managed_media(app: tauri::AppHandle, asset_id: String) -> Result<(), String> {
    let path = managed_media_path(&app, &asset_id)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn materialize_managed_media_copy(
    app: tauri::AppHandle,
    asset_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        materialize_managed_media_copy_blocking(&app, &asset_id)
    })
    .await
    .map_err(|error| format!("Managed media preparation stopped: {error}"))?
}

fn materialize_managed_media_copy_blocking(
    app: &tauri::AppHandle,
    asset_id: &str,
) -> Result<(), String> {
    let path = managed_media_path(app, asset_id)?;
    if !path.is_file() {
        return Err("Managed media file is missing.".to_string());
    }
    #[cfg(not(unix))]
    return Ok(());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if fs::metadata(&path)
            .map_err(|error| error.to_string())?
            .nlink()
            <= 1
        {
            return Ok(());
        }
    }
    let temporary = path.with_extension(format!(
        "{}.materializing",
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("media")
    ));
    fs::copy(&path, &temporary)
        .map_err(|error| format!("Couldn't materialize the managed Reel: {error}"))?;
    if let Err(error) = fs::rename(&temporary, &path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Couldn't finalize the managed Reel: {error}"));
    }
    Ok(())
}

#[tauri::command]
pub fn cleanup_orphaned_managed_media(
    app: tauri::AppHandle,
    retained_asset_ids: Vec<String>,
) -> Result<u64, String> {
    let directory = managed_media_dir(&app)?;
    if !directory.exists() {
        return Ok(0);
    }
    let retained = retained_asset_ids.into_iter().collect::<HashSet<_>>();
    let mut removed = 0;
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_file()
        {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if !retained.contains(&file_name) {
            fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
            removed += 1;
        }
    }
    Ok(removed)
}

#[tauri::command]
pub async fn test_r2_connection(app: tauri::AppHandle) -> Result<(), String> {
    let config = load_config(&app)?.ok_or_else(|| "R2 is not configured.".to_string())?;
    let (access_key_id, secret_access_key) = credentials()?;
    test_r2_credentials(&config, &access_key_id, &secret_access_key).await
}

async fn test_r2_credentials(
    config: &R2Config,
    access_key_id: &str,
    secret_access_key: &str,
) -> Result<(), String> {
    let object_key = format!("socialite/connection-tests/{}.txt", Uuid::new_v4());
    put_object(
        config,
        access_key_id,
        secret_access_key,
        &object_key,
        "text/plain",
        b"socialite-r2-connection-test".to_vec(),
    )
    .await?;
    let public_url = presigned_url(
        "GET",
        config,
        access_key_id,
        secret_access_key,
        &object_key,
        300,
    )?;
    let response = Client::new()
        .get(public_url)
        .send()
        .await
        .map_err(|error| format!("R2 read test failed: {error}"))?;
    let read_ok = response.status().is_success();
    let cleanup =
        delete_object_with_credentials(config, access_key_id, secret_access_key, &object_key).await;
    if !read_ok {
        return Err("R2 uploaded the test object but could not read it back.".to_string());
    }
    cleanup
}

fn reel_upload_headers(access_token: &str, total: u64) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("OAuth {access_token}"))
            .map_err(|error| error.to_string())?,
    );
    headers.insert("offset", HeaderValue::from_static("0"));
    headers.insert(
        "file_size",
        HeaderValue::from_str(&total.to_string()).map_err(|error| error.to_string())?,
    );
    headers.insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&total.to_string()).map_err(|error| error.to_string())?,
    );
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    Ok(headers)
}

#[tauri::command]
pub async fn stage_local_image(
    app: tauri::AppHandle,
    asset_id: String,
    instagram_user_id: String,
) -> Result<StagedMedia, String> {
    let config = load_config(&app)?
        .ok_or_else(|| "Configure Cloudflare R2 before publishing a local image.".to_string())?;
    let (access_key_id, secret_access_key) = credentials()?;
    let path = managed_media_path(&app, &asset_id)?;
    let bytes = fs::read(path).map_err(|error| format!("Couldn't read managed image: {error}"))?;
    let safe_user = instagram_user_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .collect::<String>();
    if safe_user.is_empty() {
        return Err("Instagram account ID is invalid.".to_string());
    }
    let object_key = format!("socialite/{safe_user}/{}.jpg", Uuid::new_v4());
    put_object(
        &config,
        &access_key_id,
        &secret_access_key,
        &object_key,
        "image/jpeg",
        bytes,
    )
    .await?;
    let public_url = presigned_url(
        "GET",
        &config,
        &access_key_id,
        &secret_access_key,
        &object_key,
        3600,
    )?;
    let response = Client::new()
        .get(&public_url)
        .header("Range", "bytes=0-0")
        .send()
        .await
        .map_err(|error| format!("R2 read-back failed after upload: {error}"))?;
    if !response.status().is_success() {
        let _ = delete_object_with_credentials(
            &config,
            &access_key_id,
            &secret_access_key,
            &object_key,
        )
        .await;
        return Err(format!(
            "R2 uploaded the image but could not read it back (HTTP {}).",
            response.status()
        ));
    }
    Ok(StagedMedia {
        object_key,
        public_url,
    })
}

#[tauri::command]
pub async fn delete_staged_media(app: tauri::AppHandle, object_key: String) -> Result<(), String> {
    let config = load_config(&app)?.ok_or_else(|| "R2 is not configured.".to_string())?;
    let (access_key_id, secret_access_key) = credentials()?;
    delete_object_with_credentials(&config, &access_key_id, &secret_access_key, &object_key).await
}

#[tauri::command]
pub async fn upload_local_reel(
    app: tauri::AppHandle,
    uploads: tauri::State<'_, ReelUploads>,
    asset_id: String,
    upload_url: String,
    access_token: String,
) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&upload_url)
        .map_err(|_| "Meta returned an invalid Reel upload URL.".to_string())?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("rupload.facebook.com") {
        return Err(
            "Refusing to send the Instagram token to an unexpected upload host.".to_string(),
        );
    }
    let path = managed_media_path(&app, &asset_id)?;
    let total = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("Couldn't inspect the managed Reel: {error}"))?
        .len();
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|error| format!("Couldn't open the managed Reel: {error}"))?;
    let cancel = {
        let mut guard = uploads
            .0
            .lock()
            .map_err(|_| "Reel upload state is unavailable.".to_string())?;
        let cancel = guard
            .entry(asset_id.clone())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone();
        if cancel.load(Ordering::Relaxed) {
            guard.remove(&asset_id);
            return Err("Reel upload canceled.".to_string());
        }
        cancel
    };

    let progress_app = app.clone();
    let progress_asset = asset_id.clone();
    let stream_cancel = cancel.clone();
    let mut uploaded = 0_u64;
    let stream = ReaderStream::new(file).map(move |chunk| {
        if stream_cancel.load(Ordering::Relaxed) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "Reel upload canceled.",
            ));
        }
        if let Ok(bytes) = &chunk {
            uploaded += bytes.len() as u64;
            let _ = progress_app.emit(
                "reel-upload-progress",
                ReelUploadProgress {
                    asset_id: progress_asset.clone(),
                    uploaded,
                    total,
                },
            );
        }
        chunk
    });
    let response = Client::new()
        .post(parsed)
        .headers(reel_upload_headers(&access_token, total)?)
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await;
    if let Ok(mut guard) = uploads.0.lock() {
        guard.remove(&asset_id);
    }
    if cancel.load(Ordering::Relaxed) {
        return Err("Reel upload canceled.".to_string());
    }
    let response = response.map_err(|error| format!("Reel upload failed: {error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(format!("Reel upload returned HTTP {status}: {detail}"));
    }
    Ok(())
}

#[tauri::command]
pub fn cancel_local_reel_upload(
    uploads: tauri::State<'_, ReelUploads>,
    asset_id: String,
) -> Result<(), String> {
    let mut guard = uploads
        .0
        .lock()
        .map_err(|_| "Reel upload state is unavailable.".to_string())?;
    guard
        .entry(asset_id)
        .or_insert_with(|| Arc::new(AtomicBool::new(true)))
        .store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn clear_local_reel_upload_cancellation(
    uploads: tauri::State<'_, ReelUploads>,
    asset_id: String,
) -> Result<(), String> {
    uploads
        .0
        .lock()
        .map_err(|_| "Reel upload state is unavailable.".to_string())?
        .remove(&asset_id);
    Ok(())
}
