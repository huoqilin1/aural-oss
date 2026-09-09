import { setTimeout as sleep } from "node:timers/promises";

export class GlmPreOutputOverload extends Error {
  constructor(readonly retryAfterSeconds: number) { super("LLM API 429 code=1305"); }
}

export function overloadDelay(error: unknown, retryIndex: number, waitedMs: number): number | null {
  if (!(error instanceof GlmPreOutputOverload) || retryIndex >= 2) return null;
  const delay = Math.max([15_000, 30_000][retryIndex]!, error.retryAfterSeconds * 1000);
  return Number.isFinite(delay) && waitedMs + delay <= 90_000 ? delay : null;
}

export async function waitForGlm(secondsMs: number, signal?: AbortSignal): Promise<void> {
  await sleep(secondsMs, undefined, { signal });
}
