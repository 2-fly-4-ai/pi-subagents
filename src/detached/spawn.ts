import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DetachedRunConfig, DetachedRunResult } from "./child-runner.js";
import { getDetachedRunPaths, writeAtomicJson } from "./run-dir.js";

export interface DetachedSpawnInput {
  readonly id: string;
  readonly type: string;
  readonly description: string;
  readonly cwd: string;
  readonly runRoot: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly childRunnerPath?: string;
}

export interface DetachedRunHandle {
  readonly id: string;
  readonly pid: number | undefined;
  readonly paths: ReturnType<typeof getDetachedRunPaths>;
  readonly child: ChildProcess;
  readonly promise: Promise<DetachedRunResult>;
}

export function resolveChildRunnerPath(metaUrl = import.meta.url): string {
  const here = dirname(fileURLToPath(metaUrl));
  const sibling = resolve(here, "child-runner.js");
  if (existsSync(sibling)) return sibling;
  const dist = resolve(here, "..", "..", "dist", "detached", "child-runner.js");
  if (existsSync(dist)) return dist;
  throw new Error(`Detached child runner is not built. Expected ${sibling} or ${dist}. Run npm run build.`);
}

export function readDetachedResult(paths: ReturnType<typeof getDetachedRunPaths>): DetachedRunResult & { resultText?: string } {
  const result = JSON.parse(readFileSync(paths.resultJsonPath, "utf8")) as DetachedRunResult;
  let resultText: string | undefined;
  try {
    resultText = readFileSync(paths.resultTextPath, "utf8");
  } catch {
    // Optional: result.json still carries output.
  }
  return { ...result, resultText };
}

export function spawnDetachedRun(input: DetachedSpawnInput): DetachedRunHandle {
  const paths = getDetachedRunPaths(input.runRoot, input.id);
  const config: DetachedRunConfig = {
    id: input.id,
    type: input.type,
    description: input.description,
    cwd: input.cwd,
    runRoot: input.runRoot,
    command: input.command,
    args: input.args,
    env: input.env,
    startedAt: Date.now(),
  };
  writeAtomicJson(paths.configPath, config);

  const runner = input.childRunnerPath ?? resolveChildRunnerPath();
  const child = spawn(process.execPath, [runner, paths.configPath], {
    cwd: input.cwd,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...input.env },
  });
  child.unref();

  const promise = new Promise<DetachedRunResult>((resolveResult) => {
    child.on("error", (error) => {
      resolveResult({ exitCode: 1, signal: null, output: "", error: error.message });
    });
    child.on("close", (_exitCode, _signal) => {
      try {
        resolveResult(readDetachedResult(paths));
      } catch (error) {
        resolveResult({
          exitCode: 1,
          signal: null,
          output: "",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  });

  return { id: input.id, pid: child.pid, paths, child, promise };
}
