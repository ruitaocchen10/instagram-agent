import type { ScheduledPublishState } from "../shared/types";

// The delivery lifecycle itself lives in `social-content`; this predicate reads
// the collapsed publish state that the derived Post view still carries, so the
// composer and deletion can refuse an in-flight creative before touching
// storage. It retires with the Post shape.
export function isScheduledPublishLocked(state: ScheduledPublishState | undefined): boolean {
  return state === "claimed" || state === "publishing";
}
