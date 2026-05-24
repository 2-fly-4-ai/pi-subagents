/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 * Foreground agents bypass the queue (they block the parent anyway).
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import { getAgentConfig, getToolNamesForType } from "./agent-types.js";
import { completionGuardWarning, expectsImplementationMutation, isMutatingTool } from "./completion-guard.js";
import { buildParentContext } from "./context.js";
import { spawnDetachedRun } from "./detached/spawn.js";
import type { DurableRunReconciliationResult, DurableRunStatus, DurableRunStatusStore } from "./durable-run-store.js";
import {
  DEFAULT_LONG_RUNNING_GUARD,
  type LongRunningGuardConfig,
  type LongRunningNotice,
  nextLongRunningNotice,
} from "./long-running-guard.js";
import { errorMessage, isRetryableModelFailure, modelLabel } from "./model-fallback.js";
import type { AgentInvocation, AgentRecord, IsolationMode, SubagentType, ThinkingLevel } from "./types.js";
import { addUsage } from "./usage.js";
import { cleanupWorktree, createWorktree, pruneWorktrees, } from "./worktree.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

export interface AgentManagerOptions {
  durableRunStore?: DurableRunStatusStore;
  detachedRunRoot?: string;
  detachedChildRunnerPath?: string;
  detachedCommand?: string;
  detachedArgsOverride?: readonly string[];
  onDurableRunsReconciled?: (result: DurableRunReconciliationResult) => void;
  longRunningGuard?: false | Partial<LongRunningGuardConfig>;
  onNeedsAttention?: (record: AgentRecord, notice: LongRunningNotice) => void;
}

/** Default max concurrent background agents. */
const DEFAULT_MAX_CONCURRENT = 4;

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

interface SpawnOptions {
  description: string;
  model?: Model<any>;
  fallbackModels?: readonly Model<any>[];
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  /**
   * Skip the maxConcurrent queue check for this spawn — start immediately even
   * if the configured concurrency limit would otherwise queue it. Used by the
   * scheduler so a fired job can't be deferred past its trigger window.
   */
  bypassQueue?: boolean;
  /** Isolation mode — "worktree" creates a temp git worktree for the agent. */
  isolation?: IsolationMode;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private maxConcurrent: number;
  private durableRunStore?: DurableRunStatusStore;
  private detachedRunRoot: string;
  private detachedChildRunnerPath?: string;
  private detachedCommand?: string;
  private detachedArgsOverride?: readonly string[];
  private lastDurableRunReconciliation?: DurableRunReconciliationResult;
  private longRunningGuard?: LongRunningGuardConfig;
  private onNeedsAttention?: (record: AgentRecord, notice: LongRunningNotice) => void;

  /** Queue of background agents waiting to start. */
  private queue: { id: string; args: SpawnArgs }[] = [];
  /** Number of currently running background agents. */
  private runningBackground = 0;

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
    options: AgentManagerOptions = {},
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.maxConcurrent = maxConcurrent;
    this.durableRunStore = options.durableRunStore;
    this.detachedRunRoot = options.detachedRunRoot ?? join(getAgentDir(), "subagents", "runs");
    this.detachedChildRunnerPath = options.detachedChildRunnerPath;
    this.detachedCommand = options.detachedCommand;
    this.detachedArgsOverride = options.detachedArgsOverride;
    this.onNeedsAttention = options.onNeedsAttention;
    this.longRunningGuard = options.longRunningGuard === false
      ? undefined
      : { ...DEFAULT_LONG_RUNNING_GUARD, ...options.longRunningGuard };
    try {
      const reconciliation = this.durableRunStore?.reconcileStaleRuns();
      this.lastDurableRunReconciliation = reconciliation;
      if (reconciliation) options.onDurableRunsReconciled?.(reconciliation);
    } catch { /* durable status is best-effort */ }
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  private persist(record: AgentRecord): void {
    if (!record.isBackground) return;
    try { this.durableRunStore?.write(record); } catch { /* durable status is best-effort */ }
  }

  private shouldUseDetachedBackground(options: SpawnOptions): boolean {
    return options.isBackground === true && process.env.PI_SUBAGENTS_IN_PROCESS_BACKGROUND !== "1";
  }

  private buildDetachedPiArgs(ctx: ExtensionContext, type: SubagentType, prompt: string, options: SpawnOptions, model = options.model): string[] {
    const agentConfig = getAgentConfig(type);
    const toolNames = getToolNamesForType(type)
      .filter((name) => !["Agent", "get_subagent_result", "steer_subagent", "control_subagent"].includes(name))
      .filter((name) => !agentConfig?.disallowedTools?.includes(name));
    const args = [
      "--mode", "json",
      "--print",
      "--no-extensions",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
    ];
    if (toolNames.length > 0) args.push("--tools", toolNames.join(","));
    const systemPrompt = agentConfig?.promptMode === "append"
      ? `${ctx.getSystemPrompt()}\n\n${agentConfig.systemPrompt}`
      : agentConfig?.systemPrompt;
    if (systemPrompt) args.push("--system-prompt", systemPrompt);
    if (model && modelLabel(model) !== "parent-model") args.push("--model", modelLabel(model));
    if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
    const parentContext = options.inheritContext ? buildParentContext(ctx) : "";
    const effectivePrompt = parentContext ? `${parentContext}${prompt}` : prompt;
    args.push(effectivePrompt);
    return args;
  }

  private startDetachedAgent(id: string, record: AgentRecord, ctx: ExtensionContext, type: SubagentType, prompt: string, options: SpawnOptions): void {
    const modelCandidates = [options.model, ...(options.fallbackModels ?? [])];
    let livePoll: ReturnType<typeof setInterval> | undefined;
    let observedToolUses = 0;
    let observedTurnCount = 0;
    let lastPreview = "";

    const syncDetachedLiveStatus = () => {
      const status = this.durableRunStore?.get(id) as (DurableRunStatus & { activeTools?: string[] }) | undefined;
      if (!status || status.status !== "running") return;

      if (typeof status.toolUses === "number" && status.toolUses > observedToolUses) {
        const delta = status.toolUses - observedToolUses;
        observedToolUses = status.toolUses;
        record.toolUses = Math.max(record.toolUses, status.toolUses);
        for (let index = 0; index < delta; index++) {
          options.onToolActivity?.({ type: "end", toolName: "tool" });
        }
      }

      if (typeof status.turnCount === "number" && status.turnCount !== observedTurnCount) {
        observedTurnCount = status.turnCount;
        record.turnCount = status.turnCount;
        options.onTurnEnd?.(status.turnCount);
        this.checkNeedsAttention(record);
      }

      const activeTools = Array.isArray(status.activeTools) ? status.activeTools.filter(Boolean) : [];
      const preview = activeTools.length > 0
        ? `running ${activeTools.join(", ")}…`
        : status.resultPreview ?? "";
      if (preview && preview !== lastPreview) {
        lastPreview = preview;
        options.onTextDelta?.("", preview);
      }
    };

    const startLivePoll = () => {
      if (livePoll) return;
      syncDetachedLiveStatus();
      livePoll = setInterval(syncDetachedLiveStatus, 500);
      livePoll.unref?.();
    };

    const stopLivePoll = () => {
      if (!livePoll) return;
      clearInterval(livePoll);
      livePoll = undefined;
    };

    const runAttempt = async (attemptIndex: number): Promise<string> => {
      const model = modelCandidates[attemptIndex];
      const handle = spawnDetachedRun({
        id,
        type,
        description: options.description,
        cwd: record.cwd ?? ctx.cwd,
        runRoot: this.detachedRunRoot,
        command: this.detachedCommand ?? "pi",
        args: this.detachedArgsOverride ?? this.buildDetachedPiArgs(ctx, type, prompt, options, model),
        childRunnerPath: this.detachedChildRunnerPath,
      });
      record.detachedRun = { pid: handle.pid, runDir: handle.paths.runDir };
      this.persist(record);
      startLivePoll();
      const result = await handle.promise;
      syncDetachedLiveStatus();
      const success = result.state === "paused" || (result.exitCode === 0 && !result.signal);
      if (!success && attemptIndex < modelCandidates.length - 1 && isRetryableModelFailure(result.error ?? result.output)) {
        record.modelAttempts = [...(record.modelAttempts ?? []), { model: modelLabel(model), success: false, error: result.error ?? result.output }];
        this.persist(record);
        return runAttempt(attemptIndex + 1);
      }
      record.modelAttempts = [...(record.modelAttempts ?? []), { model: modelLabel(model), success, ...(success ? {} : { error: result.error ?? result.output }) }];
      if (record.status !== "stopped" && record.status !== "paused") {
        record.status = result.state === "paused" ? "paused" : success ? "completed" : "error";
      }
      record.result = result.resultText ?? result.output;
      record.error = record.status === "error" ? result.error ?? `Detached run exited with ${result.exitCode ?? result.signal}` : undefined;
      record.completedAt ??= Date.now();
      this.persist(record);
      return record.result ?? "";
    };

    const promise = runAttempt(0)
      .catch((err) => {
        if (record.status !== "stopped" && record.status !== "paused") record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt ??= Date.now();
        this.persist(record);
        return "";
      })
      .finally(() => {
        stopLivePoll();
        this.runningBackground--;
        try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
        this.drainQueue();
      });
    record.promise = promise;
  }

  private async runAgentWithModelFallback(
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    record: AgentRecord,
    modelCandidates: readonly (Model<any> | undefined)[],
    runOptions: (model: Model<any> | undefined) => Parameters<typeof runAgent>[3],
  ) {
    const candidates = modelCandidates.length > 0 ? modelCandidates : [undefined];
    let lastError: unknown;
    for (let i = 0; i < candidates.length; i++) {
      const model = candidates[i];
      const label = modelLabel(model);
      try {
        const result = await runAgent(ctx, type, prompt, runOptions(model));
        record.modelAttempts = [...(record.modelAttempts ?? []), { model: label, success: true }];
        this.persist(record);
        return result;
      } catch (err) {
        lastError = err;
        const message = errorMessage(err);
        record.modelAttempts = [...(record.modelAttempts ?? []), { model: label, success: false, error: message }];
        this.persist(record);
        const canRetry = i < candidates.length - 1 && record.toolUses === 0 && record.session === undefined && isRetryableModelFailure(err);
        if (!canRetry) throw err;
      }
    }
    throw lastError;
  }

  private checkNeedsAttention(record: AgentRecord): void {
    if (!record.isBackground || !this.longRunningGuard) return;
    const notice = nextLongRunningNotice(record, this.longRunningGuard);
    if (!notice) return;
    record.needsAttentionAt = Date.now();
    record.needsAttentionReason = notice.reason;
    this.persist(record);
    try { this.onNeedsAttention?.(record, notice); } catch { /* notification is best-effort */ }
  }

  scanLongRunningAgents(): number {
    let count = 0;
    for (const record of this.agents.values()) {
      const before = record.needsAttentionAt;
      this.checkNeedsAttention(record);
      if (before === undefined && record.needsAttentionAt !== undefined) count++;
    }
    return count;
  }

  /** Update the max concurrent background agents limit. */
  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    // Start queued agents if the new limit allows
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    const id = randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type,
      description: options.description,
      status: options.isBackground ? "queued" : "running",
      isBackground: options.isBackground === true,
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      invocation: options.invocation,
    };
    this.agents.set(id, record);
    this.persist(record);

    const args: SpawnArgs = { pi, ctx, type, prompt, options };

    if (options.isBackground && !options.bypassQueue && this.runningBackground >= this.maxConcurrent) {
      // Queue it — will be started when a running agent completes
      this.queue.push({ id, args });
      return id;
    }

    // startAgent can throw (e.g. strict worktree-isolation failure) — clean
    // up the record so callers don't see an orphan in `listAgents()`.
    try {
      this.startAgent(id, record, args);
    } catch (err) {
      record.status = "error";
      record.error = err instanceof Error ? err.message : String(err);
      record.completedAt = Date.now();
      this.persist(record);
      this.agents.delete(id);
      throw err;
    }
    return id;
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private startAgent(id: string, record: AgentRecord, { pi, ctx, type, prompt, options }: SpawnArgs) {
    // Worktree isolation: try to create a temporary git worktree. Strict —
    // fail loud if not possible (no silent fallback to main tree). Done
    // BEFORE state mutation so a throw doesn't leave the record half-running.
    let worktreeCwd: string | undefined;
    if (options.isolation === "worktree") {
      const wt = createWorktree(ctx.cwd, id);
      if (!wt) {
        throw new Error(
          'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
          'Initialize git and commit at least once, or omit `isolation`.',
        );
      }
      record.worktree = wt;
      worktreeCwd = wt.path;
    }

    record.cwd = worktreeCwd ?? ctx.cwd;
    record.expectedMutation = expectsImplementationMutation(type, prompt);
    record.attemptedMutation = false;
    record.status = "running";
    record.startedAt = Date.now();
    if (options.isBackground) this.runningBackground++;
    this.persist(record);
    this.onStart?.(record);

    if (this.shouldUseDetachedBackground(options)) {
      this.startDetachedAgent(id, record, ctx, type, prompt, options);
      return;
    }

    // Wire parent abort signal to stop the subagent when the parent is interrupted
    let detachParentSignal: (() => void) | undefined;
    if (options.signal) {
      const onParentAbort = () => this.abort(id);
      options.signal.addEventListener("abort", onParentAbort, { once: true });
      detachParentSignal = () => options.signal!.removeEventListener("abort", onParentAbort);
    }
    const detach = () => { detachParentSignal?.(); detachParentSignal = undefined; };

    const runOptions = (model: Model<any> | undefined) => ({
      pi,
      agentId: id,
      model,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      cwd: worktreeCwd,
      signal: record.abortController!.signal,
      onToolActivity: (activity: ToolActivity) => {
        if (activity.type === "start" && isMutatingTool(activity.toolName, activity.args)) {
          record.attemptedMutation = true;
          this.persist(record);
        }
        if (activity.type === "end") {
          record.toolUses++;
          this.persist(record);
        }
        options.onToolActivity?.(activity);
      },
      onTurnEnd: (turnCount: number) => {
        record.turnCount = turnCount;
        this.persist(record);
        this.checkNeedsAttention(record);
        options.onTurnEnd?.(turnCount);
      },
      onTextDelta: options.onTextDelta,
      onAssistantUsage: (usage: { input: number; output: number; cacheWrite: number }) => {
        addUsage(record.lifetimeUsage, usage);
        this.persist(record);
        this.checkNeedsAttention(record);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info: CompactionInfo) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      onSessionCreated: (session: AgentSession) => {
        record.session = session;
        // Flush any steers that arrived before the session was ready
        if (record.pendingSteers?.length) {
          for (const msg of record.pendingSteers) {
            session.steer(msg).catch(() => {});
          }
          record.pendingSteers = undefined;
        }
        options.onSessionCreated?.(session);
      },
    });

    const modelCandidates = [options.model, ...(options.fallbackModels ?? [])];
    const promise = this.runAgentWithModelFallback(ctx, type, prompt, record, modelCandidates, runOptions)
      .then(({ responseText, session, aborted, steered }) => {
        // Don't overwrite status if externally stopped or paused via interrupt().
        if (record.status !== "stopped" && record.status !== "paused") {
          record.status = aborted ? "aborted" : steered ? "steered" : "completed";
        }
        record.result = responseText;
        record.completionGuardWarning = completionGuardWarning(type, prompt, record.attemptedMutation === true);
        if (record.completionGuardWarning) {
          record.result = `${record.result ?? ""}\n\n${record.completionGuardWarning}`.trim();
        }
        record.session = session;
        record.completedAt ??= Date.now();

        detach();

        // Final flush of streaming output file
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        // Clean up worktree if used
        if (record.worktree) {
          const wtResult = cleanupWorktree(ctx.cwd, record.worktree, options.description);
          record.worktreeResult = wtResult;
          if (wtResult.hasChanges && wtResult.branch) {
            record.result = (record.result ?? "") +
              `\n\n---\nChanges saved to branch \`${wtResult.branch}\`. Merge with: \`git merge ${wtResult.branch}\``;
          }
        }
        this.persist(record);

        if (options.isBackground) {
          this.runningBackground--;
          try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
          this.drainQueue();
        }
        return responseText;
      })
      .catch((err) => {
        // Don't overwrite status if externally stopped or paused via interrupt().
        if (record.status !== "stopped" && record.status !== "paused") {
          record.status = "error";
        }
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt ??= Date.now();

        detach();

        // Final flush of streaming output file on error
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        // Best-effort worktree cleanup on error
        if (record.worktree) {
          try {
            const wtResult = cleanupWorktree(ctx.cwd, record.worktree, options.description);
            record.worktreeResult = wtResult;
          } catch { /* ignore cleanup errors */ }
        }
        this.persist(record);

        if (options.isBackground) {
          this.runningBackground--;
          this.onComplete?.(record);
          this.drainQueue();
        }
        return "";
      });

    record.promise = promise;
  }

  /** Start queued agents up to the concurrency limit. */
  private drainQueue() {
    while (this.queue.length > 0 && this.runningBackground < this.maxConcurrent) {
      const next = this.queue.shift()!;
      const record = this.agents.get(next.id);
      if (!record || record.status !== "queued") continue;
      try {
        this.startAgent(next.id, record, next.args);
      } catch (err) {
        // Late failure (e.g. strict worktree-isolation) — surface on the record
        // so the user/agent can see it via /agents, then keep draining.
        record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt = Date.now();
        this.persist(record);
        this.onComplete?.(record);
      }
    }
  }

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Foreground agents bypass the concurrency queue.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
  ): Promise<AgentRecord> {
    const id = this.spawn(pi, ctx, type, prompt, { ...options, isBackground: false });
    const record = this.agents.get(id)!;
    await record.promise;
    return record;
  }

  /**
   * Resume an existing agent session with a new prompt.
   */
  async resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<AgentRecord | undefined> {
    const record = this.agents.get(id);
    if (!record?.session) return undefined;

    record.status = "running";
    record.startedAt = Date.now();
    record.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;
    record.needsAttentionAt = undefined;
    record.needsAttentionReason = undefined;
    this.persist(record);

    try {
      const responseText = await resumeAgent(record.session, prompt, {
        onToolActivity: (activity) => {
          if (activity.type === "end") record.toolUses++;
        },
        onAssistantUsage: (usage) => {
          addUsage(record.lifetimeUsage, usage);
          this.persist(record);
          this.checkNeedsAttention(record);
        },
        onCompaction: (info) => {
          record.compactionCount++;
          this.onCompact?.(record, info);
        },
        signal,
      });
      record.status = "completed";
      record.result = responseText;
      record.completedAt = Date.now();
      this.persist(record);
    } catch (err) {
      record.status = "error";
      record.error = err instanceof Error ? err.message : String(err);
      record.completedAt = Date.now();
      this.persist(record);
    }

    return record;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  listDurableRuns(): DurableRunStatus[] {
    try {
      return this.durableRunStore?.readAll().sort((a, b) => b.startedAt - a.startedAt) ?? [];
    } catch {
      return [];
    }
  }

  getDurableRun(id: string): DurableRunStatus | undefined {
    try { return this.durableRunStore?.get(id); } catch { return undefined; }
  }

  getDurableResult(id: string): string | undefined {
    try { return this.durableRunStore?.readResult(id); } catch { return undefined; }
  }

  getLastDurableRunReconciliation(): DurableRunReconciliationResult | undefined {
    return this.lastDurableRunReconciliation;
  }

  interrupt(id: string, message = "Interrupted. Waiting for explicit next action."): boolean {
    const record = this.agents.get(id);
    if (!record || record.status !== "running") return false;
    record.session?.abort?.();
    record.abortController?.abort();
    this.stopDetached(record, process.platform === "win32" ? "SIGBREAK" : "SIGUSR2");
    record.status = "paused";
    record.result = message;
    record.completedAt = Date.now();
    this.persist(record);
    return true;
  }

  private stopDetached(record: AgentRecord, signal: NodeJS.Signals = "SIGTERM"): void {
    const pid = record.detachedRun?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try { process.kill(pid, signal); } catch { /* ignore */ }
    }
    if (signal !== "SIGTERM") return;
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
      }
    }, 1_500).unref?.();
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // Remove from queue if queued
    if (record.status === "queued") {
      this.queue = this.queue.filter(q => q.id !== id);
      record.status = "stopped";
      record.completedAt = Date.now();
      this.persist(record);
      return true;
    }

    if (record.status !== "running") return false;
    record.abortController?.abort();
    this.stopDetached(record);
    record.status = "stopped";
    record.completedAt = Date.now();
    this.persist(record);
    return true;
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    record.session?.dispose?.();
    record.session = undefined;
    this.agents.delete(id);
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      this.removeRecord(id, record);
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   */
  clearCompleted(): void {
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      this.removeRecord(id, record);
    }
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      r => r.status === "running" || r.status === "queued",
    );
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    // Clear queued agents first
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      if (record) {
        record.status = "stopped";
        record.completedAt = Date.now();
        this.persist(record);
        count++;
      }
    }
    this.queue = [];
    // Abort running agents
    for (const record of this.agents.values()) {
      if (record.status === "running") {
        record.abortController?.abort();
        this.stopDetached(record);
        record.status = "stopped";
        record.completedAt = Date.now();
        this.persist(record);
        count++;
      }
    }
    return count;
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  async waitForAll(): Promise<void> {
    // Loop because drainQueue respects the concurrency limit — as running
    // agents finish they start queued ones, which need awaiting too.
    while (true) {
      this.drainQueue();
      const pending = [...this.agents.values()]
        .filter(r => r.status === "running" || r.status === "queued")
        .map(r => r.promise)
        .filter(Boolean);
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  dispose() {
    clearInterval(this.cleanupInterval);
    // Clear queue
    this.queue = [];
    for (const record of this.agents.values()) {
      record.session?.dispose();
    }
    this.agents.clear();
    // Prune any orphaned git worktrees (crash recovery)
    try { pruneWorktrees(process.cwd()); } catch { /* ignore */ }
  }
}
