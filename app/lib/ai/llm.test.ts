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

  it("delivers a publish_now request to the application and returns its media ID", async () => {
    const onToolCall = vi.fn().mockResolvedValue({
      post_id: "draft-1",
      media_id: "ig-42",
      status: "published",
      message: "Published to Instagram as ig-42.",
    });
    mockInvoke.mockImplementation(async (command, args) => {
      if (command === "claude_chat") {
        queueMicrotask(() =>
          receiveEvent?.({
            payload: {
              type: "app_tool_request",
              requestId: args.requestId,
              toolCallId: "tool-9",
              toolName: "publish_now",
              input: {
                post_id: "draft-1",
                caption: "The launch starts here.",
                image_url: "https://cdn.example.com/launch.jpg",
              },
            },
          }),
        );
      }
      if (command === "respond_to_app_tool") return;
    });

    const generated = generate("Publish the launch draft.", {
      conversationId: "launch",
      onToolCall,
    });

    await vi.waitFor(() => expect(onToolCall).toHaveBeenCalledOnce());
    expect(onToolCall).toHaveBeenCalledWith({
      toolCallId: "tool-9",
      toolName: "publish_now",
      input: {
        post_id: "draft-1",
        caption: "The launch starts here.",
        image_url: "https://cdn.example.com/launch.jpg",
      },
    });
    expect(mockInvoke).toHaveBeenCalledWith("respond_to_app_tool", {
      toolCallId: "tool-9",
      result: {
        post_id: "draft-1",
        media_id: "ig-42",
        status: "published",
        message: "Published to Instagram as ig-42.",
      },
      error: null,
    });

    // Complete the still-pending generation using its real request identifier.
    const requestId = mockInvoke.mock.calls.find(([command]) => command === "claude_chat")![1]
      .requestId;
    receiveEvent?.({
      payload: {
        type: "complete",
        requestId,
        text: "Published to Instagram as ig-42.",
      },
    });
    await expect(generated).resolves.toBe("Published to Instagram as ig-42.");
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
