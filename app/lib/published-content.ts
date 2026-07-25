// Reading back what a platform has already published, in platform-neutral terms.
//
// Published work is the platform's record, not the app's: the app may never have
// created it, and keeps nothing of it locally. Every platform is asked for it the
// same way, through the adapter resolved from the one registry, and a platform
// that does not offer that read is reported as unsupported rather than as an
// empty feed — an account with no published work and an account whose platform
// will not say are different answers, and the app must not show them alike.

import { platformAdapterFor } from "./platforms/registry";
import type {
  Platform,
  PublicationCredentials,
  PublishedItem,
  PublishedMetric,
  PublishedReadCapabilities,
  SocialPlatformAdapter,
} from "./social-content";

export const NO_PUBLISHED_READ: PublishedReadCapabilities = {
  publishedHistory: false,
  metrics: [],
};

export type PublishedContentRead =
  | { supported: true; items: PublishedItem[] }
  | { supported: false };

// What this build can read back for a platform. A platform with no adapter
// reads back nothing, exactly as it publishes nothing.
export function publishedReadCapabilities(platform: Platform): PublishedReadCapabilities {
  return platformAdapterFor(platform)?.publishedRead ?? NO_PUBLISHED_READ;
}

export function reportsPublishedMetric(platform: Platform, metric: PublishedMetric): boolean {
  return publishedReadCapabilities(platform).metrics.includes(metric);
}

// List the connection's published work. Errors are the caller's to report: a
// platform that should answer and did not is a failure worth surfacing, unlike a
// platform that never offered the read at all.
export function readPublishedContent(
  platform: Platform,
  credentials: PublicationCredentials,
): Promise<PublishedContentRead> {
  return readPublishedContentThrough(platformAdapterFor(platform), credentials);
}

// The same read for a caller that already holds the delivery's adapter, so
// publishing does not resolve the platform a second time.
export async function readPublishedContentThrough(
  adapter: SocialPlatformAdapter | undefined,
  credentials: PublicationCredentials,
): Promise<PublishedContentRead> {
  // The capability is what decides, not the presence of the method: an adapter
  // that declares no published history is never asked, even if it could answer.
  if (!adapter?.publishedRead.publishedHistory || !adapter.fetchPublishedContent) {
    return { supported: false };
  }
  return { supported: true, items: await adapter.fetchPublishedContent(credentials) };
}
