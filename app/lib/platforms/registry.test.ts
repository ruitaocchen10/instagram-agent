import { describe, expect, it } from "vitest";
import { instagramAdapter } from "./instagram-adapter";
import {
  publishingAdapterFor,
  requirePublishingAdapter,
  supportedPublishingPlatforms,
} from "./registry";

describe("publishing adapter registry", () => {
  it("resolves the adapter installed for a platform", () => {
    expect(publishingAdapterFor("instagram")).toBe(instagramAdapter);
  });

  it("reports no adapter for a platform this build cannot publish to", () => {
    expect(publishingAdapterFor("threads")).toBeUndefined();
  });

  it("names the unsupported platform when a caller demands an adapter", () => {
    expect(() => requirePublishingAdapter("threads")).toThrow(
      "Threads is not available for publishing yet.",
    );
  });

  it("lists the platforms a delivery can currently target", () => {
    expect(supportedPublishingPlatforms()).toEqual(["instagram"]);
  });
});
