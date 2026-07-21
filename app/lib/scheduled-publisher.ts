import type { Post } from "./types";

export function publishingScheduledPost(post: Post, attemptedAt: number): Post {
  return {
    ...post,
    publishState: "publishing",
    publishError: undefined,
    publishAttemptedAt: attemptedAt,
    updatedAt: attemptedAt,
  };
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

// Pure boundary for deciding what a scheduler tick may claim. In particular,
// an in-flight post remains scheduled for the UI but cannot be selected twice.
export function dueScheduledPosts(posts: readonly Post[], now: number): Post[] {
  return posts.filter(
    (post) =>
      post.status === "scheduled" &&
      typeof post.scheduledAt === "number" &&
      Number.isFinite(post.scheduledAt) &&
      post.scheduledAt <= now &&
      (post.publishState === undefined ||
        post.publishState === "idle" ||
        post.publishState === "failed"),
  );
}
