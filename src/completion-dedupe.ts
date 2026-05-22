export interface CompletionLike {
  readonly id?: string;
  readonly status?: string;
  readonly completedAt?: number;
}

function pruneSeenMap(seen: Map<string, number>, now: number, ttlMs: number): void {
  for (const [key, ts] of seen.entries()) {
    if (now - ts > ttlMs) seen.delete(key);
  }
}

export function buildCompletionKey(completion: CompletionLike, fallback: string): string {
  const id = completion.id?.trim();
  if (id) return `id:${id}:${completion.status ?? "unknown"}:${completion.completedAt ?? "no-completed-at"}`;
  return `fallback:${fallback}`;
}

export function markSeenWithTtl(seen: Map<string, number>, key: string, now: number, ttlMs: number): boolean {
  pruneSeenMap(seen, now, ttlMs);
  if (seen.has(key)) return true;
  seen.set(key, now);
  return false;
}

export function createCompletionDedupe(ttlMs: number, now: () => number = () => Date.now()) {
  const seen = new Map<string, number>();
  return {
    isDuplicate(completion: CompletionLike, fallback: string): boolean {
      return markSeenWithTtl(seen, buildCompletionKey(completion, fallback), now(), ttlMs);
    },
    size(): number {
      pruneSeenMap(seen, now(), ttlMs);
      return seen.size;
    },
  };
}
