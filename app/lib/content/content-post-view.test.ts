import { describe, expect, it } from "vitest";
import {
  localPostsForContentDeliveries,
  postForContentDeliveries,
  retainedLocalAssetIds,
} from "./content-post-view";
import type { StoredContent } from "./content-delivery-storage";
import type { Delivery } from "./social-content";

const CONTENT: StoredContent = {
  id: "content-1",
  caption: "Base copy",
  media: { type: "image", source: { kind: "url", url: "https://cdn.example/a.jpg" } },
  createdAt: 1,
  updatedAt: 20,
};

function delivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    id: "delivery-a",
    contentId: "content-1",
    connectionId: "brand",
    platform: "instagram",
    status: "scheduled",
    scheduledAt: 500,
    ...overrides,
  };
}

describe("deriving the post view from content and deliveries", () => {
  it("derives a draft from content that has no destination yet", () => {
    expect(postForContentDeliveries(CONTENT, [])).toEqual({
      id: "content-1",
      imageUrl: "https://cdn.example/a.jpg",
      media: { type: "image", source: { kind: "url", url: "https://cdn.example/a.jpg" } },
      caption: "Base copy",
      status: "draft",
      updatedAt: 20,
    });
  });

  it("carries the scheduled destination's lifecycle onto the derived post", () => {
    expect(
      postForContentDeliveries(CONTENT, [
        delivery({
          publishState: "failed",
          publishError: "Instagram was unreachable",
          publishAttemptedAt: 400,
          publishAttemptCount: 2,
        }),
      ]),
    ).toMatchObject({
      status: "scheduled",
      scheduledAt: 500,
      publishState: "failed",
      publishError: "Instagram was unreachable",
      publishAttemptedAt: 400,
      publishAttemptCount: 2,
    });
  });

  it("reports an in-flight destination even when a quieter one is scheduled sooner", () => {
    const derived = postForContentDeliveries(CONTENT, [
      delivery({ id: "delivery-early", connectionId: "personal", scheduledAt: 100 }),
      delivery({ id: "delivery-claimed", scheduledAt: 900, publishState: "claimed", publishAttemptedAt: 800 }),
    ]);

    // The claim is what blocks deletion and duplicate publishing, so collapsing
    // the destinations must not hide it behind the earlier, idle one.
    expect(derived.publishState).toBe("claimed");
    expect(derived.scheduledAt).toBe(900);
  });

  it("keeps an unresolved outcome visible above a merely failed destination", () => {
    const derived = postForContentDeliveries(CONTENT, [
      delivery({ id: "delivery-failed", publishState: "failed", publishError: "Retrying" }),
      delivery({
        id: "delivery-uncertain",
        connectionId: "personal",
        publishState: "uncertain",
        publishError: "Instagram may already have published this",
      }),
    ]);

    expect(derived.publishState).toBe("uncertain");
    expect(derived.publishError).toBe("Instagram may already have published this");
  });

  it("treats a video creative as a Reel and takes shareToFeed from its destination", () => {
    const video: StoredContent = {
      ...CONTENT,
      media: { type: "video", source: { kind: "url", url: "https://cdn.example/a.mp4" } },
    };

    expect(postForContentDeliveries(video, [delivery({ platformOptions: { shareToFeed: false } })]).media).toEqual({
      type: "reel",
      source: { kind: "url", url: "https://cdn.example/a.mp4" },
      shareToFeed: false,
    });
    expect(postForContentDeliveries(video, [delivery()]).media).toMatchObject({ shareToFeed: true });
  });

  // A migrated Reel recorded the flag as SQLite's 0/1 rather than false/true.
  // Reading it as truthy would put a creative on the feed they kept off it.
  it("reads a numeric shareToFeed the way the migration meant it", () => {
    const video: StoredContent = {
      ...CONTENT,
      media: { type: "video", source: { kind: "url", url: "https://cdn.example/a.mp4" } },
    };

    expect(
      postForContentDeliveries(video, [delivery({ platformOptions: { shareToFeed: 0 } })]).media,
    ).toMatchObject({ shareToFeed: false });
    expect(
      postForContentDeliveries(video, [delivery({ platformOptions: { shareToFeed: 1 } })]).media,
    ).toMatchObject({ shareToFeed: true });
  });

  it("resolves a managed asset's preview instead of inventing a URL", () => {
    const local: StoredContent = {
      ...CONTENT,
      media: {
        type: "image",
        source: { kind: "local", assetId: "asset-9", fileName: "a.jpg", mimeType: "image/jpeg", size: 10 },
      },
    };

    expect(postForContentDeliveries(local, [], new Map([["asset-9", "asset://preview"]])).imageUrl).toBe(
      "asset://preview",
    );
    expect(postForContentDeliveries(local, []).imageUrl).toBe("");
  });
});

describe("the local working set", () => {
  const other: StoredContent = { ...CONTENT, id: "content-2", updatedAt: 50 };

  it("orders the working set by most recently updated", () => {
    expect(
      localPostsForContentDeliveries([CONTENT, other], []).map((post) => post.id),
    ).toEqual(["content-2", "content-1"]);
  });

  it("drops content once every destination has published it", () => {
    const derived = localPostsForContentDeliveries(
      [CONTENT, other],
      [
        delivery({ status: "published", publishedAt: 900 }),
        delivery({ id: "delivery-b", contentId: "content-2", status: "draft" }),
      ],
    );

    expect(derived.map((post) => post.id)).toEqual(["content-2"]);
  });

  it("keeps content that one destination published while another still plans it", () => {
    const derived = localPostsForContentDeliveries(CONTENT ? [CONTENT] : [], [
      delivery({ status: "published", publishedAt: 900 }),
      delivery({ id: "delivery-b", connectionId: "personal", status: "scheduled", scheduledAt: 700 }),
    ]);

    expect(derived).toHaveLength(1);
    // The published destination is the platform's record now and must not
    // decide the state of the work that is still local.
    expect(derived[0]).toMatchObject({ status: "scheduled", scheduledAt: 700 });
  });

  it("lists the managed assets the working set still depends on", () => {
    const local: StoredContent = {
      ...CONTENT,
      media: {
        type: "image",
        source: { kind: "local", assetId: "asset-9", fileName: "a.jpg", mimeType: "image/jpeg", size: 10 },
      },
    };

    expect(retainedLocalAssetIds([local, other])).toEqual(["asset-9"]);
  });
});
