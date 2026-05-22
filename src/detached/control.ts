import { readFileSync } from "node:fs";
import { writeAtomicJson } from "./run-dir.js";

export interface DetachedControlRequest {
  readonly action: "interrupt" | "stop" | "resume";
  readonly message?: string;
  readonly createdAt: number;
}

export function writeDetachedControlRequest(path: string, action: DetachedControlRequest["action"], message?: string): DetachedControlRequest {
  const request = { action, message, createdAt: Date.now() };
  writeAtomicJson(path, request);
  return request;
}

export function readDetachedControlRequest(path: string): DetachedControlRequest | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DetachedControlRequest;
  } catch {
    return undefined;
  }
}

export function signalDetachedProcess(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (!pid) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}
