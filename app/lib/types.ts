// Shared types for the MVP mock UI.

export type PostStatus = "draft" | "scheduled" | "published";
export type ScheduledPublishState = "idle" | "publishing" | "failed" | "uncertain";

export interface Post {
  id: string;
  imageUrl: string;
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
}

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
