// Instagram Content Publishing API client.
//
// Runs in the Tauri webview but uses the Tauri HTTP plugin's `fetch` so
// requests go through Rust and are
// not subject to browser CORS (graph.instagram.com does not send CORS headers).

import { fetch } from "@tauri-apps/plugin-http";

export type ApiMode = "instagram" | "facebook";

export interface Config {
  mode: ApiMode;
  version: string; // e.g. "v21.0"
}

export interface Account {
  igUserId: string;
  username: string;
}

export const DEFAULT_CONFIG: Config = { mode: "instagram", version: "v21.0" };

export class GraphError extends Error {}

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
    throw new GraphError(`${e.type}: ${e.message} (code ${e.code})`);
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

// Resolve the Instagram user id + username for a token.
export async function resolveAccount(token: string, cfg: Config): Promise<Account> {
  const b = base(cfg);
  if (cfg.mode === "instagram") {
    const me = await get(`${b}/me?${qs({ fields: "user_id,username", access_token: token })}`);
    const igUserId = String(me.user_id ?? me.id);
    return { igUserId, username: me.username ?? igUserId };
  }

  // facebook mode: find a Page, then its linked instagram_business_account.
  const pages = await get(
    `${b}/me/accounts?${qs({ fields: "name,instagram_business_account", access_token: token })}`,
  );
  for (const page of pages.data ?? []) {
    const iba = page.instagram_business_account;
    if (iba) {
      const prof = await get(`${b}/${iba.id}?${qs({ fields: "username", access_token: token })}`);
      return { igUserId: iba.id, username: prof.username ?? iba.id };
    }
  }
  throw new GraphError(
    "No Instagram Business account found on any Page for this token. " +
      "Confirm the account is Business/Creator and linked to a Facebook Page.",
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Create a media container, wait for it to finish, then publish it.
export async function publishImage(
  token: string,
  igUserId: string,
  imageUrl: string,
  caption: string,
  cfg: Config,
): Promise<string> {
  const b = base(cfg);

  // 1. Create container.
  const container = await post(`${b}/${igUserId}/media`, {
    image_url: imageUrl,
    caption,
    access_token: token,
  });
  const creationId: string = container.id;

  // 2. Wait until the container finishes processing.
  for (let i = 0; i < 10; i++) {
    const status = await get(
      `${b}/${creationId}?${qs({ fields: "status_code", access_token: token })}`,
    );
    if (status.status_code === "FINISHED") break;
    if (status.status_code === "ERROR") {
      throw new GraphError("Media container processing failed (status ERROR).");
    }
    await sleep(2000);
  }

  // 3. Publish.
  const published = await post(`${b}/${igUserId}/media_publish`, {
    creation_id: creationId,
    access_token: token,
  });
  return published.id;
}
