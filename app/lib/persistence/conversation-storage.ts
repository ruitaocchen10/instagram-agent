import type { ChatMessage, PostIdea } from "../shared/types";
import { appDatabase as database, inTransaction } from "./app-database";

export interface ConversationSummary {
  id: string;
  title: string;
  sessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

// A project can hold zero chats. `activeConversationId` is null when the project
// has no chats yet (the composer-first project page starts one on demand).
export interface ConversationWorkspace {
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  messages: ChatMessage[];
}

interface MessageRow {
  id: string;
  role: ChatMessage["role"];
  text: string;
  ideas_json: string | null;
}

interface StoredMessageRow extends MessageRow {
  conversation_id: string;
}

interface ConversationRow {
  id: string;
  title: string;
  session_id?: string | null;
  created_at: number;
  updated_at: number;
  is_active?: number;
}

function rowToConversation(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    sessionId: row.session_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseIdeas(value: string | null): PostIdea[] | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as PostIdea[]) : undefined;
  } catch {
    // A malformed optional payload should not prevent the text conversation
    // from loading. The message remains useful without its idea cards.
    return undefined;
  }
}

function rowToMessage(row: MessageRow): ChatMessage {
  const ideas = parseIdeas(row.ideas_json);
  return {
    id: row.id,
    role: row.role,
    text: row.text,
    ...(ideas ? { ideas } : {}),
  };
}

const EMPTY_WORKSPACE: ConversationWorkspace = {
  conversations: [],
  activeConversationId: null,
  messages: [],
};

export async function loadConversationWorkspace(
  projectId: string,
): Promise<ConversationWorkspace> {
  const connection = await database();
  const rows = await connection.select<ConversationRow[]>(
    `SELECT id, title, session_id, created_at, updated_at
       FROM conversations
      WHERE project_id = $1
      ORDER BY updated_at DESC, created_at DESC`,
    [projectId],
  );
  if (rows.length === 0) return { ...EMPTY_WORKSPACE };

  const activeRows = await connection.select<{ active_conversation_id: string | null }[]>(
    `SELECT active_conversation_id
       FROM projects
      WHERE id = $1`,
    [projectId],
  );
  const storedActiveId = activeRows[0]?.active_conversation_id;
  const activeConversationId = rows.some((row) => row.id === storedActiveId)
    ? storedActiveId!
    : rows[0].id;
  if (storedActiveId !== activeConversationId) {
    await connection.execute(
      `UPDATE projects SET active_conversation_id = $1 WHERE id = $2`,
      [activeConversationId, projectId],
    );
  }
  return {
    conversations: rows.map(rowToConversation),
    activeConversationId,
    messages: await loadConversationMessages(activeConversationId),
  };
}

async function insertMessage(conversationId: string, message: ChatMessage): Promise<void> {
  const connection = await database();
  const result = await connection.execute(
    `INSERT OR IGNORE INTO messages
       (id, conversation_id, role, text, ideas_json, created_at, sequence)
     SELECT $1, $2, $3, $4, $5, $6,
            COALESCE(MAX(sequence), -1) + 1
       FROM messages
      WHERE conversation_id = $2`,
    [
      message.id,
      conversationId,
      message.role,
      message.text,
      message.ideas ? JSON.stringify(message.ideas) : null,
      Date.now(),
    ],
  );
  if (result.rowsAffected > 0) return;

  // INSERT OR IGNORE makes retries idempotent, but an ignored sequence/ID
  // collision must not masquerade as a successful durable write.
  const existing = await connection.select<StoredMessageRow[]>(
    `SELECT id, conversation_id, role, text, ideas_json
       FROM messages
      WHERE id = $1`,
    [message.id],
  );
  const stored = existing[0];
  const ideasJson = message.ideas ? JSON.stringify(message.ideas) : null;
  if (
    stored?.conversation_id === conversationId &&
    stored.role === message.role &&
    stored.text === message.text &&
    stored.ideas_json === ideasJson
  ) {
    return;
  }
  throw new Error(`Couldn't save message ${message.id}: SQLite ignored the insert.`);
}

async function loadConversationMessages(conversationId: string): Promise<ChatMessage[]> {
  const rows = await (await database()).select<MessageRow[]>(
    `SELECT id, role, text, ideas_json
       FROM messages
      WHERE conversation_id = $1
      ORDER BY sequence ASC`,
    [conversationId],
  );
  return rows.map(rowToMessage);
}

export async function selectConversation(
  projectId: string,
  conversationId: string,
): Promise<ChatMessage[]> {
  const connection = await database();
  const result = await connection.execute(
    `UPDATE projects
        SET active_conversation_id = $1
      WHERE id = $2
        AND EXISTS (
          SELECT 1 FROM conversations
           WHERE id = $1 AND project_id = $2
        )`,
    [conversationId, projectId],
  );
  if (result.rowsAffected === 0) throw new Error("Conversation no longer exists.");
  return loadConversationMessages(conversationId);
}

export async function renameConversation(
  projectId: string,
  conversationId: string,
  title: string,
): Promise<Pick<ConversationSummary, "title" | "updatedAt">> {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) throw new Error("Conversation name is required.");
  const updatedAt = Date.now();
  const result = await (await database()).execute(
    `UPDATE conversations
        SET title = $1, updated_at = $2
      WHERE id = $3 AND project_id = $4`,
    [normalizedTitle, updatedAt, conversationId, projectId],
  );
  if (result.rowsAffected === 0) throw new Error("Conversation no longer exists.");
  return { title: normalizedTitle, updatedAt };
}

export async function deleteConversation(
  projectId: string,
  conversationId: string,
): Promise<ConversationWorkspace> {
  return inTransaction(async () => {
    const connection = await database();
    const result = await connection.execute(
      `DELETE FROM conversations
        WHERE id = $1 AND project_id = $2`,
      [conversationId, projectId],
    );
    if (result.rowsAffected === 0) throw new Error("Conversation no longer exists.");

    const rows = await connection.select<ConversationRow[]>(
      `SELECT c.id, c.title, c.session_id, c.created_at, c.updated_at,
              CASE WHEN c.id = p.active_conversation_id THEN 1 ELSE 0 END AS is_active
         FROM conversations c
         JOIN projects p ON p.id = c.project_id
        WHERE c.project_id = $1
        ORDER BY c.updated_at DESC, c.created_at DESC`,
      [projectId],
    );
    if (rows.length === 0) {
      // Deleting the final chat leaves the project chat-less; the composer-first
      // project page starts a new one on demand rather than reviving a stub.
      await connection.execute(
        `UPDATE projects SET active_conversation_id = NULL WHERE id = $1`,
        [projectId],
      );
      return { ...EMPTY_WORKSPACE };
    }

    const activeRow = rows.find((row) => row.is_active === 1) ?? rows[0];
    await connection.execute(
      `UPDATE projects
          SET active_conversation_id = $1
        WHERE id = $2`,
      [activeRow.id, projectId],
    );
    return {
      conversations: rows.map(rowToConversation),
      activeConversationId: activeRow.id,
      messages: await loadConversationMessages(activeRow.id),
    };
  });
}

export async function createConversation(
  projectId: string,
  title: string,
): Promise<{ conversation: ConversationSummary; messages: ChatMessage[] }> {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) throw new Error("Conversation name is required.");

  const connection = await database();
  const now = Date.now();
  const id = `conversation-${crypto.randomUUID()}`;
  await connection.execute(
    `INSERT INTO conversations (id, project_id, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, projectId, normalizedTitle, now, now],
  );
  await connection.execute(
    `UPDATE projects
        SET active_conversation_id = $1
      WHERE id = $2`,
    [id, projectId],
  );
  // New chats open blank — the first message the user sends is the first turn.
  return {
    conversation: {
      id,
      title: normalizedTitle,
      sessionId: null,
      createdAt: now,
      updatedAt: now,
    },
    messages: [],
  };
}

export async function saveConversationMessage(
  projectId: string,
  conversationId: string,
  message: ChatMessage,
): Promise<void> {
  const result = await (await database()).execute(
    `UPDATE conversations
        SET updated_at = $1
      WHERE id = $2 AND project_id = $3`,
    [Date.now(), conversationId, projectId],
  );
  if (result.rowsAffected === 0) throw new Error("Conversation no longer exists.");
  await insertMessage(conversationId, message);
}

export async function saveConversationSessionId(
  projectId: string,
  conversationId: string,
  sessionId: string,
): Promise<void> {
  const result = await (await database()).execute(
    `UPDATE conversations
        SET session_id = $1
      WHERE id = $2 AND project_id = $3`,
    [sessionId, conversationId, projectId],
  );
  if (result.rowsAffected === 0) throw new Error("Conversation no longer exists.");
}
