// Stage outcome mapping (§13.4), abort/failure -> status mapping (§5.4, §5.5), test pending reasons (§13.5),
// retry/dead-letter classification (§6.4) and transient DB error detection (§13.1).
import { describe, expect, it } from 'vitest';
import { OrcError } from '@orc/shared';
import type { ClaudeOutcome } from '@orc/claude-runner';
import {
  classifyJobFailure,
  claudeSessionStatusFor,
  isTransientDbError,
  mapAbortReason,
  mapClaudeOutcome,
  pendingTestReason,
} from '@orc/orchestrator';

describe('mapClaudeOutcome (§13.4)', () => {
  const table: [ClaudeOutcome, ReturnType<typeof mapClaudeOutcome>][] = [
    ['success', { kind: 'continue' }],
    ['result_error', { kind: 'settle', status: 'failed', reason: 'claude_result_error' }],
    ['budget_exceeded', { kind: 'settle', status: 'failed', reason: 'budget_exceeded' }],
    ['exit_nonzero', { kind: 'settle', status: 'failed', reason: 'claude_exit_nonzero' }],
    ['protocol_error', { kind: 'settle', status: 'failed', reason: 'claude_protocol_error' }],
    ['spawn_failed', { kind: 'settle', status: 'failed', reason: 'claude_cli_unavailable' }],
    ['init_timeout', { kind: 'settle', status: 'failed', reason: 'claude_start_failed' }],
    ['resume_failed', { kind: 'settle', status: 'failed', reason: 'claude_start_failed' }],
    ['security_violation', { kind: 'settle', status: 'failed', reason: 'security_violation' }],
    ['output_limit', { kind: 'settle', status: 'failed', reason: 'output_limit_exceeded' }],
    ['quota', { kind: 'settle', status: 'failed', reason: 'disk_quota_exceeded' }],
    ['timeout', { kind: 'settle', status: 'timed_out', reason: 'timeout' }],
    ['cancelled', { kind: 'settle', status: 'cancelled', reason: 'cancelled_by_user' }],
    ['shutdown', { kind: 'interrupt' }],
  ];
  it.each(table)('%s', (outcome, expected) => {
    expect(mapClaudeOutcome(outcome)).toEqual(expected);
  });

  it('maps a failure of the resume fallback run to claude_start_failed', () => {
    expect(mapClaudeOutcome('exit_nonzero', true)).toEqual({
      kind: 'settle',
      status: 'failed',
      reason: 'claude_start_failed',
    });
  });

  it('records the ClaudeSessions status of every outcome', () => {
    expect(claudeSessionStatusFor('success')).toBe('completed');
    for (const o of ['result_error', 'budget_exceeded', 'exit_nonzero', 'protocol_error', 'spawn_failed', 'resume_failed'] as const) {
      expect(claudeSessionStatusFor(o)).toBe('failed');
    }
    for (const o of ['init_timeout', 'security_violation', 'output_limit', 'quota', 'timeout', 'cancelled', 'shutdown'] as const) {
      expect(claudeSessionStatusFor(o)).toBe('killed');
    }
  });
});

describe('mapAbortReason (§5.4, §5.5, §10.8)', () => {
  it('maps every attempt controller reason', () => {
    expect(mapAbortReason('cancel')).toEqual({ kind: 'settle', status: 'cancelled', reason: 'cancelled_by_user' });
    expect(mapAbortReason('timeout')).toEqual({ kind: 'settle', status: 'timed_out', reason: 'timeout' });
    expect(mapAbortReason('quota')).toEqual({ kind: 'settle', status: 'failed', reason: 'disk_quota_exceeded' });
    expect(mapAbortReason('output_limit')).toEqual({ kind: 'settle', status: 'failed', reason: 'output_limit_exceeded' });
    expect(mapAbortReason('security_violation')).toEqual({ kind: 'settle', status: 'failed', reason: 'security_violation' });
    expect(mapAbortReason('worker_shutdown')).toEqual({ kind: 'interrupt' });
  });
});

describe('pendingTestReason (§13.5)', () => {
  it('carries non-passing test runs into reviewing', () => {
    expect(pendingTestReason('passed')).toBeNull();
    expect(pendingTestReason('failed')).toBe('test_failed');
    expect(pendingTestReason('error')).toBe('test_command_error');
    expect(pendingTestReason('timed_out')).toBe('test_timeout');
    expect(pendingTestReason('cancelled')).toBeNull();
  });
});

describe('classifyJobFailure (§6.4 step 6)', () => {
  const base = { attemptsMade: 1, attempts: 3, jobMissing: false };
  it('ignores business failures (already recorded)', () => {
    expect(classifyJobFailure({ ...base, failedReason: 'business:claude_exit_nonzero', attemptsMade: 3 })).toBe('ignore');
  });
  it('dead-letters invalid payloads immediately', () => {
    expect(classifyJobFailure({ ...base, failedReason: 'invalid:taskId: Invalid' })).toBe('dead_letter');
  });
  it('dead-letters exhausted infra retries and lets BullMQ retry otherwise', () => {
    expect(classifyJobFailure({ ...base, failedReason: 'db down', attemptsMade: 2 })).toBe('retry');
    expect(classifyJobFailure({ ...base, failedReason: 'db down', attemptsMade: 3 })).toBe('dead_letter');
  });
  it('dead-letters stalled-limit failures and jobs that are already gone', () => {
    expect(classifyJobFailure({ ...base, failedReason: 'job stalled more than allowable limit' })).toBe('dead_letter');
    expect(classifyJobFailure({ failedReason: 'x', attemptsMade: null, attempts: null, jobMissing: true })).toBe('dead_letter');
  });
});

describe('isTransientDbError (§13.1)', () => {
  it('retries only dependency failures', () => {
    expect(isTransientDbError(new OrcError('db_unavailable'))).toBe(true);
    expect(isTransientDbError(new OrcError('db_deadlock'))).toBe(true);
    expect(isTransientDbError(Object.assign(new Error('socket'), { code: 'ESOCKET' }))).toBe(true);
    expect(isTransientDbError(Object.assign(new Error('deadlock'), { number: 1205 }))).toBe(true);
    expect(isTransientDbError(new OrcError('conflict'))).toBe(false);
    expect(isTransientDbError(new OrcError('precondition_failed'))).toBe(false);
    expect(isTransientDbError(new Error('boom'))).toBe(false);
  });
});
