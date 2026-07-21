import { invoke } from "@tauri-apps/api/core";
import type { ChatMessage } from "./types";
import { appDatabase as database, inTransaction } from "./app-database";
import {
  createConversation,
  loadConversationWorkspace,
  type ConversationSummary,
} from "./conversation-storage";

const DEFAULT_PROJECT_ID = "default-project";
const PROJECT_COLUMNS =
  "id, name, instructions, workspace_path, created_at, updated_at";

export interface ProjectSummary {
  id: string;
  name: string;
  instructions: string;
  workspacePath: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectReference {
  name: string;
  size: number;
}

export interface CreatedProject {
  project: ProjectSummary;
  conversation: ConversationSummary;
  messages: ChatMessage[];
}

export interface SelectedProject {
  project: ProjectSummary;
  conversations: ConversationSummary[];
  activeConversationId: string;
  messages: ChatMessage[];
}

export interface ProjectWorkspace {
  projects: ProjectSummary[];
  activeProjectId: string;
  conversations: ConversationSummary[];
  activeConversationId: string;
  messages: ChatMessage[];
}

interface ProjectRow {
  id: string;
  name: string;
  instructions: string;
  workspace_path: string;
  created_at: number;
  updated_at: number;
}

function rowToProject(row: ProjectRow): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    instructions: row.instructions,
    workspacePath: row.workspace_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
  return projects;
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
  };
}

async function insertPreparedProject(
  project: ProjectSummary,
  firstRunMessages: ChatMessage[],
): Promise<CreatedProject> {
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
  const created = await createConversation(
    project.id,
    "Content copilot",
    firstRunMessages,
  );
  await rememberActiveProject(project.id);
  return { project, ...created };
}

export async function loadProjectWorkspace(
  firstRunMessages: ChatMessage[],
): Promise<ProjectWorkspace> {
  const connection = await database();
  const now = Date.now();
  let rows = await connection.select<ProjectRow[]>(
    `SELECT ${PROJECT_COLUMNS} FROM projects
      ORDER BY created_at ASC`,
  );
  if (rows.length === 0) {
    await connection.execute(
      `INSERT INTO projects
         (id, name, instructions, workspace_path, created_at, updated_at)
       VALUES ($1, $2, '', '', $3, $3)`,
      [DEFAULT_PROJECT_ID, "My Instagram", now],
    );
    rows = [
      {
        id: DEFAULT_PROJECT_ID,
        name: "My Instagram",
        instructions: "",
        workspace_path: "",
        created_at: now,
        updated_at: now,
      },
    ];
  }
  const projects = await materializeProjects(rows);
  if (projects.length === 0) throw new Error("Couldn't create the default project.");

  const activeRows = await connection.select<{ value: string }[]>(
    `SELECT value FROM app_state WHERE key = 'active_project_id'`,
  );
  const storedActiveId = activeRows[0]?.value;
  const activeProject =
    projects.find((project) => project.id === storedActiveId) ?? projects[0];
  if (storedActiveId !== activeProject.id) await rememberActiveProject(activeProject.id);

  const conversationWorkspace = await loadConversationWorkspace(
    activeProject.id,
    firstRunMessages,
  );
  return {
    projects,
    activeProjectId: activeProject.id,
    ...conversationWorkspace,
  };
}

export async function selectProject(
  projectId: string,
  firstRunMessages: ChatMessage[],
): Promise<SelectedProject> {
  const rows = await (await database()).select<ProjectRow[]>(
    `SELECT ${PROJECT_COLUMNS} FROM projects
      WHERE id = $1`,
    [projectId],
  );
  if (!rows[0]) throw new Error("Project no longer exists.");
  const project = await ensureProjectWorkspace(rowToProject(rows[0]));
  await rememberActiveProject(project.id);
  const conversationWorkspace = await loadConversationWorkspace(
    project.id,
    firstRunMessages,
  );
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

export async function deleteProject(
  projectId: string,
  firstRunMessages: ChatMessage[],
): Promise<ProjectWorkspace> {
  const connection = await database();
  const countRows = await connection.select<{ count: number }[]>(
    `SELECT COUNT(*) AS count FROM projects`,
  );

  if ((countRows[0]?.count ?? 0) <= 1) {
    const replacementProject = await prepareProject("My Instagram");
    try {
      const replacement = await inTransaction(async () => {
        const created = await insertPreparedProject(replacementProject, firstRunMessages);
        const result = await connection.execute(`DELETE FROM projects WHERE id = $1`, [projectId]);
        if (result.rowsAffected === 0) throw new Error("Project no longer exists.");
        return created;
      });
      await cleanUpProjectWorkspace(projectId);
      return {
        projects: [replacement.project],
        activeProjectId: replacement.project.id,
        conversations: [replacement.conversation],
        activeConversationId: replacement.conversation.id,
        messages: replacement.messages,
      };
    } catch (error) {
      await cleanUpProjectWorkspace(replacementProject.id);
      throw error;
    }
  }

  const workspace = await inTransaction(async () => {
    const result = await connection.execute(`DELETE FROM projects WHERE id = $1`, [projectId]);
    if (result.rowsAffected === 0) throw new Error("Project no longer exists.");
    const rows = await connection.select<ProjectRow[]>(
      `SELECT ${PROJECT_COLUMNS} FROM projects
        ORDER BY created_at ASC`,
    );
    const projects = await materializeProjects(rows);
    if (projects.length === 0) throw new Error("No project remains after deletion.");
    const activeProject = projects[0];
    await rememberActiveProject(activeProject.id);
    const conversationWorkspace = await loadConversationWorkspace(
      activeProject.id,
      firstRunMessages,
    );
    return {
      projects,
      activeProjectId: activeProject.id,
      ...conversationWorkspace,
    };
  });
  await cleanUpProjectWorkspace(projectId);
  return workspace;
}

export async function createProject(
  name: string,
  firstRunMessages: ChatMessage[],
): Promise<CreatedProject> {
  const project = await prepareProject(name);
  try {
    return await inTransaction(() =>
      insertPreparedProject(project, firstRunMessages),
    );
  } catch (error) {
    await cleanUpProjectWorkspace(project.id);
    throw error;
  }
}
