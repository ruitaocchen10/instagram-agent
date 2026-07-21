import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { generate } from "./llm";

const mockInvoke = invoke as unknown as Mock;

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue("answer");
});

describe("generate", () => {
  it("includes restored earlier turns in order before the follow-up", async () => {
    await generate("What comes next?", {
      system: "Be practical.",
      model: "sonnet",
      history: [
        { role: "user", text: "Plan a launch week." },
        { role: "ai", text: "Start with a teaser." },
      ],
    });

    expect(mockInvoke).toHaveBeenCalledWith("claude_chat", {
      model: "sonnet",
      prompt:
        "Be practical.\n\nConversation so far:\nUser: Plan a launch week.\nAssistant: Start with a teaser.\n\nUser: What comes next?",
    });
  });

  it("runs a fresh request from the active project workspace", async () => {
    await generate("Draft the first post.", {
      model: "sonnet",
      workspacePath: "/app-data/projects/summer-launch",
    });

    expect(mockInvoke).toHaveBeenCalledWith("claude_chat", {
      model: "sonnet",
      prompt: "Draft the first post.",
      workspacePath: "/app-data/projects/summer-launch",
    });
  });
});
