import type { StoredContent } from "./content-delivery-storage";
import { deliveryFlag, type Delivery, type DeliveryPublishState } from "./social-content";
import type { Post, PostMedia, ScheduledPublishState } from "../shared/types";

// The composer, dashboard, and copilot still speak the Instagram-shaped Post.
// That shape is no longer stored: it is derived from the canonical content and
// its deliveries, which is the inverse of the migration that created them. The
// derivation is the only place that collapses many destinations into the one
// post those surfaces expect, so the rule for that collapse stays reviewable.

// Which destination speaks for the whole creative when several disagree. An
// in-flight or unresolved destination outranks a quiet one, so a collapsed post
// can never hide a claim that is blocking deletion or a result no one checked.
const PUBLISH_STATE_PRECEDENCE: readonly DeliveryPublishState[] = [
  "publishing",
  "claimed",
  "uncertain",
  "canceled",
  "failed",
  "idle",
];

function publishStateRank(state: DeliveryPublishState | undefined): number {
  const rank = PUBLISH_STATE_PRECEDENCE.indexOf(state ?? "idle");
  return rank === -1 ? PUBLISH_STATE_PRECEDENCE.length : rank;
}

// Every scheduled field on the derived post comes from this one delivery, so
// the state, its error, and its attempt history always describe each other.
function governingDelivery(deliveries: readonly Delivery[]): Delivery | undefined {
  const scheduled = deliveries.filter((delivery) => delivery.status === "scheduled");
  const candidates = scheduled.length > 0 ? scheduled : deliveries;
  return [...candidates].sort((a, b) => {
    const byState = publishStateRank(a.publishState) - publishStateRank(b.publishState);
    if (byState !== 0) return byState;
    return (a.scheduledAt ?? Number.POSITIVE_INFINITY) - (b.scheduledAt ?? Number.POSITIVE_INFINITY);
  })[0];
}

// Reusable content records the asset; whether it is posted as a Reel and
// whether that Reel also reaches the feed are the destination's choices.
export function postMediaForContent(content: StoredContent, delivery?: Delivery): PostMedia {
  if (content.media.type === "video") {
    return {
      type: "reel",
      source: content.media.source,
      shareToFeed: deliveryFlag(delivery?.platformOptions, "shareToFeed", true),
    };
  }
  return { type: "image", source: content.media.source };
}

export function postForContentDeliveries(
  content: StoredContent,
  deliveries: readonly Delivery[],
  previewUrls: ReadonlyMap<string, string> = new Map(),
): Post {
  const governing = governingDelivery(deliveries);
  const media = postMediaForContent(content, governing);
  const scheduled = governing?.status === "scheduled";
  return {
    id: content.id,
    imageUrl:
      content.media.source.kind === "url"
        ? content.media.source.url
        : previewUrls.get(content.media.source.assetId) ?? "",
    media,
    caption: content.caption,
    status: scheduled ? "scheduled" : "draft",
    updatedAt: content.updatedAt,
    ...(scheduled && typeof governing.scheduledAt === "number"
      ? { scheduledAt: governing.scheduledAt }
      : {}),
    ...(scheduled
      ? {
          publishState: (governing.publishState ?? "idle") as ScheduledPublishState,
          ...(governing.publishError ? { publishError: governing.publishError } : {}),
          ...(typeof governing.publishAttemptedAt === "number"
            ? { publishAttemptedAt: governing.publishAttemptedAt }
            : {}),
          publishAttemptCount: governing.publishAttemptCount ?? 0,
        }
      : {}),
  };
}

// The app's own working set: everything still being planned. Content whose every
// destination has published is the platform's record now, so it drops out here
// exactly as the retired `posts` table excluded published rows.
export function localPostsForContentDeliveries(
  contents: readonly StoredContent[],
  deliveries: readonly Delivery[],
  previewUrls: ReadonlyMap<string, string> = new Map(),
): Post[] {
  const byContent = new Map<string, Delivery[]>();
  for (const delivery of deliveries) {
    const existing = byContent.get(delivery.contentId);
    if (existing) existing.push(delivery);
    else byContent.set(delivery.contentId, [delivery]);
  }
  return contents
    .filter((content) => {
      const own = byContent.get(content.id) ?? [];
      return own.length === 0 || own.some((delivery) => delivery.status !== "published");
    })
    .map((content) =>
      postForContentDeliveries(
        content,
        (byContent.get(content.id) ?? []).filter((delivery) => delivery.status !== "published"),
        previewUrls,
      ),
    )
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

// Local assets the working set still depends on. Managed media outside this set
// belongs to nothing the creator can still open, so it can be reclaimed.
export function retainedLocalAssetIds(contents: readonly StoredContent[]): string[] {
  return contents.flatMap((content) =>
    content.media.source.kind === "local" ? [content.media.source.assetId] : [],
  );
}
