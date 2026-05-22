import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import type { DurableRunStatus } from "../src/durable-run-store.js";
import type { AgentRecord } from "../src/types.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

import { runAgent } from "../src/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

const mockSession = () => ({ dispose: vi.fn() } as any);

const resolvedRun = () =>
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "done",
    session: mockSession(),
    aborted: false,
    steered: false,
  });

describe("AgentManager — Bug 1 race condition (resultConsumed vs onComplete)", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("reproduces bug: onComplete fires with resultConsumed=false when set after await", async () => {
    let seenConsumed: boolean | undefined;
    manager = new AgentManager((r) => {
      seenConsumed = r.resultConsumed;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    // Simulate the buggy get_subagent_result: await THEN mark consumed
    await record.promise;
    record.resultConsumed = true; // too late — onComplete already fired

    // onComplete saw resultConsumed as falsy (undefined) — would queue a notification (the bug)
    expect(seenConsumed).toBeFalsy();
  });

  it("fix: onComplete sees resultConsumed=true when pre-marked before await", async () => {
    let seenConsumed: boolean | undefined;
    manager = new AgentManager((r) => {
      seenConsumed = r.resultConsumed;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    // The fix: pre-mark BEFORE awaiting
    record.resultConsumed = true;
    await record.promise;

    expect(seenConsumed).toBe(true);
  });

  it("normal case: onComplete fires with resultConsumed falsy when no explicit polling", async () => {
    let completedRecord: AgentRecord | undefined;
    manager = new AgentManager((r) => {
      completedRecord = r;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(completedRecord).toBeDefined();
    expect(completedRecord!.resultConsumed).toBeFalsy();
  });

  it("onComplete is not called for foreground agents", async () => {
    let onCompleteCalled = false;
    manager = new AgentManager(() => {
      onCompleteCalled = true;
    });
    resolvedRun();

    await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });

    expect(onCompleteCalled).toBe(false);
  });
});

describe("AgentManager — completion callbacks", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("does not let onComplete errors turn a completed agent into a failed run", async () => {
    manager = new AgentManager(() => {
      throw new Error("stale extension context");
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await expect(manager.getRecord(id)!.promise).resolves.toBe("done");

    expect(manager.getRecord(id)!.status).toBe("completed");
  });
});

describe("AgentManager — cleanup timer", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("does not keep the process alive on its own", () => {
    manager = new AgentManager();

    expect((manager as any).cleanupInterval.hasRef()).toBe(false);
  });
});

describe("AgentManager — Bug 3 clearCompleted", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("clearCompleted removes completed records", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(manager.listAgents()).toHaveLength(1);
    manager.clearCompleted();
    expect(manager.listAgents()).toHaveLength(0);
  });

  it("clearCompleted does not remove running or queued agents", async () => {
    // Use maxConcurrent=0 to keep agents queued, then spawn one running via foreground
    manager = new AgentManager(undefined, 1);

    // Mock runAgent to never resolve (keeps agent "running")
    vi.mocked(runAgent).mockImplementation(
      () => new Promise(() => {}), // hangs forever
    );

    const id1 = manager.spawn(mockPi, mockCtx, "general-purpose", "test1", {
      description: "running agent",
      isBackground: true,
    });
    // Second agent should be queued (limit=1)
    const id2 = manager.spawn(mockPi, mockCtx, "general-purpose", "test2", {
      description: "queued agent",
      isBackground: true,
    });

    expect(manager.getRecord(id1)!.status).toBe("running");
    expect(manager.getRecord(id2)!.status).toBe("queued");

    manager.clearCompleted();

    // Both should still be present
    expect(manager.getRecord(id1)).toBeDefined();
    expect(manager.getRecord(id2)).toBeDefined();

    // Abort to allow cleanup
    manager.abort(id1);
    manager.abort(id2);
  });

  it("clearCompleted calls dispose on sessions of removed records", async () => {
    manager = new AgentManager();
    const disposeSpy = vi.fn();
    const sess = { dispose: disposeSpy };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: sess as any,
      aborted: false,
      steered: false,
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    manager.clearCompleted();

    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it("clearCompleted removes error and stopped records", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("error");

    manager.clearCompleted();
    expect(manager.getRecord(id)).toBeUndefined();
  });
});

// Eager init removes the optional/required asymmetry that previously required
// `??=` defaults at the callback sites and `?? 0` / `?? 1` at the read sites.
describe("AgentManager — lifetime usage + compaction count are eagerly initialized", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("spawn initializes lifetimeUsage to zeros and compactionCount to 0", () => {
    manager = new AgentManager();
    // Don't resolve the run — we just want to inspect the record at spawn time.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(record.compactionCount).toBe(0);

    manager.abort(id);
  });

  it("onAssistantUsage from runAgent accumulates into record.lifetimeUsage", async () => {
    manager = new AgentManager();

    // Capture the options passed to runAgent so we can drive callbacks
    let captured: any;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      captured = opts;
      // Two assistant messages with usage
      opts.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 10 });
      opts.onAssistantUsage?.({ input: 200, output: 80, cacheWrite: 20 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(captured).toBeDefined();
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({
      input: 300, output: 130, cacheWrite: 30,
    });
  });

  it("onCompaction from runAgent increments record.compactionCount", async () => {
    manager = new AgentManager();
    const compactSeen: any[] = [];

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      // Compaction fires while the agent is still running — the record passed to
      // onCompact should reflect the just-incremented count.
      opts.onCompaction?.({ reason: "threshold", tokensBefore: 12345 });
      opts.onCompaction?.({ reason: "manual", tokensBefore: 22222 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    manager = new AgentManager(undefined, undefined, undefined, (record, info) => {
      compactSeen.push({ count: record.compactionCount, reason: info.reason });
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(compactSeen).toEqual([
      { count: 1, reason: "threshold" },
      { count: 2, reason: "manual" },
    ]);
    expect(manager.getRecord(id)!.compactionCount).toBe(2);
  });

  it("resume() also accumulates usage and increments compactions on the same record", async () => {
    manager = new AgentManager();

    // First, spawn with a session that resume can latch onto
    const session = { ...mockSession() };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "first",
      session: session as any,
      aborted: false,
      steered: false,
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    // Pre-resume: lifetimeUsage from spawn was zero (mock didn't call onAssistantUsage)
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(manager.getRecord(id)!.compactionCount).toBe(0);

    // Now resume — drive callbacks via the mocked resumeAgent
    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockImplementation(async (_session, _prompt, opts: any) => {
      opts.onAssistantUsage?.({ input: 70, output: 30, cacheWrite: 5 });
      opts.onCompaction?.({ reason: "overflow", tokensBefore: 999 });
      return "second";
    });

    await manager.resume(id, "more");

    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 70, output: 30, cacheWrite: 5 });
    expect(manager.getRecord(id)!.compactionCount).toBe(1);
  });
});

// Regression: `isolation: "worktree"` MUST fail loud when the cwd can't host
// a worktree. The previous behavior silently fell back to the main tree and
// injected a warning into the LLM's prompt — invisible to the caller.
describe("AgentManager — isolation: worktree fails loud, no silent fallback", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("spawn() throws when createWorktree returns undefined; no orphan record left behind", async () => {
    const { createWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce(undefined);
    vi.mocked(runAgent).mockClear();

    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    })).toThrow(/isolation: "worktree"/);

    // Cleaned up — no orphan in listAgents()
    expect(manager.listAgents()).toEqual([]);
    // runAgent never invoked — strict, no silent fallback
    expect(runAgent).not.toHaveBeenCalled();
  });
});

describe("AgentManager — durable background run status", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  function fakeStore(reconciliation = { reconciled: [] as DurableRunStatus[], active: [] as DurableRunStatus[] }) {
    return {
      writes: [] as AgentRecord[],
      statuses: [] as DurableRunStatus[],
      reconciled: false,
      write(record: AgentRecord) {
        this.writes.push({ ...record });
        return {
          version: 1 as const,
          id: record.id,
          type: record.type,
          description: record.description,
          status: record.status,
          ownerPid: 1,
          startedAt: record.startedAt,
          updatedAt: Date.now(),
          toolUses: record.toolUses,
        };
      },
      get(id: string) {
        return this.statuses.find((status) => status.id === id);
      },
      readResult(id: string) {
        return this.statuses.find((status) => status.id === id)?.resultPreview;
      },
      readAll() {
        return this.statuses;
      },
      reconcileStaleRuns() {
        this.reconciled = true;
        return reconciliation;
      },
    };
  }

  it("reconciles durable statuses when constructed", () => {
    const staleStatus: DurableRunStatus = {
      version: 1,
      id: "stale",
      type: "worker",
      description: "stale run",
      status: "error",
      ownerPid: 123,
      startedAt: 1,
      updatedAt: 2,
      completedAt: 2,
      toolUses: 0,
      stale: true,
      error: "owner died",
    };
    const store = fakeStore({ reconciled: [staleStatus], active: [] });
    let seen: any;

    manager = new AgentManager(undefined, undefined, undefined, undefined, {
      durableRunStore: store,
      onDurableRunsReconciled: (result) => { seen = result; },
    });

    expect(store.reconciled).toBe(true);
    expect(seen).toEqual({ reconciled: [staleStatus], active: [] });
    expect(manager.getLastDurableRunReconciliation()).toEqual(seen);
  });

  it("persists background status transitions but not foreground runs", async () => {
    const store = fakeStore();
    manager = new AgentManager(undefined, undefined, undefined, undefined, { durableRunStore: store });

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onToolActivity?.({ type: "end", toolName: "read" });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    const backgroundId = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "background",
      isBackground: true,
    });
    await manager.getRecord(backgroundId)!.promise;

    await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "foreground",
    });

    expect(store.writes.map((r) => r.description)).toEqual([
      "background",
      "background",
      "background",
      "background",
    ]);
    expect(store.writes.map((r) => r.status)).toEqual([
      "queued",
      "running",
      "running",
      "completed",
    ]);
    expect(store.writes.at(-1)).toMatchObject({ result: "done", toolUses: 1 });
  });

  it("lists and looks up durable statuses", () => {
    const store = fakeStore();
    const older: DurableRunStatus = {
      version: 1,
      id: "older",
      type: "worker",
      description: "older run",
      status: "completed",
      ownerPid: 1,
      startedAt: 100,
      updatedAt: 200,
      completedAt: 200,
      toolUses: 1,
      resultPreview: "older result",
    };
    const newer: DurableRunStatus = {
      version: 1,
      id: "newer",
      type: "planner",
      description: "newer run",
      status: "error",
      ownerPid: 1,
      startedAt: 300,
      updatedAt: 400,
      completedAt: 400,
      toolUses: 0,
      error: "boom",
    };
    store.statuses.push(older, newer);

    manager = new AgentManager(undefined, undefined, undefined, undefined, { durableRunStore: store });

    expect(manager.listDurableRuns().map((status) => status.id)).toEqual(["newer", "older"]);
    expect(manager.getDurableRun("older")).toEqual(older);
    expect(manager.getDurableResult("older")).toBe(older.resultPreview);
    expect(manager.getDurableRun("missing")).toBeUndefined();
  });


  it("emits a needs-attention notice once when a background run crosses a threshold", async () => {
    const store = fakeStore();
    const notices: any[] = [];
    manager = new AgentManager(undefined, undefined, undefined, undefined, {
      durableRunStore: store,
      longRunningGuard: { activeNoticeAfterMs: 60_000, activeNoticeAfterTurns: 1 },
      onNeedsAttention: (record, notice) => notices.push({ id: record.id, reason: notice.reason, turns: notice.metrics.turns }),
    });

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onTurnEnd?.(1);
      opts.onTurnEnd?.(2);
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "background",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(notices).toEqual([{ id, reason: "turn_threshold", turns: 1 }]);
    expect(store.writes.some((r) => r.needsAttentionReason === "turn_threshold")).toBe(true);
  });

  it("scanLongRunningAgents marks old running background records", () => {
    const notices: any[] = [];
    manager = new AgentManager(undefined, undefined, undefined, undefined, {
      longRunningGuard: { activeNoticeAfterMs: 1 },
      onNeedsAttention: (record, notice) => notices.push({ id: record.id, reason: notice.reason }),
    });
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "background",
      isBackground: true,
    });
    manager.getRecord(id)!.startedAt = Date.now() - 10_000;

    expect(manager.scanLongRunningAgents()).toBe(1);
    expect(manager.scanLongRunningAgents()).toBe(0);
    expect(notices).toEqual([{ id, reason: "time_threshold" }]);

    manager.abortAll();
  });


  it("interrupts a running background run into paused status without losing the session", () => {
    const store = fakeStore();
    const abort = vi.fn();
    manager = new AgentManager(undefined, undefined, undefined, undefined, { durableRunStore: store });
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated?.({ ...mockSession(), abort });
      await new Promise(() => {});
      throw new Error("unreachable");
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "background",
      isBackground: true,
    });

    expect(manager.interrupt(id)).toBe(true);
    expect(manager.getRecord(id)).toMatchObject({
      status: "paused",
      result: "Interrupted. Waiting for explicit next action.",
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(store.writes.at(-1)).toMatchObject({ status: "paused" });
  });

  it("persists stopped status when a queued background run is aborted", () => {
    const store = fakeStore();
    manager = new AgentManager(undefined, 1, undefined, undefined, { durableRunStore: store });
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    manager.spawn(mockPi, mockCtx, "general-purpose", "test1", {
      description: "running",
      isBackground: true,
    });
    const queuedId = manager.spawn(mockPi, mockCtx, "general-purpose", "test2", {
      description: "queued",
      isBackground: true,
    });

    expect(manager.abort(queuedId)).toBe(true);

    expect(store.writes.at(-1)).toMatchObject({ description: "queued", status: "stopped" });
    manager.abortAll();
  });
});
