import { describe, expect, it } from 'vitest';
import {
  ACTIVE_TASK_STATUSES,
  InvalidTransitionError,
  RETRYABLE_TASK_STATUSES,
  SETTLED_TASK_STATUSES,
  TASK_STATUSES,
  TASK_TRANSITIONS,
  assertTransition,
  attemptStatusForSettled,
  canTransition,
  isActiveStatus,
  isOrcError,
  isSettledStatus,
  type TaskStatus,
} from '@orc/shared';

// Contract §5.1, written out independently of the implementation.
const ALLOWED: readonly (readonly [TaskStatus, TaskStatus])[] = [
  ['created', 'queued'],
  ['created', 'cancelled'],
  ['queued', 'preparing_workspace'],
  ['queued', 'cancelled'],
  ['queued', 'failed'],
  ['preparing_workspace', 'indexing'],
  ['preparing_workspace', 'running'],
  ['preparing_workspace', 'blocked'],
  ['preparing_workspace', 'failed'],
  ['preparing_workspace', 'cancelled'],
  ['preparing_workspace', 'timed_out'],
  ['preparing_workspace', 'queued'],
  ['indexing', 'running'],
  ['indexing', 'blocked'],
  ['indexing', 'failed'],
  ['indexing', 'cancelled'],
  ['indexing', 'timed_out'],
  ['indexing', 'queued'],
  ['running', 'testing'],
  ['running', 'reviewing'],
  ['running', 'failed'],
  ['running', 'cancelled'],
  ['running', 'timed_out'],
  ['running', 'queued'],
  ['testing', 'reviewing'],
  ['testing', 'failed'],
  ['testing', 'cancelled'],
  ['testing', 'timed_out'],
  ['testing', 'queued'],
  ['reviewing', 'completed'],
  ['reviewing', 'failed'],
  ['reviewing', 'cancelled'],
  ['reviewing', 'timed_out'],
  ['reviewing', 'queued'],
  ['failed', 'queued'],
  ['timed_out', 'queued'],
  ['cancelled', 'queued'],
  ['blocked', 'queued'],
];

const key = (from: TaskStatus, to: TaskStatus): string => `${from}->${to}`;
const ALLOWED_KEYS = new Set(ALLOWED.map(([f, t]) => key(f, t)));
const ALL_PAIRS = TASK_STATUSES.flatMap((from) => TASK_STATUSES.map((to) => [from, to] as const));
const FORBIDDEN = ALL_PAIRS.filter(([f, t]) => !ALLOWED_KEYS.has(key(f, t)));

describe('task state machine', () => {
  it('table covers every status exactly once', () => {
    expect(Object.keys(TASK_TRANSITIONS).sort()).toEqual([...TASK_STATUSES].sort());
  });

  it('table matches the contract exactly (no extra, no missing edges)', () => {
    const actual = Object.entries(TASK_TRANSITIONS).flatMap(([from, tos]) =>
      tos.map((to) => key(from as TaskStatus, to)),
    );
    expect(new Set(actual)).toEqual(ALLOWED_KEYS);
    expect(actual).toHaveLength(ALLOWED.length);
  });

  it.each(ALLOWED)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it('rejects every pair that is not in the table', () => {
    expect(FORBIDDEN.length).toBe(TASK_STATUSES.length ** 2 - ALLOWED.length);
    for (const [from, to] of FORBIDDEN) {
      expect(canTransition(from, to), key(from, to)).toBe(false);
      expect(() => assertTransition(from, to), key(from, to)).toThrow(InvalidTransitionError);
    }
  });

  it.each([
    ['created', 'running'],
    ['created', 'completed'],
    ['queued', 'running'],
    ['queued', 'completed'],
    ['preparing_workspace', 'testing'],
    ['indexing', 'reviewing'],
    ['running', 'completed'],
    ['testing', 'completed'],
    ['testing', 'blocked'],
    ['reviewing', 'running'],
    ['completed', 'queued'],
    ['failed', 'running'],
    ['cancelled', 'created'],
    ['blocked', 'cancelled'],
    ['queued', 'queued'],
  ] as const)(
    'representative forbidden transition %s -> %s throws a 409 invalid_transition',
    (from, to) => {
      let caught: unknown;
      try {
        assertTransition(from, to);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(InvalidTransitionError);
      expect(isOrcError(caught)).toBe(true);
      const err = caught as InvalidTransitionError;
      expect(err.code).toBe('invalid_transition');
      expect(err.status).toBe(409);
      expect(err.from).toBe(from);
      expect(err.to).toBe(to);
      expect(err.details).toEqual({ from, to });
      expect(err.message).toContain(`${from} -> ${to}`);
    },
  );

  it('completed is terminal', () => {
    expect(TASK_TRANSITIONS.completed).toEqual([]);
    for (const to of TASK_STATUSES) expect(canTransition('completed', to)).toBe(false);
  });

  it('every non-completed settled state can only go back to queued (retry)', () => {
    for (const s of RETRYABLE_TASK_STATUSES) expect(TASK_TRANSITIONS[s]).toEqual(['queued']);
  });

  it('every active state may be cancelled, time out, fail or be re-queued (infra recovery)', () => {
    for (const s of ACTIVE_TASK_STATUSES) {
      for (const to of ['cancelled', 'timed_out', 'failed', 'queued'] as const) {
        expect(canTransition(s, to), key(s, to)).toBe(true);
      }
    }
  });

  it('only reviewing reaches completed', () => {
    const sources = TASK_STATUSES.filter((s) => canTransition(s, 'completed'));
    expect(sources).toEqual(['reviewing']);
  });

  it('transition table is frozen', () => {
    expect(Object.isFrozen(TASK_TRANSITIONS)).toBe(true);
    expect(Object.isFrozen(TASK_TRANSITIONS.created)).toBe(true);
  });

  it('classifies active and settled statuses', () => {
    for (const s of TASK_STATUSES) {
      expect(isActiveStatus(s)).toBe((ACTIVE_TASK_STATUSES as readonly string[]).includes(s));
      expect(isSettledStatus(s)).toBe((SETTLED_TASK_STATUSES as readonly string[]).includes(s));
    }
    expect(isActiveStatus('created')).toBe(false);
    expect(isSettledStatus('queued')).toBe(false);
  });

  it('maps settled task statuses to attempt statuses', () => {
    expect(attemptStatusForSettled('completed')).toBe('succeeded');
    expect(attemptStatusForSettled('failed')).toBe('failed');
    expect(attemptStatusForSettled('timed_out')).toBe('timed_out');
    expect(attemptStatusForSettled('cancelled')).toBe('cancelled');
    expect(attemptStatusForSettled('blocked')).toBe('blocked');
  });
});
