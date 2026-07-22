import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: { load: vi.fn() },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import {
  createProject,
  deleteProject,
  importProjectReference,
  listProjectReferences,
  loadProjectWorkspace,
  renameProject,
  removeProjectReference,
  selectProject,
  updateProjectInstructions,
} from "./project-storage";

const loadDatabase = Database.load as unknown as Mock;
const invokeCommand = invoke as unknown as Mock;
const select = vi.fn();
const execute = vi.fn();

beforeEach(() => {
  loadDatabase.mockReset();
  invokeCommand.mockReset();
  select.mockReset();
  execute.mockReset();
  loadDatabase.mockResolvedValue({ select, execute });
  execute.mockResolvedValue({ rowsAffected: 1, lastInsertId: 0 });
  invokeCommand.mockImplementation((command, args) => {
    if (command === "create_project_workspace") {
      return Promise.resolve(`/app-data/projects/${args.projectId}`);
    }
    return Promise.resolve();
  });
});

// Project rows now carry the two derived grid columns; default them so each
// test only spells out the fields it cares about.
function projectRow(overrides: Record<string, unknown>) {
  return {
    instructions: "",
    workspace_path: `/app-data/projects/${overrides.id}`,
    created_at: 10,
    updated_at: 20,
    chat_count: 0,
    last_conversation_at: null,
    ...overrides,
  };
}

describe("project storage", () => {
  it("creates a named project with its own workspace and no starter chat", async () => {
    const created = await createProject(" Summer launch ");

    expect(created.project).toMatchObject({
      id: expect.any(String),
      name: "Summer launch",
      instructions: "",
      workspacePath: expect.stringMatching(/\/projects\/project-/),
      chatCount: 0,
    });
    expect(invokeCommand).toHaveBeenCalledWith("create_project_workspace", {
      projectId: created.project.id,
      instructions: "",
    });
    // Projects open empty; no conversation row is seeded on creation.
    expect(
      execute.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO conversations")),
    ).toBe(false);
  });

  it("returns an empty workspace when no projects exist yet", async () => {
    select.mockResolvedValueOnce([]);

    const workspace = await loadProjectWorkspace();

    expect(workspace).toEqual({
      projects: [],
      activeProjectId: null,
      conversations: [],
      activeConversationId: null,
      messages: [],
    });
    // A fresh install seeds nothing — the grid's empty state takes over.
    expect(
      execute.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO projects")),
    ).toBe(false);
  });

  it("restores the selected project ordered by recent activity", async () => {
    select
      .mockResolvedValueOnce([
        projectRow({ id: "campaign-a", name: "Campaign A", updated_at: 20, chat_count: 1 }),
        projectRow({
          id: "campaign-b",
          name: "Campaign B",
          updated_at: 30,
          last_conversation_at: 90,
          chat_count: 2,
        }),
      ])
      .mockResolvedValueOnce([{ value: "campaign-b" }])
      .mockResolvedValueOnce([
        { id: "b-ideas", title: "Ideas", created_at: 50, updated_at: 60 },
      ])
      .mockResolvedValueOnce([{ active_conversation_id: "b-ideas" }])
      .mockResolvedValueOnce([
        { id: "b-message", role: "user", text: "Only campaign B", ideas_json: null },
      ]);

    const workspace = await loadProjectWorkspace();

    expect(workspace.activeProjectId).toBe("campaign-b");
    expect(workspace.activeConversationId).toBe("b-ideas");
    expect(workspace.messages).toEqual([
      { id: "b-message", role: "user", text: "Only campaign B" },
    ]);
    // campaign-b's newest chat (90) outranks campaign-a's edit (20).
    expect(workspace.projects.map((project) => project.id)).toEqual([
      "campaign-b",
      "campaign-a",
    ]);
    expect(workspace.projects[0].chatCount).toBe(2);
    expect(workspace.projects[0].lastActivityAt).toBe(90);
  });

  it("switches projects without carrying over another project's conversation", async () => {
    select
      .mockResolvedValueOnce([
        projectRow({ id: "campaign-b", name: "Campaign B", chat_count: 1 }),
      ])
      .mockResolvedValueOnce([
        { id: "b-plan", title: "Plan", created_at: 50, updated_at: 60 },
      ])
      .mockResolvedValueOnce([{ active_conversation_id: "b-plan" }])
      .mockResolvedValueOnce([
        { id: "b-message", role: "ai", text: "Campaign B reply", ideas_json: null },
      ]);

    const selected = await selectProject("campaign-b");

    expect(selected.project.id).toBe("campaign-b");
    expect(selected.activeConversationId).toBe("b-plan");
    expect(selected.messages).toEqual([
      { id: "b-message", role: "ai", text: "Campaign B reply" },
    ]);
  });

  it("writes edited instructions to CLAUDE.md and returns the saved project state", async () => {
    select.mockResolvedValueOnce([{ instructions: "Old voice" }]);

    const updated = await updateProjectInstructions(
      "campaign-b",
      "Use short sentences and a warm voice.",
    );

    expect(updated).toEqual({
      instructions: "Use short sentences and a warm voice.",
      updatedAt: expect.any(Number),
    });
    expect(invokeCommand).toHaveBeenCalledWith("write_project_instructions", {
      projectId: "campaign-b",
      instructions: "Use short sentences and a warm voice.",
    });
  });

  it("imports and lists references within the selected project workspace", async () => {
    invokeCommand
      .mockResolvedValueOnce({ name: "brand-notes.txt", size: 3 })
      .mockResolvedValueOnce([{ name: "brand-notes.txt", size: 3 }]);

    const imported = await importProjectReference(
      "campaign-b",
      "brand-notes.txt",
      new Uint8Array([65, 66, 67]),
    );
    const references = await listProjectReferences("campaign-b");

    expect(imported).toEqual({ name: "brand-notes.txt", size: 3 });
    expect(references).toEqual([{ name: "brand-notes.txt", size: 3 }]);
    expect(invokeCommand).toHaveBeenNthCalledWith(1, "import_project_reference", {
      projectId: "campaign-b",
      fileName: "brand-notes.txt",
      contents: [65, 66, 67],
    });
    expect(invokeCommand).toHaveBeenNthCalledWith(2, "list_project_references", {
      projectId: "campaign-b",
    });
  });

  it("removes a reference from only the named project", async () => {
    await removeProjectReference("campaign-b", "brand-notes.txt");

    expect(invokeCommand).toHaveBeenCalledWith("remove_project_reference", {
      projectId: "campaign-b",
      fileName: "brand-notes.txt",
    });
  });

  it("renames a project durably", async () => {
    const renamed = await renameProject("campaign-b", " Autumn launch ");

    expect(renamed).toEqual({ name: "Autumn launch", updatedAt: expect.any(Number) });
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("UPDATE projects"), [
      "Autumn launch",
      expect.any(Number),
      "campaign-b",
    ]);
  });

  it("deletes a project workspace and selects a valid remaining project", async () => {
    select
      .mockResolvedValueOnce([
        projectRow({ id: "campaign-a", name: "Campaign A", chat_count: 1 }),
      ])
      .mockResolvedValueOnce([
        { id: "a-plan", title: "Plan", created_at: 30, updated_at: 40 },
      ])
      .mockResolvedValueOnce([{ active_conversation_id: "a-plan" }])
      .mockResolvedValueOnce([
        { id: "a-message", role: "ai", text: "Campaign A remains", ideas_json: null },
      ]);
    invokeCommand.mockRejectedValueOnce(new Error("workspace is locked"));

    const workspace = await deleteProject("campaign-b");

    expect(workspace.activeProjectId).toBe("campaign-a");
    expect(workspace.activeConversationId).toBe("a-plan");
    expect(workspace.messages[0].text).toBe("Campaign A remains");
    expect(invokeCommand).toHaveBeenCalledWith("remove_project_workspace", {
      projectId: "campaign-b",
    });
  });

  it("deletes the final project into an empty grid", async () => {
    select.mockResolvedValueOnce([]);

    const workspace = await deleteProject("only-project");

    expect(workspace).toEqual({
      projects: [],
      activeProjectId: null,
      conversations: [],
      activeConversationId: null,
      messages: [],
    });
    // The remembered active project is cleared instead of a stub being recreated.
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM app_state WHERE key = 'active_project_id'"),
    );
    expect(invokeCommand).toHaveBeenCalledWith("remove_project_workspace", {
      projectId: "only-project",
    });
  });

  it("rolls back when the delete removes nothing", async () => {
    execute.mockImplementation((sql) =>
      Promise.resolve({
        rowsAffected: String(sql).includes("DELETE FROM projects") ? 0 : 1,
        lastInsertId: 0,
      }),
    );

    await expect(deleteProject("ghost-project")).rejects.toThrow(
      "Project no longer exists",
    );

    expect(execute.mock.calls.some(([sql]) => String(sql).includes("BEGIN IMMEDIATE"))).toBe(true);
    expect(execute.mock.calls.some(([sql]) => String(sql).includes("ROLLBACK"))).toBe(true);
    expect(execute.mock.calls.some(([sql]) => String(sql).includes("COMMIT"))).toBe(false);
  });
});
