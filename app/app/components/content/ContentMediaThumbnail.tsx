import type { ContentMedia } from "@/lib/content/social-content";

// Content is platform-neutral, so the still comes from the media itself: a URL
// the platform can fetch, or the preview the shell resolved for managed media.
export default function ContentMediaThumbnail({
  media,
  previewUrl,
  className,
}: {
  media: ContentMedia;
  previewUrl: string;
  className?: string;
}) {
  if (media.type === "video") {
    return <video className={className} src={previewUrl} muted playsInline preload="metadata" />;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={className} src={previewUrl} alt="" />;
}
