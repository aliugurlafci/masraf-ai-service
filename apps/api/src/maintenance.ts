// `auth-cleanup` (contract §6.5): expired auth sessions (older than 1 day past expiry) and expired idempotency keys.
// Runs in-process every AUTH_CLEANUP_INTERVAL_MS; every statement is batched and idempotent, so several API
// instances running it concurrently only repeat no-op deletes.
import type { Clock } from '@orc/shared';
import type { Database } from '@orc/database';
import type { Logger } from '@orc/logger';

export const AUTH_CLEANUP_INTERVAL_MS = 900_000;
const BATCH_SIZE = 5_000;
const MAX_BATCHES = 100;
const SESSION_GRACE_MS = 86_400_000;

export interface AuthCleanupReport {
  job: 'auth-cleanup';
  durationMs: number;
  counts: { sessions: number; idempotencyKeys: number };
  errors: string[];
}

export interface AuthCleanup {
  runOnce(): Promise<AuthCleanupReport>;
  start(): void;
  stop(): Promise<void>;
}

async function drain(fn: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i += 1) {
    const n = await fn();
    total += n;
    if (n < BATCH_SIZE) break;
  }
  return total;
}

export function createAuthCleanup(deps: {
  db: Database;
  logger: Logger;
  clock?: Clock;
  intervalMs?: number;
}): AuthCleanup {
  const now = (): number => (deps.clock ? deps.clock.nowMs() : Date.now());
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<AuthCleanupReport> | null = null;

  const runOnce = async (): Promise<AuthCleanupReport> => {
    const started = now();
    const errors: string[] = [];
    let sessions = 0;
    let idempotencyKeys = 0;
    try {
      sessions = await drain(() =>
        deps.db.repos.authSessions.deleteExpired(new Date(now() - SESSION_GRACE_MS), BATCH_SIZE),
      );
    } catch (err) {
      errors.push(`sessions: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      idempotencyKeys = await drain(() => deps.db.repos.idempotency.deleteExpired(new Date(now()), BATCH_SIZE));
    } catch (err) {
      errors.push(`idempotency: ${err instanceof Error ? err.message : String(err)}`);
    }
    const report: AuthCleanupReport = {
      job: 'auth-cleanup',
      durationMs: now() - started,
      counts: { sessions, idempotencyKeys },
      errors,
    };
    if (errors.length > 0) deps.logger.warn({ report }, 'auth-cleanup finished with errors');
    else deps.logger.info({ report }, 'auth-cleanup finished');
    return report;
  };

  const tick = (): void => {
    if (running !== null) return;
    running = runOnce().finally(() => {
      running = null;
    });
  };

  return {
    runOnce,
    start() {
      if (timer !== null) return;
      timer = setInterval(tick, deps.intervalMs ?? AUTH_CLEANUP_INTERVAL_MS);
      timer.unref();
    },
    async stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (running !== null) await running.catch(() => undefined);
    },
  };
}
