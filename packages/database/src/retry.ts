// Deadlock / lock-timeout retry policy (contract §2.5: 50ms*2^n + jitter 0-50ms, cap 2s; default 3 retries).

export const DEFAULT_TX_MAX_RETRIES = 3;
export const RETRY_BASE_MS = 50;
export const RETRY_JITTER_MS = 50;
export const RETRY_CAP_MS = 2000;

/** Delay before retry number `retry` (0-based). `random` returns [0, 1). */
export function retryDelayMs(retry: number, random: () => number = Math.random): number {
  const exp = RETRY_BASE_MS * 2 ** Math.max(0, retry);
  const jitter = Math.floor(Math.min(Math.max(random(), 0), 0.999999) * (RETRY_JITTER_MS + 1));
  return Math.min(exp + jitter, RETRY_CAP_MS);
}

export interface RetryOptions {
  maxRetries: number;
  isRetryable(err: unknown): boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { retry: number; delayMs: number; error: unknown }) => void;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `fn(attempt)`; retries while `isRetryable(err)` and fewer than `maxRetries` retries were made. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const wait = opts.sleep ?? sleep;
  const maxRetries = Math.max(0, Math.floor(opts.maxRetries));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= maxRetries || !opts.isRetryable(err)) throw err;
      const delayMs = retryDelayMs(attempt, opts.random);
      opts.onRetry?.({ retry: attempt + 1, delayMs, error: err });
      await wait(delayMs);
    }
  }
}
