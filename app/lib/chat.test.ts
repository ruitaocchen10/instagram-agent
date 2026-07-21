import { describe, expect, it, vi } from "vitest";
import { continueConversation, createConversationOutbox } from "./chat";

const history = [
  { id: "m1", role: "ai" as const, text: "What should we make?" },
  { id: "m2", role: "user" as const, text: "A trail-running series." },
];

describe("continueConversation", () => {
  it("publishes and persists both new turns while answering with earlier context", async () => {
    const published: string[] = [];
    const persist = vi.fn().mockResolvedValue(undefined);
    const generateReply = vi.fn().mockResolvedValue("Start with a beginner checklist.");

    const result = await continueConversation({
      text: "What should post one cover?",
      history,
      model: "sonnet",
      now: () => 100,
      publish: (message) => published.push(`${message.role}:${message.text}`),
      persist,
      generateReply,
    });

    expect(generateReply).toHaveBeenCalledWith("What should post one cover?", {
      model: "sonnet",
      history,
    });
    expect(published).toEqual([
      "user:What should post one cover?",
      "ai:Start with a beginner checklist.",
    ]);
    expect(persist.mock.calls.map(([message]) => message.id)).toEqual(["u100", "a100"]);
    expect(result.persistenceErrors).toEqual([]);
  });

  it("keeps answering and reports a persistence failure instead of discarding the message", async () => {
    const published: string[] = [];
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error("database locked"))
      .mockResolvedValueOnce(undefined);

    const result = await continueConversation({
      text: "Keep going",
      history,
      model: "sonnet",
      now: () => 200,
      publish: (message) => published.push(message.text),
      persist,
      generateReply: vi.fn().mockResolvedValue("Here is the next step."),
    });

    expect(published).toEqual(["Keep going", "Here is the next step."]);
    expect(result.persistenceErrors).toEqual(["database locked"]);
  });

  it("turns generation errors into a visible, persisted assistant message", async () => {
    const published: string[] = [];
    const persist = vi.fn().mockResolvedValue(undefined);

    await continueConversation({
      text: "Hello",
      history,
      model: "sonnet",
      now: () => 300,
      publish: (message) => published.push(message.text),
      persist,
      generateReply: vi.fn().mockRejectedValue(new Error("Claude unavailable")),
    });

    expect(published[1]).toContain("Claude unavailable");
    expect(persist.mock.calls[1][0].text).toContain("Claude unavailable");
  });
});

describe("conversation outbox", () => {
  it("retries failed messages in order before saving a later message", async () => {
    const saved: string[] = [];
    let unavailable = true;
    const outbox = createConversationOutbox(async (message) => {
      if (unavailable) throw new Error("database locked");
      saved.push(message.id);
    });

    await expect(
      outbox.persist({ id: "user-1", role: "user", text: "First" }),
    ).rejects.toThrow("database locked");
    expect(outbox.hasPending()).toBe(true);

    unavailable = false;
    await outbox.persist({ id: "assistant-1", role: "ai", text: "Second" });

    expect(saved).toEqual(["user-1", "assistant-1"]);
    expect(outbox.hasPending()).toBe(false);
  });
});
