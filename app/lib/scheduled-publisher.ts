import type { Post } from "./types";

// Pure boundary for deciding what a scheduler tick may claim. In particular,
// an in-flight post remains scheduled for the UI but cannot be selected twice.
export function dueScheduledPosts(posts: readonly Post[], now: number): Post[] {
  return posts.filter(
    (post) =>
      post.status === "scheduled" &&
      typeof post.scheduledAt === "number" &&
      Number.isFinite(post.scheduledAt) &&
      post.scheduledAt <= now &&
      post.publishState !== "publishing",
  );
}
