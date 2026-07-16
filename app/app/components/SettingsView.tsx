"use client";

import { useState } from "react";
import type { Account, AiProvider, AiProviderId } from "@/lib/types";
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
            <button className="btn btn-ghost btn-sm" onClick={onDisconnect}>
              Disconnect
            </button>
          </div>
          <div className="hint">
            Business or Creator account, connected via Instagram Login. Token is stored in your OS
            keychain — never in plain text.
          </div>
        </div>

        <div className="card stack">
          <div>
            <h3 style={{ fontSize: 16 }}>AI copilot</h3>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
              Bring your own model. Your key stays on this device.
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
                  <div style={{ marginTop: 6 }}>
                    {p.connected ? (
                      <span className="badge badge-published">
                        <IconCheck size={12} /> Active
                      </span>
                    ) : (
                      <span className="badge badge-draft">Not connected</span>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>

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
              placeholder={activeProvider === "claude" ? "sk-ant-…" : "sk-…"}
              autoComplete="off"
            />
            <div className="hint">Stored securely in your OS keychain, alongside your IG token.</div>
          </div>
          <div className="row row-end">
            <button className="btn btn-primary" disabled={!apiKey.trim()}>
              Save key
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
