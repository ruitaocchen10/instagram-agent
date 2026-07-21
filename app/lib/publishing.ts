import { CAPTION_MAX } from "../sidecar/app-tool-contract";
import { fetch } from "@tauri-apps/plugin-http";
import {
  fetchMedia as fetchInstagramMedia,
  publishImage as publishInstagramImage,
  type Config,
} from "./instagram";
import type { Post } from "./types";
import { deletePost } from "./storage";

export interface PublishPostInput {
  accessToken: string;
  igUserId: string;
  post: Post;
  config: Config;
  beforePublish?: () => Promise<void>;
}

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

interface PublishingDependencies {
  verifyMediaUrl: (imageUrl: string) => Promise<void>;
  publishImage: typeof publishInstagramImage;
  fetchMedia: typeof fetchInstagramMedia;
  removeLocalPost: typeof deletePost;
}

const DEFAULT_DEPENDENCIES: PublishingDependencies = {
  verifyMediaUrl: verifyPublicMediaUrl,
  publishImage: publishInstagramImage,
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

function validateAndNormalizePublishablePost(post: Post): Post {
  if (!post.id.trim()) throw new Error("The target post must have an ID before publishing.");
  if (post.status === "published") throw new Error("The target post is already published.");
  if (post.caption.length > CAPTION_MAX) {
    throw new Error(`The target post caption must be ${CAPTION_MAX} characters or fewer.`);
  }
  return { ...post, imageUrl: validateAndNormalizePublicMediaUrl(post.imageUrl) };
}

// The one Instagram publishing operation used by both the composer and the
// copilot. It validates before the outward mutation and refreshes Instagram-owned
// post data before reporting success.
export async function publishPost(
  input: PublishPostInput,
  dependencies: PublishingDependencies = DEFAULT_DEPENDENCIES,
): Promise<PublishPostResult> {
  const post = validateAndNormalizePublishablePost(input.post);
  await dependencies.verifyMediaUrl(post.imageUrl);
  await input.beforePublish?.();
  let mediaId: string;
  try {
    mediaId = await dependencies.publishImage(
      input.accessToken,
      input.igUserId,
      post.imageUrl,
      post.caption,
      input.config,
    );
  } catch (error) {
    throw new PublishOutcomeUnknownError(error);
  }
  let localPostRemoved = true;
  let cleanupError: string | undefined;
  try {
    await dependencies.removeLocalPost(post.id);
  } catch (error) {
    localPostRemoved = false;
    cleanupError = error instanceof Error ? error.message : String(error);
  }
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
