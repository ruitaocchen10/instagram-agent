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
  // Platform-specific publication choices belong to the delivery so the same
  // content can be sent differently to each destination.
  platformOptions?: Record<string, string | number | boolean>;
  status: DeliveryStatus;
  scheduledAt?: number;
  publishState?: DeliveryPublishState;
  publishError?: string;
  failureKind?: DeliveryFailureKind;
  publishAttemptedAt?: number;
  publishAttemptCount?: number;
  publishedAt?: number;
  externalResult?: DeliveryExternalResult;
}

export type DeliveryStatus = "draft" | "scheduled" | "published";
export type DeliveryPublishState =
  | "idle"
  | "claimed"
  | "publishing"
  | "failed"
  | "uncertain"
  | "canceled";

export type DeliveryFailureKind = "retryable" | "definitive" | "authentication";

export interface DeliveryExternalResult {
  id?: string;
  permalink?: string;
}

export type DeliveryInput = Omit<Delivery, "status"> & { status?: DeliveryStatus };

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
    status: input.status ?? "draft",
    ...(captionOverride ? { captionOverride } : {}),
    ...(input.platformOptions ? { platformOptions: { ...input.platformOptions } } : {}),
    ...(typeof input.scheduledAt === "number" ? { scheduledAt: input.scheduledAt } : {}),
    ...(input.publishState ? { publishState: input.publishState } : {}),
    ...(input.publishError ? { publishError: input.publishError } : {}),
    ...(input.failureKind ? { failureKind: input.failureKind } : {}),
    ...(typeof input.publishAttemptedAt === "number"
      ? { publishAttemptedAt: input.publishAttemptedAt }
      : {}),
    ...(typeof input.publishAttemptCount === "number"
      ? { publishAttemptCount: input.publishAttemptCount }
      : {}),
    ...(typeof input.publishedAt === "number" ? { publishedAt: input.publishedAt } : {}),
    ...(input.externalResult ? { externalResult: input.externalResult } : {}),
  };
}

export function claimScheduledDelivery(delivery: Delivery, attemptedAt: number): Delivery {
  assertScheduledDelivery(delivery);
  return {
    ...delivery,
    publishState: "claimed",
    publishError: undefined,
    failureKind: undefined,
    publishAttemptedAt: attemptedAt,
    publishAttemptCount: (delivery.publishAttemptCount ?? 0) + 1,
  };
}

export function markDeliveryPublishing(delivery: Delivery, attemptedAt: number): Delivery {
  assertClaimedDelivery(delivery);
  return { ...delivery, publishState: "publishing", publishAttemptedAt: attemptedAt };
}

export function recordDeliveryFailure(
  delivery: Delivery,
  error: string,
  attemptedAt: number,
  failureKind: DeliveryFailureKind = "retryable",
): Delivery {
  return recordDeliveryResult(delivery, "failed", error, attemptedAt, failureKind);
}

export function recordDeliveryOutcomeUnknown(
  delivery: Delivery,
  error: string,
  attemptedAt: number,
): Delivery {
  return recordDeliveryResult(delivery, "uncertain", error, attemptedAt);
}

export function recordDeliveryCanceled(
  delivery: Delivery,
  error: string,
  attemptedAt: number,
): Delivery {
  return recordDeliveryResult(delivery, "canceled", error, attemptedAt);
}

export function recordDeliveryPublished(
  delivery: Delivery,
  externalResult: DeliveryExternalResult | undefined,
  publishedAt: number,
): Delivery {
  assertInFlightDelivery(delivery);
  return {
    ...delivery,
    status: "published",
    scheduledAt: undefined,
    publishState: "idle",
    publishError: undefined,
    failureKind: undefined,
    publishAttemptedAt: publishedAt,
    publishedAt,
    ...(externalResult ? { externalResult } : {}),
  };
}

export function dueScheduledDeliveries(deliveries: readonly Delivery[], now: number): Delivery[] {
  return deliveries.filter(
    (delivery) =>
      delivery.status === "scheduled" &&
      typeof delivery.scheduledAt === "number" &&
      Number.isFinite(delivery.scheduledAt) &&
      delivery.scheduledAt <= now &&
      isAutomaticallyRetryable(delivery.publishState, delivery.failureKind) &&
      (delivery.publishState !== "failed" ||
        typeof delivery.publishAttemptedAt !== "number" ||
        delivery.publishAttemptedAt + retryDelayMs(delivery.publishAttemptCount ?? 1) <= now),
  );
}

function recordDeliveryResult(
  delivery: Delivery,
  publishState: Extract<DeliveryPublishState, "failed" | "uncertain" | "canceled">,
  error: string,
  attemptedAt: number,
  failureKind?: DeliveryFailureKind,
): Delivery {
  assertInFlightDelivery(delivery);
  return {
    ...delivery,
    publishState,
    publishError: error,
    failureKind: publishState === "failed" ? failureKind ?? "retryable" : undefined,
    publishAttemptedAt: attemptedAt,
  };
}

function assertScheduledDelivery(delivery: Delivery): void {
  if (delivery.status !== "scheduled") throw new Error("Only scheduled deliveries can be claimed.");
  if (!isAutomaticallyRetryable(delivery.publishState, delivery.failureKind)) {
    throw new Error("This delivery is already being published or needs its previous result checked.");
  }
}

function assertClaimedDelivery(delivery: Delivery): void {
  if (delivery.status !== "scheduled" || delivery.publishState !== "claimed") {
    throw new Error("Only a claimed scheduled delivery can begin publishing.");
  }
}

function assertInFlightDelivery(delivery: Delivery): void {
  if (
    delivery.status !== "scheduled" ||
    (delivery.publishState !== "claimed" && delivery.publishState !== "publishing")
  ) {
    throw new Error("Only an in-flight scheduled delivery can record a publishing result.");
  }
}

function isAutomaticallyRetryable(
  state: DeliveryPublishState | undefined,
  failureKind: DeliveryFailureKind | undefined,
): boolean {
  return (
    state === undefined ||
    state === "idle" ||
    (state === "failed" && (failureKind === undefined || failureKind === "retryable"))
  );
}

function retryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, Math.min(attemptCount - 1, 6));
  return 60_000 * 2 ** exponent;
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
