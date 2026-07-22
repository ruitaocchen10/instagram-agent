import { CAPTION_MAX } from "../sidecar/app-tool-contract";
import { fetch } from "@tauri-apps/plugin-http";
import {
  fetchMedia as fetchInstagramMedia,
  publishImage as publishInstagramImage,
  publishLocalReel as publishInstagramLocalReel,
  publishReelFromUrl as publishInstagramReelFromUrl,
  type Config,
} from "./instagram";
import type { Post } from "./types";
import { deletePost } from "./storage";
import { mediaForPost } from "./media";
import {
  deleteManagedMedia,
  deleteStagedMedia,
  stageLocalImage,
  type StagedMedia,
} from "./local-media";

export interface PublishPostInput {
  accessToken: string;
  igUserId: string;
  post: Post;
  config: Config;
  beforePublish?: () => Promise<void>;
  onProgress?: (stage: PublishStage) => void;
}

export type PublishStage = "preparing" | "uploading" | "processing" | "publishing" | "cleanup";

export interface PublishPostResult {
  mediaId: string;
  publishedPosts: Post[] | null;
  localPostRemoved: boolean;
  refreshError?: string;
  cleanupError?: string;
}

// The outward Instagram call can fail after the service has accepted the
// publish but before its response reaches us. Callers must not blindly retry
// this error because Instagram does not give this operation an idempotency key.
export class PublishOutcomeUnknownError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      "Instagram did not return a definitive publishing result. Check the account before retrying to avoid a duplicate post.",
    );
    this.name = "PublishOutcomeUnknownError";
    this.cause = cause;
  }
}

export class PublishCanceledAfterContainerError extends Error {
  constructor() {
    super("Reel upload canceled. Automatic publishing will remain paused.");
    this.name = "PublishCanceledAfterContainerError";
  }
}

interface PublishingDependencies {
  verifyMediaUrl: (imageUrl: string) => Promise<void>;
  publishImage: typeof publishInstagramImage;
  publishReelFromUrl: typeof publishInstagramReelFromUrl;
  publishLocalReel: typeof publishInstagramLocalReel;
  stageLocalImage: typeof stageLocalImage;
  deleteStagedMedia: typeof deleteStagedMedia;
  deleteManagedMedia: typeof deleteManagedMedia;
  fetchMedia: typeof fetchInstagramMedia;
  removeLocalPost: typeof deletePost;
}

const DEFAULT_DEPENDENCIES: PublishingDependencies = {
  verifyMediaUrl: verifyPublicMediaUrl,
  publishImage: publishInstagramImage,
  publishReelFromUrl: publishInstagramReelFromUrl,
  publishLocalReel: publishInstagramLocalReel,
  stageLocalImage,
  deleteStagedMedia,
  deleteManagedMedia,
  fetchMedia: fetchInstagramMedia,
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

function validatePublishablePost(post: Post): Post {
  if (!post.id.trim()) throw new Error("The target post must have an ID before publishing.");
  if (post.status === "published") throw new Error("The target post is already published.");
  if (post.caption.length > CAPTION_MAX) {
    throw new Error(`The target post caption must be ${CAPTION_MAX} characters or fewer.`);
  }
  return post;
}

// The one Instagram publishing operation used by both the composer and the
// copilot. It validates before the outward mutation and refreshes Instagram-owned
// post data before reporting success.
export async function publishPost(
  input: PublishPostInput,
  dependencyOverrides: Partial<PublishingDependencies> = {},
): Promise<PublishPostResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const post = validatePublishablePost(input.post);
  const media = mediaForPost(post);
  input.onProgress?.("preparing");
  let staged: StagedMedia | null = null;
  let publishUrl: string | null = null;
  if (media.source.kind === "url") {
    publishUrl = validateAndNormalizePublicMediaUrl(media.source.url);
    await dependencies.verifyMediaUrl(publishUrl);
  } else if (media.type === "image") {
    input.onProgress?.("uploading");
    staged = await dependencies.stageLocalImage(media.source.assetId, input.igUserId);
    publishUrl = staged.publicUrl;
  }
  try {
    await input.beforePublish?.();
  } catch (error) {
    if (staged) {
      await dependencies.deleteStagedMedia(staged.objectKey).catch(() => {});
    }
    throw error;
  }
  let mediaId: string;
  try {
    const lifecycle = {
      onProcessing: () => input.onProgress?.("processing"),
      onPublishing: () => input.onProgress?.("publishing"),
    };
    input.onProgress?.(
      media.type === "reel" && media.source.kind === "local" ? "uploading" : "processing",
    );
    if (media.type === "image") {
      mediaId = await dependencies.publishImage(
        input.accessToken,
        input.igUserId,
        publishUrl!,
        post.caption,
        input.config,
        lifecycle,
      );
    } else if (media.source.kind === "local") {
      mediaId = await dependencies.publishLocalReel(
        input.accessToken,
        input.igUserId,
        media.source.assetId,
        post.caption,
        media.shareToFeed,
        input.config,
        lifecycle,
      );
    } else {
      mediaId = await dependencies.publishReelFromUrl(
        input.accessToken,
        input.igUserId,
        publishUrl!,
        post.caption,
        media.shareToFeed,
        input.config,
        lifecycle,
      );
    }
  } catch (error) {
    if (String(error).toLowerCase().includes("canceled")) {
      throw new PublishCanceledAfterContainerError();
    }
    throw new PublishOutcomeUnknownError(error);
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
    const publishedPosts = await dependencies.fetchMedia(
      input.accessToken,
      input.igUserId,
      input.config,
    );
    return {
      mediaId,
      publishedPosts,
      localPostRemoved,
      ...(cleanupError ? { cleanupError } : {}),
    };
  } catch (error) {
    return {
      mediaId,
      publishedPosts: null,
      localPostRemoved,
      ...(cleanupError ? { cleanupError } : {}),
      refreshError: error instanceof Error ? error.message : String(error),
    };
  }
}
