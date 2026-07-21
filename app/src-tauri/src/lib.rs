// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use keyring::Entry;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

// The access token is a secret, so it lives in the OS keychain (macOS Keychain,
// Windows Credential Manager, Linux Secret Service) rather than the plaintext
// store. We key every entry under one service/account pair.
const KEYRING_SERVICE: &str = "com.socialite.app";
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

fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|error| error.to_string())
}

fn project_workspace_path(app_data_dir: &Path, project_id: &str) -> Result<PathBuf, String> {
    if project_id.is_empty()
        || !project_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Invalid project ID.".to_string());
    }
    Ok(app_data_dir.join("projects").join(project_id))
}

fn initialize_project_workspace(
    app_data_dir: &Path,
    project_id: &str,
    instructions: &str,
) -> Result<PathBuf, String> {
    let workspace = project_workspace_path(app_data_dir, project_id)?;
    std::fs::create_dir_all(&workspace).map_err(|error| error.to_string())?;
    std::fs::write(workspace.join("CLAUDE.md"), instructions).map_err(|error| error.to_string())?;
    Ok(workspace)
}

fn update_project_workspace_instructions(
    app_data_dir: &Path,
    project_id: &str,
    instructions: &str,
) -> Result<(), String> {
    let workspace = project_workspace_path(app_data_dir, project_id)?;
    if !workspace.is_dir() {
        return Err("Project workspace no longer exists.".to_string());
    }
    std::fs::write(workspace.join("CLAUDE.md"), instructions).map_err(|error| error.to_string())
}

fn delete_project_workspace(app_data_dir: &Path, project_id: &str) -> Result<(), String> {
    let workspace = project_workspace_path(app_data_dir, project_id)?;
    if workspace.exists() {
        std::fs::remove_dir_all(workspace).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[derive(Debug, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ProjectReference {
    name: String,
    size: u64,
}

fn project_references_path(app_data_dir: &Path, project_id: &str) -> Result<PathBuf, String> {
    let workspace = project_workspace_path(app_data_dir, project_id)?;
    if !workspace.is_dir() {
        return Err("Project workspace no longer exists.".to_string());
    }
    Ok(workspace.join("references"))
}

fn project_reference_path(
    app_data_dir: &Path,
    project_id: &str,
    file_name: &str,
) -> Result<PathBuf, String> {
    if file_name.is_empty()
        || file_name.contains(['/', '\\'])
        || Path::new(file_name)
            .file_name()
            .and_then(|name| name.to_str())
            != Some(file_name)
    {
        return Err("Invalid reference file name.".to_string());
    }
    Ok(project_references_path(app_data_dir, project_id)?.join(file_name))
}

fn import_reference_file(
    app_data_dir: &Path,
    project_id: &str,
    file_name: &str,
    contents: &[u8],
) -> Result<ProjectReference, String> {
    let path = project_reference_path(app_data_dir, project_id, file_name)?;
    let references = path
        .parent()
        .ok_or_else(|| "Couldn't resolve the references folder.".to_string())?;
    std::fs::create_dir_all(references).map_err(|error| error.to_string())?;

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                format!("A reference named \"{file_name}\" already exists.")
            } else {
                format!("Couldn't copy \"{file_name}\": {error}")
            }
        })?;
    if let Err(error) = file.write_all(contents) {
        drop(file);
        let _ = std::fs::remove_file(&path);
        return Err(format!("Couldn't copy \"{file_name}\": {error}"));
    }
    Ok(ProjectReference {
        name: file_name.to_string(),
        size: contents.len() as u64,
    })
}

fn list_reference_files(
    app_data_dir: &Path,
    project_id: &str,
) -> Result<Vec<ProjectReference>, String> {
    let references = project_references_path(app_data_dir, project_id)?;
    if !references.exists() {
        return Ok(Vec::new());
    }
    let entries = std::fs::read_dir(&references)
        .map_err(|error| format!("Couldn't read project references: {error}"))?;
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("Couldn't read project references: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Couldn't inspect a project reference: {error}"))?;
        if !file_type.is_file() {
            continue;
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "A reference file name isn't valid UTF-8.".to_string())?;
        let size = entry
            .metadata()
            .map_err(|error| format!("Couldn't inspect \"{name}\": {error}"))?
            .len();
        files.push(ProjectReference { name, size });
    }
    files.sort_by_key(|reference| reference.name.to_lowercase());
    Ok(files)
}

fn delete_reference_file(
    app_data_dir: &Path,
    project_id: &str,
    file_name: &str,
) -> Result<(), String> {
    let path = project_reference_path(app_data_dir, project_id, file_name)?;
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|error| format!("Couldn't access \"{file_name}\": {error}"))?;
    if !metadata.file_type().is_file() {
        return Err("Reference is not a regular file.".to_string());
    }
    std::fs::remove_file(path).map_err(|error| format!("Couldn't remove \"{file_name}\": {error}"))
}

#[tauri::command]
fn create_project_workspace(
    app: tauri::AppHandle,
    project_id: String,
    instructions: String,
) -> Result<String, String> {
    let app_data_dir = app_data_dir(&app)?;
    let workspace = initialize_project_workspace(&app_data_dir, &project_id, &instructions)?;
    workspace
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "Project workspace path isn't valid UTF-8.".to_string())
}

#[tauri::command]
fn write_project_instructions(
    app: tauri::AppHandle,
    project_id: String,
    instructions: String,
) -> Result<(), String> {
    let app_data_dir = app_data_dir(&app)?;
    update_project_workspace_instructions(&app_data_dir, &project_id, &instructions)
}

#[tauri::command]
fn remove_project_workspace(app: tauri::AppHandle, project_id: String) -> Result<(), String> {
    let app_data_dir = app_data_dir(&app)?;
    delete_project_workspace(&app_data_dir, &project_id)
}

#[tauri::command]
fn import_project_reference(
    app: tauri::AppHandle,
    project_id: String,
    file_name: String,
    contents: Vec<u8>,
) -> Result<ProjectReference, String> {
    import_reference_file(&app_data_dir(&app)?, &project_id, &file_name, &contents)
}

#[tauri::command]
fn list_project_references(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<Vec<ProjectReference>, String> {
    list_reference_files(&app_data_dir(&app)?, &project_id)
}

#[tauri::command]
fn remove_project_reference(
    app: tauri::AppHandle,
    project_id: String,
    file_name: String,
) -> Result<(), String> {
    delete_reference_file(&app_data_dir(&app)?, &project_id, &file_name)
}

// ── LLM: Claude via the user's own Claude Code subscription ──────────────────
//
// We never handle Anthropic credentials. The user installs Claude Code and runs
// `claude` once to sign in (OAuth against their Pro/Max subscription); the CLI
// stores that session locally. We simply shell out to `claude -p` in headless
// mode, which uses whatever session the user already established with Anthropic.
// This mirrors how the Claude Agent SDK auto-discovers the local login — the app
// is a consumer of the user's Claude Code, not a provider of Claude login.
//
// Prompts are passed as a single argv element (never through a shell), so
// arbitrary prompt text is safe from injection.

// GUI apps launched from Finder/Explorer don't inherit the login shell's PATH,
// so a `claude` on Homebrew/npm-global/~/.claude won't be found by name. Prepend
// the usual install locations for the child process. (Unix only; Windows PATH
// uses a different separator and these POSIX paths don't apply.)
#[cfg(not(windows))]
fn augmented_path() -> String {
    let mut parts: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();
    let home = std::env::var("HOME").unwrap_or_default();
    let extras = [
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        format!("{home}/.claude/local"),
        format!("{home}/.local/bin"),
        format!("{home}/.npm-global/bin"),
    ];
    for e in extras {
        if !e.is_empty() && !parts.contains(&e) {
            parts.push(e);
        }
    }
    parts.join(":")
}

fn claude_command() -> std::process::Command {
    let cmd = std::process::Command::new("claude");
    #[cfg(not(windows))]
    let mut cmd = cmd;
    #[cfg(not(windows))]
    cmd.env("PATH", augmented_path());
    cmd
}

#[derive(serde::Serialize)]
struct ClaudeStatus {
    available: bool,
    version: Option<String>,
}

// Is Claude Code installed and reachable? `claude --version` needs no auth, so
// this only reports installation — not whether the user is signed in. A real
// generation (or the Settings "Check connection" test) surfaces auth problems.
#[tauri::command]
async fn detect_claude() -> ClaudeStatus {
    tauri::async_runtime::spawn_blocking(|| {
        let mut cmd = claude_command();
        cmd.arg("--version");
        match cmd.output() {
            Ok(out) if out.status.success() => ClaudeStatus {
                available: true,
                version: Some(String::from_utf8_lossy(&out.stdout).trim().to_string()),
            },
            _ => ClaudeStatus {
                available: false,
                version: None,
            },
        }
    })
    .await
    .unwrap_or(ClaudeStatus {
        available: false,
        version: None,
    })
}

fn claude_request_command(
    prompt: &str,
    model: Option<&str>,
    workspace_path: Option<&Path>,
) -> std::process::Command {
    let mut cmd = claude_command();
    cmd.arg("-p").arg(prompt).arg("--output-format").arg("json");
    if let Some(m) = model.filter(|s| !s.is_empty()) {
        cmd.arg("--model").arg(m);
    }
    if let Some(workspace) = workspace_path {
        cmd.current_dir(workspace);
    }
    cmd
}

fn validate_project_workspace(
    app_data_dir: &Path,
    workspace_path: &Path,
) -> Result<PathBuf, String> {
    let projects_root = app_data_dir
        .join("projects")
        .canonicalize()
        .map_err(|error| format!("Couldn't resolve the projects folder: {error}"))?;
    let workspace = workspace_path
        .canonicalize()
        .map_err(|error| format!("Couldn't resolve the project workspace: {error}"))?;
    if !workspace.starts_with(&projects_root) || !workspace.is_dir() {
        return Err("Project workspace is outside the application data directory.".to_string());
    }
    Ok(workspace)
}

fn run_claude(
    prompt: &str,
    model: Option<&str>,
    workspace_path: Option<&Path>,
) -> Result<String, String> {
    let mut cmd = claude_request_command(prompt, model, workspace_path);

    let out = cmd.output().map_err(|e| {
        format!(
            "Couldn't run Claude Code ({e}). Install it with \
             `npm install -g @anthropic-ai/claude-code`, then run `claude` once to sign in."
        )
    })?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let err = err.trim();
        return Err(if err.is_empty() {
            "Claude Code exited with an error. Run `claude` in a terminal to check your login."
                .to_string()
        } else {
            err.to_string()
        });
    }

    let parsed: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("Couldn't parse Claude Code output: {e}"))?;

    // `--output-format json` returns either the result object directly (older
    // CLIs) or an array of events whose final `type:"result"` element holds the
    // answer (newer CLIs, e.g. 2.1.x). Normalize to that result object. It
    // carries the final text in `result` and flags failures with `is_error`.
    let result = match &parsed {
        serde_json::Value::Array(items) => items
            .iter()
            .rev()
            .find(|it| it.get("type").and_then(serde_json::Value::as_str) == Some("result")),
        serde_json::Value::Object(_) => Some(&parsed),
        _ => None,
    }
    .ok_or_else(|| "Claude Code returned no result.".to_string())?;

    if result
        .get("is_error")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        return Err(result
            .get("result")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Claude returned an error.")
            .to_string());
    }
    Ok(result
        .get("result")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string())
}

// One-shot generation through the user's Claude Code session. `model` is a CLI
// model alias ("sonnet" | "opus" | "haiku") or a full model id; None uses the
// CLI default. Runs on the blocking pool so the process wait doesn't stall the
// async runtime.
#[tauri::command]
async fn claude_chat(
    app: tauri::AppHandle,
    prompt: String,
    model: Option<String>,
    workspace_path: Option<String>,
) -> Result<String, String> {
    let workspace = match workspace_path {
        Some(path) => {
            let app_data_dir = app_data_dir(&app)?;
            Some(validate_project_workspace(&app_data_dir, Path::new(&path))?)
        }
        None => None,
    };
    tauri::async_runtime::spawn_blocking(move || {
        run_claude(&prompt, model.as_deref(), workspace.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

// App-owned posts (drafts + scheduled) live in a local SQLite file. Published
// posts are Instagram-owned and are fetched from the Graph API, not stored here.
fn migrations() -> Vec<Migration> {
    vec![
        Migration {
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
        },
        Migration {
            version: 2,
            description: "create_conversations",
            sql: "CREATE TABLE IF NOT EXISTS projects (
                    id         TEXT PRIMARY KEY,
                    name       TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                  );

                  CREATE TABLE IF NOT EXISTS conversations (
                    id         TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    title      TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                  );

                  CREATE TABLE IF NOT EXISTS messages (
                    id              TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    role            TEXT NOT NULL CHECK (role IN ('user', 'ai')),
                    text            TEXT NOT NULL,
                    ideas_json      TEXT,
                    created_at      INTEGER NOT NULL,
                    sequence        INTEGER NOT NULL,
                    UNIQUE (conversation_id, sequence)
                  );

                  CREATE INDEX IF NOT EXISTS idx_messages_conversation_sequence
                    ON messages (conversation_id, sequence);",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "track_active_conversation",
            sql: "ALTER TABLE projects
                    ADD COLUMN active_conversation_id TEXT
                    REFERENCES conversations(id) ON DELETE SET NULL;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "expand_projects",
            sql: "ALTER TABLE projects
                    ADD COLUMN instructions TEXT NOT NULL DEFAULT '';

                  ALTER TABLE projects
                    ADD COLUMN workspace_path TEXT NOT NULL DEFAULT '';

                  ALTER TABLE projects
                    ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;

                  CREATE TABLE IF NOT EXISTS app_state (
                    key   TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                  );",
            kind: MigrationKind::Up,
        },
    ]
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
        .invoke_handler(tauri::generate_handler![
            save_token,
            get_token,
            delete_token,
            create_project_workspace,
            write_project_instructions,
            remove_project_workspace,
            import_project_reference,
            list_project_references,
            remove_project_reference,
            detect_claude,
            claude_chat
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod project_workspace_tests {
    use super::{
        claude_request_command, delete_project_workspace, delete_reference_file,
        import_reference_file, initialize_project_workspace, list_reference_files,
        update_project_workspace_instructions,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_app_data() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "socialite-project-test-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn creates_a_project_workspace_with_standing_instructions() {
        let app_data = temporary_app_data();

        let workspace = initialize_project_workspace(
            &app_data,
            "summer-launch",
            "Use a warm, practical voice.",
        )
        .expect("workspace should be created");

        assert_eq!(workspace, app_data.join("projects").join("summer-launch"));
        assert_eq!(
            fs::read_to_string(workspace.join("CLAUDE.md")).expect("instructions should exist"),
            "Use a warm, practical voice."
        );
        fs::remove_dir_all(&app_data).expect("temporary workspace should be removable");
    }

    #[test]
    fn updates_and_deletes_only_the_named_project_workspace() {
        let app_data = temporary_app_data();
        initialize_project_workspace(&app_data, "campaign-a", "First")
            .expect("workspace should be created");
        initialize_project_workspace(&app_data, "campaign-b", "Keep me")
            .expect("second workspace should be created");

        update_project_workspace_instructions(&app_data, "campaign-a", "Revised")
            .expect("instructions should update");
        delete_project_workspace(&app_data, "campaign-a").expect("workspace should delete");

        assert!(!app_data.join("projects").join("campaign-a").exists());
        assert_eq!(
            fs::read_to_string(
                app_data
                    .join("projects")
                    .join("campaign-b")
                    .join("CLAUDE.md")
            )
            .expect("other project should remain"),
            "Keep me"
        );
        fs::remove_dir_all(&app_data).expect("temporary workspace should be removable");
    }

    #[test]
    fn rejects_project_ids_that_could_escape_the_workspace_root() {
        let app_data = temporary_app_data();

        let error = initialize_project_workspace(&app_data, "../outside", "No")
            .expect_err("path traversal must be rejected");

        assert_eq!(error, "Invalid project ID.");
        assert!(!app_data.join("outside").exists());
    }

    #[test]
    fn runs_claude_from_the_selected_project_workspace() {
        let workspace = PathBuf::from("/app-data/projects/summer-launch");

        let command = claude_request_command("Draft a post", Some("sonnet"), Some(&workspace));

        assert_eq!(command.get_current_dir(), Some(workspace.as_path()));
    }

    #[test]
    fn imports_lists_and_removes_a_project_reference() {
        let app_data = temporary_app_data();
        initialize_project_workspace(&app_data, "summer-launch", "")
            .expect("workspace should be created");

        let imported = import_reference_file(
            &app_data,
            "summer-launch",
            "brand-notes.txt",
            b"Audience: trail runners",
        )
        .expect("reference should be imported");

        assert_eq!(imported.name, "brand-notes.txt");
        assert_eq!(imported.size, 23);
        assert_eq!(
            fs::read_to_string(
                app_data
                    .join("projects")
                    .join("summer-launch")
                    .join("references")
                    .join("brand-notes.txt")
            )
            .expect("copied reference should be readable"),
            "Audience: trail runners"
        );
        assert_eq!(
            list_reference_files(&app_data, "summer-launch").expect("references should list"),
            vec![imported]
        );

        delete_reference_file(&app_data, "summer-launch", "brand-notes.txt")
            .expect("reference should be removed");
        assert!(list_reference_files(&app_data, "summer-launch")
            .expect("references should list")
            .is_empty());
        fs::remove_dir_all(&app_data).expect("temporary workspace should be removable");
    }

    #[test]
    fn keeps_references_isolated_by_project_and_rejects_unsafe_names() {
        let app_data = temporary_app_data();
        initialize_project_workspace(&app_data, "campaign-a", "")
            .expect("workspace should be created");
        initialize_project_workspace(&app_data, "campaign-b", "")
            .expect("workspace should be created");
        import_reference_file(&app_data, "campaign-a", "brief.txt", b"Campaign A only")
            .expect("reference should be imported");

        assert_eq!(
            list_reference_files(&app_data, "campaign-a").unwrap().len(),
            1
        );
        assert!(list_reference_files(&app_data, "campaign-b")
            .unwrap()
            .is_empty());
        assert_eq!(
            import_reference_file(&app_data, "campaign-a", "../escape.txt", b"no")
                .expect_err("path traversal must be rejected"),
            "Invalid reference file name."
        );
        fs::remove_dir_all(&app_data).expect("temporary workspace should be removable");
    }
}
