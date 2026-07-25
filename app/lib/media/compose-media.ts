import type { PostMedia } from "../shared/types";

export function canChooseLocalMedia(type: PostMedia["type"], r2Configured: boolean): boolean {
  return type === "reel" || r2Configured;
}
