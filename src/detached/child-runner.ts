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

export async function runDetachedChild(config: DetachedRunConfig): Promise<DetachedRunResult> {
  const paths = getDetachedRunPaths(config.runRoot, config.id);
  const events = createJsonlWriter(paths.eventsPath);
  const stdout = createJsonlWriter(paths.stdoutPath);
  let output = "";
  let stderr = "";

  writeAtomicJson(paths.statusPath, statusFor(config, "running"));
  await events.append({ type: "start", id: config.id, pid: process.pid, ts: Date.now() });

  const child = spawn(config.command, config.args, {
    cwd: config.cwd,
    env: { ...process.env, ...config.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await events.append({ type: "child_spawn", id: config.id, pid: child.pid, command: config.command, args: config.args, ts: Date.now() });
  writeAtomicJson(paths.statusPath, statusFor(config, "running", { childPid: child.pid }));

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    void stdout.append({ type: "stdout", text, ts: Date.now() });
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        void events.append({ type: "pi_event", event: JSON.parse(line), ts: Date.now() });
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
  const success = result.exitCode === 0 && !result.signal;
  const finalState: DetachedChildState = success ? "complete" : "failed";
  writeAtomicText(paths.resultTextPath, output);
  writeAtomicJson(paths.resultJsonPath, {
    id: config.id,
    type: config.type,
    description: config.description,
    success,
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
  await events.append({ type: "complete", id: config.id, success, exitCode: result.exitCode, signal: result.signal, ts: Date.now() });
  await events.close();
  return result;
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
