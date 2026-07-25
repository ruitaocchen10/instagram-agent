import type { Post, ScheduledPublishState } from "../shared/types";

export function isScheduledPublishLocked(state: ScheduledPublishState | undefined): boolean {
  return state === "claimed" || state === "publishing";
}

function isAutomaticallyRetryable(state: ScheduledPublishState | undefined): boolean {
  return state === undefined || state === "idle" || state === "failed";
}

export function claimedScheduledPost(post: Post, attemptedAt: number): Post {
  return {
    ...post,
    publishState: "claimed",
    publishError: undefined,
    publishAttemptedAt: attemptedAt,
    publishAttemptCount: (post.publishAttemptCount ?? 0) + 1,
    updatedAt: attemptedAt,
  };
}

export function publishingScheduledPost(post: Post, attemptedAt: number): Post {
  return { ...post, publishState: "publishing", updatedAt: attemptedAt };
}

export function failedScheduledPost(post: Post, error: string, attemptedAt: number): Post {
  return {
    ...post,
    publishState: "failed",
    publishError: error,
    publishAttemptedAt: attemptedAt,
    updatedAt: attemptedAt,
  };
}

export function uncertainScheduledPost(post: Post, error: string, attemptedAt: number): Post {
  return {
    ...post,
    publishState: "uncertain",
    publishError: error,
    publishAttemptedAt: attemptedAt,
    updatedAt: attemptedAt,
  };
}

export function canceledScheduledPost(post: Post, error: string, attemptedAt: number): Post {
  return {
    ...post,
    publishState: "canceled",
    publishError: error,
    publishAttemptedAt: attemptedAt,
    updatedAt: attemptedAt,
  };
}

// Pure boundary for deciding what a scheduler tick may claim. In particular,
// an in-flight post remains scheduled for the UI but cannot be selected twice.
export function dueScheduledPosts(posts: readonly Post[], now: number): Post[] {
  return posts.filter(
    (post) =>
      post.status === "scheduled" &&
      typeof post.scheduledAt === "number" &&
      Number.isFinite(post.scheduledAt) &&
      post.scheduledAt <= now &&
      isAutomaticallyRetryable(post.publishState) &&
      (post.publishState !== "failed" ||
        typeof post.publishAttemptedAt !== "number" ||
        post.publishAttemptedAt + retryDelayMs(post.publishAttemptCount ?? 1) <= now),
  );
}

function retryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, Math.min(attemptCount - 1, 6));
  return 60_000 * 2 ** exponent;
}
