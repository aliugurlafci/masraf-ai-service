// Polling with a hard deadline. The deadline also bounds a probe that never settles.
import { setTimeout as delay } from 'node:timers/promises';

export type Truthy<T> = Exclude<T, false | 0 | 0n | '' | null | undefined>;

export interface WaitForOptions {
  /** Total budget in milliseconds (default 5000). */
  readonly timeoutMs?: number;
  /** Pause between attempts in milliseconds (default 25). */
  readonly intervalMs?: number;
  /** What is awaited; used in the timeout error message. */
  readonly description?: string;
  readonly signal?: AbortSignal;
}

export class WaitForTimeoutError extends Error {
  override readonly name = 'WaitForTimeoutError';
  readonly attempts: number;

  constructor(message: string, attempts: number, options?: ErrorOptions) {
    super(message, options);
    this.attempts = attempts;
  }
}

const TIMED_OUT: unique symbol = Symbol('timed out');

async function attempt<T>(
  probe: () => T | PromiseLike<T>,
  budgetMs: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(resolve, budgetMs, TIMED_OUT);
  });
  try {
    return await Promise.race([Promise.resolve().then(probe), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? typeof error;
  } catch {
    return typeof error;
  }
}

function assertDuration(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`waitFor: ${name} must be a finite number >= 0, got ${value}`);
  }
}

/**
 * Calls `probe` until it returns a truthy value (probes that throw are retried) and resolves
 * with that value. Attempts never overlap. Rejects with {@link WaitForTimeoutError} once
 * `timeoutMs` has elapsed (the last thrown error is the `cause`), or with the abort reason.
 */
export async function waitFor<T>(
  probe: () => T | PromiseLike<T>,
  options: WaitForOptions = {},
): Promise<Truthy<T>> {
  const { timeoutMs = 5000, intervalMs = 25, description = 'condition', signal } = options;
  assertDuration('timeoutMs', timeoutMs);
  assertDuration('intervalMs', intervalMs);
  const deadline = performance.now() + timeoutMs;
  let attempts = 0;
  let lastError: unknown;
  let hung = false;

  for (;;) {
    signal?.throwIfAborted();
    attempts += 1;
    try {
      const value = await attempt(probe, Math.max(deadline - performance.now(), 0));
      if (value === TIMED_OUT) {
        hung = true;
        break;
      }
      if (value) return value as Truthy<T>;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    try {
      await delay(Math.min(intervalMs, remaining), undefined, { signal });
    } catch (error) {
      signal?.throwIfAborted(); // surface the caller's abort reason, not a generic AbortError
      throw error;
    }
  }

  signal?.throwIfAborted();
  const detail = hung
    ? 'the last attempt did not settle'
    : lastError === undefined
      ? 'the last attempt returned a falsy value'
      : `last error: ${describeError(lastError)}`;
  throw new WaitForTimeoutError(
    `waitFor timed out after ${timeoutMs} ms waiting for ${description} (${attempts} attempt${attempts === 1 ? '' : 's'}; ${detail})`,
    attempts,
    lastError === undefined ? undefined : { cause: lastError },
  );
}
