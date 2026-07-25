import { fetch } from "@tauri-apps/plugin-http";
import type { Post } from "./types";
import { deletePost } from "./storage";
import { mediaForPost } from "./media";
import { requirePlatformAdapter } from "./platforms/registry";
import {
  contentMediaForPost,
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
import {
  deleteManagedMedia,
  deleteStagedMedia,
  stageLocalImage,
  type StagedMedia,
} from "./local-media";

export interface PublishPostInput {
  platform: Platform;
  accessToken: string;
  externalIdentityId: string;
  post: Post;
  beforePublish?: () => Promise<void>;
  onProgress?: (stage: PublishStage) => void;
}

export type PublishStage = "preparing" | "uploading" | "processing" | "publishing" | "cleanup";

export interface PublishPostResult {
  mediaId: string;
  // The platform's published feed as it stands after this publication, or null
  // when it could not be read — because the platform offers no such read, or
  // because reading it failed (`refreshError`). Publication itself succeeded
  // either way.
  publishedContent: PublishedItem[] | null;
  localPostRemoved: boolean;
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
  deleteManagedMedia: typeof deleteManagedMedia;
  removeLocalPost: typeof deletePost;
}

const DEFAULT_DEPENDENCIES: PublishingDependencies = {
  verifyMediaUrl: verifyPublicMediaUrl,
  resolveAdapter: requirePlatformAdapter,
  stageLocalImage,
  deleteStagedMedia,
  deleteManagedMedia,
  removeLocalPost: deletePost,
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

// Transitional bridge for the legacy Instagram-shaped post: it is checked
// against the adapter's declared capabilities through the same validation the
// composer runs, so platform rules stay in one place.
function validatePublishablePost(
  post: Post,
  adapter: SocialPlatformAdapter,
  connectionId: string,
): Post {
  if (!post.id.trim()) throw new Error("The target post must have an ID before publishing.");
  if (post.status === "published") throw new Error("The target post is already published.");

  const content: Content = { id: post.id, caption: post.caption, media: contentMediaForPost(post) };
  const delivery: Delivery = {
    id: `publish-${post.id}`,
    contentId: post.id,
    connectionId,
    platform: adapter.platform,
    status: "draft",
  };
  const validationError = validateDelivery(content, delivery, adapter)[0];
  if (validationError?.field === "caption") {
    throw new Error(
      `The target post caption must be ${adapter.capabilities.maxCaptionLength} characters or fewer.`,
    );
  }
  if (validationError) throw new Error(validationError.message);
  return post;
}

// The one publishing operation used by both the composer and the copilot. It
// owns everything platform-neutral — validation, public media staging, durable
// cleanup — and routes the outward mutation through the platform's adapter.
export async function publishPost(
  input: PublishPostInput,
  dependencyOverrides: Partial<PublishingDependencies> = {},
): Promise<PublishPostResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const adapter = dependencies.resolveAdapter(input.platform);
  const credentials: PublicationCredentials = {
    accessToken: input.accessToken,
    externalIdentityId: input.externalIdentityId,
  };
  const post = validatePublishablePost(input.post, adapter, input.externalIdentityId);
  const media = mediaForPost(post);
  const mediaType = media.type === "reel" ? "video" : "image";
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
      caption: post.caption,
      ...(media.type === "reel" ? { platformOptions: { shareToFeed: media.shareToFeed } } : {}),
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
    throw new PublishOutcomeUnknownError(input.platform, error);
  }
  input.onProgress?.("cleanup");
  let localPostRemoved = true;
  const cleanupErrors: string[] = [];
  if (staged) {
    try {
      await dependencies.deleteStagedMedia(staged.objectKey);
    } catch (error) {
      cleanupErrors.push(`temporary R2 media could not be deleted: ${String(error)}`);
    }
  }
  try {
    await dependencies.removeLocalPost(post.id);
  } catch (error) {
    localPostRemoved = false;
    cleanupErrors.push(error instanceof Error ? error.message : String(error));
  }
  if (localPostRemoved && media.source.kind === "local") {
    try {
      await dependencies.deleteManagedMedia(media.source.assetId);
    } catch (error) {
      cleanupErrors.push(`managed local media could not be deleted: ${String(error)}`);
    }
  }
  const cleanupError = cleanupErrors.length > 0 ? cleanupErrors.join("; ") : undefined;
  try {
    const published = await readPublishedContentThrough(adapter, credentials);
    return {
      mediaId: outcome.externalId,
      publishedContent: published.supported ? published.items : null,
      localPostRemoved,
      ...(cleanupError ? { cleanupError } : {}),
    };
  } catch (error) {
    return {
      mediaId: outcome.externalId,
      publishedContent: null,
      localPostRemoved,
      ...(cleanupError ? { cleanupError } : {}),
      refreshError: error instanceof Error ? error.message : String(error),
    };
  }
}
