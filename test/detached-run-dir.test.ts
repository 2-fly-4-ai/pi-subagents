import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJsonlWriter } from "../src/detached/jsonl-writer.js";
import { assertInsideRoot, ensureDetachedRunDir, getDetachedRunPaths, safeRunIdSegment, writeAtomicJson, writeAtomicText } from "../src/detached/run-dir.js";

let tempDirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagents-detached-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("detached run directory primitives", () => {
  it("normalizes safe id segments and rejects path-like ids", () => {
    expect(safeRunIdSegment("abc-123_ok.test")).toBe("abc-123_ok.test");
    expect(safeRunIdSegment("abc:123")).toBe("abc_123");
    expect(() => safeRunIdSegment("../escape")).toThrow(/simple id/);
    expect(() => safeRunIdSegment("")).toThrow(/must not be empty/);
  });

  it("builds all expected run paths inside the root", () => {
    const root = tempRoot();
    const paths = getDetachedRunPaths(root, "agent:one");

    expect(paths.runDir).toBe(join(root, "agent_one"));
    expect(paths.statusPath).toBe(join(root, "agent_one", "status.json"));
    expect(paths.eventsPath).toBe(join(root, "agent_one", "events.jsonl"));
    expect(paths.stdoutPath).toBe(join(root, "agent_one", "stdout.jsonl"));
    expect(paths.stderrPath).toBe(join(root, "agent_one", "stderr.log"));
    expect(paths.resultTextPath).toBe(join(root, "agent_one", "result.md"));
    expect(paths.resultJsonPath).toBe(join(root, "agent_one", "result.json"));
    expect(paths.controlPath).toBe(join(root, "agent_one", "control.json"));
  });

  it("guards against paths outside the root", () => {
    const root = tempRoot();
    expect(() => assertInsideRoot(root, join(root, "child"))).not.toThrow();
    expect(() => assertInsideRoot(root, join(root, "..", "escape"))).toThrow(/escapes root/);
  });

  it("writes atomic json and text files", () => {
    const paths = getDetachedRunPaths(tempRoot(), "agent-1");
    ensureDetachedRunDir(paths);

    writeAtomicJson(paths.statusPath, { id: "agent-1", status: "running" });
    writeAtomicText(paths.resultTextPath, "hello");

    expect(JSON.parse(readFileSync(paths.statusPath, "utf8"))).toEqual({ id: "agent-1", status: "running" });
    expect(readFileSync(paths.resultTextPath, "utf8")).toBe("hello");
  });

  it("appends JSONL records in order", async () => {
    const paths = getDetachedRunPaths(tempRoot(), "agent-1");
    const writer = createJsonlWriter(paths.eventsPath);

    await writer.append({ type: "start" });
    await writer.append({ type: "end" });
    await writer.close();

    expect(existsSync(paths.eventsPath)).toBe(true);
    expect(readFileSync(paths.eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { type: "start" },
      { type: "end" },
    ]);
  });
});
