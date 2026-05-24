import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createJsonlWriter } from "./jsonl-writer.js";
import { getDetachedRunPaths, writeAtomicJson, writeAtomicText } from "./run-dir.js";

export type DetachedChildState = "running" | "complete" | "failed" | "paused";

export interface DetachedRunConfig {
  readonly id: string;
  readonly type: string;
  readonly description: string;
  readonly cwd: string;
  readonly runRoot: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly prompt?: string;
  readonly startedAt?: number;
}

export interface DetachedRunResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly state?: DetachedChildState;
  readonly output: string;
  readonly resultText?: string;
  readonly error?: string;
}

function statusFor(config: DetachedRunConfig, state: DetachedChildState, extra: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    version: 1,
    id: config.id,
    type: config.type,
    description: config.description,
    status: state === "complete" ? "completed" : state === "failed" ? "error" : state,
    state,
    ownerPid: process.pid,
    childPid: process.pid,
    cwd: config.cwd,
    startedAt: config.startedAt ?? now,
    updatedAt: now,
    ...(state !== "running" ? { completedAt: now } : {}),
    ...extra,
  };
}

interface DetachedLiveState {
  toolUses: number;
  turnCount: number;
  activeTools: string[];
  resultPreview?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function messageText(message: unknown): string | undefined {
  if (!isRecord(message) || !Array.isArray(message.content)) return undefined;
  const text = message.content
    .map((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "")
    .join("\n")
    .trim();
  return text || undefined;
}

function textDelta(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  const assistantMessageEvent = event.assistantMessageEvent;
  if (!isRecord(assistantMessageEvent) || assistantMessageEvent.type !== "text_delta") return undefined;
  return typeof assistantMessageEvent.delta === "string" ? assistantMessageEvent.delta : undefined;
}

function updateLiveStateFromPiEvent(live: DetachedLiveState, event: unknown): boolean {
  if (!isRecord(event) || typeof event.type !== "string") return false;

  switch (event.type) {
    case "tool_execution_start": {
      const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
      live.activeTools = [...live.activeTools, toolName];
      live.resultPreview = `running ${toolName}…`;
      return true;
    }
    case "tool_execution_end": {
      const toolName = typeof event.toolName === "string" ? event.toolName : undefined;
      live.toolUses += 1;
      live.activeTools = toolName ? live.activeTools.filter((name) => name !== toolName) : [];
      live.resultPreview = toolName ? `finished ${toolName}` : `finished tool ${live.toolUses}`;
      return true;
    }
    case "turn_end":
      live.turnCount += 1;
      return true;
    case "message_update": {
      const delta = textDelta(event);
      if (!delta) return false;
      live.resultPreview = `${live.resultPreview ?? ""}${delta}`.slice(-2_000);
      return true;
    }
    case "message_end": {
      const message = event.message;
      if (isRecord(message) && message.role === "assistant") {
        const text = messageText(message);
        if (text) {
          live.resultPreview = text.slice(-2_000);
          return true;
        }
      }
      return false;
    }
    default:
      return false;
  }
}

export async function runDetachedChild(config: DetachedRunConfig): Promise<DetachedRunResult> {
  const paths = getDetachedRunPaths(config.runRoot, config.id);
  const events = createJsonlWriter(paths.eventsPath);
  const stdout = createJsonlWriter(paths.stdoutPath);
  let output = "";
  let stderr = "";

  const liveState: DetachedLiveState = { toolUses: 0, turnCount: 0, activeTools: [] };
  let lastLiveStatusWrite = 0;
  const writeLiveStatus = (force = false) => {
    const now = Date.now();
    if (!force && now - lastLiveStatusWrite < 250) return;
    lastLiveStatusWrite = now;
    writeAtomicJson(paths.statusPath, statusFor(config, "running", liveState as unknown as Record<string, unknown>));
  };

  writeLiveStatus(true);
  await events.append({ type: "start", id: config.id, pid: process.pid, ts: Date.now() });

  let interrupted = false;
  const child = spawn(config.command, config.args, {
    cwd: config.cwd,
    env: { ...process.env, ...config.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const interrupt = () => {
    interrupted = true;
    try { child.kill("SIGTERM"); } catch { /* ignore already-exited child */ }
  };
  process.once(process.platform === "win32" ? "SIGBREAK" : "SIGUSR2", interrupt);

  await events.append({ type: "child_spawn", id: config.id, pid: child.pid, command: config.command, args: config.args, ts: Date.now() });
  writeAtomicJson(paths.statusPath, statusFor(config, "running", { ...liveState, childPid: child.pid }));

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    void stdout.append({ type: "stdout", text, ts: Date.now() });
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as unknown;
        void events.append({ type: "pi_event", event, ts: Date.now() });
        if (updateLiveStateFromPiEvent(liveState, event)) {
          writeLiveStatus();
        }
      } catch {
        // Text mode output is valid; stdout.jsonl preserves it.
      }
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderr += text;
    appendFileSync(paths.stderrPath, text, "utf8");
  });

  const result = await new Promise<DetachedRunResult>((resolve) => {
    child.on("error", (error) => {
      resolve({ exitCode: 1, signal: null, output, error: error.message });
    });
    child.on("close", (exitCode, signal) => {
      resolve({ exitCode, signal: signal as NodeJS.Signals | null, output, error: stderr.trim() || undefined });
    });
  });

  await stdout.close();
  process.off(process.platform === "win32" ? "SIGBREAK" : "SIGUSR2", interrupt);
  writeLiveStatus(true);
  const success = interrupted || (result.exitCode === 0 && !result.signal);
  const finalState: DetachedChildState = interrupted ? "paused" : success ? "complete" : "failed";
  writeAtomicText(paths.resultTextPath, output);
  writeAtomicJson(paths.resultJsonPath, {
    id: config.id,
    type: config.type,
    description: config.description,
    success,
    state: finalState,
    exitCode: result.exitCode,
    signal: result.signal,
    output,
    error: success ? undefined : result.error,
  });
  writeAtomicJson(paths.statusPath, statusFor(config, finalState, {
    childPid: child.pid,
    exitCode: result.exitCode,
    signal: result.signal,
    resultPath: paths.resultTextPath,
    resultPreview: output.length > 2_000 ? `${output.slice(0, 2_000)}…` : output,
    error: success ? undefined : result.error,
  }));
  await events.append({ type: "complete", id: config.id, success, state: finalState, exitCode: result.exitCode, signal: result.signal, ts: Date.now() });
  await events.close();
  return { ...result, state: finalState };
}

export function readDetachedConfig(path: string): DetachedRunConfig {
  return JSON.parse(readFileSync(path, "utf8")) as DetachedRunConfig;
}

async function main(): Promise<void> {
  const configPath = process.argv[2] ?? process.env.PI_SUBAGENTS_DETACHED_CONFIG;
  if (!configPath) throw new Error("Detached child runner requires a config path.");
  const result = await runDetachedChild(readDetachedConfig(configPath));
  process.exitCode = result.exitCode ?? (result.signal ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
