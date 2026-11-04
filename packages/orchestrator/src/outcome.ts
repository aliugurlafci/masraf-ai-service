// Pure outcome / failure mappings of the pipeline (contract §5.2, §6.4, §13.2, §13.4, §13.5).
import { isOrcError } from '@orc/shared';
import type { ClaudeSessionStatus, FailureReason, SettledTaskStatus } from '@orc/shared';
import type { AbortReason, ClaudeOutcome } from '@orc/claude-runner';
import type { TestRunOutcome } from './types.js';

export type StageDecision =
  | { kind: 'continue' }
  | { kind: 'settle'; status: SettledTaskStatus; reason: FailureReason }
  | { kind: 'interrupt' };

/** §13.4: Claude outcome -> next pipeline step. `resume_failed` is handled by the caller (fallback run). */
export function mapClaudeOutcome(outcome: ClaudeOutcome, afterResumeFallback = false): StageDecision {
  switch (outcome) {
    case 'success':
      return { kind: 'continue' };
    case 'result_error':
      return { kind: 'settle', status: 'failed', reason: 'claude_result_error' };
    case 'budget_exceeded':
      return { kind: 'settle', status: 'failed', reason: 'budget_exceeded' };
    case 'exit_nonzero':
      return { kind: 'settle', status: 'failed', reason: afterResumeFallback ? 'claude_start_failed' : 'claude_exit_nonzero' };
    case 'protocol_error':
      return { kind: 'settle', status: 'failed', reason: 'claude_protocol_error' };
    case 'spawn_failed':
      return { kind: 'settle', status: 'failed', reason: 'claude_cli_unavailable' };
    case 'init_timeout':
    case 'resume_failed':
      return { kind: 'settle', status: 'failed', reason: 'claude_start_failed' };
    case 'security_violation':
      return { kind: 'settle', status: 'failed', reason: 'security_violation' };
    case 'output_limit':
      return { kind: 'settle', status: 'failed', reason: 'output_limit_exceeded' };
    case 'quota':
      return { kind: 'settle', status: 'failed', reason: 'disk_quota_exceeded' };
    case 'timeout':
      return { kind: 'settle', status: 'timed_out', reason: 'timeout' };
    case 'cancelled':
      return { kind: 'settle', status: 'cancelled', reason: 'cancelled_by_user' };
    case 'shutdown':
      return { kind: 'interrupt' };
  }
}

/** §13.4 third column. */
export function claudeSessionStatusFor(outcome: ClaudeOutcome): Extract<ClaudeSessionStatus, 'completed' | 'failed' | 'killed'> {
  switch (outcome) {
    case 'success':
      return 'completed';
    case 'result_error':
    case 'budget_exceeded':
    case 'exit_nonzero':
    case 'protocol_error':
    case 'spawn_failed':
    case 'resume_failed':
      return 'failed';
    case 'init_timeout':
    case 'security_violation':
    case 'output_limit':
    case 'quota':
    case 'timeout':
    case 'cancelled':
    case 'shutdown':
      return 'killed';
  }
}

/** Attempt controller abort reason -> settle (§5.4, §5.5, §10.8). `worker_shutdown` interrupts. */
export function mapAbortReason(reason: AbortReason): StageDecision {
  switch (reason) {
    case 'cancel':
      return { kind: 'settle', status: 'cancelled', reason: 'cancelled_by_user' };
    case 'timeout':
      return { kind: 'settle', status: 'timed_out', reason: 'timeout' };
    case 'quota':
      return { kind: 'settle', status: 'failed', reason: 'disk_quota_exceeded' };
    case 'output_limit':
      return { kind: 'settle', status: 'failed', reason: 'output_limit_exceeded' };
    case 'security_violation':
      return { kind: 'settle', status: 'failed', reason: 'security_violation' };
    case 'worker_shutdown':
      return { kind: 'interrupt' };
  }
}

/** §13.5: test outcome -> pending reason carried into reviewing (null => none). */
export function pendingTestReason(status: TestRunOutcome['status']): FailureReason | null {
  switch (status) {
    case 'passed':
    case 'cancelled':
      return null;
    case 'failed':
      return 'test_failed';
    case 'error':
      return 'test_command_error';
    case 'timed_out':
      return 'test_timeout';
  }
}

/** Errors the worker retries for DB_WRITE_RETRY_WINDOW_MS (§13.1). */
export function isTransientDbError(err: unknown): boolean {
  if (isOrcError(err)) return err.code === 'db_unavailable' || err.code === 'db_deadlock';
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  const number = (err as { number?: unknown }).number;
  return (
    code === 'ESOCKET' ||
    code === 'ETIMEOUT' ||
    code === 'ECONNCLOSED' ||
    code === 'ELOGIN' ||
    code === 'ENOTOPEN' ||
    code === 'ECONNRESET' ||
    number === 1205 ||
    number === 1222
  );
}

export type DeadLetterDecision = 'ignore' | 'dead_letter' | 'retry';

export const STALLED_LIMIT_TEXT = 'stalled more than allowable limit';

/** §6.4 step 6: what the QueueEvents 'failed' listener does with a failure. */
export function classifyJobFailure(i: {
  failedReason: string;
  attemptsMade: number | null;
  attempts: number | null;
  jobMissing: boolean;
}): DeadLetterDecision {
  if (i.failedReason.startsWith('business:')) return 'ignore';
  if (i.failedReason.startsWith('invalid:')) return 'dead_letter';
  if (i.failedReason.includes(STALLED_LIMIT_TEXT)) return 'dead_letter';
  if (i.jobMissing) return 'dead_letter';
  if (i.attemptsMade !== null && i.attemptsMade >= (i.attempts ?? 1)) return 'dead_letter';
  return 'retry';
}
