"use client";

import { IconHeart, IconComment, IconShare, IconBookmark, IconMore, IconImage } from "./icons";

export default function PostPreview({
  username,
  imageUrl,
  caption,
  mediaType = "image",
  likes = 128,
}: {
  username: string;
  imageUrl: string;
  caption: string;
  mediaType?: "image" | "reel";
  likes?: number;
}) {
  return (
    <div className="ig-preview">
      <div className="ig-head">
        <div className="av">
          <span>{username.slice(0, 2).toUpperCase()}</span>
        </div>
        <div className="u">{username}</div>
        <div className="more">
          <IconMore size={18} />
        </div>
      </div>

      {imageUrl && mediaType === "reel" ? (
        <video className="ig-media" src={imageUrl} controls playsInline preload="metadata" />
      ) : imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="ig-media" src={imageUrl} alt="Post preview" />
      ) : (
        <div className="ig-media empty">
          <IconImage size={30} />
          <span>Add media to preview your post</span>
        </div>
      )}

      <div className="ig-actions">
        <IconHeart size={24} />
        <IconComment size={24} />
        <IconShare size={24} />
        <div className="spacer" />
        <IconBookmark size={24} />
      </div>

      <div className="ig-likes">{likes.toLocaleString()} likes</div>

      <div className="ig-caption">
        {caption ? (
          <>
            <span className="u">{username}</span>
            {caption}
          </>
        ) : (
          <span className="ph">Your caption preview will appear here…</span>
        )}
      </div>
    </div>
  );
}
