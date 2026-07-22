import { deleteEditablePost } from "./storage";
import { isScheduledPublishLocked } from "./scheduled-publisher";
import type { Post } from "./types";

interface PostDeletionDependencies {
  removeEditablePost: (id: string) => Promise<boolean>;
}

const DEFAULT_DEPENDENCIES: PostDeletionDependencies = {
  removeEditablePost: deleteEditablePost,
};

export function postDeletionConfirmation(post: Post): string {
  if (post.status === "scheduled" && post.publishState === "uncertain") {
    return "Instagram may already have published this post because its last publish result is uncertain. Check Instagram before deleting this local scheduled post. Delete it anyway? This can't be undone.";
  }
  if (post.status === "scheduled") {
    return "Delete this scheduled post and cancel future publishing? This can't be undone.";
  }
  return "Delete this draft? This can't be undone.";
}

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
