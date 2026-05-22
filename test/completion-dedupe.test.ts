import { describe, expect, it } from "vitest";
import { buildCompletionKey, createCompletionDedupe, markSeenWithTtl } from "../src/completion-dedupe.js";

describe("completion dedupe", () => {
  it("builds stable keys from completion ids", () => {
    expect(buildCompletionKey({ id: "abc", status: "completed", completedAt: 10 }, "x")).toBe("id:abc:completed:10");
    expect(buildCompletionKey({}, "x")).toBe("fallback:x");
  });

  it("marks duplicate keys within ttl", () => {
    const seen = new Map<string, number>();
    expect(markSeenWithTtl(seen, "key", 1_000, 500)).toBe(false);
    expect(markSeenWithTtl(seen, "key", 1_100, 500)).toBe(true);
    expect(markSeenWithTtl(seen, "key", 2_000, 500)).toBe(false);
  });

  it("dedupes completion objects", () => {
    let now = 1_000;
    const dedupe = createCompletionDedupe(500, () => now);
    const completion = { id: "abc", status: "completed", completedAt: 10 };

    expect(dedupe.isDuplicate(completion, "x")).toBe(false);
    expect(dedupe.isDuplicate(completion, "x")).toBe(true);
    now = 2_000;
    expect(dedupe.isDuplicate(completion, "x")).toBe(false);
  });
});
