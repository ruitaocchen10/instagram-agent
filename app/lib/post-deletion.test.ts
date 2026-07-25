import { describe, expect, it, vi } from "vitest";
import { deleteLocalPost } from "./post-deletion";
import type { Post } from "./types";

// Every case supplies its own content removal; the default one would reach the
// database. `removeContent` is asserted where the ordering is what matters.
const removeContent = () => Promise.resolve();

const draft: Post = {
  id: "draft-1",
  imageUrl: "https://cdn.example.com/draft.jpg",
  caption: "A work in progress.",
  status: "draft",
};

describe("deleteLocalPost", () => {
  it("durably deletes a draft", async () => {
    const removeEditablePost = vi.fn().mockResolvedValue(true);

    await expect(deleteLocalPost(draft, { removeContent, removeEditablePost })).resolves.toBeUndefined();

    expect(removeEditablePost).toHaveBeenCalledWith("draft-1");
  });

  it("removes managed media only after the owning draft is durably deleted", async () => {
    const removeEditablePost = vi.fn().mockResolvedValue(true);
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

    await deleteLocalPost(localDraft, { removeContent, removeEditablePost, removeManagedMedia });

    expect(removeEditablePost).toHaveBeenCalledBefore(removeManagedMedia);
    expect(removeManagedMedia).toHaveBeenCalledWith("asset-1.jpg");
  });

  it("removes the content and its deliveries before the legacy post row", async () => {
    const removeStoredContent = vi.fn().mockResolvedValue(undefined);
    const removeEditablePost = vi.fn().mockResolvedValue(true);

    await deleteLocalPost(draft, { removeContent: removeStoredContent, removeEditablePost });

    expect(removeStoredContent).toHaveBeenCalledWith("draft-1");
    expect(removeStoredContent).toHaveBeenCalledBefore(removeEditablePost);
  });

  it("keeps the post when a destination refuses to release its content", async () => {
    const removeEditablePost = vi.fn();

    await expect(
      deleteLocalPost(draft, {
        removeContent: () => Promise.reject(new Error("A destination is already publishing this content, so it cannot be deleted.")),
        removeEditablePost,
      }),
    ).rejects.toThrow("already publishing this content");

    expect(removeEditablePost).not.toHaveBeenCalled();
  });

  it("durably cancels and deletes a scheduled post", async () => {
    const removeEditablePost = vi.fn().mockResolvedValue(true);
    const scheduled = { ...draft, id: "scheduled-1", status: "scheduled" as const };

    await expect(
      deleteLocalPost(scheduled, { removeContent, removeEditablePost }),
    ).resolves.toBeUndefined();

    expect(removeEditablePost).toHaveBeenCalledWith("scheduled-1");
  });

  it("rejects an Instagram-owned published post", async () => {
    const removeEditablePost = vi.fn();

    await expect(
      deleteLocalPost({ ...draft, id: "ig-42", status: "published" }, { removeContent, removeEditablePost }),
    ).rejects.toThrow("Published posts cannot be deleted");

    expect(removeEditablePost).not.toHaveBeenCalled();
  });

  it("does not delete a scheduled post once publishing has started", async () => {
    const removeEditablePost = vi.fn();

    await expect(
      deleteLocalPost(
        { ...draft, id: "scheduled-1", status: "scheduled", publishState: "publishing" },
        { removeContent, removeEditablePost },
      ),
    ).rejects.toThrow("already being published");

    expect(removeEditablePost).not.toHaveBeenCalled();
  });

  it("reports when the atomic delete loses a race", async () => {
    const removeEditablePost = vi.fn().mockResolvedValue(false);

    await expect(deleteLocalPost(draft, { removeContent, removeEditablePost })).rejects.toThrow(
      "no longer exists or has started publishing",
    );
  });
});

