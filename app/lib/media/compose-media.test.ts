import { describe, expect, it } from "vitest";
import { canChooseLocalMedia } from "./compose-media";

describe("Compose local-media availability", () => {
  it("requires R2 for local images", () => {
    expect(canChooseLocalMedia("image", false)).toBe(false);
    expect(canChooseLocalMedia("image", true)).toBe(true);
  });

  it("allows local Reels without R2", () => {
    expect(canChooseLocalMedia("reel", false)).toBe(true);
  });
});
