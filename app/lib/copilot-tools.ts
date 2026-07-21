import type {
  GetAnalyticsToolResult,
  ListPostsToolResult,
  PostAnalytics,
} from "../sidecar/app-tool-contract";
import type { Post } from "./types";

function isoTimestamp(value: number | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : null;
}

// Read-only projections of current application state for the copilot. Returning
// new records keeps the tool boundary from handing mutable Post objects to RPC.
export function listPostsForCopilot(posts: readonly Post[]): ListPostsToolResult {
  const listed = posts.map((post) => ({
    post_id: post.id,
    caption: post.caption,
    image_url: post.imageUrl,
    status: post.status,
    scheduled_at: isoTimestamp(post.scheduledAt),
    published_at: isoTimestamp(post.publishedAt),
  }));
  const counts = {
    draft: listed.filter((post) => post.status === "draft").length,
    scheduled: listed.filter((post) => post.status === "scheduled").length,
    published: listed.filter((post) => post.status === "published").length,
  };
  return {
    posts: listed,
    message: `${counts.draft} drafts, ${counts.scheduled} scheduled posts, and ${counts.published} published posts are currently available.`,
  };
}

export function getAnalyticsForCopilot(posts: readonly Post[]): GetAnalyticsToolResult {
  const analytics: PostAnalytics[] = posts
    .filter((post) => post.status === "published")
    .map((post) => {
      const unavailable: PostAnalytics["unavailable_metrics"] = [];
      if (typeof post.likes !== "number") unavailable.push("likes");
      if (typeof post.comments !== "number") unavailable.push("comments");
      return {
        post_id: post.id,
        caption: post.caption,
        published_at: isoTimestamp(post.publishedAt),
        metrics: {
          likes: typeof post.likes === "number" ? post.likes : null,
          comments: typeof post.comments === "number" ? post.comments : null,
        },
        unavailable_metrics: unavailable,
      };
    });

  return {
    posts: analytics,
    message:
      analytics.length === 0
        ? "No published posts are currently available for analytics."
        : `Analytics are available for ${analytics.length} published posts; null metrics are named in unavailable_metrics.`,
  };
}
