"use client";

import { useState } from "react";
import {
  DEFAULT_CONFIG,
  GraphError,
  resolveAccount,
  publishImage,
  type Account,
  type ApiMode,
} from "@/lib/instagram";

interface Message {
  text: string;
  ok: boolean;
}

export default function Home() {
  const [mode, setMode] = useState<ApiMode>(DEFAULT_CONFIG.mode);
  const [token, setToken] = useState("");
  const [account, setAccount] = useState<Account | null>(null);

  const [imageUrl, setImageUrl] = useState("https://picsum.photos/1080");
  const [caption, setCaption] = useState("Hello from my Instagram agent test 🚀");

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Message | null>(null);

  const cfg = { ...DEFAULT_CONFIG, mode };

  function errText(e: unknown): string {
    if (e instanceof GraphError) return e.message;
    if (e instanceof Error) return e.message;
    return String(e);
  }

  async function connect() {
    if (!token.trim()) {
      setMsg({ text: "Please paste a token.", ok: false });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const acct = await resolveAccount(token.trim(), cfg);
      setAccount(acct);
      setMsg({ text: `Connected as @${acct.username}.`, ok: true });
    } catch (e) {
      setMsg({ text: `Connect failed: ${errText(e)}`, ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!account) return;
    setBusy(true);
    setMsg(null);
    try {
      const id = await publishImage(token.trim(), account.igUserId, imageUrl.trim(), caption, cfg);
      setMsg({ text: `Published! Media id ${id}`, ok: true });
    } catch (e) {
      setMsg({ text: `Publish failed: ${errText(e)}`, ok: false });
    } finally {
      setBusy(false);
    }
  }

  function disconnect() {
    setAccount(null);
    setToken("");
    setMsg(null);
  }

  return (
    <main className="wrap">
      <h1>📸 Instagram Agent</h1>
      <p className="muted">
        Mode: <code>{cfg.mode}</code> · API {cfg.version}
      </p>

      {msg && <p className={msg.ok ? "ok" : "err"}>{msg.text}</p>}

      {!account ? (
        <div className="card">
          <h2>1 · Connect</h2>
          <p className="muted">
            Paste an access token from the Graph API Explorer (or the Instagram token generator on
            your app&apos;s setup page). Needs <code>instagram_business_content_publish</code>.
          </p>

          <label>API mode</label>
          <select value={mode} onChange={(e) => setMode(e.target.value as ApiMode)}>
            <option value="instagram">Instagram Login (graph.instagram.com)</option>
            <option value="facebook">Facebook Login (graph.facebook.com)</option>
          </select>

          <label>Access token</label>
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="EAAG..."
            autoComplete="off"
          />

          <button onClick={connect} disabled={busy}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      ) : (
        <>
          <div className="card">
            <h2>✅ Connected</h2>
            <p>
              Account: <b>@{account.username}</b>{" "}
              <span className="muted">(id {account.igUserId})</span>
            </p>
            <a className="link" onClick={disconnect}>
              Disconnect
            </a>
          </div>

          <div className="card">
            <h2>2 · Publish a post</h2>
            <p className="muted">
              Instagram fetches the image from a <b>public URL</b> — you can&apos;t upload a local
              file. Any public image URL works for the test.
            </p>

            <label>Public image URL</label>
            <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} />

            <label>Caption</label>
            <textarea rows={3} value={caption} onChange={(e) => setCaption(e.target.value)} />

            <button onClick={publish} disabled={busy}>
              {busy ? "Publishing…" : "Publish now"}
            </button>
          </div>
        </>
      )}
    </main>
  );
}
