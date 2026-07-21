import { savePost } from "./storage";
import type { Post } from "./types";

export const CAPTION_MAX = 2200;

export interface CreateDraftInput {
  caption: string;
  imageUrl: string;
}

function validatedDraft(input: CreateDraftInput): CreateDraftInput {
  if (typeof input.caption !== "string") {
    throw new Error("Draft caption must be text.");
  }
  if (input.caption.length > CAPTION_MAX) {
    throw new Error(`Draft caption must be ${CAPTION_MAX} characters or fewer.`);
  }
  if (typeof input.imageUrl !== "string" || !input.imageUrl.trim()) {
    throw new Error("Draft media must include an image URL.");
  }

  const imageUrl = input.imageUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    throw new Error("Draft media must be a valid image URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Draft media must use an http or https image URL.");
  }

  return { caption: input.caption, imageUrl };
}

// The single application operation used by both the composer and copilot.
// Persistence completes before the draft is returned to either caller.
export async function createDraft(input: CreateDraftInput): Promise<Post> {
  const content = validatedDraft(input);
  const draft: Post = {
    id: crypto.randomUUID(),
    imageUrl: content.imageUrl,
    caption: content.caption,
    status: "draft",
    updatedAt: Date.now(),
  };
  await savePost(draft);
  return draft;
}
