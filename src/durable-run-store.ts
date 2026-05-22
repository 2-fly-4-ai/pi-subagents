import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentRecord } from "./types.js";

export type DurableRunTerminalStatus = "paused" | "completed" | "steered" | "aborted" | "stopped" | "error";
export type DurableRunActiveStatus = "queued" | "running";
export type DurableRunStatusValue = DurableRunActiveStatus | DurableRunTerminalStatus;

export interface DurableRunStatus {
  version: 1;
  id: string;
  type: string;
  description: string;
  status: DurableRunStatusValue;
  ownerPid: number;
  cwd?: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  toolUses: number;
  resultPreview?: string;
  resultPath?: string;
  error?: string;
  turnCount?: number;
  needsAttentionAt?: number;
  needsAttentionReason?: "time_threshold" | "turn_threshold" | "token_threshold";
  stale?: boolean;
}

export interface DurableRunReconciliationResult {
  reconciled: DurableRunStatus[];
  active: DurableRunStatus[];
}

export interface DurableRunStatusStore {
  write(record: AgentRecord): DurableRunStatus;
  get(id: string): DurableRunStatus | undefined;
  readResult(id: string): string | undefined;
  readAll(): DurableRunStatus[];
  reconcileStaleRuns(): DurableRunReconciliationResult;
}

interface DurableRunStoreOptions {
  ownerPid?: number;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
}

const PREVIEW_LIMIT = 2_000;

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function preview(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.length <= PREVIEW_LIMIT ? value : `${value.slice(0, PREVIEW_LIMIT)}…`;
}

function isActive(status: DurableRunStatusValue): status is DurableRunActiveStatus {
  return status === "queued" || status === "running";
}

function hasTerminalResult(record: AgentRecord): boolean {
  return !isActive(record.status) && typeof record.result === "string" && record.result.trim().length > 0;
}

export class DurableRunStore implements DurableRunStatusStore {
  private readonly ownerPid: number;
  private readonly now: () => number;
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor(private readonly rootDir: string, options: DurableRunStoreOptions = {}) {
    this.ownerPid = options.ownerPid ?? process.pid;
    this.now = options.now ?? (() => Date.now());
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  }

  write(record: AgentRecord): DurableRunStatus {
    const resultPath = hasTerminalResult(record) ? this.writeResultArtifact(record.id, record.result!) : undefined;
    const status: DurableRunStatus = {
      version: 1,
      id: record.id,
      type: record.type,
      description: record.description,
      status: record.status,
      ownerPid: this.ownerPid,
      cwd: record.cwd,
      startedAt: record.startedAt,
      updatedAt: this.now(),
      completedAt: record.completedAt,
      toolUses: record.toolUses,
      resultPreview: preview(record.result),
      resultPath,
      error: record.error,
      turnCount: record.turnCount,
      needsAttentionAt: record.needsAttentionAt,
      needsAttentionReason: record.needsAttentionReason,
    };
    this.writeStatus(status);
    return status;
  }

  get(id: string): DurableRunStatus | undefined {
    try {
      const statusPath = join(this.rootDir, safeSegment(id), "status.json");
      const parsed = JSON.parse(readFileSync(statusPath, "utf8")) as DurableRunStatus;
      return parsed.version === 1 && parsed.id === id ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  readResult(id: string): string | undefined {
    const status = this.get(id);
    if (!status?.resultPath) return undefined;
    try {
      if (!existsSync(status.resultPath)) return undefined;
      return readFileSync(status.resultPath, "utf8");
    } catch {
      return undefined;
    }
  }

  readAll(): DurableRunStatus[] {
    let entries: string[];
    try {
      entries = readdirSync(this.rootDir);
    } catch {
      return [];
    }

    const statuses: DurableRunStatus[] = [];
    for (const entry of entries) {
      const statusPath = join(this.rootDir, entry, "status.json");
      try {
        const parsed = JSON.parse(readFileSync(statusPath, "utf8")) as DurableRunStatus;
        if (parsed.version === 1 && typeof parsed.id === "string") statuses.push(parsed);
      } catch {
        // Ignore malformed or partially-written status files; they should not
        // break extension startup or status reconciliation.
      }
    }
    return statuses;
  }

  reconcileStaleRuns(): DurableRunReconciliationResult {
    const reconciled: DurableRunStatus[] = [];
    const active: DurableRunStatus[] = [];

    for (const status of this.readAll()) {
      if (!isActive(status.status)) continue;
      if (status.ownerPid === this.ownerPid || this.isProcessAlive(status.ownerPid)) {
        active.push(status);
        continue;
      }

      const staleStatus: DurableRunStatus = {
        ...status,
        status: "error",
        stale: true,
        completedAt: this.now(),
        updatedAt: this.now(),
        error: `Subagent owner process ${status.ownerPid} is no longer running; marked stale.`,
      };
      this.writeStatus(staleStatus);
      reconciled.push(staleStatus);
    }

    return { reconciled, active };
  }

  private writeStatus(status: DurableRunStatus): void {
    const dir = join(this.rootDir, safeSegment(status.id));
    const file = join(dir, "status.json");
    const tmp = join(dir, `status.${process.pid}.${Date.now()}.tmp`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
  }

  private writeResultArtifact(id: string, result: string): string {
    const dir = join(this.rootDir, safeSegment(id));
    const file = join(dir, "result.md");
    const tmp = join(dir, `result.${process.pid}.${Date.now()}.tmp`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, result, "utf8");
    renameSync(tmp, file);
    return file;
  }
}
