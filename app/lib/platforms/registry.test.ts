import { describe, expect, it } from "vitest";
import { instagramAdapter } from "./instagram-adapter";
import {
  connectablePlatforms,
  platformAdapterFor,
  requirePlatformAdapter,
} from "./registry";

describe("platform adapter registry", () => {
  it("resolves the adapter installed for a platform", () => {
    expect(platformAdapterFor("instagram")).toBe(instagramAdapter);
  });

  it("reports no adapter for a platform this build does not support", () => {
    expect(platformAdapterFor("threads")).toBeUndefined();
  });

  it("names the unsupported platform when a caller demands an adapter", () => {
    expect(() => requirePlatformAdapter("threads")).toThrow(
      "Threads is not available for publishing yet.",
    );
  });

  it("offers each supported platform with the credential it asks for", () => {
    expect(connectablePlatforms()).toEqual([
      { platform: "instagram", credentialRequest: instagramAdapter.credentialRequest },
    ]);
  });
});
