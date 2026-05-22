import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnDetachedRun } from "../src/detached/spawn.js";

let tempDirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagents-detached-spawn-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("spawnDetachedRun", () => {
  it("spawns a detached child runner and resolves from result artifacts", async () => {
    const root = tempRoot();
    const handle = spawnDetachedRun({
      id: "agent-1",
      type: "worker",
      description: "detached test",
      cwd: root,
      runRoot: root,
      command: process.execPath,
      args: ["-e", "console.log('detached hello')"],
      childRunnerPath: join(process.cwd(), "dist", "detached", "child-runner.js"),
    });

    const result = await handle.promise;

    expect(handle.pid).toEqual(expect.any(Number));
    expect(result.exitCode).toBe(0);
    expect(result.resultText).toContain("detached hello");
    expect(existsSync(handle.paths.configPath)).toBe(true);
    expect(JSON.parse(readFileSync(handle.paths.statusPath, "utf8"))).toMatchObject({
      id: "agent-1",
      status: "completed",
    });
  });
});
