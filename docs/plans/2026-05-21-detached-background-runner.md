# Detached Background Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make detached child-process execution the default for background subagents while preserving the existing public `Agent` API and reliability features.

**Architecture:** Add a detached runner alongside the existing in-process runner, then route `run_in_background: true` through the detached runner by default. The detached runner owns a durable run directory and communicates through status/result/event files plus process signals/control files.

**Tech Stack:** TypeScript, Node child_process/fs/path/process APIs, Pi CLI `--mode json --print`, Vitest.

---

## Success Criteria

- Background `Agent` calls start detached child processes by default.
- Existing foreground `Agent` behavior remains in-process and unchanged.
- Existing tools and custom agents continue to work.
- Detached runs write `status.json`, `events.jsonl`, stdout/stderr, `result.md`, and `result.json`.
- Parent restart can list/reconcile detached runs from files.
- `get_subagent_result` works for live detached, completed detached, and stale/dead detached runs.
- `control_subagent action: interrupt|resume|status` works for detached runs where technically possible.
- Long-running notices, model fallback, completion guard, and completion dedupe apply to detached runs.
- `/subagents-doctor` reports detached runner health.
- Full test/typecheck/build/lint pass.

## Task 1: Run directory and artifact primitives

**Files:**
- Create: `src/detached/run-dir.ts`
- Create: `src/detached/jsonl-writer.ts`
- Test: `test/detached-run-dir.test.ts`

Steps:
- [ ] Define run dir paths: `status.json`, `events.jsonl`, `stdout.jsonl`, `stderr.log`, `result.md`, `result.json`, `control.json`.
- [ ] Implement safe id segment normalization and root containment checks.
- [ ] Implement atomic JSON writes and append-only JSONL writer with best-effort backpressure handling.
- [ ] Test path safety, atomic writes, malformed ids, and JSONL append behavior.

## Task 2: Child runner entrypoint

**Files:**
- Create: `src/detached/child-runner.ts`
- Modify: `package.json` if a bin/script entry is needed
- Test: `test/detached-child-runner.test.ts`

Steps:
- [ ] Define `DetachedRunConfig` JSON shape.
- [ ] Child reads config path from argv/env.
- [ ] Child writes `status: running` with pid, cwd, type, description, timestamps.
- [ ] Child invokes Pi CLI in JSON/print mode or SDK-equivalent with generated prompt/tool config.
- [ ] Child streams JSON events to `events.jsonl` and stdout/stderr artifacts.
- [ ] Child writes terminal `result.md` and `result.json`.
- [ ] Child exits 0 for completed/paused interrupted success, non-zero for failure.

## Task 3: Parent detached spawn integration

**Files:**
- Modify: `src/agent-manager.ts`
- Create: `src/detached/spawn.ts`
- Test: `test/detached-spawn.test.ts`, `test/agent-manager.test.ts`

Steps:
- [ ] Add `DetachedRunHandle` with id, pid, pgid/process-group behavior, paths, promise.
- [ ] Spawn child with cwd, env, package root, model, thinking, tools, prompt, agent config.
- [ ] Route background runs through detached spawn by default.
- [ ] Keep `PI_SUBAGENTS_IN_PROCESS_BACKGROUND=1` emergency fallback during rollout.
- [ ] Convert child status/result changes into `AgentRecord` updates and existing events.

## Task 4: Result watcher and polling fallback

**Files:**
- Create: `src/detached/result-watcher.ts`
- Test: `test/detached-result-watcher.test.ts`

Steps:
- [ ] Watch result/status files using `fs.watch`.
- [ ] Fall back to polling on watch failure or resource exhaustion.
- [ ] Deduplicate completion delivery via existing completion dedupe.
- [ ] Prime existing results at startup.

## Task 5: Stale reconciliation and doctor updates

**Files:**
- Modify: `src/durable-run-store.ts`
- Modify: `src/doctor.ts`
- Test: `test/durable-run-store.test.ts`, `test/doctor.test.ts`

Steps:
- [ ] Store child pid/pgid and last heartbeat in durable status.
- [ ] Mark dead-child running records stale/error on startup.
- [ ] Doctor reports detached runner capability, live child count, stale count, result watcher mode.

## Task 6: Controls bridge

**Files:**
- Modify: `src/index.ts`
- Create: `src/detached/control.ts`
- Test: `test/detached-control.test.ts`

Steps:
- [ ] `control_subagent status` reads detached status/result files.
- [ ] `interrupt` writes control request and signals child (`SIGUSR2`/`SIGBREAK`) when supported.
- [ ] `stop`/abort sends SIGTERM then SIGKILL to process group.
- [ ] `resume` starts a new child with the prior session file when available; otherwise returns a clear non-revivable message.

## Task 7: Reliability feature parity in child path

**Files:**
- Modify: child runner and shared helpers
- Tests: targeted unit tests

Steps:
- [ ] Apply model fallback attempts inside detached child.
- [ ] Apply completion guard based on observed child tool calls.
- [ ] Emit long-running/needs-attention notices from status heartbeat.
- [ ] Preserve full result artifacts.
- [ ] Ensure completion dedupe covers child and parent notifications.

## Task 8: Default rollout and verification

**Files:**
- README/docs updates
- Tests and manual verification

Steps:
- [ ] Make detached runner default for `run_in_background: true`.
- [ ] Document emergency fallback env var.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, `npm run lint`.
- [ ] Run a real background subagent, kill/restart parent, verify `get_subagent_result` still works.
- [ ] Interrupt and resume a detached run.
- [ ] Run `/subagents-doctor` and verify detached checks.
