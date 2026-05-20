import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, normalize, relative, resolve } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ToolDefinition,
  type ToolsOptions,
} from "@mariozechner/pi-coding-agent";
import { appendAudit } from "./audit-log.js";

export interface WorkspaceIdentity {
  cwd: string;
  root: string;
  isGitRepo: boolean;
}

export interface WorkspaceViolation {
  reason: string;
  path?: string;
  root: string;
  cwd: string;
}

function realpathIfPossible(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return normalize(path);
  }
}

export async function resolveWorkspace(pi: ExtensionAPI, cwd: string): Promise<WorkspaceIdentity> {
  const absoluteCwd = realpathIfPossible(resolve(cwd));
  try {
    const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: absoluteCwd, timeout: 5000 });
    const root = result.code === 0 ? result.stdout.trim() : "";
    if (root) {
      return { cwd: absoluteCwd, root: realpathIfPossible(root), isGitRepo: true };
    }
  } catch {
    // Fall through to cwd-rooted guard when git is unavailable.
  }
  return { cwd: absoluteCwd, root: absoluteCwd, isGitRepo: false };
}

export function isInsidePath(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function stripTrailingPunctuation(path: string): string {
  return path.replace(/[),.;:!?\]}>'"]+$/g, "");
}

export function expandPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

export function extractAbsolutePaths(text: string): string[] {
  const matches = text.match(/(?<![:/\w.-])(?:~|\/(?!\/))[^\s`"'<>|;&]+/g) ?? [];
  return [...new Set(matches
    .map(stripTrailingPunctuation)
    .filter(candidate => !looksLikeRegexLiteral(candidate))
    .map(expandPath)
    .filter(isAbsolute))];
}

function looksLikeRegexLiteral(path: string): boolean {
  return path.includes("\\") || /\/(?:[dgimsuy]+)?[,\])}]?$/.test(path);
}

function isApprovedExternalReadPath(path: string): boolean {
  const resolved = realpathIfPossible(path);
  const skillRepoRoot = realpathIfPossible(resolve(homedir(), ".pi", "agent", "skill-repos"));
  if (isInsidePath(resolved, skillRepoRoot)) return true;
  return basename(resolved) === "SKILL.md" && resolved.split(/[\\/]+/).includes("skills");
}

export function resolveToolPath(path: string | undefined, workspace: WorkspaceIdentity): string {
  if (!path || path.trim() === "") return workspace.cwd;
  const expanded = expandPath(path);
  return realpathIfPossible(isAbsolute(expanded) ? expanded : resolve(workspace.cwd, expanded));
}

export function validateWorkspacePath(path: string | undefined, workspace: WorkspaceIdentity): WorkspaceViolation | undefined {
  const resolved = resolveToolPath(path, workspace);
  if (isInsidePath(resolved, workspace.root)) return undefined;
  return {
    reason: `Blocked path outside workspace root: ${resolved}`,
    path: resolved,
    root: workspace.root,
    cwd: workspace.cwd,
  };
}

export function validateReadPath(path: string | undefined, workspace: WorkspaceIdentity): WorkspaceViolation | undefined {
  const resolved = resolveToolPath(path, workspace);
  if (isInsidePath(resolved, workspace.root) || isApprovedExternalReadPath(resolved)) return undefined;
  return {
    reason: `Blocked path outside workspace root: ${resolved}`,
    path: resolved,
    root: workspace.root,
    cwd: workspace.cwd,
  };
}

export function findPromptWorkspaceMismatch(prompt: string, workspace: WorkspaceIdentity): WorkspaceViolation | undefined {
  for (const candidate of extractAbsolutePaths(prompt)) {
    const resolved = existsSync(candidate) ? realpathIfPossible(candidate) : normalize(candidate);
    if (!isInsidePath(resolved, workspace.root)) {
      return {
        reason: `Prompt references path outside current workspace root: ${resolved}`,
        path: resolved,
        root: workspace.root,
        cwd: workspace.cwd,
      };
    }
  }
  return undefined;
}

export function validateBashCommand(command: string, workspace: WorkspaceIdentity): WorkspaceViolation | undefined {
  for (const candidate of extractAbsolutePaths(command)) {
    const resolved = existsSync(candidate) ? realpathIfPossible(candidate) : normalize(candidate);
    if (!isInsidePath(resolved, workspace.root)) {
      return {
        reason: `Blocked bash command path outside workspace root: ${resolved}`,
        path: resolved,
        root: workspace.root,
        cwd: workspace.cwd,
      };
    }
  }
  return undefined;
}

function guarded<T extends ToolDefinition<any, any, any>>(
  tool: T,
  workspace: WorkspaceIdentity,
  validate: (params: any) => WorkspaceViolation | undefined,
  agentId?: string,
): T {
  return {
    ...tool,
    async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
      const violation = validate(params);
      if (violation) {
        appendAudit("subagent_tool_blocked", {
          agentId,
          toolName: tool.name,
          toolCallId,
          reason: violation.reason,
          path: violation.path,
          cwd: violation.cwd,
          workspaceRoot: violation.root,
        });
        throw new Error(`${violation.reason}. Subagents are locked to ${violation.root}; start a session in the target repo instead.`);
      }
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  } as T;
}

export function createGuardedBuiltinToolDefinitions(
  workspace: WorkspaceIdentity,
  agentId?: string,
  toolOptions: ToolsOptions = {},
): ToolDefinition<any, any, any>[] {
  return [
    guarded(createReadToolDefinition(workspace.cwd, toolOptions.read), workspace, params => validateReadPath(params.path, workspace), agentId),
    guarded(createWriteToolDefinition(workspace.cwd, toolOptions.write), workspace, params => validateWorkspacePath(params.path, workspace), agentId),
    guarded(createEditToolDefinition(workspace.cwd, toolOptions.edit), workspace, params => validateWorkspacePath(params.path, workspace), agentId),
    guarded(createGrepToolDefinition(workspace.cwd, toolOptions.grep), workspace, params => validateWorkspacePath(params.path, workspace), agentId),
    guarded(createFindToolDefinition(workspace.cwd, toolOptions.find), workspace, params => validateWorkspacePath(params.path, workspace), agentId),
    guarded(createLsToolDefinition(workspace.cwd, toolOptions.ls), workspace, params => validateWorkspacePath(params.path, workspace), agentId),
    guarded(createBashToolDefinition(workspace.cwd, toolOptions.bash), workspace, params => validateBashCommand(params.command ?? "", workspace), agentId),
  ];
}
