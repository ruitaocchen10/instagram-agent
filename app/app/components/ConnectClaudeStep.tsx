"use client";

import type { ClaudeConnection } from "@/lib/useClaudeStatus";
import { IconCheck, IconSparkle } from "./icons";

// Full-screen, skippable onboarding step shown once after a first connect. It
// checks whether the user's Claude Code session is live and, if not, teaches the
// one-time CLI setup. It blocks nothing — Instagram publishing works without
// Claude, and sign-in *cannot* happen in-app anyway (it lives in Anthropic's own
// CLI, per the ToS boundary), so this step only detects and instructs.
export default function ConnectClaudeStep({
  conn,
  onDone,
}: {
  conn: ClaudeConnection;
  onDone: () => void;
}) {
  const { checking, connected, status, test } = conn;

  return (
    <div className="connect-screen">
      <div className="connect-card card stack">
        <div className="row" style={{ gap: "var(--s3)" }}>
          <div className="int-ico" style={{ background: "#d97757" }}>
            <IconSparkle size={22} />
          </div>
          <div>
            <h1 style={{ fontSize: 22 }}>Connect your AI copilot</h1>
            <div className="muted" style={{ marginTop: 4, fontSize: 14, lineHeight: 1.5 }}>
              Captions and chat run on <strong>your own Claude Pro/Max subscription</strong> — no API
              key, no per-token bill.
            </div>
          </div>
        </div>

        <div className="integration">
          <div className="grow">
            <div style={{ fontWeight: 600 }}>Claude Code subscription</div>
            <div className="muted" style={{ fontSize: 13 }}>
              {checking
                ? "Checking your Claude Code session…"
                : connected
                  ? `Signed in${status?.version ? ` · ${status.version}` : ""}`
                  : status?.available
                    ? "Claude Code is installed but not signed in."
                    : "Claude Code not found on this Mac."}
            </div>
          </div>
          {!checking &&
            (connected ? (
              <span className="badge badge-published">
                <IconCheck size={13} /> Connected
              </span>
            ) : (
              <span className="badge badge-draft">Not connected</span>
            ))}
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => void conn.check()}
            disabled={checking}
          >
            {checking ? "Checking…" : "Check again"}
          </button>
        </div>

        {!checking && !connected && (
          <div className="hint">
            Set it up once, in Anthropic&apos;s CLI:
            <ol style={{ margin: "8px 0 0", paddingLeft: 18 }}>
              <li>
                Install: <code>npm install -g @anthropic-ai/claude-code</code>
              </li>
              <li>
                Sign in: run <code>claude</code> in a terminal and log in with your Anthropic account.
              </li>
              <li>Come back here and hit “Check again.”</li>
            </ol>
          </div>
        )}

        {!checking && status?.available && test && !test.ok && (
          <div className="banner banner-err">{test.text}</div>
        )}

        <div className="row" style={{ gap: "var(--s3)" }}>
          {connected ? (
            <button className="btn btn-grad" onClick={onDone} style={{ flex: 1 }}>
              <IconCheck size={17} /> Continue
            </button>
          ) : (
            <button className="btn btn-ghost" onClick={onDone} style={{ flex: 1 }}>
              Skip for now — I&apos;ll do this in Settings
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
