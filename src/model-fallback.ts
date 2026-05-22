import type { Model } from "@mariozechner/pi-ai";

export interface ModelAttempt {
  readonly model: string;
  readonly success: boolean;
  readonly error?: string;
}

const RETRYABLE_MODEL_FAILURE_PATTERNS = [
  /rate\s*limit/i,
  /too many requests/i,
  /\b429\b/,
  /quota/i,
  /billing/i,
  /credit/i,
  /auth(?:entication)?/i,
  /unauthori[sz]ed/i,
  /forbidden/i,
  /api key/i,
  /token expired/i,
  /invalid key/i,
  /provider.*unavailable/i,
  /model.*unavailable/i,
  /model.*disabled/i,
  /model.*not found/i,
  /unknown model/i,
  /overloaded/i,
  /service unavailable/i,
  /temporar(?:ily)? unavailable/i,
  /connection refused/i,
  /fetch failed/i,
  /network error/i,
  /socket hang up/i,
  /upstream/i,
  /timed? out/i,
  /timeout/i,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
];

export function modelLabel(model: Model<any> | undefined): string {
  if (!model) return "parent-model";
  const provider = (model as any).provider;
  return provider ? `${provider}/${model.id}` : model.id;
}

export function isRetryableModelFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
