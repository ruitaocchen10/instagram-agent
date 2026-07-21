import { describe, expect, it } from "vitest";
import { dueScheduledPosts } from "./scheduled-publisher";
import type { Post } from "./types";

const scheduled: Post = {
  id: "scheduled-1",
  imageUrl: "https://cdn.example.com/launch.jpg",
  caption: "Launch day",
  status: "scheduled",
  scheduledAt: 10_000,
};

describe("dueScheduledPosts", () => {
  it.each([
    ["before", 9_999, []],
    ["exactly at", 10_000, [scheduled]],
    ["after", 10_001, [scheduled]],
  ])("selects a scheduled post %s its scheduled instant", (_label, now, expected) => {
    expect(dueScheduledPosts([scheduled], now)).toEqual(expected);
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "ignores a missing or invalid schedule value (%s)",
    (scheduledAt) => {
      expect(dueScheduledPosts([{ ...scheduled, scheduledAt }], 10_000)).toEqual([]);
    },
  );

  it("returns exactly due, unclaimed scheduled posts", () => {
    const draft = { ...scheduled, id: "draft", status: "draft" as const };
    const future = { ...scheduled, id: "future", scheduledAt: 10_001 };
    const published = { ...scheduled, id: "published", status: "published" as const };
    const publishing = { ...scheduled, id: "publishing", publishState: "publishing" as const };
    const claimed = { ...scheduled, id: "claimed", publishState: "claimed" as const };
    const uncertain = { ...scheduled, id: "uncertain", publishState: "uncertain" as const };

    expect(
      dueScheduledPosts(
        [draft, scheduled, future, published, claimed, publishing, uncertain],
        10_000,
      ),
    ).toEqual([scheduled]);
  });
});
