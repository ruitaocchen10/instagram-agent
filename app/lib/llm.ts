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

// A single past turn, used to give Claude conversation context. Structurally a
// subset of ChatMessage, so callers can pass their message list directly.
export interface ChatTurn {
  role: "ai" | "user";
  text: string;
}

// One-shot text generation. The CLI is stateless (one process per call), so to
// carry a conversation we fold the prior turns into the prompt as a labeled
// transcript. A system instruction, if given, is prepended (headless CLI has no
// separate system channel we rely on across versions). Throws with the CLI's
// error text on failure (not installed, not signed in, etc.).
export async function generate(
  prompt: string,
  opts?: {
    system?: string;
    model?: ClaudeModel;
    history?: ChatTurn[];
    workspacePath?: string;
  },
): Promise<string> {
  const sections: string[] = [];
  if (opts?.system) sections.push(opts.system);
  if (opts?.history && opts.history.length > 0) {
    const transcript = opts.history
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
      .join("\n");
    sections.push(`Conversation so far:\n${transcript}`);
    sections.push(`User: ${prompt}`);
  } else {
    sections.push(prompt);
  }
  return invoke<string>("claude_chat", {
    prompt: sections.join("\n\n"),
    model: opts?.model ?? "sonnet",
    ...(opts?.workspacePath ? { workspacePath: opts.workspacePath } : {}),
  });
}
