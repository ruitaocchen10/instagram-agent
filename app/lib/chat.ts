import { generate, type ChatTurn, type ClaudeModel } from "./llm";
import type { ChatMessage } from "./types";

interface ContinueConversationOptions {
  text: string;
  history: ChatMessage[];
  model: ClaudeModel;
  system?: string;
  publish: (message: ChatMessage) => void;
  persist: (message: ChatMessage) => Promise<void>;
  generateReply?: typeof generate;
  now?: () => number;
}

export interface ContinueConversationResult {
  persistenceErrors: string[];
}

export interface ConversationOutbox {
  persist: (message: ChatMessage) => Promise<void>;
  hasPending: () => boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Failed writes remain queued in message order. A later turn retries the whole
// queue before saving its own message, preventing an assistant reply from being
// stored ahead of the user message that prompted it.
export function createConversationOutbox(
  save: (message: ChatMessage) => Promise<void>,
): ConversationOutbox {
  const pending: ChatMessage[] = [];
  return {
    async persist(message) {
      pending.push(message);
      while (pending.length > 0) {
        await save(pending[0]);
        pending.shift();
      }
    },
    hasPending: () => pending.length > 0,
  };
}

// Coordinates one durable vertical slice of chat behavior. Messages are
// published to the UI immediately, then persisted before work advances, so a
// generation failure or navigation never makes the submitted user turn vanish.
export async function continueConversation({
  text,
  history,
  model,
  system,
  publish,
  persist,
  generateReply = generate,
  now = Date.now,
}: ContinueConversationOptions): Promise<ContinueConversationResult> {
  const persistenceErrors: string[] = [];
  async function persistSafely(message: ChatMessage): Promise<void> {
    try {
      await persist(message);
    } catch (error) {
      persistenceErrors.push(errorMessage(error));
    }
  }

  const userMessage: ChatMessage = { id: `u${now()}`, role: "user", text };
  publish(userMessage);
  await persistSafely(userMessage);

  let reply: string;
  try {
    const generationOptions: {
      model: ClaudeModel;
      history: ChatTurn[];
      system?: string;
    } = { model, history };
    if (system) generationOptions.system = system;
    reply = await generateReply(text, generationOptions);
  } catch (error) {
    reply = `${errorMessage(error)}\n\nConnect Claude in Settings to start chatting.`;
  }

  const assistantMessage: ChatMessage = { id: `a${now()}`, role: "ai", text: reply };
  publish(assistantMessage);
  await persistSafely(assistantMessage);

  return { persistenceErrors };
}
