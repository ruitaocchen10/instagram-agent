"use client";

// Shared, informational instructions for turning a short-lived Instagram token
// (~1 hour) into a long-lived one (60 days). This is the single source of truth
// for that content — it appears both in onboarding (right after a first paste)
// and in the reconnect nudge for creators who keep hitting expiry. The app never
// performs this exchange itself: it needs the Meta app secret, so the user makes
// the ig_exchange_token GET request themselves (browser address bar or curl).
// Purely informational — nothing here is verified.
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
          Get your app secret: Meta App Dashboard → your app → App settings → Basic →{" "}
          <strong>App secret</strong> (click &quot;Show&quot;).
        </li>
        <li>
          Make one GET request — paste this into a browser address bar (with your own values
          filled in) or run it with curl:
          <pre className="upgrade-request">
            https://graph.instagram.com/access_token
            {"\n"}
            &nbsp;&nbsp;?grant_type=ig_exchange_token
            {"\n"}
            &nbsp;&nbsp;&client_secret=YOUR_APP_SECRET
            {"\n"}
            &nbsp;&nbsp;&access_token=YOUR_SHORT_LIVED_TOKEN
          </pre>
        </li>
        <li>
          Copy <code>access_token</code> from the JSON response — that&apos;s your 60-day token.
        </li>
        <li>Paste that long-lived token back into this app when you connect.</li>
      </ol>

      <div className="hint">
        The exchange needs your app secret, so it happens outside this app — there&apos;s no
        dedicated UI for it, just that one request. Once connected with a long-lived token,
        refreshes are automatic.
      </div>
    </div>
  );
}
