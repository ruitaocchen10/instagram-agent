import type { ChatMessage, PostIdea } from "./types";
import { appDatabase as database } from "./app-database";

const DEFAULT_PROJECT_ID = "default-project";
const DEFAULT_CONVERSATION_ID = "default-conversation";

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationWorkspace {
  conversations: ConversationSummary[];
  activeConversationId: string;
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
  created_at: number;
  updated_at: number;
  is_active?: number;
}

function rowToConversation(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function inTransaction<T>(operation: () => Promise<T>): Promise<T> {
  const connection = await database();
  await connection.execute("BEGIN IMMEDIATE");
  try {
    const result = await operation();
    await connection.execute("COMMIT");
    return result;
  } catch (error) {
    try {
      await connection.execute("ROLLBACK");
    } catch {
      // Preserve the operation error; it explains why the transaction failed.
    }
    throw error;
  }
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

export async function loadConversationWorkspace(
  firstRunMessages: ChatMessage[],
): Promise<ConversationWorkspace> {
  const connection = await database();
  const now = Date.now();
  await connection.execute(
    `INSERT OR IGNORE INTO projects (id, name, created_at)
     VALUES ($1, $2, $3)`,
    [DEFAULT_PROJECT_ID, "My Instagram", now],
  );
  let rows = await connection.select<ConversationRow[]>(
    `SELECT id, title, created_at, updated_at
       FROM conversations
      WHERE project_id = $1
      ORDER BY updated_at DESC, created_at DESC`,
    [DEFAULT_PROJECT_ID],
  );
  let activeConversationId: string;
  if (rows.length === 0) {
    await connection.execute(
      `INSERT INTO conversations (id, project_id, title, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [DEFAULT_CONVERSATION_ID, DEFAULT_PROJECT_ID, "Content copilot", now, now],
    );
    rows = [
      {
        id: DEFAULT_CONVERSATION_ID,
        title: "Content copilot",
        created_at: now,
        updated_at: now,
      },
    ];
    activeConversationId = DEFAULT_CONVERSATION_ID;
    await connection.execute(
      `UPDATE projects SET active_conversation_id = $1 WHERE id = $2`,
      [activeConversationId, DEFAULT_PROJECT_ID],
    );
  } else {
    const activeRows = await connection.select<{ active_conversation_id: string | null }[]>(
      `SELECT active_conversation_id
         FROM projects
        WHERE id = $1`,
      [DEFAULT_PROJECT_ID],
    );
    const storedActiveId = activeRows[0]?.active_conversation_id;
    activeConversationId = rows.some((row) => row.id === storedActiveId)
      ? storedActiveId!
      : rows[0].id;
    if (storedActiveId !== activeConversationId) {
      await connection.execute(
        `UPDATE projects SET active_conversation_id = $1 WHERE id = $2`,
        [activeConversationId, DEFAULT_PROJECT_ID],
      );
    }
  }
  return {
    conversations: rows.map(rowToConversation),
    activeConversationId,
    messages: await loadConversationMessages(activeConversationId, firstRunMessages),
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

function seedMessagesFor(conversationId: string, messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    id: `${conversationId}-${message.id}`,
  }));
}

async function loadConversationMessages(
  conversationId: string,
  firstRunMessages: ChatMessage[],
): Promise<ChatMessage[]> {
  const connection = await database();
  const rows = await connection.select<MessageRow[]>(
    `SELECT id, role, text, ideas_json
       FROM messages
      WHERE conversation_id = $1
      ORDER BY sequence ASC`,
    [conversationId],
  );
  if (rows.length > 0) return rows.map(rowToMessage);

  const messages =
    conversationId === DEFAULT_CONVERSATION_ID
      ? firstRunMessages
      : seedMessagesFor(conversationId, firstRunMessages);
  for (const message of messages) await insertMessage(conversationId, message);
  return messages;
}

export async function selectConversation(
  conversationId: string,
  firstRunMessages: ChatMessage[],
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
    [conversationId, DEFAULT_PROJECT_ID],
  );
  if (result.rowsAffected === 0) throw new Error("Conversation no longer exists.");
  return loadConversationMessages(conversationId, firstRunMessages);
}

export async function renameConversation(
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
    [normalizedTitle, updatedAt, conversationId, DEFAULT_PROJECT_ID],
  );
  if (result.rowsAffected === 0) throw new Error("Conversation no longer exists.");
  return { title: normalizedTitle, updatedAt };
}

export async function deleteConversation(
  conversationId: string,
  firstRunMessages: ChatMessage[],
): Promise<ConversationWorkspace> {
  return inTransaction(async () => {
    const connection = await database();
    const result = await connection.execute(
      `DELETE FROM conversations
        WHERE id = $1 AND project_id = $2`,
      [conversationId, DEFAULT_PROJECT_ID],
    );
    if (result.rowsAffected === 0) throw new Error("Conversation no longer exists.");

    const rows = await connection.select<ConversationRow[]>(
      `SELECT c.id, c.title, c.created_at, c.updated_at,
              CASE WHEN c.id = p.active_conversation_id THEN 1 ELSE 0 END AS is_active
         FROM conversations c
         JOIN projects p ON p.id = c.project_id
        WHERE c.project_id = $1
        ORDER BY c.updated_at DESC, c.created_at DESC`,
      [DEFAULT_PROJECT_ID],
    );
    if (rows.length === 0) {
      const created = await createConversation("Content copilot", firstRunMessages);
      return {
        conversations: [created.conversation],
        activeConversationId: created.conversation.id,
        messages: created.messages,
      };
    }

    const activeRow = rows.find((row) => row.is_active === 1) ?? rows[0];
    await connection.execute(
      `UPDATE projects
          SET active_conversation_id = $1
        WHERE id = $2`,
      [activeRow.id, DEFAULT_PROJECT_ID],
    );
    return {
      conversations: rows.map(rowToConversation),
      activeConversationId: activeRow.id,
      messages: await loadConversationMessages(activeRow.id, firstRunMessages),
    };
  });
}

export async function createConversation(
  title: string,
  firstRunMessages: ChatMessage[],
): Promise<{ conversation: ConversationSummary; messages: ChatMessage[] }> {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) throw new Error("Conversation name is required.");

  const connection = await database();
  const now = Date.now();
  const id = `conversation-${crypto.randomUUID()}`;
  await connection.execute(
    `INSERT OR IGNORE INTO projects (id, name, created_at)
     VALUES ($1, $2, $3)`,
    [DEFAULT_PROJECT_ID, "My Instagram", now],
  );
  await connection.execute(
    `INSERT INTO conversations (id, project_id, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, DEFAULT_PROJECT_ID, normalizedTitle, now, now],
  );
  await connection.execute(
    `UPDATE projects
        SET active_conversation_id = $1
      WHERE id = $2`,
    [id, DEFAULT_PROJECT_ID],
  );
  const messages = seedMessagesFor(id, firstRunMessages);
  for (const message of messages) await insertMessage(id, message);
  return {
    conversation: { id, title: normalizedTitle, createdAt: now, updatedAt: now },
    messages,
  };
}

export async function saveConversationMessage(
  conversationId: string,
  message: ChatMessage,
): Promise<void> {
  await insertMessage(conversationId, message);
  await (await database()).execute(
    `UPDATE conversations
        SET updated_at = $1
      WHERE id = $2 AND project_id = $3`,
    [Date.now(), conversationId, DEFAULT_PROJECT_ID],
  );
}
