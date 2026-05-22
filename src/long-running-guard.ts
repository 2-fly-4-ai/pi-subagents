import type { AgentRecord } from "./types.js";
import { getLifetimeTotal } from "./usage.js";

export type LongRunningReason = "time_threshold" | "turn_threshold" | "token_threshold";

export interface LongRunningGuardConfig {
  readonly activeNoticeAfterMs: number;
  readonly activeNoticeAfterTurns?: number;
  readonly activeNoticeAfterTokens?: number;
}

export interface LongRunningMetrics {
  readonly elapsedMs: number;
  readonly turns: number;
  readonly tokens: number;
}

export interface LongRunningNotice {
  readonly reason: LongRunningReason;
  readonly metrics: LongRunningMetrics;
}

export const DEFAULT_LONG_RUNNING_GUARD: LongRunningGuardConfig = {
  activeNoticeAfterMs: 20 * 60_000,
  activeNoticeAfterTurns: 30,
  activeNoticeAfterTokens: 200_000,
};

export function getLongRunningMetrics(record: AgentRecord, now = Date.now()): LongRunningMetrics {
  return {
    elapsedMs: now - record.startedAt,
    turns: record.turnCount ?? 0,
    tokens: getLifetimeTotal(record.lifetimeUsage),
  };
}

export function nextLongRunningNotice(
  record: AgentRecord,
  config: LongRunningGuardConfig,
  now = Date.now(),
): LongRunningNotice | undefined {
  if (record.status !== "running") return undefined;
  if (record.needsAttentionAt !== undefined) return undefined;

  const metrics = getLongRunningMetrics(record, now);
  if (metrics.elapsedMs >= config.activeNoticeAfterMs) return { reason: "time_threshold", metrics };
  if (config.activeNoticeAfterTurns !== undefined && metrics.turns >= config.activeNoticeAfterTurns) {
    return { reason: "turn_threshold", metrics };
  }
  if (config.activeNoticeAfterTokens !== undefined && metrics.tokens >= config.activeNoticeAfterTokens) {
    return { reason: "token_threshold", metrics };
  }
  return undefined;
}
