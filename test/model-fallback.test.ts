import { describe, expect, it } from "vitest";
import { errorMessage, isRetryableModelFailure, modelLabel } from "../src/model-fallback.js";

describe("model fallback helpers", () => {
  it("recognizes retryable model/provider failures", () => {
    expect(isRetryableModelFailure(new Error("429 rate limit"))).toBe(true);
    expect(isRetryableModelFailure("model unavailable")).toBe(true);
    expect(isRetryableModelFailure("network error")).toBe(true);
    expect(isRetryableModelFailure("tool failed: grep path not found")).toBe(false);
  });

  it("formats model labels defensively", () => {
    expect(modelLabel(undefined)).toBe("parent-model");
    expect(modelLabel({ provider: "openai", id: "gpt-x" } as any)).toBe("openai/gpt-x");
    expect(modelLabel({ id: "gpt-x" } as any)).toBe("gpt-x");
  });

  it("normalizes thrown values to messages", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("boom")).toBe("boom");
  });
});
