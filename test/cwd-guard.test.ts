import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGuardedBuiltinToolDefinitions,
  extractAbsolutePaths,
  findPromptWorkspaceMismatch,
  isInsidePath,
  resolveWorkspace,
  validateBashCommand,
  validateReadPath,
  validateWorkspacePath,
  type WorkspaceIdentity,
} from "../src/cwd-guard.js";

vi.mock("../src/audit-log.js", () => ({
  appendAudit: vi.fn(),
}));

const workspace: WorkspaceIdentity = {
  cwd: "/repo/project",
  root: "/repo/project",
  isGitRepo: true,
};

describe("cwd guard", () => {
  let tmp: string | undefined;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it("recognizes paths inside a workspace root", () => {
    expect(isInsidePath("/repo/project", "/repo/project")).toBe(true);
    expect(isInsidePath("/repo/project/src/file.ts", "/repo/project")).toBe(true);
    expect(isInsidePath("/repo/project-other/file.ts", "/repo/project")).toBe(false);
    expect(isInsidePath("/repo/other/file.ts", "/repo/project")).toBe(false);
  });

  it("extracts absolute paths from prompts", () => {
    expect(extractAbsolutePaths("check /Users/me/lago, not relative/path")).toEqual(["/Users/me/lago"]);
  });

  it("does not treat URLs as filesystem paths", () => {
    expect(extractAbsolutePaths("fetch https://hotmovs.com/embed/3822358 and https://example.com/api/v1")).toEqual([]);
  });

  it("does not treat JavaScript regex literals as filesystem paths", () => {
    expect(extractAbsolutePaths("const pats=[/api\\/videofile\\.php/g,/get_file\\/\\d+\\/[^\\s]+/g]")).toEqual([]);
  });

  it("blocks prompt references outside the active workspace", () => {
    const violation = findPromptWorkspaceMismatch("inspect /repo/lago/src/index.ts", workspace);
    expect(violation?.path).toBe("/repo/lago/src/index.ts");
  });

  it("allows prompt references inside the active workspace", () => {
    expect(findPromptWorkspaceMismatch("inspect /repo/project/src/index.ts", workspace)).toBeUndefined();
  });

  it("blocks tool paths outside the workspace", () => {
    const violation = validateWorkspacePath("/repo/lago/package.json", workspace);
    expect(violation?.reason).toContain("outside workspace root");
  });

  it("allows relative tool paths because they resolve under cwd", () => {
    expect(validateWorkspacePath("src/index.ts", workspace)).toBeUndefined();
  });

  it("blocks bash commands containing outside absolute paths", () => {
    const violation = validateBashCommand("git -C /repo/lago status", workspace);
    expect(violation?.path).toBe("/repo/lago");
  });

  it("allows bash commands containing URLs", () => {
    expect(validateBashCommand("python3 -c \"url='https://hotmovs.com/embed/3822358'\"", workspace)).toBeUndefined();
  });

  it("allows bash commands writing output to /dev/null", () => {
    expect(validateBashCommand("curl -sS -D - -o /dev/null https://example.com", workspace)).toBeUndefined();
    expect(validateBashCommand("command -v gh >/dev/null 2>&1", workspace)).toBeUndefined();
  });

  it("allows bash commands containing quoted slash-prefixed regex patterns", () => {
    expect(validateBashCommand("awk '/^content-range/ {print}' headers.txt", workspace)).toBeUndefined();
  });

  it("allows read-only access to skill files", () => {
    expect(validateReadPath("/Users/me/skill-repos/example/skills/diagnose/SKILL.md", workspace)).toBeUndefined();
  });

  it("overrides built-in tool definitions with workspace-guarded versions", async () => {
    const tools = createGuardedBuiltinToolDefinitions(workspace, "agent-1");
    const read = tools.find(t => t.name === "read")!;

    await expect(read.execute("tool-1", { path: "/repo/lago/file.ts" }, undefined, undefined, {} as any))
      .rejects.toThrow("outside workspace root");
  });

  it("resolves git root via pi.exec", async () => {
    tmp = mkdtempSync(join(tmpdir(), "pi-subagents-guard-"));
    const pi = {
      exec: vi.fn(async () => ({ code: 0, stdout: `${tmp}\n`, stderr: "" })),
    } as any;

    const resolved = await resolveWorkspace(pi, tmp);
    expect(resolved.root).toBe(realpathSync.native(tmp));
    expect(resolved.isGitRepo).toBe(true);
  });
});
