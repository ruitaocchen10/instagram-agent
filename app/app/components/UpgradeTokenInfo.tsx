"use client";

// Shared, informational instructions for turning a short-lived Instagram token
// (~1 hour) into a long-lived one (60 days). This is the single source of truth
// for that content — it appears both in onboarding (right after a first paste)
// and in the reconnect nudge for creators who keep hitting expiry. The app never
// performs this exchange itself: it needs the Meta app secret, so the user does
// it manually in Meta's tools. Purely informational — nothing here is verified.
export default function UpgradeTokenInfo() {
  return (
    <div className="stack" style={{ gap: "var(--s3)" }}>
      <div className="muted" style={{ fontSize: 13.5, lineHeight: 1.55 }}>
        A <strong>short-lived</strong> token lasts only about an hour. A{" "}
        <strong>long-lived</strong> token lasts <strong>60 days</strong> and this app keeps it
        alive for you automatically. Upgrading is a one-time step you do in Meta&apos;s tools:
      </div>

      <ol className="upgrade-steps">
        <li>
          In Meta&apos;s API tools, exchange your short-lived token using the{" "}
          <code>ig_exchange_token</code> grant with your app secret.
        </li>
        <li>
          Meta returns a 60-day <code>access_token</code>. Copy it.
        </li>
        <li>Paste that long-lived token back into this app when you connect.</li>
      </ol>

      <div className="hint">
        The exchange needs your app secret, so it happens in Meta&apos;s tools — never in this app.
        Once connected with a long-lived token, refreshes are automatic.
      </div>
    </div>
  );
}
