import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { getAvailableTypes, getUserAgentNames } from "./agent-types.js";
import type { DurableRunStatus } from "./durable-run-store.js";

export interface DoctorCheck {
  readonly name: string;
  readonly status: "ok" | "warning" | "error";
  readonly detail: string;
}

export interface DoctorDeps {
  readonly cwd: string;
  readonly durableRuns: readonly DurableRunStatus[];
  readonly modelCount?: number;
  readonly packageRoot?: string;
}

function checkWritableDir(path: string): DoctorCheck {
  try {
    mkdirSync(path, { recursive: true });
    const probe = join(path, `.doctor-${process.pid}-${Date.now()}`);
    writeFileSync(probe, "ok", "utf8");
    return { name: "durable run directory", status: "ok", detail: path };
  } catch (error) {
    return {
      name: "durable run directory",
      status: "error",
      detail: `${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function checkAgentDirs(cwd: string): DoctorCheck {
  const projectDir = join(cwd, ".pi", "agents");
  const globalDir = join(getAgentDir(), "agents");
  const existing = [projectDir, globalDir].filter((dir) => existsSync(dir));
  return {
    name: "custom agent directories",
    status: existing.length > 0 ? "ok" : "warning",
    detail: existing.length > 0 ? existing.join(", ") : `none found (${projectDir}, ${globalDir})`,
  };
}

function checkPackageRoot(packageRoot: string | undefined): DoctorCheck {
  if (!packageRoot) return { name: "package root", status: "warning", detail: "not provided" };
  const pkg = join(packageRoot, "package.json");
  return {
    name: "package root",
    status: existsSync(pkg) ? "ok" : "warning",
    detail: packageRoot,
  };
}

function checkDurableRuns(runs: readonly DurableRunStatus[]): DoctorCheck {
  const stale = runs.filter((run) => run.stale).length;
  const active = runs.filter((run) => run.status === "running" || run.status === "queued").length;
  const errored = runs.filter((run) => run.status === "error").length;
  return {
    name: "durable run statuses",
    status: stale > 0 || errored > 0 ? "warning" : "ok",
    detail: `${runs.length} total, ${active} active, ${errored} error, ${stale} stale`,
  };
}

function checkRecentRunDir(): DoctorCheck {
  const runsDir = join(getAgentDir(), "subagents", "runs");
  try {
    const count = existsSync(runsDir) ? readdirSync(runsDir).length : 0;
    return { name: "durable run files", status: "ok", detail: `${count} run director${count === 1 ? "y" : "ies"}` };
  } catch (error) {
    return { name: "durable run files", status: "warning", detail: error instanceof Error ? error.message : String(error) };
  }
}

export function buildDoctorReport(deps: DoctorDeps): string {
  const checks: DoctorCheck[] = [
    checkPackageRoot(deps.packageRoot),
    checkWritableDir(join(getAgentDir(), "subagents", "runs")),
    checkAgentDirs(deps.cwd),
    checkRecentRunDir(),
    checkDurableRuns(deps.durableRuns),
    {
      name: "registered agents",
      status: getAvailableTypes().length > 0 ? "ok" : "error",
      detail: `${getAvailableTypes().length} available, ${getUserAgentNames().length} custom`,
    },
    {
      name: "models",
      status: deps.modelCount === undefined ? "warning" : deps.modelCount > 0 ? "ok" : "error",
      detail: deps.modelCount === undefined ? "model registry unavailable" : `${deps.modelCount} available`,
    },
  ];

  const icon = (status: DoctorCheck["status"]) => status === "ok" ? "✓" : status === "warning" ? "!" : "✗";
  const lines = ["Subagents doctor", ""];
  for (const check of checks) {
    lines.push(`${icon(check.status)} ${check.name}: ${check.detail}`);
  }
  return lines.join("\n");
}
