import { deleteEditablePost } from "../persistence/storage";
import { deleteStoredContent } from "./content-delivery-storage";
import { isScheduledPublishLocked } from "./scheduled-publisher";
import type { Post } from "../shared/types";
import { deleteManagedMedia } from "../media/local-media";
import { mediaForPost } from "../media/media";

interface PostDeletionDependencies {
  removeContent: (contentId: string) => Promise<void>;
  removeEditablePost: (id: string) => Promise<boolean>;
  removeManagedMedia: typeof deleteManagedMedia;
}

const DEFAULT_DEPENDENCIES: PostDeletionDependencies = {
  removeContent: deleteStoredContent,
  removeEditablePost: deleteEditablePost,
  removeManagedMedia: deleteManagedMedia,
};

export async function deleteLocalPost(
  post: Post,
  dependencyOverrides: Partial<PostDeletionDependencies> = {},
): Promise<void> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  if (post.status === "published") {
    throw new Error("Published posts cannot be deleted from Socialite.");
  }
  if (post.status === "scheduled" && isScheduledPublishLocked(post.publishState)) {
    throw new Error("This scheduled post is already being published and cannot be deleted.");
  }
  // Content and its deliveries are what the library, calendar, and scheduler
  // read, so they go first. Its own durable guard refuses while a destination
  // holds a publishing claim, which the in-memory status above cannot see.
  await dependencies.removeContent(post.id);
  const removed = await dependencies.removeEditablePost(post.id);
  if (!removed) {
    throw new Error("This post no longer exists or has started publishing, so it was not deleted.");
  }
  const media = mediaForPost(post);
  if (media.source.kind === "local") {
    await dependencies.removeManagedMedia(media.source.assetId);
  }
}
