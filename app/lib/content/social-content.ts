import { mediaForPost } from "../media/media";
import type { MediaSource, Post } from "../shared/types";

// Platform IDs remain open until another concrete adapter is introduced.
// The adapter registry, rather than a speculative union, defines support.
export type Platform = string;

// A connection is the durable, non-secret identity of one destination. Secret
// credentials deliberately live outside SQLite, in a per-connection keychain
// entry. Keeping this type beside Content and Delivery makes the ownership
// boundary explicit to every adapter.
export type ConnectionHealth = "ready" | "attention" | "unknown" | "disconnected";

// Metadata may explain a credential's lifecycle, but it must never contain
// credential material. The secret itself belongs only in the OS keychain.
export interface ConnectionCredentialMetadata {
  expiresAt?: number;
  expirySource?: "estimated" | "platform";
  lastRefreshedAt?: number;
}

export interface Connection {
  id: string;
  platform: Platform;
  externalIdentityId?: string;
  displayName: string;
  health: ConnectionHealth;
  capabilities?: DeliveryCapabilities;
  credentialMetadata?: ConnectionCredentialMetadata;
}

export function assertConnectionId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error("A connection ID may contain only letters, numbers, hyphens, and underscores.");
  }
}

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

// An audience figure a platform reports for something it has published.
export type PublishedMetric = "likes" | "comments";

// What an adapter can read back about a connection's published work. Absence is
// declared rather than inferred: a platform that reports no engagement figures
// says so, so the app shows nothing instead of a fabricated zero, and a platform
// that cannot list published work at all is not asked for it.
export interface PublishedReadCapabilities {
  publishedHistory: boolean;
  metrics: readonly PublishedMetric[];
}

export type PublishedMetrics = Partial<Record<PublishedMetric, number>>;

// One item the platform reports as published for a connection. This is the
// platform's own record, not a Delivery: the app may never have created it, and
// keeps nothing of it locally.
export interface PublishedItem {
  externalId: string;
  caption: string;
  media?: ContentMedia;
  // A still the platform offers for the item — its own frame for a video, the
  // image itself otherwise.
  previewUrl?: string;
  permalink?: string;
  publishedAt?: number;
  metrics?: PublishedMetrics;
}

// Credentials are handed to an adapter for a single publication and are never
// stored by it. `externalIdentityId` is the platform's own ID for the account
// behind the connection.
export interface PublicationCredentials {
  accessToken: string;
  externalIdentityId: string;
}

// What a platform needs collected to authorize a connection. The connect screen
// renders this instead of knowing any platform's credential vocabulary.
export interface CredentialRequest {
  label: string;
  placeholder: string;
  hint: string;
}

// The credential the app holds for one connection: the secret itself, which
// belongs only in the keychain, plus the non-secret lifecycle metadata stored
// beside the connection.
export interface PlatformCredential {
  secret: string;
  metadata: ConnectionCredentialMetadata;
}

// The platform's own view of the account behind a connection. Handle, name,
// audience size, and avatar are what every platform exposes; anything
// platform-shaped stays inside the adapter.
export interface ConnectionIdentity {
  externalIdentityId: string;
  handle: string;
  // How the app labels this destination — the '@handle' convention is the
  // adapter's choice, not every platform's.
  displayName: string;
  fullName?: string;
  audienceCount?: number;
  avatarUrl?: string;
}

export interface EstablishedConnection {
  identity: ConnectionIdentity;
  credential: PlatformCredential;
}

// Why a credential can no longer be used. "expired" is recoverable by
// reconnecting the same account; "revoked" means this credential is dead and a
// new one has to be issued.
export type CredentialFailure = "expired" | "revoked";

// When a platform lets a credential be rolled forward. The adapter declares its
// platform's rule and the neutral lifecycle schedules refreshes against it.
export interface CredentialLifetimePolicy {
  // Assumed lifetime of a freshly issued credential, used to derive its age
  // when the platform never told us when it was issued.
  assumedLifetimeMs: number;
  // Minimum age before the platform will accept a refresh.
  refreshFloorMs: number;
  // How close to expiry refreshing starts.
  refreshWindowMs: number;
}

// Media resolved into a form the platform can ingest. The publisher, not the
// adapter, decides which form applies: local media is staged at a public URL
// unless the adapter declares it uploads that media type directly.
export type PreparedMedia =
  | { type: ContentMedia["type"]; kind: "public-url"; url: string }
  | { type: ContentMedia["type"]; kind: "local-asset"; assetId: string };

export interface PublicationLifecycle {
  onProcessing?: () => void;
  onPublishing?: () => void;
}

export interface PublicationRequest {
  media: PreparedMedia;
  caption: string;
  platformOptions?: Record<string, string | number | boolean>;
  credentials: PublicationCredentials;
  lifecycle?: PublicationLifecycle;
}

export interface PublicationOutcome {
  externalId: string;
  permalink?: string;
}

// Why a publication attempt failed, in the only terms the publisher needs:
// "authentication" is definitive and connection-local, "canceled" means the
// operator stopped an upload the platform had already begun staging, and
// "uncertain" means the platform may or may not have accepted the publication.
export type PublishFailureClassification = "authentication" | "canceled" | "uncertain";

// The full adapter for one platform: how a connection to it is authorized and
// kept alive, and how a delivery reaches it. It extends the validation-facing
// adapter so the composer can describe a destination from a stored connection
// snapshot without that snapshot having to carry any behavior.
export interface SocialPlatformAdapter extends PlatformAdapter {
  credentialRequest: CredentialRequest;
  credentialLifetime: CredentialLifetimePolicy;
  // Validates a credential the creator supplied and reports the identity behind
  // it, along with the credential to store — which may be a longer-lived one the
  // platform issued in exchange.
  establishConnection(secret: string, now: number): Promise<EstablishedConnection>;
  // Rolls a credential's window forward. Throws when the platform declines,
  // including when the credential is not old enough to be refreshed yet.
  refreshCredential(secret: string, now: number): Promise<PlatformCredential>;
  // Reads a failure as a verdict on the credential, or undefined when the
  // failure was about something else.
  classifyCredentialFailure(error: unknown): CredentialFailure | undefined;
  fetchIdentity(credentials: PublicationCredentials): Promise<ConnectionIdentity>;
  // Media types this adapter uploads itself from a local asset. Anything else
  // local must be staged at a public URL before the platform can fetch it.
  directLocalUpload: readonly ContentMedia["type"][];
  publish(request: PublicationRequest): Promise<PublicationOutcome>;
  classifyPublishFailure(error: unknown): PublishFailureClassification;
  publishedRead: PublishedReadCapabilities;
  // Lists what the platform has published for this connection, most recent
  // first. Only defined by an adapter that declares `publishedHistory`, so a
  // platform with no such read is unsupported rather than silently empty.
  fetchPublishedContent?(credentials: PublicationCredentials): Promise<PublishedItem[]>;
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
        message: `This delivery targets ${displayPlatformName(delivery.platform)} but the selected adapter is ${displayPlatformName(adapter.platform)}.`,
      },
    ];
  }

  const errors: DeliveryValidationError[] = [];
  const caption = captionForDelivery(content, delivery);
  if (caption.length > adapter.capabilities.maxCaptionLength) {
    errors.push({
      field: "caption",
      message: `${displayPlatformName(adapter.platform)} captions must be ${adapter.capabilities.maxCaptionLength} characters or fewer.`,
    });
  }
  if (!adapter.capabilities.mediaTypes.includes(content.media.type)) {
    errors.push({
      field: "media",
      message: `${displayPlatformName(adapter.platform)} does not support ${content.media.type} deliveries.`,
    });
  }
  return errors;
}

export function displayPlatformName(platform: Platform): string {
  if (platform === "x") return "X";
  return `${platform.slice(0, 1).toUpperCase()}${platform.slice(1)}`;
}
