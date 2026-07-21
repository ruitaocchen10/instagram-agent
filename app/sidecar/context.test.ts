import { describe, expect, it } from "vitest";
import { assembleAgentInput } from "./context";

const history = [
  { role: "user" as const, text: "Plan a launch week." },
  { role: "ai" as const, text: "Start with a teaser." },
];

describe("agent context assembly", () => {
  it("sends only the new input to a warm conversation session", () => {
    expect(
      assembleAgentInput({
        prompt: "What comes next?",
        history,
        sessionId: "session-1",
        sessionState: "warm",
      }),
    ).toEqual({
      prompt: "What comes next?",
      resumeSessionId: null,
    });
  });

  it("replays authoritative stored history after a session expires", () => {
    expect(
      assembleAgentInput({
        prompt: "What comes next?",
        history,
        sessionId: "expired-session",
        sessionState: "expired",
      }),
    ).toEqual({
      prompt:
        "Conversation so far (replayed from the app's authoritative message log):\n" +
        "User: Plan a launch week.\n\n" +
        "Assistant: Start with a teaser.\n\n" +
        "User: What comes next?",
      resumeSessionId: null,
    });
  });

  it("resumes a stored cold session without duplicating its history", () => {
    expect(
      assembleAgentInput({
        prompt: "Make it punchier.",
        history,
        sessionId: "stored-session",
        sessionState: "cold",
      }),
    ).toEqual({
      prompt: "Make it punchier.",
      resumeSessionId: "stored-session",
    });
  });
});
