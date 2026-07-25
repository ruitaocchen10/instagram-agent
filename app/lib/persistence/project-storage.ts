import { invoke } from "@tauri-apps/api/core";
import { appDatabase as database, inTransaction } from "./app-database";
import {
  loadConversationWorkspace,
  type ConversationSummary,
} from "./conversation-storage";
import type { ChatMessage } from "../shared/types";

// Selects each project plus the two derived fields the grid needs: how many
// chats it holds and when it was last touched (project edit or newest chat).
const PROJECT_SELECT = `
  SELECT p.id, p.name, p.instructions, p.workspace_path, p.created_at, p.updated_at,
         (SELECT COUNT(*) FROM conversations c WHERE c.project_id = p.id) AS chat_count,
         (SELECT MAX(c.updated_at) FROM conversations c WHERE c.project_id = p.id)
           AS last_conversation_at
    FROM projects p`;

export interface ProjectSummary {
  id: string;
  name: string;
  instructions: string;
  workspacePath: string;
  createdAt: number;
  updatedAt: number;
  chatCount: number;
  // Most recent of the project's own edits and its newest chat. Drives grid
  // ordering and the "last active" label on each card.
  lastActivityAt: number;
}

export interface ProjectReference {
  name: string;
  size: number;
}

export interface CreatedProject {
  project: ProjectSummary;
}

export interface SelectedProject {
  project: ProjectSummary;
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  messages: ChatMessage[];
}

// A fresh install has no projects at all, so every field is empty/null until
// the user creates their first project.
export interface ProjectWorkspace {
  projects: ProjectSummary[];
  activeProjectId: string | null;
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  messages: ChatMessage[];
}

interface ProjectRow {
  id: string;
  name: string;
  instructions: string;
  workspace_path: string;
  created_at: number;
  updated_at: number;
  chat_count: number;
  last_conversation_at: number | null;
}

function rowToProject(row: ProjectRow): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    instructions: row.instructions,
    workspacePath: row.workspace_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    chatCount: row.chat_count ?? 0,
    lastActivityAt: Math.max(row.updated_at, row.last_conversation_at ?? 0),
  };
}

// Grid order: most recently active first, newest as the tiebreaker.
function byRecentActivity(a: ProjectSummary, b: ProjectSummary): number {
  return b.lastActivityAt - a.lastActivityAt || b.createdAt - a.createdAt;
}

async function ensureProjectWorkspace(project: ProjectSummary): Promise<ProjectSummary> {
  if (project.workspacePath) return project;
  const workspacePath = await invoke<string>("create_project_workspace", {
    projectId: project.id,
    instructions: project.instructions,
  });
  await (await database()).execute(
    `UPDATE projects SET workspace_path = $1 WHERE id = $2`,
    [workspacePath, project.id],
  );
  return { ...project, workspacePath };
}

async function materializeProjects(rows: ProjectRow[]): Promise<ProjectSummary[]> {
  const projects: ProjectSummary[] = [];
  for (const row of rows) projects.push(await ensureProjectWorkspace(rowToProject(row)));
  return projects.sort(byRecentActivity);
}

async function rememberActiveProject(projectId: string): Promise<void> {
  await (await database()).execute(
    `INSERT INTO app_state (key, value)
     VALUES ('active_project_id', $1)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [projectId],
  );
}

async function cleanUpProjectWorkspace(projectId: string): Promise<void> {
  try {
    await invoke("remove_project_workspace", { projectId });
  } catch {
    // The database is the source of truth. A failed best-effort cleanup must
    // not make a durably deleted project remain in the UI until restart.
  }
}

async function prepareProject(name: string): Promise<ProjectSummary> {
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error("Project name is required.");

  const id = `project-${crypto.randomUUID()}`;
  const instructions = "";
  const workspacePath = await invoke<string>("create_project_workspace", {
    projectId: id,
    instructions,
  });
  const now = Date.now();
  return {
    id,
    name: normalizedName,
    instructions,
    workspacePath,
    createdAt: now,
    updatedAt: now,
    chatCount: 0,
    lastActivityAt: now,
  };
}

async function insertPreparedProject(project: ProjectSummary): Promise<CreatedProject> {
  await (await database()).execute(
    `INSERT INTO projects
       (id, name, instructions, workspace_path, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      project.id,
      project.name,
      project.instructions,
      project.workspacePath,
      project.createdAt,
      project.updatedAt,
    ],
  );
  // New projects start with zero chats — the composer-first project page opens
  // the first one when the user sends a message.
  await rememberActiveProject(project.id);
  return { project };
}

const EMPTY_WORKSPACE: Omit<ProjectWorkspace, "projects"> = {
  activeProjectId: null,
  conversations: [],
  activeConversationId: null,
  messages: [],
};

export async function loadProjectWorkspace(): Promise<ProjectWorkspace> {
  const connection = await database();
  const rows = await connection.select<ProjectRow[]>(`${PROJECT_SELECT}`);
  if (rows.length === 0) return { projects: [], ...EMPTY_WORKSPACE };

  const projects = await materializeProjects(rows);

  const activeRows = await connection.select<{ value: string }[]>(
    `SELECT value FROM app_state WHERE key = 'active_project_id'`,
  );
  const storedActiveId = activeRows[0]?.value;
  const activeProject =
    projects.find((project) => project.id === storedActiveId) ?? projects[0];
  if (storedActiveId !== activeProject.id) await rememberActiveProject(activeProject.id);

  const conversationWorkspace = await loadConversationWorkspace(activeProject.id);
  return {
    projects,
    activeProjectId: activeProject.id,
    ...conversationWorkspace,
  };
}

export async function selectProject(projectId: string): Promise<SelectedProject> {
  const rows = await (await database()).select<ProjectRow[]>(
    `${PROJECT_SELECT} WHERE p.id = $1`,
    [projectId],
  );
  if (!rows[0]) throw new Error("Project no longer exists.");
  const project = await ensureProjectWorkspace(rowToProject(rows[0]));
  await rememberActiveProject(project.id);
  const conversationWorkspace = await loadConversationWorkspace(project.id);
  return { project, ...conversationWorkspace };
}

export async function updateProjectInstructions(
  projectId: string,
  instructions: string,
): Promise<Pick<ProjectSummary, "instructions" | "updatedAt">> {
  const connection = await database();
  const rows = await connection.select<{ instructions: string }[]>(
    `SELECT instructions FROM projects WHERE id = $1`,
    [projectId],
  );
  if (!rows[0]) throw new Error("Project no longer exists.");

  await invoke("write_project_instructions", { projectId, instructions });
  const updatedAt = Date.now();
  try {
    const result = await connection.execute(
      `UPDATE projects
          SET instructions = $1, updated_at = $2
        WHERE id = $3`,
      [instructions, updatedAt, projectId],
    );
    if (result.rowsAffected === 0) throw new Error("Project no longer exists.");
    return { instructions, updatedAt };
  } catch (error) {
    try {
      await invoke("write_project_instructions", {
        projectId,
        instructions: rows[0].instructions,
      });
    } catch {
      // Preserve the database error; the next successful edit repairs the file.
    }
    throw error;
  }
}

export async function listProjectReferences(
  projectId: string,
): Promise<ProjectReference[]> {
  return invoke<ProjectReference[]>("list_project_references", { projectId });
}

export async function importProjectReference(
  projectId: string,
  fileName: string,
  contents: Uint8Array,
): Promise<ProjectReference> {
  return invoke<ProjectReference>("import_project_reference", {
    projectId,
    fileName,
    contents: Array.from(contents),
  });
}

export async function removeProjectReference(
  projectId: string,
  fileName: string,
): Promise<void> {
  await invoke("remove_project_reference", { projectId, fileName });
}

export async function renameProject(
  projectId: string,
  name: string,
): Promise<Pick<ProjectSummary, "name" | "updatedAt">> {
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error("Project name is required.");
  const updatedAt = Date.now();
  const result = await (await database()).execute(
    `UPDATE projects SET name = $1, updated_at = $2 WHERE id = $3`,
    [normalizedName, updatedAt, projectId],
  );
  if (result.rowsAffected === 0) throw new Error("Project no longer exists.");
  return { name: normalizedName, updatedAt };
}

export async function deleteProject(projectId: string): Promise<ProjectWorkspace> {
  const connection = await database();
  const workspace = await inTransaction(async () => {
    const result = await connection.execute(`DELETE FROM projects WHERE id = $1`, [projectId]);
    if (result.rowsAffected === 0) throw new Error("Project no longer exists.");
    const rows = await connection.select<ProjectRow[]>(`${PROJECT_SELECT}`);
    if (rows.length === 0) {
      // The grid is allowed to be empty; a fresh "create your first project"
      // state takes over rather than resurrecting a placeholder project.
      await connection.execute(`DELETE FROM app_state WHERE key = 'active_project_id'`);
      return { projects: [], ...EMPTY_WORKSPACE };
    }
    const projects = await materializeProjects(rows);
    const activeProject = projects[0];
    await rememberActiveProject(activeProject.id);
    const conversationWorkspace = await loadConversationWorkspace(activeProject.id);
    return {
      projects,
      activeProjectId: activeProject.id,
      ...conversationWorkspace,
    };
  });
  await cleanUpProjectWorkspace(projectId);
  return workspace;
}

export async function createProject(name: string): Promise<CreatedProject> {
  const project = await prepareProject(name);
  try {
    return await inTransaction(() => insertPreparedProject(project));
  } catch (error) {
    await cleanUpProjectWorkspace(project.id);
    throw error;
  }
}
