import { describe, expect, it } from "vitest";
import { deriveChatTitle } from "./chat-title";

describe("deriveChatTitle", () => {
  it("keeps a short message verbatim", () => {
    expect(deriveChatTitle("Plan a week of posts")).toBe("Plan a week of posts");
  });

  it("collapses whitespace and newlines", () => {
    expect(deriveChatTitle("  Draft   captions\nfor sunrise ")).toBe(
      "Draft captions for sunrise",
    );
  });

  it("falls back when the message is blank", () => {
    expect(deriveChatTitle("   \n  ")).toBe("New chat");
  });

  it("truncates a long message at a word boundary with an ellipsis", () => {
    const title = deriveChatTitle(
      "Write three caption options for this sunrise photo from the trail",
    );
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(41);
    expect(title).not.toContain("  ");
    // Cut on a boundary, not mid-word.
    expect(title).toBe("Write three caption options for this…");
  });

  it("hard-slices a single oversized token", () => {
    const title = deriveChatTitle("a".repeat(80));
    expect(title).toBe(`${"a".repeat(40)}…`);
  });
});
