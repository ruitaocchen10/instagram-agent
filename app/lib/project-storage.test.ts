import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: { load: vi.fn() },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import { INITIAL_CHAT } from "./mock";
import {
  createProject,
  deleteProject,
  loadProjectWorkspace,
  renameProject,
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

describe("project storage", () => {
  it("creates a named project with its own workspace and active conversation", async () => {
    const created = await createProject(" Summer launch ", INITIAL_CHAT);

    expect(created.project).toMatchObject({
      id: expect.any(String),
      name: "Summer launch",
      instructions: "",
      workspacePath: expect.stringMatching(/\/projects\/project-/),
    });
    expect(created.conversation).toMatchObject({
      id: expect.any(String),
      title: "Content copilot",
    });
    expect(created.messages[0].text).toBe(INITIAL_CHAT[0].text);
    expect(invokeCommand).toHaveBeenCalledWith("create_project_workspace", {
      projectId: created.project.id,
      instructions: "",
    });
  });

  it("restores the selected project and only that project's selected conversation", async () => {
    select
      .mockResolvedValueOnce([
        {
          id: "campaign-a",
          name: "Campaign A",
          instructions: "Voice A",
          workspace_path: "/app-data/projects/campaign-a",
          created_at: 10,
          updated_at: 20,
        },
        {
          id: "campaign-b",
          name: "Campaign B",
          instructions: "Voice B",
          workspace_path: "/app-data/projects/campaign-b",
          created_at: 30,
          updated_at: 40,
        },
      ])
      .mockResolvedValueOnce([{ value: "campaign-b" }])
      .mockResolvedValueOnce([
        {
          id: "b-ideas",
          title: "Ideas",
          created_at: 50,
          updated_at: 60,
        },
      ])
      .mockResolvedValueOnce([{ active_conversation_id: "b-ideas" }])
      .mockResolvedValueOnce([
        { id: "b-message", role: "user", text: "Only campaign B", ideas_json: null },
      ]);

    const workspace = await loadProjectWorkspace(INITIAL_CHAT);

    expect(workspace.activeProjectId).toBe("campaign-b");
    expect(workspace.activeConversationId).toBe("b-ideas");
    expect(workspace.messages).toEqual([
      { id: "b-message", role: "user", text: "Only campaign B" },
    ]);
    expect(workspace.projects.map((project) => project.id)).toEqual([
      "campaign-a",
      "campaign-b",
    ]);
    expect(
      execute.mock.calls.some(([sql]) => String(sql).includes("INSERT OR IGNORE INTO projects")),
    ).toBe(false);
  });

  it("switches projects without carrying over another project's conversation", async () => {
    select
      .mockResolvedValueOnce([
        {
          id: "campaign-b",
          name: "Campaign B",
          instructions: "Voice B",
          workspace_path: "/app-data/projects/campaign-b",
          created_at: 30,
          updated_at: 40,
        },
      ])
      .mockResolvedValueOnce([
        { id: "b-plan", title: "Plan", created_at: 50, updated_at: 60 },
      ])
      .mockResolvedValueOnce([{ active_conversation_id: "b-plan" }])
      .mockResolvedValueOnce([
        { id: "b-message", role: "ai", text: "Campaign B reply", ideas_json: null },
      ]);

    const selected = await selectProject("campaign-b", INITIAL_CHAT);

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
      .mockResolvedValueOnce([{ count: 2 }])
      .mockResolvedValueOnce([
        {
          id: "campaign-a",
          name: "Campaign A",
          instructions: "Voice A",
          workspace_path: "/app-data/projects/campaign-a",
          created_at: 10,
          updated_at: 20,
        },
      ])
      .mockResolvedValueOnce([
        { id: "a-plan", title: "Plan", created_at: 30, updated_at: 40 },
      ])
      .mockResolvedValueOnce([{ active_conversation_id: "a-plan" }])
      .mockResolvedValueOnce([
        { id: "a-message", role: "ai", text: "Campaign A remains", ideas_json: null },
      ]);
    invokeCommand.mockRejectedValueOnce(new Error("workspace is locked"));

    const workspace = await deleteProject("campaign-b", INITIAL_CHAT);

    expect(workspace.activeProjectId).toBe("campaign-a");
    expect(workspace.activeConversationId).toBe("a-plan");
    expect(workspace.messages[0].text).toBe("Campaign A remains");
    expect(invokeCommand).toHaveBeenCalledWith("remove_project_workspace", {
      projectId: "campaign-b",
    });
  });

  it("rolls back the replacement when deleting the sole project fails", async () => {
    select.mockResolvedValueOnce([{ count: 1 }]);
    execute.mockImplementation((sql) =>
      Promise.resolve({
        rowsAffected: String(sql).includes("DELETE FROM projects") ? 0 : 1,
        lastInsertId: 0,
      }),
    );

    await expect(deleteProject("only-project", INITIAL_CHAT)).rejects.toThrow(
      "Project no longer exists",
    );

    expect(execute.mock.calls.some(([sql]) => String(sql).includes("BEGIN IMMEDIATE"))).toBe(true);
    expect(execute.mock.calls.some(([sql]) => String(sql).includes("ROLLBACK"))).toBe(true);
    expect(execute.mock.calls.some(([sql]) => String(sql).includes("COMMIT"))).toBe(false);
  });
});
