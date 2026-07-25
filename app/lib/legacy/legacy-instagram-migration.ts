import { contentMediaForPost, createDelivery, type Content, type Delivery } from "../content/social-content";
import type { Post } from "../shared/types";

// This identifier is deliberately stable: the connection migration can attach
// the existing singleton credential to it without making a secret part of a
// content or delivery row.
export const LEGACY_INSTAGRAM_CONNECTION_ID = "legacy-instagram-default";

export interface LegacyInstagramMigration {
  content: Content;
  delivery: Delivery;
  updatedAt: number;
}

// A pure representation of the database migration. Keeping this conversion
// outside SQL makes the recoverable user intent explicit and testable.
export function migrateLegacyInstagramPost(post: Post): LegacyInstagramMigration {
  const content: Content = {
    id: post.id,
    caption: post.caption,
    media: contentMediaForPost(post),
  };
  const reel = post.media?.type === "reel" ? post.media : undefined;
  const delivery = createDelivery({
    id: `legacy-instagram-${post.id}`,
    contentId: content.id,
    connectionId: LEGACY_INSTAGRAM_CONNECTION_ID,
    platform: "instagram",
    status: post.status,
    scheduledAt: post.scheduledAt,
    publishState: post.publishState,
    publishError: post.publishError,
    ...(post.publishState === "failed" ? { failureKind: "retryable" as const } : {}),
    publishAttemptedAt: post.publishAttemptedAt,
    publishAttemptCount: post.publishAttemptCount,
    publishedAt: post.publishedAt,
    ...(reel ? { platformOptions: { shareToFeed: reel.shareToFeed } } : {}),
  });

  return { content, delivery, updatedAt: post.updatedAt ?? 0 };
}
