// Streaming Claude Agent SDK client. Rust owns and supervises the long-running
// Node sidecar; this module correlates Tauri events with browser-side requests.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface ClaudeStatus {
  available: boolean;
  version: string | null;
}

export type ClaudeModel = "sonnet" | "opus" | "haiku";

export interface ChatTurn {
  role: "ai" | "user";
  text: string;
}

interface SidecarEvent {
  type: "session" | "delta" | "reset" | "complete" | "error" | "fatal" | "protocol_error";
  requestId?: string;
  sessionId?: string;
  text?: string;
  message?: string;
}

interface PendingGeneration {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  onDelta?: (text: string) => void;
  onReset?: () => void;
  onSessionId?: (sessionId: string) => void | Promise<void>;
}

const pendingGenerations = new Map<string, PendingGeneration>();
let sidecarListener: Promise<UnlistenFn> | null = null;

function eventError(event: SidecarEvent): Error {
  return new Error(event.message?.trim() || "The Claude Agent sidecar failed. Send again to retry.");
}

function rejectAllPending(error: Error): void {
  for (const pending of pendingGenerations.values()) pending.reject(error);
  pendingGenerations.clear();
}

function parseSidecarEvent(payload: unknown): SidecarEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const event = payload as Record<string, unknown>;
  if (typeof event.type !== "string") return null;
  if (event.type === "fatal" || event.type === "protocol_error") {
    return {
      type: event.type,
      ...(typeof event.message === "string" ? { message: event.message } : {}),
    };
  }
  if (typeof event.requestId !== "string") return null;
  if (event.type === "reset") return { type: "reset", requestId: event.requestId };
  if (event.type === "session" && typeof event.sessionId === "string") {
    return { type: "session", requestId: event.requestId, sessionId: event.sessionId };
  }
  if (event.type === "delta" && typeof event.text === "string") {
    return { type: "delta", requestId: event.requestId, text: event.text };
  }
  if (event.type === "complete" && typeof event.text === "string") {
    return {
      type: "complete",
      requestId: event.requestId,
      text: event.text,
      ...(typeof event.sessionId === "string" ? { sessionId: event.sessionId } : {}),
    };
  }
  if (event.type === "error" && typeof event.message === "string") {
    return { type: "error", requestId: event.requestId, message: event.message };
  }
  return null;
}

function rememberSession(pending: PendingGeneration, sessionId: string | undefined): void {
  if (!sessionId) return;
  void Promise.resolve(pending.onSessionId?.(sessionId)).catch(() => {
    // Session IDs are disposable optimizations; message persistence is the
    // correctness path, so a failed cache write must not fail the reply.
  });
}

function handleSidecarPayload(payload: unknown): void {
  const event = parseSidecarEvent(payload);
  if (!event) {
    rejectAllPending(
      new Error("The Claude Agent sidecar sent malformed IPC. Send the message again to retry."),
    );
    return;
  }
  if (event.type === "fatal" || event.type === "protocol_error") {
    rejectAllPending(eventError(event));
    return;
  }

  if (!event.requestId) return;
  const pending = pendingGenerations.get(event.requestId);
  if (!pending) return;
  if (event.type === "delta" && event.text) {
    pending.onDelta?.(event.text);
    return;
  }
  if (event.type === "reset") {
    pending.onReset?.();
    return;
  }
  if (event.type === "session" && event.sessionId) {
    rememberSession(pending, event.sessionId);
    return;
  }
  pendingGenerations.delete(event.requestId);
  if (event.type === "complete") {
    rememberSession(pending, event.sessionId);
    pending.resolve(event.text ?? "");
  }
  else pending.reject(eventError(event));
}

async function ensureSidecarListener(): Promise<void> {
  sidecarListener ??= listen<unknown>("claude-sidecar", ({ payload }) => {
    handleSidecarPayload(payload);
  });
  await sidecarListener;
}

export async function detectClaude(): Promise<ClaudeStatus> {
  return invoke<ClaudeStatus>("detect_claude");
}

export async function generate(
  prompt: string,
  opts?: {
    system?: string;
    model?: ClaudeModel;
    history?: ChatTurn[];
    workspacePath?: string;
    conversationId?: string;
    sessionId?: string | null;
    onDelta?: (text: string) => void;
    onReset?: () => void;
    onSessionId?: (sessionId: string) => void | Promise<void>;
  },
): Promise<string> {
  await ensureSidecarListener();
  const requestId = crypto.randomUUID();
  const conversationId = opts?.conversationId ?? `ephemeral-${requestId}`;

  return new Promise<string>((resolve, reject) => {
    pendingGenerations.set(requestId, {
      resolve,
      reject,
      ...(opts?.onDelta ? { onDelta: opts.onDelta } : {}),
      ...(opts?.onReset ? { onReset: opts.onReset } : {}),
      ...(opts?.onSessionId ? { onSessionId: opts.onSessionId } : {}),
    });
    void invoke<void>("claude_chat", {
      requestId,
      conversationId,
      prompt,
      history: opts?.history ?? [],
      model: opts?.model ?? "sonnet",
      ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts?.system ? { system: opts.system } : {}),
      ...(opts?.workspacePath ? { workspacePath: opts.workspacePath } : {}),
    }).catch((error) => {
      pendingGenerations.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
