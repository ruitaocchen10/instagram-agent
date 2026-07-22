// Derives a readable chat title from the user's first message so the chats
// list reads like the message ("Plan a week of posts") instead of "New chat".
const MAX_TITLE_LENGTH = 40;

export function deriveChatTitle(firstMessage: string): string {
  const normalized = firstMessage.replace(/\s+/g, " ").trim();
  if (!normalized) return "New chat";
  if (normalized.length <= MAX_TITLE_LENGTH) return normalized;
  // Trim to the last word boundary within the limit so titles don't cut a word
  // in half; fall back to a hard slice when a single token is oversized.
  const clipped = normalized.slice(0, MAX_TITLE_LENGTH);
  const lastSpace = clipped.lastIndexOf(" ");
  const base = lastSpace > 20 ? clipped.slice(0, lastSpace) : clipped;
  return `${base.trimEnd()}…`;
}
