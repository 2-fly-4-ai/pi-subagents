import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

const LOG_DIR = "logs";
const LOG_FILE = "subagents-audit.jsonl";

export type AuditPayload = Record<string, unknown>;

export function auditLogPath(): string {
  return join(getAgentDir(), LOG_DIR, LOG_FILE);
}

export function appendAudit(event: string, payload: AuditPayload = {}): void {
  try {
    const path = auditLogPath();
    mkdirSync(join(getAgentDir(), LOG_DIR), { recursive: true, mode: 0o700 });
    appendFileSync(
      path,
      JSON.stringify({ ts: new Date().toISOString(), event, ...payload }) + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // Audit logging must never break agent execution.
  }
}

export function excerpt(text: unknown, max = 500): string | undefined {
  if (typeof text !== "string") return undefined;
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > max ? compact.slice(0, max) + "…" : compact;
}
