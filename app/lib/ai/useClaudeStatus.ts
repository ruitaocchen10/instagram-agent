"use client";

import { useCallback, useEffect, useState } from "react";
import { detectClaude, generate, type ClaudeStatus } from "./llm";

// Shared Claude-connection probe. Onboarding, the chat banner, and Settings all
// need to know whether the Agent sidecar starts *and* Claude is signed in, so we run the
// probe once at the app level (page.tsx) and thread this object down rather than
// check once at the app level.
export interface ClaudeConnection {
  checking: boolean;
  connected: boolean; // installed AND a test generation succeeded
  status: ClaudeStatus | null; // install / version info
  test: { ok: boolean; text: string } | null; // last generation result
  check: () => Promise<void>; // re-probe (e.g. after the user signs in)
}

// Start the Node/Agent SDK runtime and prove sign-in with a tiny real generation.
export function useClaudeStatus(): ClaudeConnection {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    setTest(null);
    try {
      const s = await detectClaude();
      setStatus(s);
      if (s.available) {
        try {
          const reply = await generate("Reply with exactly: OK", {
            model: "sonnet",
            conversationId: "connection-check",
          });
          setTest({ ok: true, text: reply.trim() || "OK" });
        } catch (e) {
          setTest({ ok: false, text: e instanceof Error ? e.message : String(e) });
        }
      }
    } catch (e) {
      setStatus({ available: false, version: null });
      setTest({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const connected = !!(status?.available && test?.ok);
  return { checking, connected, status, test, check };
}
