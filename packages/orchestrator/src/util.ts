// Small helpers shared by the pipeline, processors and heartbeat.
import { OrcError } from '@orc/shared';
import type { Clock } from '@orc/shared';
import { isTransientDbError } from './outcome.js';

/** Thrown when worker-side DB writes still fail after DB_WRITE_RETRY_WINDOW_MS (§13.1). */
export class DbWriteAbandonedError extends OrcError {
  constructor(what: string, cause: unknown) {
    super('db_unavailable', `Database write "${what}" kept failing; attempt left for stale recovery`, { cause });
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;

/** Retries transient DB errors with backoff 1 s..30 s for `windowMs`; other errors are rethrown as is. */
export async function withDbRetry<T>(
  what: string,
  fn: () => Promise<T>,
  o: { windowMs: number; clock: Clock; onRetry?: (err: unknown, attempt: number) => void },
): Promise<T> {
  const started = o.clock.nowMs();
  let delay = RETRY_MIN_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientDbError(err)) throw err;
      const elapsed = o.clock.nowMs() - started;
      if (elapsed + delay > o.windowMs) throw new DbWriteAbandonedError(what, err);
      o.onRetry?.(err, attempt);
      await sleep(delay);
      delay = Math.min(delay * 2, RETRY_MAX_MS);
    }
  }
}

/** Runs `fn` with an AbortSignal that fires after `ms`; rejects with OrcError('internal_error') on timeout. */
export async function withTimeout<T>(ms: number, what: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_r, reject) => {
    timer = setTimeout(() => {
      controller.abort('timeout');
      reject(new OrcError('internal_error', `${what} timed out after ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function errorCode(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const c = (err as { code?: unknown }).code;
    return typeof c === 'string' ? c : null;
  }
  return null;
}

/** OrcError('process_spawn_failed', details.reason 'busy') from a launcher (§2.2). */
export function isBusyError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const details = (err as { details?: unknown }).details;
  return (
    typeof details === 'object' &&
    details !== null &&
    (details as { reason?: unknown }).reason === 'busy'
  );
}
