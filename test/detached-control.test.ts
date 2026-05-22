import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDetachedControlRequest, writeDetachedControlRequest } from "../src/detached/control.js";
import { getDetachedRunPaths } from "../src/detached/run-dir.js";

let tempDirs: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagents-control-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("detached control", () => {
  it("writes and reads control requests", () => {
    const paths = getDetachedRunPaths(tempRoot(), "agent-1");

    const request = writeDetachedControlRequest(paths.controlPath, "interrupt", "pause please");

    expect(request).toMatchObject({ action: "interrupt", message: "pause please" });
    expect(readDetachedControlRequest(paths.controlPath)).toEqual(request);
  });

  it("returns undefined for missing control requests", () => {
    const paths = getDetachedRunPaths(tempRoot(), "agent-1");
    expect(readDetachedControlRequest(paths.controlPath)).toBeUndefined();
  });
});
