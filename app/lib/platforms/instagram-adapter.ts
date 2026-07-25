import { CAPTION_MAX } from "../../sidecar/app-tool-contract";
import {
  AuthError,
  DEFAULT_CONFIG,
  fetchMedia,
  publishImage,
  publishLocalReel,
  publishReelFromUrl,
  refreshToken,
  resolveAccount,
  type Config,
  type InstagramMedia,
} from "../instagram";
import type {
  ConnectionIdentity,
  CredentialFailure,
  CredentialLifetimePolicy,
  EstablishedConnection,
  PlatformCredential,
  PublicationCredentials,
  PublicationOutcome,
  PublicationRequest,
  PublishedItem,
  PublishFailureClassification,
  SocialPlatformAdapter,
} from "../social-content";
import type { Account } from "../types";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Meta issues a long-lived token good for about 60 days, accepts a refresh only
// once that token is at least 24 hours old, and refuses one after it lapses.
const INSTAGRAM_CREDENTIAL_LIFETIME: CredentialLifetimePolicy = {
  assumedLifetimeMs: 60 * DAY,
  refreshFloorMs: 24 * HOUR,
  refreshWindowMs: 10 * DAY,
};

// The Graph API surface the adapter needs, injectable so its dispatch can be
// tested without a Tauri host or the network.
export interface InstagramApi {
  resolveAccount: typeof resolveAccount;
  refreshToken: typeof refreshToken;
  publishImage: typeof publishImage;
  publishReelFromUrl: typeof publishReelFromUrl;
  publishLocalReel: typeof publishLocalReel;
  fetchMedia: typeof fetchMedia;
}

// Instagram's media list in neutral terms. A VIDEO item carries its own poster
// frame, so the preview falls back to the media URL only for stills.
function publishedItemForMedia(media: InstagramMedia): PublishedItem {
  const type = media.mediaType === "VIDEO" ? "video" : "image";
  const previewUrl = media.thumbnailUrl ?? media.mediaUrl;
  return {
    externalId: media.id,
    caption: media.caption ?? "",
    ...(media.mediaUrl
      ? { media: { type, source: { kind: "url", url: media.mediaUrl } } }
      : {}),
    ...(previewUrl ? { previewUrl } : {}),
    ...(media.permalink ? { permalink: media.permalink } : {}),
    ...(media.timestamp ? { publishedAt: new Date(media.timestamp).getTime() } : {}),
    metrics: {
      ...(typeof media.likeCount === "number" ? { likes: media.likeCount } : {}),
      ...(typeof media.commentsCount === "number" ? { comments: media.commentsCount } : {}),
    },
  };
}

function identityForAccount(account: Account): ConnectionIdentity {
  return {
    externalIdentityId: account.igUserId,
    handle: account.username,
    displayName: `@${account.username}`,
    ...(account.fullName ? { fullName: account.fullName } : {}),
    audienceCount: account.followers,
    ...(account.profilePicUrl ? { avatarUrl: account.profilePicUrl } : {}),
  };
}

export function createInstagramAdapter(
  api: Partial<InstagramApi> = {},
  config: Config = DEFAULT_CONFIG,
): SocialPlatformAdapter {
  const graph: InstagramApi = {
    resolveAccount,
    refreshToken,
    publishImage,
    publishReelFromUrl,
    publishLocalReel,
    fetchMedia,
    ...api,
  };

  async function refreshCredential(secret: string, now: number): Promise<PlatformCredential> {
    const refreshed = await graph.refreshToken(secret, config);
    return {
      secret: refreshed.token,
      metadata: {
        expiresAt: now + refreshed.expiresIn * 1000,
        expirySource: "platform",
        lastRefreshedAt: now,
      },
    };
  }

  return {
    platform: "instagram",
    capabilities: {
      mediaTypes: ["image", "video"],
      maxCaptionLength: CAPTION_MAX,
    },
    credentialLifetime: INSTAGRAM_CREDENTIAL_LIFETIME,
    credentialRequest: {
      label: "Instagram access token",
      placeholder: "IGAA…",
      hint: "Instagram Login (graph.instagram.com). Tokens generated in Meta's Instagram API setup are valid for about 60 days.",
    },
    // Instagram fetches an image from a public URL, but accepts a video through
    // its own resumable upload, so a local video never needs public staging.
    directLocalUpload: ["video"],

    async establishConnection(secret: string, now: number): Promise<EstablishedConnection> {
      const identity = identityForAccount(await graph.resolveAccount(secret, config));
      try {
        // A token pasted from an older session may already be refresh-eligible,
        // and taking Meta's exact expiry now beats waiting out an estimate. A
        // freshly issued token is not eligible for 24 hours, so Meta declining
        // is the expected case rather than a problem.
        return { identity, credential: await refreshCredential(secret, now) };
      } catch {
        return {
          identity,
          credential: {
            secret,
            metadata: {
              expiresAt: now + INSTAGRAM_CREDENTIAL_LIFETIME.assumedLifetimeMs,
              expirySource: "estimated",
            },
          },
        };
      }
    },

    refreshCredential,

    classifyCredentialFailure(error: unknown): CredentialFailure | undefined {
      if (!(error instanceof AuthError)) return undefined;
      // Meta reports a password change or a de-authorized app under the same
      // code as a plain lapse; only the revoked case needs a brand-new token.
      return error.revoked ? "revoked" : "expired";
    },

    async fetchIdentity(credentials: PublicationCredentials): Promise<ConnectionIdentity> {
      return identityForAccount(await graph.resolveAccount(credentials.accessToken, config));
    },

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

    publishedRead: {
      publishedHistory: true,
      metrics: ["likes", "comments"],
    },

    async fetchPublishedContent(credentials: PublicationCredentials): Promise<PublishedItem[]> {
      const media = await graph.fetchMedia(
        credentials.accessToken,
        credentials.externalIdentityId,
        config,
      );
      return media.map(publishedItemForMedia);
    },
  };
}

export const instagramAdapter = createInstagramAdapter();
