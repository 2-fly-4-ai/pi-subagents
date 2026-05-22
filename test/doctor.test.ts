import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const agentDir = mkdtempSync(join(tmpdir(), "pi-subagents-doctor-agent-"));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  getAgentDir: () => agentDir,
}));

const { buildDoctorReport } = await import("../src/doctor.js");

let tempDirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagents-doctor-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("buildDoctorReport", () => {
  it("reports core runtime checks", () => {
    const cwd = tempRoot();

    const report = buildDoctorReport({
      cwd,
      durableRuns: [{
        version: 1,
        id: "stale",
        type: "worker",
        description: "stale run",
        status: "error",
        ownerPid: 123,
        startedAt: 1,
        updatedAt: 2,
        completedAt: 2,
        toolUses: 0,
        stale: true,
      }],
      modelCount: 2,
      packageRoot: cwd,
    });

    expect(report).toContain("Subagents doctor");
    expect(report).toContain("detached runner");
    expect(report).toContain("durable run directory");
    expect(report).toContain("durable run statuses: 1 total, 0 active, 1 error, 1 stale, 0 detached");
    expect(report).toContain("models: 2 available");
  });
});
