// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use keyring::Entry;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};
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

// ── LLM: long-running Claude Agent SDK sidecar ───────────────────────────────
//
// The Node process stays alive for the lifetime of the desktop app. JSON lines
// go over stdin/stdout; Rust supervises the process and relays typed events to
// the webview. SQLite remains authoritative — the sidecar receives stored turns
// with every request and uses SDK session IDs only as a warm-resume shortcut.

// GUI apps launched from Finder/Explorer don't inherit the login shell's PATH,
// so a system Node installation may not be found by name. Prepend the usual
// install locations for the child process. (Unix only; Windows PATH
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

fn node_command() -> std::process::Command {
    let cmd = std::process::Command::new("node");
    #[cfg(not(windows))]
    let mut cmd = cmd;
    #[cfg(not(windows))]
    cmd.env("PATH", augmented_path());
    cmd
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeStatus {
    available: bool,
    version: Option<String>,
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

fn sidecar_script(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sidecar/index.js");
        if development.is_file() {
            return Ok(development);
        }
    }
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Couldn't locate app resources: {error}"))?
        .join("sidecar")
        .join("index.js");
    if bundled.is_file() {
        Ok(bundled)
    } else {
        Err(format!(
            "The Claude Agent sidecar is missing at {}. Reinstall Socialite.",
            bundled.display()
        ))
    }
}

struct SidecarProcess {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
struct AgentSidecar {
    process: Mutex<Option<SidecarProcess>>,
}

fn visible_sidecar_error(message: impl Into<String>) -> serde_json::Value {
    serde_json::json!({
        "type": "fatal",
        "message": message.into(),
        "recoverable": true
    })
}

fn spawn_sidecar(app: &tauri::AppHandle) -> Result<SidecarProcess, String> {
    let script = sidecar_script(app)?;
    let mut command = node_command();
    command
        .arg(&script)
        .current_dir(
            script
                .parent()
                .ok_or_else(|| "Couldn't resolve the Agent sidecar folder.".to_string())?,
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        format!(
            "Couldn't start the Claude Agent sidecar ({error}). Install Node.js 18 or newer and restart Socialite."
        )
    })?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Couldn't open the Agent sidecar input stream.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Couldn't open the Agent sidecar output stream.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Couldn't open the Agent sidecar error stream.".to_string())?;

    let recent_stderr = Arc::new(Mutex::new(Vec::<String>::new()));
    let stderr_lines = Arc::clone(&recent_stderr);
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Ok(mut lines) = stderr_lines.lock() {
                if lines.len() == 8 {
                    lines.remove(0);
                }
                lines.push(line);
            }
        }
    });

    let (startup_sender, startup_receiver) = mpsc::sync_channel(1);
    let reader_app = app.clone();
    std::thread::spawn(move || {
        let mut lines = BufReader::new(stdout).lines();
        let startup = match lines.next() {
            Some(Ok(line)) => match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(value)
                    if value.get("type").and_then(|value| value.as_str()) == Some("ready") =>
                {
                    Ok(())
                }
                Ok(value) => Err(value
                    .get("message")
                    .and_then(|value| value.as_str())
                    .unwrap_or("The Agent sidecar sent an invalid startup message.")
                    .to_string()),
                Err(error) => Err(format!(
                    "The Agent sidecar sent malformed startup IPC: {error}"
                )),
            },
            Some(Err(error)) => Err(format!(
                "Couldn't read the Agent sidecar startup message: {error}"
            )),
            None => Err("The Agent sidecar exited before it was ready.".to_string()),
        };
        let startup_ok = startup.is_ok();
        let _ = startup_sender.send(startup);
        if !startup_ok {
            return;
        }

        for line in lines {
            let event = match line {
                Ok(line) => match serde_json::from_str::<serde_json::Value>(&line) {
                    Ok(value) if value.get("type").and_then(|value| value.as_str()).is_some() => {
                        value
                    }
                    Ok(_) => visible_sidecar_error(
                        "The Agent sidecar sent an IPC message without a type. Retry your request.",
                    ),
                    Err(error) => visible_sidecar_error(format!(
                        "The Agent sidecar sent malformed IPC ({error}). Retry your request."
                    )),
                },
                Err(error) => visible_sidecar_error(format!(
                    "The Agent sidecar output failed ({error}). Retry your request."
                )),
            };
            let _ = reader_app.emit("claude-sidecar", event);
        }
        let _ = reader_app.emit(
            "claude-sidecar",
            visible_sidecar_error(
                "The Claude Agent sidecar exited. Send the message again to restart it.",
            ),
        );
    });

    match startup_receiver.recv_timeout(Duration::from_secs(8)) {
        Ok(Ok(())) => Ok(SidecarProcess { child, stdin }),
        Ok(Err(error)) => {
            let _ = child.kill();
            let details = recent_stderr
                .lock()
                .ok()
                .and_then(|lines| lines.last().cloned())
                .filter(|line| !line.trim().is_empty());
            Err(match details {
                Some(details) => format!("{error} Details: {details}"),
                None => error,
            })
        }
        Err(_) => {
            let _ = child.kill();
            Err("The Claude Agent sidecar didn't become ready within 8 seconds. Check your Node.js installation and retry.".to_string())
        }
    }
}

impl AgentSidecar {
    fn ensure_started(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let mut process = self
            .process
            .lock()
            .map_err(|_| "The Agent sidecar supervisor is unavailable.".to_string())?;
        if let Some(running) = process.as_mut() {
            match running.child.try_wait() {
                Ok(None) => return Ok(()),
                Ok(Some(_)) | Err(_) => *process = None,
            }
        }
        *process = Some(spawn_sidecar(app)?);
        Ok(())
    }

    fn send(&self, app: &tauri::AppHandle, request: &serde_json::Value) -> Result<(), String> {
        self.ensure_started(app)?;
        let mut process = self
            .process
            .lock()
            .map_err(|_| "The Agent sidecar supervisor is unavailable.".to_string())?;
        let running = process
            .as_mut()
            .ok_or_else(|| "The Agent sidecar isn't running.".to_string())?;
        serde_json::to_writer(&mut running.stdin, request)
            .map_err(|error| format!("Couldn't encode the Agent request: {error}"))?;
        running
            .stdin
            .write_all(b"\n")
            .and_then(|_| running.stdin.flush())
            .map_err(|error| {
                *process = None;
                format!("The Agent sidecar stopped accepting requests ({error}). Send the message again to restart it.")
            })
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct ChatTurn {
    role: String,
    text: String,
}

// Proves the actual runtime and sidecar can start. A tiny real generation in
// useClaudeStatus separately checks the user's Claude subscription login.
#[tauri::command]
async fn detect_claude(
    app: tauri::AppHandle,
    sidecar: tauri::State<'_, AgentSidecar>,
) -> Result<ClaudeStatus, String> {
    let node_version = tauri::async_runtime::spawn_blocking(|| {
        let mut command = node_command();
        command.arg("--version");
        command.output()
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| {
        format!(
            "Node.js wasn't found ({error}). Install Node.js 18 or newer and restart Socialite."
        )
    })?;
    if !node_version.status.success() {
        return Ok(ClaudeStatus {
            available: false,
            version: None,
        });
    }
    sidecar.ensure_started(&app)?;
    Ok(ClaudeStatus {
        available: true,
        version: Some(format!(
            "Agent SDK · Node {}",
            String::from_utf8_lossy(&node_version.stdout).trim()
        )),
    })
}

#[tauri::command]
async fn claude_chat(
    app: tauri::AppHandle,
    sidecar: tauri::State<'_, AgentSidecar>,
    request_id: String,
    conversation_id: String,
    prompt: String,
    history: Vec<ChatTurn>,
    session_id: Option<String>,
    model: Option<String>,
    system: Option<String>,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let workspace = match workspace_path.filter(|path| !path.is_empty()) {
        Some(path) => {
            let app_data_dir = app_data_dir(&app)?;
            validate_project_workspace(&app_data_dir, Path::new(&path))?
        }
        None => {
            let workspace = app_data_dir(&app)?.join("agent-connection-check");
            std::fs::create_dir_all(&workspace)
                .map_err(|error| format!("Couldn't prepare the Agent connection check: {error}"))?;
            workspace
        }
    };
    let request = serde_json::json!({
        "type": "generate",
        "requestId": request_id,
        "conversationId": conversation_id,
        "prompt": prompt,
        "history": history,
        "sessionId": session_id,
        "model": model.unwrap_or_else(|| "sonnet".to_string()),
        "system": system,
        "workspacePath": workspace,
    });
    sidecar.send(&app, &request)
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum ToolApprovalDecision {
    Once,
    Always,
    Deny,
}

#[tauri::command]
async fn respond_to_tool_approval(
    app: tauri::AppHandle,
    sidecar: tauri::State<'_, AgentSidecar>,
    approval_id: String,
    decision: ToolApprovalDecision,
) -> Result<(), String> {
    if approval_id.is_empty() {
        return Err("The tool approval ID is missing.".to_string());
    }
    sidecar.send(
        &app,
        &serde_json::json!({
            "type": "permission_response",
            "approvalId": approval_id,
            "decision": decision,
        }),
    )
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
        Migration {
            version: 5,
            description: "cache_agent_session_ids",
            sql: "ALTER TABLE conversations ADD COLUMN session_id TEXT;",
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let sidecar = AgentSidecar::default();
            if let Err(error) = sidecar.ensure_started(app.handle()) {
                eprintln!("Claude Agent sidecar startup failed: {error}");
            }
            app.manage(sidecar);
            Ok(())
        })
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
            claude_chat,
            respond_to_tool_approval
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod project_workspace_tests {
    use super::{
        delete_project_workspace, delete_reference_file, import_reference_file,
        initialize_project_workspace, list_reference_files, update_project_workspace_instructions,
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
