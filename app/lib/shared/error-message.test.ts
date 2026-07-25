import { describe, expect, it } from "vitest";
import { errorMessage } from "./error-message";

describe("errorMessage", () => {
  it("keeps a string rejection visible to the user", () => {
    expect(errorMessage("no such table: deliveries", "Couldn't schedule the post.")).toBe(
      "no such table: deliveries",
    );
  });

  it("uses the fallback only when a rejection has no useful message", () => {
    expect(errorMessage(null, "Couldn't schedule the post.")).toBe("Couldn't schedule the post.");
  });

  it("keeps a native error object's message visible", () => {
    expect(errorMessage({ message: "SQLite error: no such table" }, "Couldn't schedule the post.")).toBe(
      "SQLite error: no such table",
    );
  });
});
