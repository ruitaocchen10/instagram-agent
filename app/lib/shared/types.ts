// Shared types for the MVP mock UI.

export type PostStatus = "draft" | "scheduled" | "published";
export type ScheduledPublishState =
  | "idle"
  | "claimed"
  | "publishing"
  | "failed"
  | "uncertain"
  | "canceled";

export interface Post {
  id: string;
  imageUrl: string;
  media?: PostMedia;
  caption: string;
  status: PostStatus;
  scheduledAt?: number; // epoch ms — set for scheduled
  publishedAt?: number; // epoch ms — set for published
  likes?: number;
  comments?: number;
  updatedAt?: number; // epoch ms — last local edit; drives ordering. Local posts only.
  publishState?: ScheduledPublishState;
  publishError?: string;
  publishAttemptedAt?: number;
  publishAttemptCount?: number;
}

export interface UrlMediaSource {
  kind: "url";
  url: string;
}

export interface LocalMediaSource {
  kind: "local";
  assetId: string;
  fileName: string;
  mimeType: string;
  size: number;
  posterAssetId?: string;
}

export type MediaSource = UrlMediaSource | LocalMediaSource;

export type PostMedia =
  | { type: "image"; source: MediaSource }
  | { type: "reel"; source: MediaSource; shareToFeed: boolean };

export interface PostIdea {
  id: string;
  title: string;
  caption: string;
  imageUrl: string;
}

export interface ChatMessage {
  id: string;
  role: "ai" | "user";
  text: string;
  ideas?: PostIdea[];
  typing?: boolean;
}

export interface Account {
  username: string;
  fullName: string;
  followers: number;
  igUserId: string;
  profilePicUrl?: string;
}

export type AiProviderId = "claude" | "openai";

export interface AiProvider {
  id: AiProviderId;
  name: string;
  model: string;
  connected: boolean;
}
