"use client";

import { useState } from "react";
import { IconInstagram, IconSparkle } from "./icons";
import UpgradeTokenInfo from "./UpgradeTokenInfo";

// Full-screen gated onboarding / reconnect. Blocks the app until an Instagram
// account is connected. The parent (page.tsx) does the actual resolve/persist;
// this screen just collects the token and surfaces connecting/error state.
//
// `variant` switches copy between first-run and post-expiry reconnect. In the
// reconnect variant the durable-token nudge is expandable inline — the pain of
// repeated reconnects is exactly the moment to sell the 60-day token.
export default function ConnectView({
  onConnect,
  connecting,
  error,
  variant = "first-run",
  onCancel,
}: {
  onConnect: (token: string) => void;
  connecting: boolean;
  error: string | null;
  variant?: "first-run" | "reconnect";
  onCancel?: () => void;
}) {
  const [token, setToken] = useState("");
  const [showNudge, setShowNudge] = useState(false);
  const canSubmit = token.trim().length > 0 && !connecting;
  const isReconnect = variant === "reconnect";

  return (
    <div className="connect-screen">
      <div className="connect-card card stack">
        <div className="connect-logo" style={{ background: "var(--gradient)" }}>
          <IconInstagram size={28} />
        </div>

        <div>
          <h1 style={{ fontSize: 22 }}>{isReconnect ? "Reconnect Instagram" : "Connect Instagram"}</h1>
          <div className="muted" style={{ marginTop: 6, fontSize: 14, lineHeight: 1.5 }}>
            {isReconnect ? (
              <>
                Your connection expired. Paste a fresh access token to pick up right where you left
                off. The token is stored in your OS keychain — never in plain text.
              </>
            ) : (
              <>
                Paste an access token for your Business or Creator account to load your posts and
                start scheduling. The token is stored in your OS keychain — never in plain text.
              </>
            )}
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

        {isReconnect && (
          <div className="stack" style={{ gap: 8 }}>
            <button
              type="button"
              className="link-btn"
              onClick={() => setShowNudge((s) => !s)}
              aria-expanded={showNudge}
            >
              {showNudge ? "Hide" : "Tired of reconnecting? Get a 60-day token"}
            </button>
            {showNudge && (
              <div className="card" style={{ background: "var(--surface-2)" }}>
                <UpgradeTokenInfo />
              </div>
            )}
          </div>
        )}

        {error && <div className="banner banner-err">{error}</div>}

        <div className="row" style={{ gap: "var(--s3)" }}>
          <button
            className="btn btn-grad"
            disabled={!canSubmit}
            onClick={() => onConnect(token.trim())}
            style={{ flex: 1 }}
          >
            {connecting ? (
              <>Connecting…</>
            ) : (
              <>
                <IconSparkle size={17} /> {isReconnect ? "Reconnect account" : "Connect account"}
              </>
            )}
          </button>
          {isReconnect && onCancel && (
            <button className="btn btn-ghost" onClick={onCancel} disabled={connecting}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
