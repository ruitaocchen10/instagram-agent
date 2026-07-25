import { CAPTION_MAX } from "../../sidecar/app-tool-contract";
import {
  contentMediaForPost,
  validateDelivery,
  type Content,
  type Delivery,
  type PlatformAdapter,
} from "../social-content";
import type { Post } from "../types";

// The first concrete adapter establishes the shared capability contract while
// existing Instagram publishing continues unchanged. The next slice routes
// publication through this adapter instead of callers importing Instagram APIs.
export const instagramAdapter: PlatformAdapter = {
  platform: "instagram",
  capabilities: {
    mediaTypes: ["image", "video"],
    maxCaptionLength: CAPTION_MAX,
  },
};

// Transitional bridge for the existing Instagram-shaped persistence model.
// It keeps platform validation local while callers migrate to Content/Delivery.
export function validateInstagramPost(post: Post, connectionId: string): void {
  const content: Content = { id: post.id, caption: post.caption, media: contentMediaForPost(post) };
  const delivery: Delivery = {
    id: `legacy-instagram-${post.id}`,
    contentId: post.id,
    connectionId,
    platform: instagramAdapter.platform,
    status: "draft",
  };
  const validationError = validateDelivery(content, delivery, instagramAdapter)[0];
  if (validationError?.field === "caption") {
    throw new Error(
      `The target post caption must be ${instagramAdapter.capabilities.maxCaptionLength} characters or fewer.`,
    );
  }
  if (validationError) throw new Error(validationError.message);
}
