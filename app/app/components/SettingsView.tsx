"use client";

import { useEffect, useState } from "react";
import type { Account, AiProvider, AiProviderId } from "@/lib/types";
import type { ClaudeModel } from "@/lib/llm";
import type { ClaudeConnection } from "@/lib/useClaudeStatus";
import { r2SetupReady } from "@/lib/r2-setup";
import {
  configureR2,
  disconnectR2,
  type R2Jurisdiction,
  type R2Status,
} from "@/lib/local-media";
import {
  IconInstagram,
  IconSparkle,
  IconCheck,
  IconUsers,
  IconMoon,
  IconSun,
} from "./icons";

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
  theme,
  onSelectTheme,
  onDisconnect,
  r2Status,
  onR2StatusChange,
  onReturnToCompose,
}: {
  account: Account;
  providers: AiProvider[];
  activeProvider: AiProviderId;
  onSelectProvider: (id: AiProviderId) => void;
  claude: ClaudeConnection;
  activeModel: ClaudeModel;
  onSelectModel: (m: ClaudeModel) => void;
  theme: "light" | "dark";
  onSelectTheme: (theme: "light" | "dark") => void;
  onDisconnect: () => void;
  r2Status: R2Status;
  onR2StatusChange: (status: R2Status) => void;
  onReturnToCompose?: () => void;
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
          <div>
            <h3 style={{ fontSize: 16 }}>Appearance</h3>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
              Choose how Socialite looks. Your choice is remembered when you reopen the app.
            </div>
          </div>
          <div className="provider-grid" role="group" aria-label="Color theme">
            <button
              className={`provider${theme === "light" ? " on" : ""}`}
              onClick={() => onSelectTheme("light")}
              aria-pressed={theme === "light"}
            >
              <div className="p-ico" style={{ background: "var(--gradient)" }}>
                <IconSun size={18} />
              </div>
              <div style={{ fontWeight: 600 }}>Light</div>
            </button>
            <button
              className={`provider${theme === "dark" ? " on" : ""}`}
              onClick={() => onSelectTheme("dark")}
              aria-pressed={theme === "dark"}
            >
              <div className="p-ico" style={{ background: "var(--gradient)" }}>
                <IconMoon size={18} />
              </div>
              <div style={{ fontWeight: 600 }}>Dark</div>
            </button>
          </div>
        </div>

        <R2Panel
          status={r2Status}
          onStatusChange={onR2StatusChange}
          onReturnToCompose={onReturnToCompose}
        />

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

function R2Panel({
  status,
  onStatusChange,
  onReturnToCompose,
}: {
  status: R2Status;
  onStatusChange: (status: R2Status) => void;
  onReturnToCompose?: () => void;
}) {
  const [accountId, setAccountId] = useState(status.config?.accountId ?? "");
  const [bucketName, setBucketName] = useState(status.config?.bucketName ?? "");
  const [jurisdiction, setJurisdiction] = useState<R2Jurisdiction>(
    status.config?.jurisdiction ?? "default",
  );
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [lifecycleAcknowledged, setLifecycleAcknowledged] = useState(
    status.config?.lifecycleAcknowledged ?? false,
  );
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    if (!status.config) return;
    setAccountId(status.config.accountId);
    setBucketName(status.config.bucketName);
    setJurisdiction(status.config.jurisdiction);
    setLifecycleAcknowledged(status.config.lifecycleAcknowledged);
  }, [status.config]);

  const formReady = r2SetupReady({
    accountId,
    bucketName,
    accessKeyId,
    secretAccessKey,
    lifecycleAcknowledged,
  });

  async function saveAndTest() {
    setWorking(true);
    setMessage(null);
    try {
      const next = await configureR2(
        { accountId, bucketName, jurisdiction, lifecycleAcknowledged },
        accessKeyId,
        secretAccessKey,
      );
      onStatusChange(next);
      setMessage({
        text: "R2 is connected. Upload, read-back, and cleanup all succeeded.",
        error: false,
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessage({ text, error: true });
    } finally {
      setSecretAccessKey("");
      setWorking(false);
    }
  }

  async function removeConfiguration() {
    setWorking(true);
    setMessage(null);
    try {
      await disconnectR2();
      onStatusChange({ configured: false, config: null, maskedAccessKeyId: null, error: null });
      setAccessKeyId("");
      setSecretAccessKey("");
      setMessage({ text: "R2 credentials were removed from this device.", error: false });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="card stack" id="media-staging" tabIndex={-1}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h3 style={{ fontSize: 16 }}>Local image staging</h3>
          <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
            Optional · your Cloudflare R2 account · local Reels do not use this
          </div>
        </div>
        <span className={`badge ${status.configured ? "badge-published" : "badge-draft"}`}>
          {status.configured ? (
            <>
              <IconCheck size={13} /> Connected
            </>
          ) : status.error ? (
            "Needs attention"
          ) : (
            "Not configured"
          )}
        </span>
      </div>

      <div className="hint">
        Create a dedicated private R2 bucket and an API token scoped only to that bucket with Object
        Read &amp; Write. Add a lifecycle rule that deletes objects under <code>socialite/</code> after
        one day. Socialite creates short-lived signed URLs only when Instagram needs the image.
        <ol style={{ margin: "8px 0 0", paddingLeft: 18 }}>
          <li>In Cloudflare, open R2 Object Storage and create a private Standard bucket.</li>
          <li>Create an R2 API token with Object Read &amp; Write access to only that bucket.</li>
          <li>
            In the bucket&apos;s lifecycle settings, expire the <code>socialite/</code> prefix after one
            day.
          </li>
          <li>Copy the account ID and token credentials into the fields below.</li>
        </ol>
      </div>

      <div className="field">
        <label htmlFor="r2-account">1. Cloudflare account ID</label>
        <input id="r2-account" className="input" value={accountId} onChange={(event) => setAccountId(event.target.value)} placeholder="32-character account ID" disabled={working} />
      </div>
      <div className="field">
        <label htmlFor="r2-bucket">2. Dedicated bucket name</label>
        <input id="r2-bucket" className="input" value={bucketName} onChange={(event) => setBucketName(event.target.value)} placeholder="socialite-media-staging" disabled={working} />
      </div>
      <div className="field">
        <label htmlFor="r2-jurisdiction">3. Bucket jurisdiction</label>
        <select id="r2-jurisdiction" className="input" value={jurisdiction} onChange={(event) => setJurisdiction(event.target.value as R2Jurisdiction)} disabled={working}>
          <option value="default">Automatic / default</option>
          <option value="eu">European Union</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="r2-access">4. Access Key ID</label>
        <input id="r2-access" className="input" value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} placeholder={status.maskedAccessKeyId ?? "R2 S3 Access Key ID"} autoComplete="off" disabled={working} />
      </div>
      <div className="field">
        <label htmlFor="r2-secret">5. Secret Access Key</label>
        <input id="r2-secret" className="input" type="password" value={secretAccessKey} onChange={(event) => setSecretAccessKey(event.target.value)} placeholder={status.configured ? "Enter again to replace configuration" : "R2 S3 Secret Access Key"} autoComplete="new-password" disabled={working} />
        <div className="hint">Credentials are sent only to Cloudflare and stored in your OS keychain.</div>
      </div>
      <label className="row" style={{ gap: 8, alignItems: "flex-start" }}>
        <input type="checkbox" checked={lifecycleAcknowledged} onChange={(event) => setLifecycleAcknowledged(event.target.checked)} disabled={working} />
        <span className="hint">I configured a one-day lifecycle cleanup rule for the <code>socialite/</code> prefix.</span>
      </label>

      {status.error && <div className="banner banner-err">{status.error}</div>}
      {message && <div className={`banner banner-${message.error ? "err" : "ok"}`}>{message.text}</div>}

      <div className="row row-end" style={{ gap: 8 }}>
        {status.config && <button className="btn btn-ghost btn-sm" onClick={() => void removeConfiguration()} disabled={working}>Disconnect R2</button>}
        <button className="btn btn-primary" onClick={() => void saveAndTest()} disabled={!formReady || working}>
          {working ? "Testing…" : "Save and test connection"}
        </button>
        {status.configured && onReturnToCompose && <button className="btn btn-ghost" onClick={onReturnToCompose}>Return to Compose</button>}
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
                  ? "Agent runtime is ready but Claude is not signed in."
                  : "Claude Agent runtime is unavailable."}
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
            <li>Install Node.js 18 or newer.</li>
            <li>
              Install Claude Code: <code>npm install -g @anthropic-ai/claude-code</code>
            </li>
            <li>
              Sign in: run <code>claude</code> in a terminal and log in with your Anthropic account.
            </li>
            <li>Come back here and hit “Check connection.”</li>
          </ol>
        </div>
      )}

      {!checking && test && !test.ok && (
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
