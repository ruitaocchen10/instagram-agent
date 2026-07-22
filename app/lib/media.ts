import type { Post, PostMedia } from "./types";

export function newPostMedia(media: PostMedia): PostMedia {
  if (media.source.kind === "url") {
    const url = media.source.url.trim();
    if (!url) throw new Error("Media URL is required.");
    return { ...media, source: { kind: "url", url } };
  }
  if (!media.source.assetId.trim() || !media.source.fileName.trim()) {
    throw new Error("Local media is missing its managed asset reference.");
  }
  if (!Number.isFinite(media.source.size) || media.source.size <= 0) {
    throw new Error("Local media size must be greater than zero.");
  }
  return media;
}

export function mediaForPost(post: Pick<Post, "imageUrl" | "media">): PostMedia {
  if (post.media) return newPostMedia(post.media);
  return {
    type: "image",
    source: { kind: "url", url: post.imageUrl.trim() },
  };
}

export function mediaDisplayUrl(post: Pick<Post, "imageUrl" | "media">): string {
  const media = mediaForPost(post);
  return media.source.kind === "url" ? media.source.url : post.imageUrl;
}
