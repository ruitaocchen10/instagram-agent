export interface AgentHistoryTurn {
  role: "user" | "ai";
  text: string;
}

export type AgentSessionState = "warm" | "cold" | "expired";

export interface AgentInput {
  prompt: string;
  resumeSessionId: string | null;
}

function replayPrompt(history: AgentHistoryTurn[], prompt: string): string {
  if (history.length === 0) return prompt;
  const transcript = history
    .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`)
    .join("\n\n");
  return (
    "Conversation so far (replayed from the app's authoritative message log):\n" +
    `${transcript}\n\nUser: ${prompt}`
  );
}

export function assembleAgentInput({
  prompt,
  history,
  sessionId,
  sessionState,
}: {
  prompt: string;
  history: AgentHistoryTurn[];
  sessionId?: string | null;
  sessionState: AgentSessionState;
}): AgentInput {
  if (sessionState === "warm") {
    return { prompt, resumeSessionId: null };
  }

  if (sessionState === "expired") {
    return {
      prompt: replayPrompt(history, prompt),
      resumeSessionId: null,
    };
  }

  return {
    prompt,
    resumeSessionId: sessionState === "cold" ? (sessionId ?? null) : null,
  };
}
