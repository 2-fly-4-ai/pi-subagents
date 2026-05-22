import { describe, expect, it } from "vitest";
import { nextLongRunningNotice } from "../src/long-running-guard.js";
import type { AgentRecord } from "../src/types.js";

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    type: "worker",
    description: "do work",
    status: "running",
    startedAt: 1_000,
    toolUses: 0,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    isBackground: true,
    ...overrides,
  } as AgentRecord;
}

describe("long-running guard", () => {
  it("triggers on elapsed time", () => {
    expect(nextLongRunningNotice(record(), { activeNoticeAfterMs: 500 }, 1_600)).toEqual({
      reason: "time_threshold",
      metrics: { elapsedMs: 600, turns: 0, tokens: 0 },
    });
  });

  it("triggers on turns when time threshold has not been reached", () => {
    expect(nextLongRunningNotice(
      record({ turnCount: 4 }),
      { activeNoticeAfterMs: 10_000, activeNoticeAfterTurns: 4 },
      1_100,
    )).toEqual({
      reason: "turn_threshold",
      metrics: { elapsedMs: 100, turns: 4, tokens: 0 },
    });
  });

  it("triggers on tokens when time and turn thresholds have not been reached", () => {
    expect(nextLongRunningNotice(
      record({ lifetimeUsage: { input: 50, output: 40, cacheWrite: 10 } }),
      { activeNoticeAfterMs: 10_000, activeNoticeAfterTurns: 5, activeNoticeAfterTokens: 100 },
      1_100,
    )).toEqual({
      reason: "token_threshold",
      metrics: { elapsedMs: 100, turns: 0, tokens: 100 },
    });
  });

  it("does not retrigger once attention was requested", () => {
    expect(nextLongRunningNotice(
      record({ needsAttentionAt: 1_500 }),
      { activeNoticeAfterMs: 500 },
      1_600,
    )).toBeUndefined();
  });

  it("does not trigger for terminal records", () => {
    expect(nextLongRunningNotice(
      record({ status: "completed" }),
      { activeNoticeAfterMs: 500 },
      1_600,
    )).toBeUndefined();
  });
});
