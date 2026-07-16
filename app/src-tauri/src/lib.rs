// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use keyring::Entry;
use tauri_plugin_sql::{Migration, MigrationKind};

// The access token is a secret, so it lives in the OS keychain (macOS Keychain,
// Windows Credential Manager, Linux Secret Service) rather than the plaintext
// store. We key every entry under one service/account pair.
const KEYRING_SERVICE: &str = "com.instagramagent.app";
const KEYRING_ACCOUNT: &str = "instagram_access_token";

fn token_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_token(token: String) -> Result<(), String> {
    token_entry()?
        .set_password(&token)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_token() -> Result<Option<String>, String> {
    match token_entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn delete_token() -> Result<(), String> {
    match token_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// App-owned posts (drafts + scheduled) live in a local SQLite file. Published
// posts are Instagram-owned and are fetched from the Graph API, not stored here.
fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "create_posts_table",
        sql: "CREATE TABLE IF NOT EXISTS posts (
                id           TEXT PRIMARY KEY,
                image_url    TEXT NOT NULL DEFAULT '',
                caption      TEXT NOT NULL DEFAULT '',
                status       TEXT NOT NULL,
                scheduled_at INTEGER,
                published_at INTEGER,
                likes        INTEGER,
                comments     INTEGER,
                updated_at   INTEGER NOT NULL
            );",
        kind: MigrationKind::Up,
    }]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:app.db", migrations())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![save_token, get_token, delete_token])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
