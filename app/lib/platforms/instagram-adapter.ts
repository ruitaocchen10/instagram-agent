import { CAPTION_MAX } from "../../sidecar/app-tool-contract";
import {
  AuthError,
  DEFAULT_CONFIG,
  fetchMedia,
  publishImage,
  publishLocalReel,
  publishReelFromUrl,
  type Config,
} from "../instagram";
import type {
  PublicationCredentials,
  PublicationOutcome,
  PublicationRequest,
  PublishFailureClassification,
  PublishingPlatformAdapter,
} from "../social-content";
import type { Post } from "../types";

// The Graph API surface the adapter needs, injectable so its dispatch can be
// tested without a Tauri host or the network.
export interface InstagramPublishingApi {
  publishImage: typeof publishImage;
  publishReelFromUrl: typeof publishReelFromUrl;
  publishLocalReel: typeof publishLocalReel;
  fetchMedia: typeof fetchMedia;
}

export function createInstagramAdapter(
  api: Partial<InstagramPublishingApi> = {},
  config: Config = DEFAULT_CONFIG,
): PublishingPlatformAdapter {
  const graph: InstagramPublishingApi = {
    publishImage,
    publishReelFromUrl,
    publishLocalReel,
    fetchMedia,
    ...api,
  };

  return {
    platform: "instagram",
    capabilities: {
      mediaTypes: ["image", "video"],
      maxCaptionLength: CAPTION_MAX,
    },
    // Instagram fetches an image from a public URL, but accepts a video through
    // its own resumable upload, so a local video never needs public staging.
    directLocalUpload: ["video"],

    async publish(request: PublicationRequest): Promise<PublicationOutcome> {
      const { accessToken, externalIdentityId } = request.credentials;
      const { media, caption, lifecycle } = request;
      // A Reel is shared to the feed unless the delivery opted out.
      const shareToFeed = request.platformOptions?.shareToFeed !== false;

      if (media.type === "image") {
        if (media.kind !== "public-url") {
          throw new Error("Instagram fetches images from a public URL, so this image needs staging.");
        }
        return {
          externalId: await graph.publishImage(
            accessToken,
            externalIdentityId,
            media.url,
            caption,
            config,
            lifecycle,
          ),
        };
      }

      if (media.kind === "local-asset") {
        return {
          externalId: await graph.publishLocalReel(
            accessToken,
            externalIdentityId,
            media.assetId,
            caption,
            shareToFeed,
            config,
            lifecycle,
          ),
        };
      }
      return {
        externalId: await graph.publishReelFromUrl(
          accessToken,
          externalIdentityId,
          media.url,
          caption,
          shareToFeed,
          config,
          lifecycle,
        ),
      };
    },

    classifyPublishFailure(error: unknown): PublishFailureClassification {
      // A cancellation is reported by the local upload, before Instagram has
      // been asked to publish the container it is holding.
      if (String(error).toLowerCase().includes("canceled")) return "canceled";
      // An authentication rejection is definitive and connection-local.
      if (error instanceof AuthError) return "authentication";
      // Anything else stays uncertain: Instagram gives publishing no
      // idempotency key, so an interrupted call may still have been accepted.
      return "uncertain";
    },

    fetchPublishedPosts(credentials: PublicationCredentials): Promise<Post[]> {
      return graph.fetchMedia(credentials.accessToken, credentials.externalIdentityId, config);
    },
  };
}

export const instagramAdapter = createInstagramAdapter();
