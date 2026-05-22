import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDetachedResultWatcher } from "../src/detached/result-watcher.js";
import { getDetachedRunPaths, writeAtomicJson } from "../src/detached/run-dir.js";

let tempDirs: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagents-watch-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
  vi.useRealTimers();
});

describe("detached result watcher", () => {
  it("scans existing result files once", () => {
    const root = tempRoot();
    const paths = getDetachedRunPaths(root, "agent-1");
    mkdirSync(paths.runDir, { recursive: true });
    writeAtomicJson(paths.resultJsonPath, { id: "agent-1", success: true });
    const seen: any[] = [];
    const watcher = createDetachedResultWatcher(root, { onResult: (record) => seen.push(record) });

    watcher.scan();
    watcher.scan();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: "agent-1", data: { id: "agent-1", success: true } });
  });

  it("falls back to polling when root cannot be watched yet", async () => {
    vi.useFakeTimers();
    const root = join(tempRoot(), "missing");
    const seen: any[] = [];
    const watcher = createDetachedResultWatcher(root, { pollIntervalMs: 100, onResult: (record) => seen.push(record) });

    watcher.start();
    expect(watcher.mode).toBe("poll");

    const paths = getDetachedRunPaths(root, "agent-1");
    mkdirSync(paths.runDir, { recursive: true });
    writeAtomicJson(paths.resultJsonPath, { id: "agent-1", success: true });
    await vi.advanceTimersByTimeAsync(100);

    expect(seen).toHaveLength(1);
    watcher.stop();
    expect(watcher.mode).toBe("stopped");
  });
});
