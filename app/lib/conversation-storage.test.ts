import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: { load: vi.fn() },
}));

import Database from "@tauri-apps/plugin-sql";
import { INITIAL_CHAT } from "./mock";
import {
  loadDefaultConversation,
  saveConversationMessage,
} from "./conversation-storage";

const loadDatabase = Database.load as unknown as Mock;
const select = vi.fn();
const execute = vi.fn();

beforeEach(() => {
  loadDatabase.mockReset();
  select.mockReset();
  execute.mockReset();
  loadDatabase.mockResolvedValue({ select, execute });
  execute.mockResolvedValue({ rowsAffected: 1, lastInsertId: 0 });
});

describe("default conversation persistence", () => {
  it("creates the durable defaults and seeds the greeting on first run", async () => {
    select.mockResolvedValueOnce([]);

    const messages = await loadDefaultConversation(INITIAL_CHAT);

    expect(messages).toEqual(INITIAL_CHAT);
    expect(execute.mock.calls[0][0]).toContain("INSERT OR IGNORE INTO projects");
    expect(execute.mock.calls[1][0]).toContain("INSERT OR IGNORE INTO conversations");
    expect(execute.mock.calls[2][0]).toContain("INSERT OR IGNORE INTO messages");
    expect(execute.mock.calls[2][1]).toEqual([
      INITIAL_CHAT[0].id,
      "default-conversation",
      "ai",
      INITIAL_CHAT[0].text,
      null,
      expect.any(Number),
    ]);
  });

  it("restores stored turns in their durable sequence without reseeding", async () => {
    select.mockResolvedValueOnce([
      {
        id: "m1",
        role: "ai",
        text: "Earlier answer",
        ideas_json: null,
      },
      {
        id: "m2",
        role: "user",
        text: "Later question",
        ideas_json: null,
      },
    ]);

    const messages = await loadDefaultConversation(INITIAL_CHAT);

    expect(messages).toEqual([
      { id: "m1", role: "ai", text: "Earlier answer" },
      { id: "m2", role: "user", text: "Later question" },
    ]);
    expect(select).toHaveBeenCalledWith(expect.stringContaining("ORDER BY sequence ASC"), [
      "default-conversation",
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("stores idea metadata with an appended message", async () => {
    const message = {
      id: "assistant-2",
      role: "ai" as const,
      text: "Pick one",
      ideas: [
        {
          id: "idea-1",
          title: "Trail tips",
          caption: "Three trail tips",
          imageUrl: "https://example.com/trail.jpg",
        },
      ],
    };

    await saveConversationMessage(message);

    const messageInsert = execute.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT OR IGNORE INTO messages"),
    );
    expect(messageInsert?.[1]).toEqual([
      "assistant-2",
      "default-conversation",
      "ai",
      "Pick one",
      JSON.stringify(message.ideas),
      expect.any(Number),
    ]);
  });
});
