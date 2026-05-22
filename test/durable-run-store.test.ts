import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type DurableRunStatus, DurableRunStore } from "../src/durable-run-store.js";
import type { AgentRecord } from "../src/types.js";

let tempDirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagents-runs-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent/one",
    type: "worker",
    description: "do work",
    status: "running",
    toolUses: 2,
    startedAt: 100,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...overrides,
  } as AgentRecord;
}

function readStatus(root: string, id = "agent_one"): DurableRunStatus {
  return JSON.parse(readFileSync(join(root, id, "status.json"), "utf8"));
}

describe("DurableRunStore", () => {
  it("writes a status.json file for an agent record", () => {
    const root = tempRoot();
    const store = new DurableRunStore(root, { ownerPid: 123, now: () => 456 });

    const status = store.write(record({ cwd: "/repo", result: "done" }));

    expect(status).toMatchObject({
      version: 1,
      id: "agent/one",
      type: "worker",
      description: "do work",
      status: "running",
      ownerPid: 123,
      cwd: "/repo",
      startedAt: 100,
      updatedAt: 456,
      toolUses: 2,
      resultPreview: "done",
    });
    expect(readStatus(root)).toEqual(status);
  });

  it("truncates long result previews", () => {
    const root = tempRoot();
    const store = new DurableRunStore(root, { ownerPid: 123, now: () => 456 });

    store.write(record({ result: "x".repeat(2_010) }));

    const status = readStatus(root);
    expect(status.resultPreview).toHaveLength(2_001);
    expect(status.resultPreview?.endsWith("…")).toBe(true);
  });

  it("looks up existing statuses by original id", () => {
    const root = tempRoot();
    const store = new DurableRunStore(root, { ownerPid: 123, now: () => 456 });

    store.write(record({ id: "agent/one", status: "completed", result: "done" }));

    expect(store.get("agent/one")).toMatchObject({
      id: "agent/one",
      status: "completed",
      resultPreview: "done",
    });
    expect(store.get("missing")).toBeUndefined();
  });

  it("marks stale queued and running records owned by dead processes as error", () => {
    const root = tempRoot();
    const writer = new DurableRunStore(root, { ownerPid: 111, now: () => 1_000 });
    writer.write(record({ id: "running", status: "running" }));
    writer.write(record({ id: "queued", status: "queued" }));
    writer.write(record({ id: "done", status: "completed", completedAt: 1_010 }));

    const reconciler = new DurableRunStore(root, {
      ownerPid: 222,
      now: () => 2_000,
      isProcessAlive: () => false,
    });

    const result = reconciler.reconcileStaleRuns();

    expect(result.reconciled.map((s) => s.id).sort()).toEqual(["queued", "running"]);
    expect(result.active).toEqual([]);
    expect(readStatus(root, "running")).toMatchObject({
      id: "running",
      status: "error",
      stale: true,
      completedAt: 2_000,
      updatedAt: 2_000,
      error: "Subagent owner process 111 is no longer running; marked stale.",
    });
    expect(readStatus(root, "done")).toMatchObject({ id: "done", status: "completed" });
  });

  it("leaves active records alone when their owner process is still alive", () => {
    const root = tempRoot();
    const writer = new DurableRunStore(root, { ownerPid: 111, now: () => 1_000 });
    writer.write(record({ id: "running", status: "running" }));

    const reconciler = new DurableRunStore(root, {
      ownerPid: 222,
      now: () => 2_000,
      isProcessAlive: (pid) => pid === 111,
    });

    const result = reconciler.reconcileStaleRuns();

    expect(result.reconciled).toEqual([]);
    expect(result.active.map((s) => s.id)).toEqual(["running"]);
    expect(readStatus(root, "running")).toMatchObject({
      id: "running",
      status: "running",
      updatedAt: 1_000,
    });
  });
});
