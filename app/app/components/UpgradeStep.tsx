"use client";

import { IconCheck } from "./icons";
import UpgradeTokenInfo from "./UpgradeTokenInfo";

// Full-screen, skippable onboarding step shown after a successful first connect.
// It teaches the durable (long-lived) token path but blocks nothing: the user
// can mark it done or skip, and either way proceeds into the app. The app does
// not — and cannot cheaply — verify which kind of token was pasted here.
export default function UpgradeStep({ onDone }: { onDone: () => void }) {
  return (
    <div className="connect-screen">
      <div className="connect-card card stack">
        <div>
          <h1 style={{ fontSize: 22 }}>Make your connection durable</h1>
          <div className="muted" style={{ marginTop: 6, fontSize: 14, lineHeight: 1.5 }}>
            You&apos;re connected. Optionally, upgrade to a 60-day token so you don&apos;t have to
            reconnect.
          </div>
        </div>

        <UpgradeTokenInfo />

        <div className="row" style={{ gap: "var(--s3)" }}>
          <button className="btn btn-grad" onClick={onDone} style={{ flex: 1 }}>
            <IconCheck size={17} /> I&apos;ve done this
          </button>
          <button className="btn btn-ghost" onClick={onDone} style={{ flex: 1 }}>
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
