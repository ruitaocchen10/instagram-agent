import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { generate } from "./llm";

const mockInvoke = invoke as unknown as Mock;
const mockListen = listen as unknown as Mock;
let receiveEvent: ((event: { payload: Record<string, unknown> }) => void) | undefined;

mockListen.mockImplementation(async (_name, handler) => {
  receiveEvent = handler;
  return vi.fn();
});

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(async (_command, args) => {
    queueMicrotask(() =>
      receiveEvent?.({
        payload: {
          type: "complete",
          requestId: args.requestId,
          sessionId: "session-1",
          text: "answer",
        },
      }),
    );
  });
});

describe("generate", () => {
  it("submits stored history and the cached session id as separate Agent inputs", async () => {
    await generate("What comes next?", {
      system: "Be practical.",
      model: "sonnet",
      conversationId: "launch-planning",
      sessionId: "session-1",
      history: [
        { role: "user", text: "Plan a launch week." },
        { role: "ai", text: "Start with a teaser." },
      ],
    });

    expect(mockInvoke).toHaveBeenCalledWith("claude_chat", {
      requestId: expect.any(String),
      conversationId: "launch-planning",
      model: "sonnet",
      prompt: "What comes next?",
      history: [
        { role: "user", text: "Plan a launch week." },
        { role: "ai", text: "Start with a teaser." },
      ],
      sessionId: "session-1",
      system: "Be practical.",
    });
  });

  it("delivers session metadata and reply deltas before completion", async () => {
    const chunks: string[] = [];
    const sessions: string[] = [];
    let resets = 0;
    mockInvoke.mockImplementationOnce(async (_command, args) => {
      queueMicrotask(() => {
        receiveEvent?.({
          payload: { type: "session", requestId: args.requestId, sessionId: "warm-2" },
        });
        receiveEvent?.({
          payload: { type: "delta", requestId: args.requestId, text: "Start" },
        });
        receiveEvent?.({ payload: { type: "reset", requestId: args.requestId } });
        receiveEvent?.({
          payload: { type: "delta", requestId: args.requestId, text: "Fresh." },
        });
        receiveEvent?.({
          payload: {
            type: "complete",
            requestId: args.requestId,
            sessionId: "warm-3",
            text: "Fresh.",
          },
        });
      });
    });

    await expect(
      generate("Draft the first post.", {
        conversationId: "ideas",
        workspacePath: "/app-data/projects/summer-launch",
        onDelta: (text) => chunks.push(text),
        onReset: () => {
          resets += 1;
        },
        onSessionId: (sessionId) => {
          sessions.push(sessionId);
        },
      }),
    ).resolves.toBe("Fresh.");

    expect(chunks).toEqual(["Start", "Fresh."]);
    expect(resets).toBe(1);
    expect(sessions).toEqual(["warm-2", "warm-3"]);
  });

  it("rejects visibly when the sidecar sends malformed IPC", async () => {
    mockInvoke.mockImplementationOnce(async () => {
      queueMicrotask(() => {
        receiveEvent?.({ payload: { type: "delta", requestId: 123, text: "lost" } });
      });
    });

    await expect(generate("Hello", { conversationId: "ideas" })).rejects.toThrow(
      "malformed IPC",
    );
  });
});
