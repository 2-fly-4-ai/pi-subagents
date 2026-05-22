import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDetachedChild } from "../src/detached/child-runner.js";
import { getDetachedRunPaths } from "../src/detached/run-dir.js";

let tempDirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagents-child-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("detached child runner", () => {
  it("runs a command and writes terminal artifacts", async () => {
    const root = tempRoot();
    const result = await runDetachedChild({
      id: "agent-1",
      type: "worker",
      description: "test child",
      cwd: root,
      runRoot: root,
      command: process.execPath,
      args: ["-e", "console.log(JSON.stringify({type:'message', text:'hello'})); console.log('done')"],
      startedAt: 100,
    });
    const paths = getDetachedRunPaths(root, "agent-1");

    expect(result.exitCode).toBe(0);
    expect(readFileSync(paths.resultTextPath, "utf8")).toContain("done");
    expect(JSON.parse(readFileSync(paths.statusPath, "utf8"))).toMatchObject({
      id: "agent-1",
      status: "completed",
      state: "complete",
      resultPath: paths.resultTextPath,
    });
    expect(JSON.parse(readFileSync(paths.resultJsonPath, "utf8"))).toMatchObject({
      id: "agent-1",
      success: true,
      exitCode: 0,
    });
    const events = readFileSync(paths.eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((event) => event.type)).toContain("start");
    expect(events.map((event) => event.type)).toContain("child_spawn");
    expect(events.map((event) => event.type)).toContain("pi_event");
    expect(events.at(-1)).toMatchObject({ type: "complete", success: true });
  });

  it("marks failed commands as error", async () => {
    const root = tempRoot();
    const result = await runDetachedChild({
      id: "agent-1",
      type: "worker",
      description: "test child",
      cwd: root,
      runRoot: root,
      command: process.execPath,
      args: ["-e", "console.error('boom'); process.exit(7)"],
    });
    const paths = getDetachedRunPaths(root, "agent-1");

    expect(result.exitCode).toBe(7);
    expect(JSON.parse(readFileSync(paths.statusPath, "utf8"))).toMatchObject({
      id: "agent-1",
      status: "error",
      state: "failed",
      exitCode: 7,
      error: "boom",
    });
    expect(readFileSync(paths.stderrPath, "utf8")).toContain("boom");
  });
});
