import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: { load: vi.fn() },
}));

import Database from "@tauri-apps/plugin-sql";
import { INITIAL_CHAT } from "./mock";
import {
  createConversation,
  deleteConversation,
  loadConversationWorkspace,
  renameConversation,
  selectConversation,
  saveConversationMessage,
  saveConversationSessionId,
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
  it("creates a named active conversation seeded for immediate chat", async () => {
    const created = await createConversation("default-project", "Launch planning", INITIAL_CHAT);

    expect(created.conversation).toMatchObject({
      id: expect.any(String),
      title: "Launch planning",
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    expect(created.messages).toEqual([
      { ...INITIAL_CHAT[0], id: `${created.conversation.id}-${INITIAL_CHAT[0].id}` },
    ]);
    expect(execute.mock.calls.some(([sql, params]) =>
      String(sql).includes("INSERT INTO conversations") && params[2] === "Launch planning",
    )).toBe(true);
    expect(execute.mock.calls.some(([sql, params]) =>
      String(sql).includes("active_conversation_id") && params[0] === created.conversation.id,
    )).toBe(true);
    expect(execute.mock.calls.some(([sql, params]) =>
      String(sql).includes("INSERT OR IGNORE INTO messages") &&
      params[1] === created.conversation.id,
    )).toBe(true);
  });

  it("restores the most recently active conversation with only its own messages", async () => {
    select
      .mockResolvedValueOnce([
        {
          id: "ideas",
          title: "Post ideas",
          created_at: 10,
          updated_at: 30,
        },
        {
          id: "captions",
          title: "Caption workshop",
          session_id: "sdk-session-1",
          created_at: 20,
          updated_at: 40,
        },
      ])
      .mockResolvedValueOnce([{ active_conversation_id: "captions" }])
      .mockResolvedValueOnce([
        { id: "c1", role: "user", text: "Caption only", ideas_json: null },
      ]);

    const workspace = await loadConversationWorkspace("default-project", INITIAL_CHAT);

    expect(workspace).toEqual({
      conversations: [
        { id: "ideas", title: "Post ideas", sessionId: null, createdAt: 10, updatedAt: 30 },
        {
          id: "captions",
          title: "Caption workshop",
          sessionId: "sdk-session-1",
          createdAt: 20,
          updatedAt: 40,
        },
      ],
      activeConversationId: "captions",
      messages: [{ id: "c1", role: "user", text: "Caption only" }],
    });
    expect(select.mock.calls[2]).toEqual([
      expect.stringContaining("WHERE conversation_id = $1"),
      ["captions"],
    ]);
  });

  it("creates the initial conversation when the workspace is empty", async () => {
    select.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const workspace = await loadConversationWorkspace("default-project", INITIAL_CHAT);

    expect(workspace.conversations).toEqual([
      {
        id: "default-conversation",
        title: "Content copilot",
        sessionId: null,
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      },
    ]);
    expect(workspace.activeConversationId).toBe("default-conversation");
    expect(workspace.messages).toEqual(INITIAL_CHAT);
    expect(execute.mock.calls[0][0]).toContain("INSERT INTO conversations");
    expect(execute.mock.calls[2][0]).toContain("INSERT OR IGNORE INTO messages");
  });

  it("switches to a conversation and returns only that thread's messages", async () => {
    select.mockResolvedValueOnce([
      { id: "idea-1", role: "ai", text: "Ideas thread", ideas_json: null },
    ]);

    const messages = await selectConversation("default-project", "ideas", INITIAL_CHAT);

    expect(messages).toEqual([{ id: "idea-1", role: "ai", text: "Ideas thread" }]);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("active_conversation_id"), [
      "ideas",
      "default-project",
    ]);
    expect(select).toHaveBeenCalledWith(expect.stringContaining("WHERE conversation_id = $1"), [
      "ideas",
    ]);
  });

  it("renames a conversation durably", async () => {
    const renamed = await renameConversation("default-project", "ideas", "  Evergreen ideas  ");

    expect(renamed).toEqual({ title: "Evergreen ideas", updatedAt: expect.any(Number) });
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("UPDATE conversations"), [
      "Evergreen ideas",
      expect.any(Number),
      "ideas",
      "default-project",
    ]);
  });

  it("deletes a conversation and selects a valid remaining thread", async () => {
    select
      .mockResolvedValueOnce([
        { id: "captions", title: "Captions", created_at: 20, updated_at: 40 },
      ])
      .mockResolvedValueOnce([
        { id: "caption-1", role: "ai", text: "Still here", ideas_json: null },
      ]);

    const workspace = await deleteConversation("default-project", "ideas", INITIAL_CHAT);

    expect(execute).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM conversations"), [
      "ideas",
      "default-project",
    ]);
    expect(workspace.activeConversationId).toBe("captions");
    expect(workspace.conversations).toEqual([
      { id: "captions", title: "Captions", sessionId: null, createdAt: 20, updatedAt: 40 },
    ]);
    expect(workspace.messages).toEqual([
      { id: "caption-1", role: "ai", text: "Still here" },
    ]);
  });

  it("creates and selects a fresh conversation after deleting the last one", async () => {
    select.mockResolvedValueOnce([]);

    const workspace = await deleteConversation("default-project", "only-thread", INITIAL_CHAT);

    expect(workspace.conversations).toHaveLength(1);
    expect(workspace.activeConversationId).toBe(workspace.conversations[0].id);
    expect(workspace.conversations[0].title).toBe("Content copilot");
    expect(workspace.messages[0].text).toBe(INITIAL_CHAT[0].text);
  });

  it("rolls back deletion when selecting a replacement fails", async () => {
    select.mockRejectedValueOnce(new Error("database locked"));

    await expect(
      deleteConversation("default-project", "ideas", INITIAL_CHAT),
    ).rejects.toThrow("database locked");

    expect(execute.mock.calls.some(([sql]) => String(sql).includes("BEGIN IMMEDIATE"))).toBe(true);
    expect(execute.mock.calls.some(([sql]) => String(sql).includes("ROLLBACK"))).toBe(true);
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

    await saveConversationMessage("default-project", "default-conversation", message);

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

  it("stores new messages in the selected conversation only", async () => {
    await saveConversationMessage("default-project", "ideas", {
      id: "idea-user-1",
      role: "user",
      text: "Keep this with ideas",
    });

    const messageInsert = execute.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT OR IGNORE INTO messages"),
    );
    expect(messageInsert?.[1]?.[1]).toBe("ideas");
  });

  it("stores the last Agent SDK session id as conversation metadata", async () => {
    await saveConversationSessionId("default-project", "ideas", "sdk-session-1");

    expect(execute).toHaveBeenCalledWith(expect.stringContaining("SET session_id = $1"), [
      "sdk-session-1",
      "ideas",
      "default-project",
    ]);
  });

  it("rejects a message before inserting when the conversation belongs to another project", async () => {
    execute.mockResolvedValueOnce({ rowsAffected: 0 });

    await expect(
      saveConversationMessage("campaign-b", "campaign-a-conversation", {
        id: "wrong-project",
        role: "user",
        text: "Keep projects isolated",
      }),
    ).rejects.toThrow("Conversation no longer exists");

    expect(
      execute.mock.calls.some(([sql]) => String(sql).includes("INSERT OR IGNORE INTO messages")),
    ).toBe(false);
  });

  it("rejects an ignored insert unless it is an idempotent retry", async () => {
    execute
      .mockResolvedValueOnce({ rowsAffected: 1 })
      .mockResolvedValueOnce({ rowsAffected: 0 });
    select.mockResolvedValueOnce([]);

    await expect(
      saveConversationMessage("default-project", "default-conversation", {
        id: "collision",
        role: "user",
        text: "Don't lose me",
      }),
    ).rejects.toThrow("SQLite ignored the insert");
  });

  it("accepts an ignored insert when the same message was already committed", async () => {
    execute
      .mockResolvedValueOnce({ rowsAffected: 1 })
      .mockResolvedValueOnce({ rowsAffected: 0 });
    select.mockResolvedValueOnce([
      {
        id: "retry",
        conversation_id: "default-conversation",
        role: "user",
        text: "Save this once",
        ideas_json: null,
      },
    ]);

    await expect(
      saveConversationMessage("default-project", "default-conversation", {
        id: "retry",
        role: "user",
        text: "Save this once",
      }),
    ).resolves.toBeUndefined();
  });
});
