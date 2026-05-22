const REVIEW_ONLY_PATTERNS = [
  /\breview only\b/i,
  /\bsuggest fixes only\b/i,
  /\bonly return findings\b/i,
  /\breturn findings only\b/i,
];

const EXPLICIT_NO_EDIT_PATTERNS = [
  /\bdo not edit\b/i,
  /\bdon't edit\b/i,
  /\bdo not modify\b/i,
  /\bdo not change files\b/i,
];

const RESEARCH_AGENT_PATTERNS = [
  /\bexplore\b/i,
  /\bplan\b/i,
  /\bscout\b/i,
  /\bresearch(?:er)?\b/i,
  /\breviewer\b/i,
];

const IMPLEMENTATION_PATTERNS = [
  /\b(?:implement|fix|edit|modify|patch|refactor)\b/i,
  /\bapply\s+(?:the\s+)?(?:changes?|fix(?:es)?|patch)\b/i,
  /\bmake\s+(?:the\s+)?changes\b/i,
  /\bdo those fixes\b/i,
  /\b(?:update|add|remove|replace|delete|create)\s+(?:the\s+)?(?:file|files|code|source|implementation|test|tests|component|function|module|class|method|logic|import|imports|readme|docs?|changelog|package\.json|config|manifest|extension|prompt|command)\b/i,
];

const MUTATING_BASH_PATTERNS = [
  /(^|[;&|()\s])rm\s+/,
  /(^|[;&|()\s])mv\s+/,
  /(^|[;&|()\s])cp\s+/,
  /(^|[;&|()\s])mkdir\s+/,
  /(^|[;&|()\s])touch\s+/,
  /(^|[;&|()\s])git\s+apply\b/,
  /(^|[;&|()\s])patch\s+/,
  /(^|[;&|()\s])sed\s+[^\n;&|]*\s-i\b/,
  /(^|[;&|()\s])perl\s+[^\n;&|]*\s-pi\b/,
  /(^|[;&|()]|\n)\s*tee\s+[^|&;]+/,
  /\b(writeFile|writeFileSync|appendFile|appendFileSync)\b/,
  /\bwrite_text\s*\(/,
  /\bopen\s*\([^)]*,\s*["'][wa]/,
];

function hasUnquotedFileRedirection(command: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble || char !== ">") continue;
    if (command[i - 1] === "-") continue;
    const isDouble = command[i + 1] === ">";
    let cursor = i + (isDouble ? 2 : 1);
    while (cursor < command.length && /\s/.test(command[cursor]!)) cursor++;
    if (cursor >= command.length) continue;
    const targetStart = command[cursor]!;
    if (targetStart === "&" || targetStart === "|" || targetStart === ";" || targetStart === "(" || targetStart === ")") continue;
    return true;
  }
  return false;
}

export function isMutatingBashCommand(command: string): boolean {
  return hasUnquotedFileRedirection(command) || MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(command));
}

export function isMutatingTool(toolName: string | undefined, args: Record<string, unknown> | undefined): boolean {
  if (!toolName) return false;
  if (toolName === "edit" || toolName === "write") return true;
  if (toolName !== "bash") return false;
  const command = typeof args?.command === "string" ? args.command : "";
  return command.trim().length > 0 && isMutatingBashCommand(command);
}

export function expectsImplementationMutation(agent: string, task: string): boolean {
  if (REVIEW_ONLY_PATTERNS.some((pattern) => pattern.test(task))) return false;
  if (EXPLICIT_NO_EDIT_PATTERNS.some((pattern) => pattern.test(task))) return false;
  if (RESEARCH_AGENT_PATTERNS.some((pattern) => pattern.test(agent))) return false;
  return IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(task));
}

export function completionGuardWarning(agent: string, task: string, attemptedMutation: boolean): string | undefined {
  if (!expectsImplementationMutation(agent, task) || attemptedMutation) return undefined;
  return `Completion guard: task looked like implementation work for ${agent}, but no mutating tool call was observed.`;
}
