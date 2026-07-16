// LLM client — Claude via the user's own Claude Code subscription.
//
// Auth is entirely out-of-band: the user installs Claude Code and runs `claude`
// once to sign in (OAuth against their Pro/Max subscription). We never see or
// store their credentials — the Rust backend shells out to `claude -p`, which
// uses whatever local session the user already established with Anthropic. See
// src-tauri/src/lib.rs (detect_claude / claude_chat).

import { invoke } from "@tauri-apps/api/core";

export interface ClaudeStatus {
  available: boolean; // Claude Code installed and on PATH
  version: string | null;
}

// Model aliases the Claude Code `--model` flag accepts. (Full model ids also
// work, but aliases track "latest" without pinning.)
export type ClaudeModel = "sonnet" | "opus" | "haiku";

// Is Claude Code installed? Reports installation only, not sign-in state — an
// actual generation surfaces auth problems (see generate()).
export async function detectClaude(): Promise<ClaudeStatus> {
  return invoke<ClaudeStatus>("detect_claude");
}

// One-shot text generation. A system instruction, if given, is prepended to the
// prompt (headless CLI has no separate system channel we rely on across
// versions). Throws with the CLI's error text on failure (not installed, not
// signed in, etc.).
export async function generate(
  prompt: string,
  opts?: { system?: string; model?: ClaudeModel },
): Promise<string> {
  const full = opts?.system ? `${opts.system}\n\n${prompt}` : prompt;
  return invoke<string>("claude_chat", {
    prompt: full,
    model: opts?.model ?? "sonnet",
  });
}
