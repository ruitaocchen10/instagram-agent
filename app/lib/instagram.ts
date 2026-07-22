// Instagram Content Publishing API client.
//
// Runs in the Tauri webview but uses the Tauri HTTP plugin's `fetch` so
// requests go through Rust and are
// not subject to browser CORS (graph.instagram.com does not send CORS headers).

import { fetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import type { Account, Post } from "./types";

export type { Account };

export type ApiMode = "instagram" | "facebook";

export interface Config {
  mode: ApiMode;
  version: string; // e.g. "v21.0"
}

export const DEFAULT_CONFIG: Config = { mode: "instagram", version: "v21.0" };

export class GraphError extends Error {}

// A distinct, catchable signal for Meta's auth failures (OAuthException, code
// 190): the token is expired or revoked. Kept separate from GraphError so
// orchestration can branch into the reconnect state instead of showing a generic
// "couldn't load" error. `revoked` distinguishes "just reconnect" (expired) from
// "this token is invalid — get a new one" (password change / de-auth / invalid),
// derived from Meta's error_subcode where present.
export class AuthError extends Error {
  readonly code = 190;
  readonly revoked: boolean;
  constructor(message: string, revoked = false) {
    super(message);
    this.name = "AuthError";
    this.revoked = revoked;
  }
}

// Meta error_subcodes that mean the token is gone for good (not merely expired):
// 460 password changed / session invalidated, 467 invalid token. Anything else
// under code 190 (incl. 463 "expired") is treated as a plain, recoverable expiry.
const REVOKED_SUBCODES = new Set([460, 467]);

function host(mode: ApiMode): string {
  return mode === "instagram" ? "graph.instagram.com" : "graph.facebook.com";
}

function base(cfg: Config): string {
  return `https://${host(cfg.mode)}/${cfg.version}`;
}

// Parse a Graph response, throwing GraphError with Meta's message on failure.
async function parse(res: Response): Promise<any> {
  const data = await res.json().catch(() => ({}));
  if (data && data.error) {
    const e = data.error;
    const msg = `${e.type}: ${e.message} (code ${e.code})`;
    if (e.code === 190) {
      throw new AuthError(msg, REVOKED_SUBCODES.has(e.error_subcode));
    }
    throw new GraphError(msg);
  }
  if (!res.ok) {
    throw new GraphError(`HTTP ${res.status}`);
  }
  return data;
}

function qs(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

async function get(url: string): Promise<any> {
  return parse(await fetch(url, { method: "GET" }));
}

async function post(url: string, body: Record<string, string>): Promise<any> {
  return parse(
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: qs(body),
    }),
  );
}

const PROFILE_FIELDS = "username,name,followers_count,profile_picture_url";

// Shape a raw Graph profile node into our Account.
function toAccount(igUserId: string, node: any): Account {
  return {
    igUserId,
    username: node.username ?? igUserId,
    fullName: node.name ?? node.username ?? "",
    followers: node.followers_count ?? 0,
    profilePicUrl: node.profile_picture_url,
  };
}

export interface RefreshResult {
  token: string;
  expiresIn: number; // seconds until the new token expires (≈ 60 days)
}

// Refresh a long-lived Instagram token, rolling its 60-day window forward.
//
// Uses the versionless, secret-free endpoint
//   GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=…
// (host-level, NOT under /vXX). Meta only honors this when the token is already
// long-lived, at least 24h old, and not yet expired. Scheduled refreshes are
// eligibility-gated; initial connection may probe once and tolerate rejection.
// A lapsed/revoked token comes back as an AuthError (code 190) from parse().
export async function refreshToken(
  token: string,
  cfg: Config = DEFAULT_CONFIG,
): Promise<RefreshResult> {
  const url = `https://${host(cfg.mode)}/refresh_access_token?${qs({
    grant_type: "ig_refresh_token",
    access_token: token,
  })}`;
  const data = await get(url);
  return { token: data.access_token, expiresIn: data.expires_in };
}

// Resolve the connected Instagram account (id, username, name, followers) for a token.
export async function resolveAccount(token: string, cfg: Config): Promise<Account> {
  const b = base(cfg);
  if (cfg.mode === "instagram") {
    const me = await get(
      `${b}/me?${qs({ fields: `user_id,${PROFILE_FIELDS}`, access_token: token })}`,
    );
    return toAccount(String(me.user_id ?? me.id), me);
  }

  // facebook mode: find a Page, then its linked instagram_business_account.
  const pages = await get(
    `${b}/me/accounts?${qs({ fields: "name,instagram_business_account", access_token: token })}`,
  );
  for (const page of pages.data ?? []) {
    const iba = page.instagram_business_account;
    if (iba) {
      const prof = await get(
        `${b}/${iba.id}?${qs({ fields: PROFILE_FIELDS, access_token: token })}`,
      );
      return toAccount(iba.id, prof);
    }
  }
  throw new GraphError(
    "No Instagram Business account found on any Page for this token. " +
      "Confirm the account is Business/Creator and linked to a Facebook Page.",
  );
}

// Fetch the account's published posts (most recent first) as `published` Posts.
// VIDEO items expose the frame via thumbnail_url; fall back to media_url.
export async function fetchMedia(
  token: string,
  igUserId: string,
  cfg: Config,
  limit = 25,
): Promise<Post[]> {
  const b = base(cfg);
  const fields =
    "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count";
  const res = await get(
    `${b}/${igUserId}/media?${qs({ fields, limit: String(limit), access_token: token })}`,
  );
  return (res.data ?? []).map(
    (m: any): Post => ({
      id: m.id,
      imageUrl: m.thumbnail_url ?? m.media_url ?? "",
      media:
        m.media_type === "VIDEO"
          ? {
              type: "reel",
              source: { kind: "url", url: m.media_url ?? "" },
              shareToFeed: true,
            }
          : m.media_url
            ? { type: "image", source: { kind: "url", url: m.media_url } }
            : undefined,
      caption: m.caption ?? "",
      status: "published",
      publishedAt: m.timestamp ? new Date(m.timestamp).getTime() : undefined,
      likes: m.like_count,
      comments: m.comments_count,
    }),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForContainer(
  creationId: string,
  token: string,
  cfg: Config,
): Promise<void> {
  const b = base(cfg);
  for (let attempt = 0; attempt < 30; attempt++) {
    const status = await get(
      `${b}/${creationId}?${qs({ fields: "status_code", access_token: token })}`,
    );
    if (status.status_code === "FINISHED") return;
    if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
      throw new GraphError(`Media container processing failed (status ${status.status_code}).`);
    }
    if (attempt < 29) await sleep(2000);
  }
  throw new GraphError("Media container did not finish processing before the timeout.");
}

async function publishContainer(
  creationId: string,
  token: string,
  igUserId: string,
  cfg: Config,
): Promise<string> {
  const published = await post(`${base(cfg)}/${igUserId}/media_publish`, {
    creation_id: creationId,
    access_token: token,
  });
  return published.id;
}

export interface PublishLifecycle {
  onProcessing?: () => void;
  onPublishing?: () => void;
}

// Create a media container, wait for it to finish, then publish it.
export async function publishImage(
  token: string,
  igUserId: string,
  imageUrl: string,
  caption: string,
  cfg: Config,
  lifecycle?: PublishLifecycle,
): Promise<string> {
  const b = base(cfg);

  // 1. Create container.
  const container = await post(`${b}/${igUserId}/media`, {
    image_url: imageUrl,
    caption,
    access_token: token,
  });
  const creationId: string = container.id;

  lifecycle?.onProcessing?.();
  await waitForContainer(creationId, token, cfg);
  lifecycle?.onPublishing?.();
  return publishContainer(creationId, token, igUserId, cfg);
}

export async function publishReelFromUrl(
  token: string,
  igUserId: string,
  videoUrl: string,
  caption: string,
  shareToFeed: boolean,
  cfg: Config,
  lifecycle?: PublishLifecycle,
): Promise<string> {
  const container = await post(`${base(cfg)}/${igUserId}/media`, {
    media_type: "REELS",
    video_url: videoUrl,
    caption,
    share_to_feed: String(shareToFeed),
    access_token: token,
  });
  lifecycle?.onProcessing?.();
  await waitForContainer(container.id, token, cfg);
  lifecycle?.onPublishing?.();
  return publishContainer(container.id, token, igUserId, cfg);
}

export async function publishLocalReel(
  token: string,
  igUserId: string,
  assetId: string,
  caption: string,
  shareToFeed: boolean,
  cfg: Config,
  lifecycle?: PublishLifecycle,
): Promise<string> {
  let container: { id: string; uri?: string };
  try {
    container = await post(`${base(cfg)}/${igUserId}/media`, {
      media_type: "REELS",
      upload_type: "resumable",
      caption,
      share_to_feed: String(shareToFeed),
      access_token: token,
    });
  } catch (error) {
    await invoke("clear_local_reel_upload_cancellation", { assetId }).catch(() => {});
    throw error;
  }
  const uploadUrl =
    container.uri ?? `https://rupload.facebook.com/ig-api-upload/${cfg.version}/${container.id}`;
  await invoke("upload_local_reel", {
    assetId,
    uploadUrl,
    accessToken: token,
  });
  lifecycle?.onProcessing?.();
  await waitForContainer(container.id, token, cfg);
  lifecycle?.onPublishing?.();
  return publishContainer(container.id, token, igUserId, cfg);
}
