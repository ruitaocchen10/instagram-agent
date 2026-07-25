import { savePost } from "../persistence/storage";
import type { Post, PostMedia } from "../shared/types";
import { newPostMedia } from "../media/media";
import { CAPTION_MAX } from "../../sidecar/app-tool-contract";

export { CAPTION_MAX } from "../../sidecar/app-tool-contract";

export interface CreateDraftInput {
  caption: string;
  imageUrl?: string;
  media?: PostMedia;
}

function validatedDraft(input: CreateDraftInput): Required<Pick<CreateDraftInput, "caption">> & {
  imageUrl: string;
  media: PostMedia;
} {
  if (typeof input.caption !== "string") {
    throw new Error("Draft caption must be text.");
  }
  if (input.caption.length > CAPTION_MAX) {
    throw new Error(`Draft caption must be ${CAPTION_MAX} characters or fewer.`);
  }
  const media = input.media
    ? newPostMedia(input.media)
    : newPostMedia({ type: "image", source: { kind: "url", url: input.imageUrl ?? "" } });
  if (media.source.kind === "local") {
    return { caption: input.caption, imageUrl: "", media };
  }
  const imageUrl = media.source.url;
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    throw new Error("Draft media must be a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Draft media must use an http or https URL.");
  }

  return { caption: input.caption, imageUrl, media };
}

// The single application operation used by both the composer and copilot.
// Persistence completes before the draft is returned to either caller.
export async function createDraft(input: CreateDraftInput): Promise<Post> {
  const content = validatedDraft(input);
  const draft: Post = {
    id: crypto.randomUUID(),
    imageUrl: content.imageUrl,
    media: content.media,
    caption: content.caption,
    status: "draft",
    updatedAt: Date.now(),
  };
  await savePost(draft);
  return draft;
}
