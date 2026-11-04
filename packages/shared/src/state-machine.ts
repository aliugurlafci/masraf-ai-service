// Task state machine (contract §5.1). Pure; persistence rules live in TaskStateStore.
import {
  ACTIVE_TASK_STATUSES,
  SETTLED_TASK_STATUSES,
  type ActiveTaskStatus,
  type AttemptStatus,
  type SettledTaskStatus,
  type TaskStatus,
} from './constants';
import { InvalidTransitionError } from './errors';

const freeze = <T extends readonly TaskStatus[]>(targets: T): T => Object.freeze(targets);

/**
 * Exhaustive transition table. Active -> queued is legal only through
 * `createAttempt({trigger:'infra_recovery'})`; retryable -> queued only through
 * `createAttempt({trigger:'user_retry'})` (enforced by the store, not here).
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = Object.freeze({
  created: freeze(['queued', 'cancelled']),
  queued: freeze(['preparing_workspace', 'cancelled', 'failed']),
  preparing_workspace: freeze([
    'indexing',
    'running',
    'blocked',
    'failed',
    'cancelled',
    'timed_out',
    'queued',
  ]),
  indexing: freeze(['running', 'blocked', 'failed', 'cancelled', 'timed_out', 'queued']),
  running: freeze(['testing', 'reviewing', 'failed', 'cancelled', 'timed_out', 'queued']),
  testing: freeze(['reviewing', 'failed', 'cancelled', 'timed_out', 'queued']),
  reviewing: freeze(['completed', 'failed', 'cancelled', 'timed_out', 'queued']),
  completed: freeze([]),
  failed: freeze(['queued']),
  timed_out: freeze(['queued']),
  cancelled: freeze(['queued']),
  blocked: freeze(['queued']),
});

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  const targets: readonly TaskStatus[] | undefined = TASK_TRANSITIONS[from];
  return targets !== undefined && targets.includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

const ACTIVE_SET: ReadonlySet<TaskStatus> = new Set(ACTIVE_TASK_STATUSES);
const SETTLED_SET: ReadonlySet<TaskStatus> = new Set(SETTLED_TASK_STATUSES);

export function isActiveStatus(s: TaskStatus): s is ActiveTaskStatus {
  return ACTIVE_SET.has(s);
}

export function isSettledStatus(s: TaskStatus): s is SettledTaskStatus {
  return SETTLED_SET.has(s);
}

/** completed -> succeeded; failed, timed_out, cancelled, blocked keep their name. */
export function attemptStatusForSettled(s: SettledTaskStatus): AttemptStatus {
  switch (s) {
    case 'completed':
      return 'succeeded';
    case 'failed':
    case 'timed_out':
    case 'cancelled':
    case 'blocked':
      return s;
  }
}
