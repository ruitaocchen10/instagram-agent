// Streaming Claude Agent SDK client. Rust owns and supervises the long-running
// Node sidecar; this module correlates Tauri events with browser-side requests.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface ClaudeStatus {
  available: boolean;
  version: string | null;
}

export type ClaudeModel = "sonnet" | "opus" | "haiku";

export interface AppToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export type AppToolResult = Record<string, unknown>;

export interface ChatTurn {
  role: "ai" | "user";
  text: string;
}

export interface ToolApprovalRequest {
  requestId: string;
  approvalId: string;
  toolName: string;
  input: Record<string, unknown>;
  grantable: boolean;
  reason: string;
}

export type ToolApprovalDecision = "once" | "always" | "deny";

type SidecarEvent =
  | { type: "fatal"; message?: string }
  | { type: "protocol_error"; message?: string }
  | ({ type: "approval" } & ToolApprovalRequest)
  | { type: "approval_cancelled"; requestId: string; approvalId: string }
  | ({ type: "app_tool_request"; requestId: string } & AppToolCall)
  | { type: "session"; requestId: string; sessionId: string }
  | { type: "delta"; requestId: string; text: string }
  | { type: "reset"; requestId: string }
  | { type: "complete"; requestId: string; text: string; sessionId?: string }
  | { type: "error"; requestId: string; message: string };

interface PendingGeneration {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  onDelta?: (text: string) => void;
  onReset?: () => void;
  onSessionId?: (sessionId: string) => void | Promise<void>;
  onToolCall?: (call: AppToolCall) => Promise<AppToolResult>;
}

const pendingGenerations = new Map<string, PendingGeneration>();
const pendingApprovals: ToolApprovalRequest[] = [];
const approvalSubscribers = new Set<(requests: readonly ToolApprovalRequest[]) => void>();
let sidecarListener: Promise<UnlistenFn> | null = null;

function publishApprovals(): void {
  const snapshot = [...pendingApprovals];
  for (const subscriber of approvalSubscribers) subscriber(snapshot);
}

function removeApprovals(predicate: (request: ToolApprovalRequest) => boolean): void {
  const retained = pendingApprovals.filter((request) => !predicate(request));
  if (retained.length === pendingApprovals.length) return;
  pendingApprovals.splice(0, pendingApprovals.length, ...retained);
  publishApprovals();
}

function eventError(event: { message?: string }): Error {
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
  if (event.type === "approval_cancelled" && typeof event.approvalId === "string") {
    return {
      type: "approval_cancelled",
      requestId: event.requestId,
      approvalId: event.approvalId,
    };
  }
  if (
    event.type === "app_tool_request" &&
    typeof event.toolCallId === "string" &&
    typeof event.toolName === "string" &&
    event.input &&
    typeof event.input === "object" &&
    !Array.isArray(event.input)
  ) {
    return {
      type: "app_tool_request",
      requestId: event.requestId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input as Record<string, unknown>,
    };
  }
  if (
    event.type === "approval" &&
    typeof event.approvalId === "string" &&
    typeof event.toolName === "string" &&
    event.input &&
    typeof event.input === "object" &&
    !Array.isArray(event.input) &&
    typeof event.grantable === "boolean" &&
    typeof event.reason === "string"
  ) {
    return {
      type: "approval",
      requestId: event.requestId,
      approvalId: event.approvalId,
      toolName: event.toolName,
      input: event.input as Record<string, unknown>,
      grantable: event.grantable,
      reason: event.reason,
    };
  }
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

async function executeAppTool(
  event: Extract<SidecarEvent, { type: "app_tool_request" }>,
  pending: PendingGeneration,
): Promise<void> {
  let result: AppToolResult | undefined;
  let error: string | undefined;
  try {
    if (!pending.onToolCall) throw new Error(`${event.toolName} is not available in this view.`);
    result = await pending.onToolCall({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
    });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  try {
    await invoke<void>("respond_to_app_tool", {
      toolCallId: event.toolCallId,
      result: result ?? null,
      error: error ?? null,
    });
  } catch (cause) {
    pendingGenerations.delete(event.requestId);
    pending.reject(cause instanceof Error ? cause : new Error(String(cause)));
  }
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
    removeApprovals(() => true);
    rejectAllPending(eventError(event));
    return;
  }

  if (event.type === "approval_cancelled") {
    removeApprovals((approval) => approval.approvalId === event.approvalId);
    return;
  }

  if (event.type === "approval") {
    if (!pendingApprovals.some((approval) => approval.approvalId === event.approvalId)) {
      const { type: _, ...approval } = event;
      pendingApprovals.push(approval);
      publishApprovals();
    }
    return;
  }

  const pending = pendingGenerations.get(event.requestId);
  if (!pending) return;
  if (event.type === "app_tool_request") {
    void executeAppTool(event, pending);
    return;
  }
  if (event.type === "delta") {
    if (event.text) pending.onDelta?.(event.text);
    return;
  }
  if (event.type === "reset") {
    pending.onReset?.();
    return;
  }
  if (event.type === "session") {
    rememberSession(pending, event.sessionId);
    return;
  }
  pendingGenerations.delete(event.requestId);
  removeApprovals((approval) => approval.requestId === event.requestId);
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

export function subscribeToolApprovals(
  subscriber: (requests: readonly ToolApprovalRequest[]) => void,
): () => void {
  approvalSubscribers.add(subscriber);
  subscriber([...pendingApprovals]);
  return () => approvalSubscribers.delete(subscriber);
}

export async function respondToToolApproval(
  approvalId: string,
  decision: ToolApprovalDecision,
): Promise<void> {
  await invoke<void>("respond_to_tool_approval", { approvalId, decision });
  const index = pendingApprovals.findIndex((approval) => approval.approvalId === approvalId);
  if (index >= 0) {
    pendingApprovals.splice(index, 1);
    publishApprovals();
  }
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
    onToolCall?: (call: AppToolCall) => Promise<AppToolResult>;
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
      ...(opts?.onToolCall ? { onToolCall: opts.onToolCall } : {}),
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
