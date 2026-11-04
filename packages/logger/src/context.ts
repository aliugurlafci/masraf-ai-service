import { AsyncLocalStorage } from 'node:async_hooks';
import type { Uuid } from '@orc/shared';

export interface LogContext {
  requestId?: string;
  correlationId?: string;
  userId?: Uuid;
  taskId?: Uuid;
  attemptId?: Uuid;
  projectId?: Uuid;
  jobId?: string;
  queue?: string;
  workerId?: string;
}

const LOG_CONTEXT_KEYS = [
  'requestId',
  'correlationId',
  'userId',
  'taskId',
  'attemptId',
  'projectId',
  'jobId',
  'queue',
  'workerId',
] as const satisfies readonly (keyof LogContext)[];

const EMPTY_CONTEXT: Readonly<LogContext> = Object.freeze({});
const storage = new AsyncLocalStorage<Readonly<LogContext>>();

/**
 * Runs `fn` with `ctx` merged over the current context (inner values win; `undefined` values are
 * ignored, so they never erase an outer value). Propagates through promises, timers and events.
 */
export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
  const merged: LogContext = { ...(storage.getStore() ?? EMPTY_CONTEXT) };
  for (const key of LOG_CONTEXT_KEYS) {
    const value = ctx[key];
    if (typeof value === 'string') merged[key] = value;
  }
  return storage.run(Object.freeze(merged), fn);
}

export function getLogContext(): Readonly<LogContext> {
  return storage.getStore() ?? EMPTY_CONTEXT;
}
