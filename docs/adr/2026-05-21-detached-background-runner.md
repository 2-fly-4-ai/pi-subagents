# ADR: Detached Background Subagent Runner by Default

Date: 2026-05-21
Status: Proposed

## Context

Background subagents currently run as in-process `AgentSession`s. We have added durable status files, stale reconciliation, long-running notices, full result artifacts, interrupt controls, model fallback, doctor checks, completion guard, and completion dedupe. These features reduce failure impact, but they do not fully solve the root process-lifecycle problem: if the parent Pi process, pi-gui, extension host, or session binding dies, the background run dies with it or becomes only a stale record.

Nico's package solves this with detached child Pi processes and run directories. The user explicitly chose the "fuck it, default it" direction: detached execution should become the default for background subagents, not a hidden experiment forever. The concern is valid that the surrounding reliability features are important to how detached execution works. Therefore the detached runner must not be a bare `spawn(pi -p)`: it must carry the reliability contract as part of the runtime.

## Decision

Make a detached child-process runner the default execution path for `Agent(..., run_in_background: true)`. Foreground `Agent(...)` runs remain in-process for this phase.

Detached background runs will be represented by a run directory under the existing durable run root:

```txt
~/.pi/agent/subagents/runs/<agent-id>/
  status.json
  events.jsonl
  stdout.jsonl
  stderr.log
  result.md
  result.json
  child-session.jsonl? / session refs
```

The parent process will spawn a child Pi CLI process in JSON/print mode with a generated prompt and constrained tool configuration matching the current agent config. The parent will track PID/process group, watch durable files, and keep the existing public API stable:

- `Agent`
- `get_subagent_result`
- `steer_subagent`
- `control_subagent`
- `/agents`
- event/RPC surface

The detached runner must preserve or reimplement the already-ported reliability features:

- durable status writes
- stale/dead PID reconciliation
- full result artifacts
- result watcher with polling fallback
- interrupt/stop controls
- resume/revive path where possible
- long-running / needs-attention notices
- model fallback
- completion guard
- completion dedupe
- doctor diagnostics

## Alternatives Considered

- Keep in-process runner and stop here: rejected because it cannot revive or outlive parent process failures.
- Make detached runner opt-in long-term: rejected by user preference; acceptable only as a short internal safety switch during implementation.
- Adopt Nico's package wholesale: rejected earlier because our package has custom API/UX, cwd guard behavior, worktree handling, settings, and pi-gui integration that should remain stable.
- Convert foreground and background at once: rejected as too risky; foreground does not need revivable async semantics first.

## Non-Goals

- Do not change custom agent file locations or delete user agents.
- Do not replace `Agent` with Nico's `/run`/`/chain` command model.
- Do not implement nested fanout/chains in the first detached-runner pass.
- Do not remove the in-process background runner until detached runner is proven.
- Do not weaken cwd guard, worktree isolation, tool allowlists, or subagent tool exclusion.

## Consequences

- Background subagents should survive parent UI restarts and be inspectable from durable files.
- The implementation is larger than the previous slices and must land in small commits.
- Some current live features, especially mid-run steering, may need a file/signal bridge in detached mode rather than direct `session.steer()`.
- Debugging improves because status/events/stdout/stderr/result files become first-class artifacts.
- There must remain a temporary emergency fallback to the in-process runner until real-world verification is complete.

## Follow-Up Spec Slice

Implement detached background runner as a sequence of vertical slices:

1. run directory schema + JSONL writer + atomic status/result writes
2. child runner entrypoint that can execute one agent and write artifacts
3. parent spawn/watch/reconcile integration in `AgentManager`
4. interrupt/stop/resume bridge via PID signals and control files
5. migrate reliability features into child path: long-running, model fallback, completion guard, dedupe
6. make detached path default for background runs, keeping an emergency env fallback
7. update doctor and tests to cover detached health
