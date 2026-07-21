"use client";

import { useState } from "react";
import type { Account, AiProvider, AiProviderId } from "@/lib/types";
import type { ClaudeModel } from "@/lib/llm";
import type { ClaudeConnection } from "@/lib/useClaudeStatus";
import { IconInstagram, IconSparkle, IconCheck, IconUsers } from "./icons";

// Claude model aliases exposed in the picker, with a one-line "when to use" hint.
const CLAUDE_MODELS: { id: ClaudeModel; name: string; blurb: string }[] = [
  { id: "haiku", name: "Haiku", blurb: "Fastest, cheapest" },
  { id: "sonnet", name: "Sonnet", blurb: "Balanced default" },
  { id: "opus", name: "Opus", blurb: "Best writing" },
];

export default function SettingsView({
  account,
  providers,
  activeProvider,
  onSelectProvider,
  claude,
  activeModel,
  onSelectModel,
  onDisconnect,
}: {
  account: Account;
  providers: AiProvider[];
  activeProvider: AiProviderId;
  onSelectProvider: (id: AiProviderId) => void;
  claude: ClaudeConnection;
  activeModel: ClaudeModel;
  onSelectModel: (m: ClaudeModel) => void;
  onDisconnect: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  // Two-step disconnect: the first click arms a confirm/cancel pair so an
  // accidental click can't silently wipe the connection and boot to the gate.
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  return (
    <div className="view-enter">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <div className="sub">Manage your connections and AI copilot.</div>
        </div>
      </div>

      <div className="stack">
        <div className="card stack">
          <h3 style={{ fontSize: 16 }}>Instagram account</h3>
          <div className="integration">
            <div className="int-ico" style={{ background: "var(--gradient)" }}>
              <IconInstagram size={24} />
            </div>
            <div className="grow">
              <div style={{ fontWeight: 600 }}>@{account.username}</div>
              <div className="muted row" style={{ gap: 12, fontSize: 13 }}>
                <span>{account.fullName}</span>
                <span className="row" style={{ gap: 4 }}>
                  <IconUsers size={13} /> {account.followers.toLocaleString()} followers
                </span>
              </div>
            </div>
            <span className="badge badge-published">
              <IconCheck size={13} /> Connected
            </span>
            {confirmingDisconnect ? (
              <div className="row" style={{ gap: 8 }}>
                <button className="btn btn-danger btn-sm" onClick={onDisconnect}>
                  Confirm
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setConfirmingDisconnect(false)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setConfirmingDisconnect(true)}
              >
                Disconnect
              </button>
            )}
          </div>
          <div className="hint">
            {confirmingDisconnect ? (
              <>
                Disconnecting removes your token from the OS keychain and returns you to the connect
                screen. Your drafts and scheduled posts are kept.
              </>
            ) : (
              <>
                Business or Creator account, connected via Instagram Login. Token is stored in your
                OS keychain — never in plain text.
              </>
            )}
          </div>
        </div>

        <div className="card stack">
          <div>
            <h3 style={{ fontSize: 16 }}>AI copilot</h3>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
              Bring your own model. Nothing leaves this device.
            </div>
          </div>

          <div className="provider-grid">
            {providers.map((p) => (
              <button
                key={p.id}
                className={`provider${activeProvider === p.id ? " on" : ""}`}
                onClick={() => onSelectProvider(p.id)}
              >
                <div
                  className="p-ico"
                  style={{ background: p.id === "claude" ? "#d97757" : "#10a37f" }}
                >
                  {p.id === "claude" ? <IconSparkle size={18} /> : "AI"}
                </div>
                <div>
                  <div style={{ fontWeight: 600 }}>{p.name}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {p.model}
                  </div>
                </div>
              </button>
            ))}
          </div>

          {activeProvider === "claude" ? (
            <ClaudePanel conn={claude} activeModel={activeModel} onSelectModel={onSelectModel} />
          ) : (
            // OpenAI (and future key-based providers) still use BYOK API keys.
            // Not wired to generation yet.
            <>
              <div className="field">
                <label htmlFor="key">
                  {providers.find((p) => p.id === activeProvider)?.name} API key
                </label>
                <input
                  id="key"
                  className="input"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-…"
                  autoComplete="off"
                />
                <div className="hint">
                  Stored securely in your OS keychain, alongside your IG token.
                </div>
              </div>
              <div className="row row-end">
                <button className="btn btn-primary" disabled={!apiKey.trim()}>
                  Save key
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Claude connects through the user's own Claude Code login (their Pro/Max
// subscription), not an API key. We only detect and test that local session —
// we never handle Anthropic credentials. Sign-in itself happens in Anthropic's
// own CLI (`claude`), never in this app. The connection is probed once at the
// app level and passed in via `conn`.
function ClaudePanel({
  conn,
  activeModel,
  onSelectModel,
}: {
  conn: ClaudeConnection;
  activeModel: ClaudeModel;
  onSelectModel: (m: ClaudeModel) => void;
}) {
  const { checking, connected, status, test } = conn;

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="integration">
        <div className="int-ico" style={{ background: "#d97757" }}>
          <IconSparkle size={20} />
        </div>
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
          {checking ? "Checking…" : "Check connection"}
        </button>
      </div>

      {!checking && !connected && (
        <div className="hint">
          Captions and chat run on <strong>your own Claude Pro/Max subscription</strong> — no API
          key or per-token bill. Set it up once, in Anthropic&apos;s CLI:
          <ol style={{ margin: "8px 0 0", paddingLeft: 18 }}>
            <li>
              Install: <code>npm install -g @anthropic-ai/claude-code</code>
            </li>
            <li>
              Sign in: run <code>claude</code> in a terminal and log in with your Anthropic account.
            </li>
            <li>Come back here and hit “Check connection.”</li>
          </ol>
        </div>
      )}

      {!checking && status?.available && test && !test.ok && (
        <div className="banner banner-err">{test.text}</div>
      )}

      {/* Model picker — the alias used for captions and chat. The connection
          test always runs on Sonnet; this only changes real generations. */}
      <div className="field">
        <label>Model</label>
        <div className="provider-grid">
          {CLAUDE_MODELS.map((m) => (
            <button
              key={m.id}
              className={`provider${activeModel === m.id ? " on" : ""}`}
              onClick={() => onSelectModel(m.id)}
            >
              <div>
                <div style={{ fontWeight: 600 }}>{m.name}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {m.blurb}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
