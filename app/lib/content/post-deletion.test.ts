import { describe, expect, it, vi } from "vitest";
import { deleteLocalPost } from "./post-deletion";
import type { Post } from "../shared/types";

// Every case supplies its own content removal; the default one would reach the
// database. It reports true — the row existed and was deleted — unless a case
// is specifically about it not being there.
const removeContent = () => Promise.resolve(true);

const draft: Post = {
  id: "draft-1",
  imageUrl: "https://cdn.example.com/draft.jpg",
  caption: "A work in progress.",
  status: "draft",
};

describe("deleteLocalPost", () => {
  it("durably deletes a draft with its deliveries", async () => {
    const removeStoredContent = vi.fn().mockResolvedValue(true);

    await expect(
      deleteLocalPost(draft, { removeContent: removeStoredContent }),
    ).resolves.toBeUndefined();

    expect(removeStoredContent).toHaveBeenCalledWith("draft-1");
  });

  it("removes managed media only after the owning content is durably deleted", async () => {
    const removeStoredContent = vi.fn().mockResolvedValue(true);
    const removeManagedMedia = vi.fn().mockResolvedValue(undefined);
    const localDraft: Post = {
      ...draft,
      imageUrl: "",
      media: {
        type: "image",
        source: {
          kind: "local",
          assetId: "asset-1.jpg",
          fileName: "photo.jpg",
          mimeType: "image/jpeg",
          size: 2048,
        },
      },
    };

    await deleteLocalPost(localDraft, { removeContent: removeStoredContent, removeManagedMedia });

    expect(removeStoredContent).toHaveBeenCalledBefore(removeManagedMedia);
    expect(removeManagedMedia).toHaveBeenCalledWith("asset-1.jpg");
  });

  it("keeps managed media when a destination refuses to release its content", async () => {
    const removeManagedMedia = vi.fn();

    await expect(
      deleteLocalPost(draft, {
        removeContent: () =>
          Promise.reject(
            new Error("A destination is already publishing this content, so it cannot be deleted."),
          ),
        removeManagedMedia,
      }),
    ).rejects.toThrow("already publishing this content");

    expect(removeManagedMedia).not.toHaveBeenCalled();
  });

  it("durably cancels and deletes a scheduled post", async () => {
    const removeStoredContent = vi.fn().mockResolvedValue(true);
    const scheduled = { ...draft, id: "scheduled-1", status: "scheduled" as const };

    await expect(
      deleteLocalPost(scheduled, { removeContent: removeStoredContent }),
    ).resolves.toBeUndefined();

    expect(removeStoredContent).toHaveBeenCalledWith("scheduled-1");
  });

  it("rejects a platform-owned published post", async () => {
    const removeStoredContent = vi.fn();

    await expect(
      deleteLocalPost(
        { ...draft, id: "ig-42", status: "published" },
        { removeContent: removeStoredContent },
      ),
    ).rejects.toThrow("Published posts cannot be deleted");

    expect(removeStoredContent).not.toHaveBeenCalled();
  });

  it("does not delete a scheduled post once publishing has started", async () => {
    const removeStoredContent = vi.fn();

    await expect(
      deleteLocalPost(
        { ...draft, id: "scheduled-1", status: "scheduled", publishState: "publishing" },
        { removeContent: removeStoredContent },
      ),
    ).rejects.toThrow("already being published");

    expect(removeStoredContent).not.toHaveBeenCalled();
  });

  it("reports when the content was already gone", async () => {
    await expect(
      deleteLocalPost(draft, { removeContent: () => Promise.resolve(false) }),
    ).rejects.toThrow("no longer exists");
  });
});
