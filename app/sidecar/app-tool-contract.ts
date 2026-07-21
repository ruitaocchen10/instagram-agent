export const CREATE_DRAFT_TOOL = "create_draft" as const;
export const CREATE_DRAFT_SDK_TOOL = "mcp__socialite__create_draft" as const;
export const LIST_POSTS_TOOL = "list_posts" as const;
export const LIST_POSTS_SDK_TOOL = "mcp__socialite__list_posts" as const;
export const GET_ANALYTICS_TOOL = "get_analytics" as const;
export const GET_ANALYTICS_SDK_TOOL = "mcp__socialite__get_analytics" as const;
export const SCHEDULE_POST_TOOL = "schedule_post" as const;
export const SCHEDULE_POST_SDK_TOOL = "mcp__socialite__schedule_post" as const;
export const PUBLISH_NOW_TOOL = "publish_now" as const;
export const PUBLISH_NOW_SDK_TOOL = "mcp__socialite__publish_now" as const;
export const CAPTION_MAX = 2200;

export type AppToolName =
  | typeof CREATE_DRAFT_TOOL
  | typeof LIST_POSTS_TOOL
  | typeof GET_ANALYTICS_TOOL
  | typeof SCHEDULE_POST_TOOL
  | typeof PUBLISH_NOW_TOOL;

export type AppToolInput =
  | CreateDraftToolInput
  | ListPostsToolInput
  | GetAnalyticsToolInput
  | SchedulePostToolInput
  | PublishNowToolInput;

export interface CreateDraftToolInput {
  caption: string;
  image_url: string;
}

export interface CreateDraftToolResult {
  draft_id: string;
  status: "draft";
  message: string;
}

export type ListPostsToolInput = Record<string, never>;

export interface ListedPost {
  post_id: string;
  caption: string;
  image_url: string;
  status: "draft" | "scheduled" | "published";
  scheduled_at: string | null;
  published_at: string | null;
}

export interface ListPostsToolResult {
  posts: ListedPost[];
  message: string;
}

export type GetAnalyticsToolInput = Record<string, never>;
export type AnalyticsMetric = "likes" | "comments";

export interface PostAnalytics {
  post_id: string;
  caption: string;
  published_at: string | null;
  metrics: Record<AnalyticsMetric, number | null>;
  unavailable_metrics: AnalyticsMetric[];
}

export interface GetAnalyticsToolResult {
  posts: PostAnalytics[];
  message: string;
}

export interface SchedulePostToolInput {
  post_id: string;
  scheduled_at: string;
}

export interface SchedulePostToolResult {
  post_id: string;
  status: "scheduled";
  scheduled_at: string;
  message: string;
}

export interface PublishNowToolInput {
  post_id: string;
  caption: string;
  image_url: string;
}

export interface PublishNowToolResult {
  post_id: string;
  media_id: string;
  status: "published";
  message: string;
}

export type AppToolResult =
  | CreateDraftToolResult
  | ListPostsToolResult
  | GetAnalyticsToolResult
  | SchedulePostToolResult
  | PublishNowToolResult;
