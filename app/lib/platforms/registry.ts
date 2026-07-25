import { displayPlatformName, type Platform, type PublishingPlatformAdapter } from "../social-content";
import { instagramAdapter } from "./instagram-adapter";

// One place decides which platforms this build can publish to. A platform with
// no adapter is unsupported everywhere — composer, scheduler, and publisher —
// instead of in each caller's own conditional.
const PUBLISHING_ADAPTERS: readonly PublishingPlatformAdapter[] = [instagramAdapter];

export function publishingAdapterFor(platform: Platform): PublishingPlatformAdapter | undefined {
  return PUBLISHING_ADAPTERS.find((adapter) => adapter.platform === platform);
}

export function requirePublishingAdapter(platform: Platform): PublishingPlatformAdapter {
  const adapter = publishingAdapterFor(platform);
  if (!adapter) {
    throw new Error(`${displayPlatformName(platform)} is not available for publishing yet.`);
  }
  return adapter;
}

export function supportedPublishingPlatforms(): Platform[] {
  return PUBLISHING_ADAPTERS.map((adapter) => adapter.platform);
}
