import { LlmError } from './errors.ts';

export type RetryPolicy = { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 20_000 };

/**
 * Retries only retryable LlmErrors. Honours provider retry-after (capped);
 * otherwise exponential backoff. Every attempt is a separate provider call, so
 * RecordingProvider records each one.
 */
export async function withRetry<T>(fn: () => Promise<T>, policy: RetryPolicy = DEFAULT_RETRY, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof LlmError) || !e.retryable || attempt >= policy.maxAttempts) throw e;
      if (e.retryAfterMs !== null && e.retryAfterMs > policy.maxDelayMs) throw e; // waiting longer than our budget: surface it
      const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      await sleep(e.retryAfterMs ?? backoff);
    }
  }
}
