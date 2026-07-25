"use client";

import { useState } from "react";
import type { ConnectablePlatform } from "@/lib/platforms/registry";
import { displayPlatformName, type Platform } from "@/lib/content/social-content";
import { IconInstagram, IconSparkle } from "../chrome/icons";

// Full-screen connect / reconnect flow. The parent (page.tsx) does the actual
// authorize/persist; this screen collects the credential the chosen platform's
// adapter asks for and surfaces connecting/error state.
//
// Nothing here knows what an Instagram token looks like: the label, placeholder,
// and hint come from the adapter, so a newly registered platform is connectable
// without touching this file.
//
// `variant` switches copy between a new destination and reconnecting one that
// already exists.
export default function ConnectView({
  platforms,
  platform,
  onPlatformChange,
  onConnect,
  connecting,
  error,
  variant = "first-run",
  onCancel,
}: {
  platforms: ConnectablePlatform[];
  platform: Platform;
  onPlatformChange: (platform: Platform) => void;
  onConnect: (secret: string) => void;
  connecting: boolean;
  error: string | null;
  variant?: "first-run" | "reconnect";
  onCancel?: () => void;
}) {
  const [secret, setSecret] = useState("");
  const canSubmit = secret.trim().length > 0 && !connecting;
  const isReconnect = variant === "reconnect";
  const selected = platforms.find((candidate) => candidate.platform === platform) ?? platforms[0];
  const platformName = displayPlatformName(selected?.platform ?? platform);
  const credential = selected?.credentialRequest;

  return (
    <div className="connect-screen">
      <div className="connect-card card stack">
        <div className="connect-logo" style={{ background: "var(--gradient)" }}>
          <PlatformMark platform={selected?.platform ?? platform} />
        </div>

        <div>
          <h1 style={{ fontSize: 22 }}>
            {isReconnect ? `Reconnect ${platformName}` : `Connect ${platformName}`}
          </h1>
          <div className="muted" style={{ marginTop: 6, fontSize: 14, lineHeight: 1.5 }}>
            {isReconnect ? (
              <>
                Your connection expired. Paste a fresh credential to pick up right where you left
                off. It is stored in your OS keychain — never in plain text.
              </>
            ) : (
              <>
                Paste a credential for the account you want to publish to. It is stored in your OS
                keychain — never in plain text.
              </>
            )}
          </div>
        </div>

        {/* One supported platform needs no choice; the picker appears as soon as
            a second adapter is registered. */}
        {!isReconnect && platforms.length > 1 && (
          <div className="field">
            <label>Platform</label>
            <div className="row" style={{ gap: "var(--s2)", flexWrap: "wrap" }}>
              {platforms.map((candidate) => (
                <button
                  key={candidate.platform}
                  className={`btn btn-sm ${candidate.platform === selected?.platform ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => onPlatformChange(candidate.platform)}
                  disabled={connecting}
                >
                  {displayPlatformName(candidate.platform)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="field">
          <label htmlFor="connection-credential">{credential?.label ?? "Access token"}</label>
          <input
            id="connection-credential"
            className="input"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={credential?.placeholder}
            autoComplete="off"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit) onConnect(secret.trim());
            }}
          />
          {credential?.hint && <div className="hint">{credential.hint}</div>}
        </div>

        {error && <div className="banner banner-err">{error}</div>}

        <div className="row" style={{ gap: "var(--s3)" }}>
          <button
            className="btn btn-grad"
            disabled={!canSubmit}
            onClick={() => onConnect(secret.trim())}
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

// A platform without its own mark falls back to the neutral one rather than
// borrowing another platform's logo.
function PlatformMark({ platform }: { platform: Platform }) {
  if (platform === "instagram") return <IconInstagram size={28} />;
  return <IconSparkle size={28} />;
}
