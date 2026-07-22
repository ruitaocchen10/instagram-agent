import { deleteEditablePost } from "./storage";
import { isScheduledPublishLocked } from "./scheduled-publisher";
import type { Post } from "./types";

interface PostDeletionDependencies {
  removeEditablePost: (id: string) => Promise<boolean>;
}

const DEFAULT_DEPENDENCIES: PostDeletionDependencies = {
  removeEditablePost: deleteEditablePost,
};

export async function deleteLocalPost(
  post: Post,
  dependencies: PostDeletionDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  if (post.status === "published") {
    throw new Error("Published posts cannot be deleted from Socialite.");
  }
  if (post.status === "scheduled" && isScheduledPublishLocked(post.publishState)) {
    throw new Error("This scheduled post is already being published and cannot be deleted.");
  }
  const removed = await dependencies.removeEditablePost(post.id);
  if (!removed) {
    throw new Error("This post no longer exists or has started publishing, so it was not deleted.");
  }
}
