# Durable Subagent Status Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make durable/stale background subagent statuses visible through existing logs/events and result tools.

**Architecture:** Keep the public agent API stable. Extend the durable run store with lookup/list operations, let `AgentManager` report reconciliation results, emit audit/event records during startup, and fall back to durable status when tools query a no-longer-in-memory agent id.

**Tech Stack:** TypeScript, Node fs/path APIs, Vitest.

---

## Success Criteria

- Stale durable run reconciliation produces audit/event payloads on startup.
- `get_subagent_result` can return last-known durable status when the in-memory record is gone.
- `steer_subagent` explains last-known durable status for no-longer-running agents instead of only saying not found.
- Cross-extension/global manager callers can list durable statuses.
- Tests cover durable lookup and reconciliation callback behavior.
- `npm test`, `npm run typecheck`, `npm run build`, and `npm run lint` pass.

## Tasks

### Task 1: Add durable lookup/list helpers

**Files:**
- Modify: `src/durable-run-store.ts`
- Modify: `test/durable-run-store.test.ts`

- [x] Add `get(id)` using the same safe id segment as writes.
- [x] Keep `readAll()` as the list API.
- [x] Test lookup for existing/missing ids.

### Task 2: Surface reconciliation results from AgentManager

**Files:**
- Modify: `src/agent-manager.ts`
- Modify: `test/agent-manager.test.ts`

- [x] Add an optional `onDurableRunsReconciled` callback.
- [x] Store the latest reconciliation result.
- [x] Add `listDurableRuns()` and `getDurableRun(id)` helpers.
- [x] Test callback/list behavior.

### Task 3: Emit startup audit/events and tool fallback output

**Files:**
- Modify: `src/index.ts`

- [x] Emit `subagent_stale_reconciled` audit entries and `subagents:stale_reconciled` events for stale runs.
- [x] Include durable status helpers in the global manager singleton.
- [x] Make `get_subagent_result` fall back to durable status when no in-memory record exists.
- [x] Make `steer_subagent` mention durable last-known status when no in-memory record exists.

### Task 4: Verify and commit

**Files:** none

- [x] Run `npm test`.
- [x] Run `npm run typecheck`.
- [x] Run `npm run build`.
- [x] Run `npm run lint`.
- [x] Commit and push.
