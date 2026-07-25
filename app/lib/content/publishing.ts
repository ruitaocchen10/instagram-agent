import { fetch } from "@tauri-apps/plugin-http";
import { requirePlatformAdapter } from "../platforms/registry";
import {
  captionForDelivery,
  displayPlatformName,
  validateDelivery,
  type Content,
  type Delivery,
  type Platform,
  type PreparedMedia,
  type PublicationCredentials,
  type PublicationOutcome,
  type PublishedItem,
  type SocialPlatformAdapter,
} from "./social-content";
import { readPublishedContentThrough } from "./published-content";
import { deleteStagedMedia, stageLocalImage, type StagedMedia } from "../media/local-media";

export interface PublishDeliveryInput {
  // The reusable creative and the one destination being published to. Together
  // they carry everything the platform needs: the asset, the caption this
  // destination should use, and that destination's own publishing options.
  content: Content;
  delivery: Delivery;
  accessToken: string;
  externalIdentityId: string;
  beforePublish?: () => Promise<void>;
  onProgress?: (stage: PublishStage) => void;
}

export type PublishStage = "preparing" | "uploading" | "processing" | "publishing" | "cleanup";

export interface PublishDeliveryResult {
  externalId: string;
  // The platform's published feed as it stands after this publication, or null
  // when it could not be read — because the platform offers no such read, or
  // because reading it failed (`refreshError`). Publication itself succeeded
  // either way.
  publishedContent: PublishedItem[] | null;
  refreshError?: string;
  cleanupError?: string;
}

// The outward publishing call can fail after the platform has accepted the
// publication but before its response reaches us. Callers must not blindly
// retry this error: platforms give the operation no idempotency key.
export class PublishOutcomeUnknownError extends Error {
  readonly cause: unknown;

  constructor(platform: Platform, cause: unknown) {
    super(
      `${displayPlatformName(platform)} did not return a definitive publishing result. Check the account before retrying to avoid a duplicate post.`,
    );
    this.name = "PublishOutcomeUnknownError";
    this.cause = cause;
  }
}

export class PublishCanceledAfterContainerError extends Error {
  constructor() {
    super("Upload canceled. Automatic publishing will remain paused.");
    this.name = "PublishCanceledAfterContainerError";
  }
}

// A definitive, connection-local rejection. It carries the adapter's own error
// so the shell can still read platform-specific detail such as whether the
// credential was revoked rather than merely expired.
export class PublishAuthenticationError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "PublishAuthenticationError";
    this.cause = cause;
  }
}

interface PublishingDependencies {
  verifyMediaUrl: (imageUrl: string) => Promise<void>;
  resolveAdapter: (platform: Platform) => SocialPlatformAdapter;
  stageLocalImage: typeof stageLocalImage;
  deleteStagedMedia: typeof deleteStagedMedia;
}

const DEFAULT_DEPENDENCIES: PublishingDependencies = {
  verifyMediaUrl: verifyPublicMediaUrl,
  resolveAdapter: requirePlatformAdapter,
  stageLocalImage,
  deleteStagedMedia,
};

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized)
  );
}

function validateAndNormalizePublicMediaUrl(value: string): string {
  const imageUrl = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    throw new Error("Publishing requires a publicly reachable http(s) URL for the image.");
  }

  const hostname = parsed.hostname.toLowerCase();
  const privateHostname =
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    isPrivateIpv4(hostname) ||
    isPrivateIpv6(hostname);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    privateHostname
  ) {
    throw new Error(
      "Publishing requires a publicly reachable http(s) URL; local files, localhost, and private network addresses cannot be published.",
    );
  }
  return imageUrl;
}

async function verifyPublicMediaUrl(imageUrl: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(imageUrl, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 405 || response.status === 501) {
      response = await fetch(imageUrl, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        redirect: "follow",
        signal: AbortSignal.timeout(10_000),
      });
    }
  } catch {
    throw new Error(
      "Publishing requires a publicly reachable image URL; the media endpoint could not be reached.",
    );
  }
  if (!response.ok) {
    throw new Error(
      `Publishing requires a publicly reachable image URL; the media endpoint returned HTTP ${response.status}.`,
    );
  }
  if (response.url) validateAndNormalizePublicMediaUrl(response.url);
}

// The delivery is checked against the adapter's declared capabilities through
// the same validation the composer runs, so platform rules stay in one place.
function validatePublishableDelivery(
  content: Content,
  delivery: Delivery,
  adapter: SocialPlatformAdapter,
): void {
  if (!content.id.trim()) throw new Error("The target content must have an ID before publishing.");
  if (delivery.contentId !== content.id) {
    throw new Error("The delivery does not belong to the content being published.");
  }
  if (delivery.status === "published") throw new Error("This delivery has already been published.");

  const validationError = validateDelivery(content, delivery, adapter)[0];
  if (validationError?.field === "caption") {
    throw new Error(
      `The caption for this destination must be ${adapter.capabilities.maxCaptionLength} characters or fewer.`,
    );
  }
  if (validationError) throw new Error(validationError.message);
}

// The one publishing operation used by the composer, the scheduler, and the
// copilot. It owns everything platform-neutral — validation, public media
// staging, staging cleanup — and routes the outward mutation through the
// platform's adapter. Recording the delivery's own durable lifecycle belongs to
// the caller that holds its claim.
export async function publishDelivery(
  input: PublishDeliveryInput,
  dependencyOverrides: Partial<PublishingDependencies> = {},
): Promise<PublishDeliveryResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const platform = input.delivery.platform;
  const adapter = dependencies.resolveAdapter(platform);
  const credentials: PublicationCredentials = {
    accessToken: input.accessToken,
    externalIdentityId: input.externalIdentityId,
  };
  validatePublishableDelivery(input.content, input.delivery, adapter);
  const media = input.content.media;
  const mediaType = media.type;
  input.onProgress?.("preparing");
  let staged: StagedMedia | null = null;
  let prepared: PreparedMedia;
  if (media.source.kind === "url") {
    prepared = {
      type: mediaType,
      kind: "public-url",
      url: validateAndNormalizePublicMediaUrl(media.source.url),
    };
    await dependencies.verifyMediaUrl(prepared.url);
  } else if (adapter.directLocalUpload.includes(mediaType)) {
    prepared = { type: mediaType, kind: "local-asset", assetId: media.source.assetId };
  } else {
    // Public staging holds images only — staged objects are written as JPEG —
    // so a platform that cannot upload local video itself has no path to it.
    if (mediaType !== "image") {
      throw new Error(
        `${displayPlatformName(adapter.platform)} cannot publish a local ${mediaType} yet; publish it from a public URL instead.`,
      );
    }
    input.onProgress?.("uploading");
    staged = await dependencies.stageLocalImage(media.source.assetId, input.externalIdentityId);
    prepared = { type: mediaType, kind: "public-url", url: staged.publicUrl };
  }
  try {
    await input.beforePublish?.();
  } catch (error) {
    if (staged) {
      await dependencies.deleteStagedMedia(staged.objectKey).catch(() => {});
    }
    throw error;
  }
  let outcome: PublicationOutcome;
  try {
    // A local asset the adapter uploads itself is still travelling; anything
    // already public is now the platform's to fetch and process.
    input.onProgress?.(prepared.kind === "local-asset" ? "uploading" : "processing");
    outcome = await adapter.publish({
      media: prepared,
      caption: captionForDelivery(input.content, input.delivery),
      ...(input.delivery.platformOptions ? { platformOptions: input.delivery.platformOptions } : {}),
      credentials,
      lifecycle: {
        onProcessing: () => input.onProgress?.("processing"),
        onPublishing: () => input.onProgress?.("publishing"),
      },
    });
  } catch (error) {
    // Only the adapter can read its platform's failures; the publisher just
    // maps that verdict onto the lifecycle the callers already handle.
    const classification = adapter.classifyPublishFailure(error);
    if (classification === "canceled") throw new PublishCanceledAfterContainerError();
    if (classification === "authentication") throw new PublishAuthenticationError(error);
    throw new PublishOutcomeUnknownError(platform, error);
  }
  input.onProgress?.("cleanup");
  // Only the temporary public staging copy is reclaimed here. The creative's own
  // managed asset still belongs to its content record, which outlives this one
  // destination's publication.
  const cleanupErrors: string[] = [];
  if (staged) {
    try {
      await dependencies.deleteStagedMedia(staged.objectKey);
    } catch (error) {
      cleanupErrors.push(`temporary R2 media could not be deleted: ${String(error)}`);
    }
  }
  const cleanupError = cleanupErrors.length > 0 ? cleanupErrors.join("; ") : undefined;
  try {
    const published = await readPublishedContentThrough(adapter, credentials);
    return {
      externalId: outcome.externalId,
      publishedContent: published.supported ? published.items : null,
      ...(cleanupError ? { cleanupError } : {}),
    };
  } catch (error) {
    return {
      externalId: outcome.externalId,
      publishedContent: null,
      ...(cleanupError ? { cleanupError } : {}),
      refreshError: error instanceof Error ? error.message : String(error),
    };
  }
}
