import {
  generate,
  type AppToolCall,
  type AppToolResult,
  type ChatTurn,
  type ClaudeModel,
} from "./llm";
import type { ChatMessage } from "./types";

interface ContinueConversationOptions {
  text: string;
  history: ChatMessage[];
  model: ClaudeModel;
  system?: string;
  workspacePath?: string;
  conversationId?: string;
  sessionId?: string | null;
  publish: (message: ChatMessage) => void;
  update?: (message: ChatMessage) => void;
  persist: (message: ChatMessage) => Promise<void>;
  rememberSessionId?: (sessionId: string) => void | Promise<void>;
  onToolCall?: (call: AppToolCall) => Promise<AppToolResult>;
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
  let drainPromise: Promise<void> | null = null;

  function drain(): Promise<void> {
    if (drainPromise) return drainPromise;
    const running = (async () => {
      while (pending.length > 0) {
        await save(pending[0]);
        pending.shift();
      }
    })();
    drainPromise = running;
    const clearDrain = () => {
      if (drainPromise === running) drainPromise = null;
    };
    void running.then(clearDrain, clearDrain);
    return running;
  }

  return {
    persist(message) {
      pending.push(message);
      return drain();
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
  workspacePath,
  conversationId,
  sessionId,
  publish,
  update,
  persist,
  rememberSessionId,
  onToolCall,
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

  const assistantMessage: ChatMessage = { id: `a${now()}`, role: "ai", text: "" };
  let streamedText = "";
  if (update) publish(assistantMessage);

  let reply: string;
  try {
    const generationOptions: {
      model: ClaudeModel;
      history: ChatTurn[];
      system?: string;
      workspacePath?: string;
      conversationId?: string;
      sessionId?: string | null;
      onDelta?: (text: string) => void;
      onReset?: () => void;
      onSessionId?: (sessionId: string) => void | Promise<void>;
      onToolCall?: (call: AppToolCall) => Promise<AppToolResult>;
    } = { model, history };
    if (system) generationOptions.system = system;
    if (workspacePath) generationOptions.workspacePath = workspacePath;
    if (conversationId) generationOptions.conversationId = conversationId;
    if (sessionId) generationOptions.sessionId = sessionId;
    if (update) {
      generationOptions.onDelta = (text) => {
        streamedText += text;
        update({ ...assistantMessage, text: streamedText });
      };
      generationOptions.onReset = () => {
        streamedText = "";
        update(assistantMessage);
      };
    }
    if (rememberSessionId) generationOptions.onSessionId = rememberSessionId;
    if (onToolCall) generationOptions.onToolCall = onToolCall;
    reply = await generateReply(text, generationOptions);
  } catch (error) {
    const recovery = `${errorMessage(error)}\n\nSend the message again to retry, or check Claude in Settings.`;
    reply = streamedText ? `${streamedText}\n\nReply interrupted: ${recovery}` : recovery;
  }

  const completedAssistant = { ...assistantMessage, text: reply };
  if (update) {
    if (reply !== streamedText) update(completedAssistant);
  } else {
    publish(completedAssistant);
  }
  await persistSafely(completedAssistant);

  return { persistenceErrors };
}
