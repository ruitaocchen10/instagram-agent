import type { ChatMessage, PostIdea } from "./types";
import { appDatabase as database } from "./app-database";

const DEFAULT_PROJECT_ID = "default-project";
const DEFAULT_CONVERSATION_ID = "default-conversation";

interface MessageRow {
  id: string;
  role: ChatMessage["role"];
  text: string;
  ideas_json: string | null;
}

interface StoredMessageRow extends MessageRow {
  conversation_id: string;
}

async function ensureDefaultConversation(): Promise<void> {
  const connection = await database();
  const now = Date.now();
  await connection.execute(
    `INSERT OR IGNORE INTO projects (id, name, created_at)
     VALUES ($1, $2, $3)`,
    [DEFAULT_PROJECT_ID, "My Instagram", now],
  );
  await connection.execute(
    `INSERT OR IGNORE INTO conversations (id, project_id, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [DEFAULT_CONVERSATION_ID, DEFAULT_PROJECT_ID, "Content copilot", now, now],
  );
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

async function insertMessage(message: ChatMessage): Promise<void> {
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
      DEFAULT_CONVERSATION_ID,
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
    stored?.conversation_id === DEFAULT_CONVERSATION_ID &&
    stored.role === message.role &&
    stored.text === message.text &&
    stored.ideas_json === ideasJson
  ) {
    return;
  }
  throw new Error(`Couldn't save message ${message.id}: SQLite ignored the insert.`);
}

// Selects the app's durable default thread. On a true first run, the supplied
// greeting is inserted once so the UI and the database begin from the same
// history. Existing messages always win.
export async function loadDefaultConversation(
  firstRunMessages: ChatMessage[],
): Promise<ChatMessage[]> {
  await ensureDefaultConversation();
  const rows = await (await database()).select<MessageRow[]>(
    `SELECT id, role, text, ideas_json
       FROM messages
      WHERE conversation_id = $1
      ORDER BY sequence ASC`,
    [DEFAULT_CONVERSATION_ID],
  );
  if (rows.length > 0) return rows.map(rowToMessage);

  for (const message of firstRunMessages) await insertMessage(message);
  return firstRunMessages;
}

export async function saveConversationMessage(message: ChatMessage): Promise<void> {
  await ensureDefaultConversation();
  await insertMessage(message);
}
