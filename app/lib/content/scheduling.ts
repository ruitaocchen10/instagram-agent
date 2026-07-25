import { CAPTION_MAX } from "../../sidecar/app-tool-contract";
import { isScheduledPublishLocked } from "./scheduled-publisher";
import { reschedulePost, savePost } from "../persistence/storage";
import type { Post } from "../shared/types";
import { mediaForPost } from "../media/media";

function validateSchedulablePost(post: Post): void {
  if (!post.id.trim()) throw new Error("The target post must have an ID.");
  if (isScheduledPublishLocked(post.publishState)) {
    throw new Error("This post is already being published and cannot be rescheduled.");
  }
  if (post.status === "published") {
    throw new Error("Published posts cannot be scheduled.");
  }
  mediaForPost(post);
  if (post.caption.length > CAPTION_MAX) {
    throw new Error(`The target post caption must be ${CAPTION_MAX} characters or fewer.`);
  }
}

// The one application-level scheduling operation used by the composer and the
// copilot. It validates before writing and returns only after SQLite is durable.
export async function schedulePost(
  post: Post,
  scheduledAt: number,
  now = Date.now(),
): Promise<Post> {
  validateSchedulablePost(post);
  if (!Number.isFinite(scheduledAt)) {
    throw new Error("The scheduled time must be a valid date and time.");
  }
  if (scheduledAt <= now) {
    throw new Error("The scheduled time must be in the future.");
  }

  const scheduled: Post = {
    ...post,
    status: "scheduled",
    scheduledAt,
    publishedAt: undefined,
    likes: undefined,
    comments: undefined,
    updatedAt: now,
    publishState: "idle",
    publishError: undefined,
    publishAttemptedAt: undefined,
    publishAttemptCount: 0,
  };
  if (post.status === "scheduled") {
    await reschedulePost(scheduled);
  } else {
    await savePost(scheduled);
  }
  return scheduled;
}
