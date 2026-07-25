import {
  displayPlatformName,
  type CredentialRequest,
  type Platform,
  type SocialPlatformAdapter,
} from "../content/social-content";
import { instagramAdapter } from "./instagram-adapter";

// One place decides which platforms this build supports. A platform with no
// adapter is unsupported everywhere — connect flow, composer, scheduler, and
// publisher — instead of in each caller's own conditional.
const ADAPTERS: readonly SocialPlatformAdapter[] = [instagramAdapter];

export function platformAdapterFor(platform: Platform): SocialPlatformAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.platform === platform);
}

export function requirePlatformAdapter(platform: Platform): SocialPlatformAdapter {
  const adapter = platformAdapterFor(platform);
  if (!adapter) {
    throw new Error(`${displayPlatformName(platform)} is not available for publishing yet.`);
  }
  return adapter;
}

// What the connect screen needs to offer a destination: the platform and the
// credential it asks the creator for.
export interface ConnectablePlatform {
  platform: Platform;
  credentialRequest: CredentialRequest;
}

export function connectablePlatforms(): ConnectablePlatform[] {
  return ADAPTERS.map((adapter) => ({
    platform: adapter.platform,
    credentialRequest: adapter.credentialRequest,
  }));
}
