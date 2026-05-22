# Durable Subagent Run Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a first reliability slice to the owned `pi-subagents` fork: durable background-run status plus stale-run reconciliation.

**Architecture:** Keep the public `Agent`, `get_subagent_result`, and `steer_subagent` APIs unchanged. Add a small filesystem-backed status store and have `AgentManager` update it for background records. Reconcile stale queued/running records owned by dead processes when the manager starts.

**Tech Stack:** TypeScript, Node fs/path/process APIs, Vitest.

---

## Success Criteria

- Background agent records are persisted as JSON status files under the pi agent dir.
- Terminal states update the status file with result/error previews and `completedAt`.
- Stale `queued`/`running` records owned by dead processes are marked `error` during store reconciliation.
- Existing public tool names and custom-agent discovery behavior do not change.
- Tests cover status writes and stale reconciliation.
- `npm test`, `npm run typecheck`, and `npm run build` pass.

## Tasks

### Task 1: Add durable status store

**Files:**
- Create: `src/durable-run-store.ts`
- Create: `test/durable-run-store.test.ts`

- [x] Define a `DurableRunStatus` JSON shape with version, id, type, description, status, cwd, timestamps, owner pid, tool count, result preview, and error.
- [x] Implement safe per-run `status.json` writes.
- [x] Implement `readAll()` for status discovery.
- [x] Implement `reconcileStaleRuns()` to mark dead-owner queued/running records as `error`.
- [x] Add tests using a temp directory and injected PID liveness.

### Task 2: Wire status persistence into AgentManager

**Files:**
- Modify: `src/agent-manager.ts`
- Modify: `src/types.ts`
- Test: `test/agent-manager.test.ts`

- [x] Add an optional durable store parameter to `AgentManager` construction.
- [x] Mark records with `isBackground` so foreground runs are not persisted as background work.
- [x] Persist status when background records are created, started, updated, aborted, completed, or errored.
- [x] Call store reconciliation on manager creation.
- [x] Add integration tests with a fake store.

### Task 3: Enable store in extension startup

**Files:**
- Modify: `src/index.ts`

- [x] Create the durable store under `join(getAgentDir(), "subagents", "runs")`.
- [x] Pass it to `AgentManager`.
- [x] Keep extension startup resilient if the store path cannot be created or reconciled.

### Task 4: Verify and commit

**Files:** none

- [x] Run `npm test`.
- [x] Run `npm run typecheck`.
- [x] Run `npm run build`.
- [x] Commit the reliability slice.
- [x] Push to `origin/master`.
