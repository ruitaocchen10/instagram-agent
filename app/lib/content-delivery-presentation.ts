import type { StoredConnection } from "./connection-storage";
import type { StoredContent } from "./content-delivery-storage";
import { displayPlatformName, type Delivery, type DeliveryStatus } from "./social-content";

// How a destination-local state reads to a creator. The tone carries the
// urgency; the label and detail carry the words. A view chooses styling from the
// tone rather than re-deriving a state machine it does not own.
export type DeliveryTone = "neutral" | "pending" | "success" | "warning" | "error";

export interface DeliveryState {
  tone: DeliveryTone;
  label: string;
  detail?: string;
}

export interface PresentedDelivery extends Delivery {
  connectionName: string;
  platformName: string;
  state: DeliveryState;
}

export interface ContentDeliveryGroup {
  content: StoredContent;
  // The still a view can show for this content. Media the app manages locally
  // has no URL of its own, so the shell resolves its preview and passes it in.
  previewUrl: string;
  deliveries: PresentedDelivery[];
}

export interface ScheduledDelivery {
  content: StoredContent;
  previewUrl: string;
  delivery: PresentedDelivery;
}

// UI consumers deal in reusable content with its destination-local state,
// rather than reconstructing a singleton Instagram post for every surface.
export function groupContentDeliveries(
  contents: readonly StoredContent[],
  deliveries: readonly Delivery[],
  connections: readonly StoredConnection[],
  localPreviewUrls: ReadonlyMap<string, string> = new Map(),
): ContentDeliveryGroup[] {
  const connectionNames = new Map(connections.map((connection) => [connection.id, connection.displayName]));
  const byContent = new Map<string, ContentDeliveryGroup>();
  for (const content of contents) {
    byContent.set(content.id, {
      content,
      previewUrl: previewUrlForContent(content, localPreviewUrls),
      deliveries: [],
    });
  }
  for (const delivery of deliveries) {
    const group = byContent.get(delivery.contentId);
    if (!group) continue;
    group.deliveries.push({
      ...delivery,
      connectionName: connectionNames.get(delivery.connectionId) ?? delivery.connectionId,
      platformName: displayPlatformName(delivery.platform),
      state: deliveryState(delivery),
    });
  }
  return [...byContent.values()].sort((a, b) => b.content.updatedAt - a.content.updatedAt);
}

// Content belongs to whichever lists its destinations put it in: the same
// creative can be a draft in one place and already scheduled in another.
// Content with no destination yet is still a draft the creator can finish.
export function groupsWithStatus(
  groups: readonly ContentDeliveryGroup[],
  status: DeliveryStatus,
): ContentDeliveryGroup[] {
  return groups.filter((group) =>
    group.deliveries.length === 0
      ? status === "draft"
      : group.deliveries.some((delivery) => delivery.status === status),
  );
}

// The calendar plots deliveries, not content: one creative scheduled to two
// destinations at two times is two entries, each with its own state.
export function scheduledDeliveries(groups: readonly ContentDeliveryGroup[]): ScheduledDelivery[] {
  return groups
    .flatMap((group) =>
      group.deliveries
        .filter((delivery) => delivery.status === "scheduled" && typeof delivery.scheduledAt === "number")
        .map((delivery) => ({ content: group.content, previewUrl: group.previewUrl, delivery })),
    )
    .sort((a, b) => (a.delivery.scheduledAt ?? 0) - (b.delivery.scheduledAt ?? 0));
}

export function deliveryState(delivery: Delivery): DeliveryState {
  const platformName = displayPlatformName(delivery.platform);
  if (delivery.status === "published") return { tone: "success", label: "Published" };
  if (delivery.status === "draft") return { tone: "neutral", label: "Not scheduled" };
  switch (delivery.publishState) {
    case "claimed":
    case "publishing":
      return {
        tone: "pending",
        label: "Publishing",
        detail: "Publishing or awaiting confirmation; automatic retries are paused.",
      };
    case "failed":
      return delivery.failureKind === "authentication"
        ? {
            tone: "error",
            label: "Reconnect needed",
            detail: sentence(
              delivery.publishError ?? "This destination needs to be reconnected before it can publish",
            ),
          }
        : {
            tone: "error",
            label: "Publish failed",
            detail: `${sentence(delivery.publishError ?? "Unknown error")} Retrying automatically.`,
          };
    case "canceled":
      return {
        tone: "warning",
        label: "Upload canceled",
        detail: "Automatic publishing is paused; reschedule to try again.",
      };
    // An uncertain outcome is never retried automatically, so it says which
    // platform to check rather than implying the publish simply failed.
    case "uncertain":
      return {
        tone: "warning",
        label: "Outcome unknown",
        detail: `${sentence(delivery.publishError ?? `${platformName} may already have published this`)} Check ${platformName} before rescheduling; automatic retries are paused.`,
      };
    default:
      return { tone: "neutral", label: "Scheduled" };
  }
}

// A platform's own error text may or may not end a sentence; the guidance that
// follows it has to read as a separate one either way.
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function contentDeletionConfirmation(group: ContentDeliveryGroup): string {
  const uncertain = group.deliveries.filter((delivery) => delivery.publishState === "uncertain");
  if (uncertain.length > 0) {
    return `${destinationList(uncertain)} may already have published this content because its last publish result is uncertain. Check there before deleting this local copy. Delete it anyway? This can't be undone.`;
  }
  const scheduled = group.deliveries.filter((delivery) => delivery.status === "scheduled");
  if (scheduled.length > 0) {
    return `Delete this content and cancel publishing to ${destinationList(scheduled)}? This can't be undone.`;
  }
  return "Delete this draft? This can't be undone.";
}

function destinationList(deliveries: readonly PresentedDelivery[]): string {
  const names = [...new Set(deliveries.map((delivery) => delivery.connectionName))];
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function previewUrlForContent(
  content: StoredContent,
  localPreviewUrls: ReadonlyMap<string, string>,
): string {
  return content.media.source.kind === "url"
    ? content.media.source.url
    : localPreviewUrls.get(content.media.source.assetId) ?? "";
}
