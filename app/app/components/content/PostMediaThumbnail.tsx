import type { Post } from "@/lib/shared/types";

export default function PostMediaThumbnail({
  post,
  className,
}: {
  post: Post;
  className?: string;
}) {
  if (post.media?.type === "reel" && post.status !== "published") {
    return <video className={className} src={post.imageUrl} muted playsInline preload="metadata" />;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={className} src={post.imageUrl} alt="" />;
}
