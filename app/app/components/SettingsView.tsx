"use client";

import { useCallback, useEffect, useState } from "react";
import type { Account, AiProvider, AiProviderId } from "@/lib/types";
import { detectClaude, generate, type ClaudeStatus } from "@/lib/llm";
import { IconInstagram, IconSparkle, IconCheck, IconUsers } from "./icons";

export default function SettingsView({
  account,
  providers,
  activeProvider,
  onSelectProvider,
  onDisconnect,
}: {
  account: Account;
  providers: AiProvider[];
  activeProvider: AiProviderId;
  onSelectProvider: (id: AiProviderId) => void;
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
                  <div className="muted mono" style={{ fontSize: 12 }}>
                    {p.model}
                  </div>
                </div>
              </button>
            ))}
          </div>

          {activeProvider === "claude" ? (
            <ClaudeConnection />
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
// own CLI (`claude`), never in this app.
function ClaudeConnection() {
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
        // A tiny real generation confirms the session is actually signed in —
        // `--version` only proves the binary exists.
        try {
          const reply = await generate("Reply with exactly: OK", { model: "sonnet" });
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

  const connected = status?.available && test?.ok;

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
        <button className="btn btn-ghost btn-sm" onClick={() => void check()} disabled={checking}>
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
    </div>
  );
}
