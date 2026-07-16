"use client";

import { useState } from "react";
import { IconInstagram, IconSparkle } from "./icons";

// Full-screen gated onboarding. Blocks the app until an Instagram account is
// connected. The parent (page.tsx) does the actual resolve/persist; this screen
// just collects the token and surfaces connecting/error state.
export default function ConnectView({
  onConnect,
  connecting,
  error,
}: {
  onConnect: (token: string) => void;
  connecting: boolean;
  error: string | null;
}) {
  const [token, setToken] = useState("");
  const canSubmit = token.trim().length > 0 && !connecting;

  return (
    <div className="connect-screen">
      <div className="connect-card card stack">
        <div className="connect-logo" style={{ background: "var(--gradient)" }}>
          <IconInstagram size={28} />
        </div>

        <div>
          <h1 style={{ fontSize: 22 }}>Connect Instagram</h1>
          <div className="muted" style={{ marginTop: 6, fontSize: 14, lineHeight: 1.5 }}>
            Paste an access token for your Business or Creator account to load your posts and start
            scheduling. The token is stored in your OS keychain — never in plain text.
          </div>
        </div>

        <div className="field">
          <label htmlFor="ig-token">Instagram access token</label>
          <input
            id="ig-token"
            className="input"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="IGAA…"
            autoComplete="off"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit) onConnect(token.trim());
            }}
          />
          <div className="hint">
            Instagram Login (graph.instagram.com). A short-lived token works for testing.
          </div>
        </div>

        {error && <div className="banner banner-err">{error}</div>}

        <button
          className="btn btn-grad"
          disabled={!canSubmit}
          onClick={() => onConnect(token.trim())}
        >
          {connecting ? (
            <>Connecting…</>
          ) : (
            <>
              <IconSparkle size={17} /> Connect account
            </>
          )}
        </button>
      </div>
    </div>
  );
}
