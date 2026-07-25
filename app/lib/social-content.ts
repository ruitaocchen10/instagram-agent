import { mediaForPost } from "./media";
import type { MediaSource, Post } from "./types";

// Platform IDs remain open until another concrete adapter is introduced.
// The adapter registry, rather than a speculative union, defines support.
export type Platform = string;

export interface Content {
  id: string;
  caption: string;
  media: ContentMedia;
}

// Reusable content describes the asset without choosing a platform's post
// format. Delivery options hold platform-specific choices such as whether an
// Instagram video is shared to the feed.
export type ContentMedia = {
  type: "image" | "video";
  source: MediaSource;
};

export interface Delivery {
  id: string;
  contentId: string;
  connectionId: string;
  platform: Platform;
  captionOverride?: string;
}

export type DeliveryInput = Delivery;

export interface DeliveryCapabilities {
  mediaTypes: readonly ContentMedia["type"][];
  maxCaptionLength: number;
}

export function contentMediaForPost(post: Pick<Post, "imageUrl" | "media">): ContentMedia {
  const media = mediaForPost(post);
  return {
    type: media.type === "reel" ? "video" : "image",
    source: media.source,
  };
}

export interface PlatformAdapter {
  platform: Platform;
  capabilities: DeliveryCapabilities;
}

export interface DeliveryValidationError {
  field: "caption" | "connection" | "media";
  message: string;
}

export function createDelivery(input: DeliveryInput): Delivery {
  if (!input.id.trim()) throw new Error("A delivery needs an ID.");
  if (!input.contentId.trim()) throw new Error("A delivery needs content.");
  if (!input.connectionId.trim()) throw new Error("A delivery needs a connection.");
  if (!input.platform.trim()) throw new Error("A delivery needs a platform.");

  const captionOverride = input.captionOverride?.trim();
  return {
    id: input.id,
    contentId: input.contentId,
    connectionId: input.connectionId,
    platform: input.platform,
    ...(captionOverride ? { captionOverride } : {}),
  };
}

export function captionForDelivery(content: Content, delivery: Delivery): string {
  return delivery.captionOverride ?? content.caption;
}

export function validateDelivery(
  content: Content,
  delivery: Delivery,
  adapter: PlatformAdapter,
): DeliveryValidationError[] {
  if (delivery.platform !== adapter.platform) {
    return [
      {
        field: "connection",
        message: `This delivery targets ${platformName(delivery.platform)} but the selected adapter is ${platformName(adapter.platform)}.`,
      },
    ];
  }

  const errors: DeliveryValidationError[] = [];
  const caption = captionForDelivery(content, delivery);
  if (caption.length > adapter.capabilities.maxCaptionLength) {
    errors.push({
      field: "caption",
      message: `${platformName(adapter.platform)} captions must be ${adapter.capabilities.maxCaptionLength} characters or fewer.`,
    });
  }
  if (!adapter.capabilities.mediaTypes.includes(content.media.type)) {
    errors.push({
      field: "media",
      message: `${platformName(adapter.platform)} does not support ${content.media.type} deliveries.`,
    });
  }
  return errors;
}

function platformName(platform: Platform): string {
  if (platform === "x") return "X";
  return `${platform.slice(0, 1).toUpperCase()}${platform.slice(1)}`;
}
