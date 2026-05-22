import { describe, expect, it } from "vitest";
import { completionGuardWarning, expectsImplementationMutation, isMutatingBashCommand, isMutatingTool } from "../src/completion-guard.js";

describe("completion guard", () => {
  it("expects mutations for implementation-like work", () => {
    expect(expectsImplementationMutation("worker", "fix the failing test")).toBe(true);
    expect(expectsImplementationMutation("general-purpose", "update the README file")).toBe(true);
  });

  it("does not expect mutations for read-only/research work", () => {
    expect(expectsImplementationMutation("Explore", "fix the failing test")).toBe(false);
    expect(expectsImplementationMutation("worker", "review only and return findings")).toBe(false);
    expect(expectsImplementationMutation("worker", "do not edit; suggest a fix")).toBe(false);
  });

  it("detects mutating tools and bash commands", () => {
    expect(isMutatingTool("edit", { path: "x" })).toBe(true);
    expect(isMutatingTool("write", { path: "x" })).toBe(true);
    expect(isMutatingTool("read", { path: "x" })).toBe(false);
    expect(isMutatingBashCommand("git diff > patch.txt")).toBe(true);
    expect(isMutatingBashCommand("grep foo file.txt")).toBe(false);
  });

  it("warns when expected mutations were not attempted", () => {
    expect(completionGuardWarning("worker", "fix the failing test", false)).toMatch(/Completion guard/);
    expect(completionGuardWarning("worker", "fix the failing test", true)).toBeUndefined();
  });
});
