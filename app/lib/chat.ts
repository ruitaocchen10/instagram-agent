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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const userMessage: ChatMessage = { id: `u${now()}`, role: "user", text };
  publish(userMessage);

  try {
    await persist(userMessage);
  } catch (error) {
    persistenceErrors.push(errorMessage(error));
  }

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
  try {
    await persist(assistantMessage);
  } catch (error) {
    persistenceErrors.push(errorMessage(error));
  }

  return { persistenceErrors };
}
