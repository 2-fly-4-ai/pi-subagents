import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface DetachedRunPaths {
  readonly root: string;
  readonly runDir: string;
  readonly configPath: string;
  readonly statusPath: string;
  readonly eventsPath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly resultTextPath: string;
  readonly resultJsonPath: string;
  readonly controlPath: string;
}

export function safeRunIdSegment(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) throw new Error("Detached run id must not be empty.");
  if (trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(`Detached run id must be a simple id, got: ${id}`);
  }
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safe || safe === "." || safe === "..") throw new Error(`Detached run id is not usable: ${id}`);
  return safe;
}

export function assertInsideRoot(root: string, target: string): void {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const rel = relative(rootPath, targetPath);
  if (rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !rel.startsWith("\\"))) return;
  throw new Error(`Detached run path escapes root: ${targetPath}`);
}

export function getDetachedRunPaths(root: string, id: string): DetachedRunPaths {
  const resolvedRoot = resolve(root);
  const runDir = join(resolvedRoot, safeRunIdSegment(id));
  assertInsideRoot(resolvedRoot, runDir);
  return {
    root: resolvedRoot,
    runDir,
    configPath: join(runDir, "config.json"),
    statusPath: join(runDir, "status.json"),
    eventsPath: join(runDir, "events.jsonl"),
    stdoutPath: join(runDir, "stdout.jsonl"),
    stderrPath: join(runDir, "stderr.log"),
    resultTextPath: join(runDir, "result.md"),
    resultJsonPath: join(runDir, "result.json"),
    controlPath: join(runDir, "control.json"),
  };
}

export function ensureDetachedRunDir(paths: DetachedRunPaths): void {
  mkdirSync(paths.runDir, { recursive: true });
}

export function writeAtomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function writeAtomicText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, value, "utf8");
  renameSync(tmp, path);
}
