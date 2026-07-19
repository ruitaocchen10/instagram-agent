// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use keyring::Entry;
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

fn run_claude(prompt: &str, model: Option<&str>) -> Result<String, String> {
    let mut cmd = claude_command();
    cmd.arg("-p").arg(prompt).arg("--output-format").arg("json");
    if let Some(m) = model.filter(|s| !s.is_empty()) {
        cmd.arg("--model").arg(m);
    }

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
async fn claude_chat(prompt: String, model: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_claude(&prompt, model.as_deref()))
        .await
        .map_err(|e| e.to_string())?
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
        .invoke_handler(tauri::generate_handler![
            save_token,
            get_token,
            delete_token,
            detect_claude,
            claude_chat
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
