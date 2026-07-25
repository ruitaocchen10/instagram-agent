import type { PresentedDelivery } from "@/lib/content/content-delivery-presentation";
import { IconClock, IconExternal } from "../chrome/icons";

function fmtWhen(ms: number) {
  return new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// One row per destination: who it publishes as, on which platform, and where
// that delivery stands. A destination's trouble is reported against that
// destination alone — the others carry on.
export default function DeliveryStateList({
  deliveries,
}: {
  deliveries: PresentedDelivery[];
}) {
  if (deliveries.length === 0) {
    return <div className="dest-empty muted">No destination yet — edit to choose where this publishes.</div>;
  }
  return (
    <ul className="dest-list">
      {deliveries.map((delivery) => (
        <li key={delivery.id} className="dest-row">
          <div className="dest-head">
            <span className="dest-name" title={`${delivery.connectionName} on ${delivery.platformName}`}>
              {delivery.connectionName}
              <span className="muted"> · {delivery.platformName}</span>
            </span>
            <span className={`badge badge-tone-${delivery.state.tone}`}>
              <span className="badge-dot" />
              {delivery.state.label}
            </span>
          </div>
          {typeof delivery.scheduledAt === "number" && delivery.status === "scheduled" && (
            <div className="dest-when row" style={{ gap: 5 }}>
              <IconClock size={12} /> {fmtWhen(delivery.scheduledAt)}
            </div>
          )}
          {delivery.state.detail && (
            <div className={`dest-detail dest-detail-${delivery.state.tone}`}>{delivery.state.detail}</div>
          )}
          {/* A published delivery links to the platform's own copy so the
              creator can verify it, but only when the platform gave us one. */}
          {delivery.externalResult?.permalink && (
            <a
              className="dest-link"
              href={delivery.externalResult.permalink}
              target="_blank"
              rel="noreferrer"
            >
              <IconExternal size={12} /> View on {delivery.platformName}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
