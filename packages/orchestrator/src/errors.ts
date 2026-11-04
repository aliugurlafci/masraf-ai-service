// Internal control-flow errors of the attempt pipeline (never leave @orc/orchestrator).
import type { FailureReason, SettledTaskStatus } from '@orc/shared';
import type { AbortReason } from './types.js';

/** A stage decided the attempt's settled status. */
export class SettleSignal extends Error {
  readonly status: SettledTaskStatus;
  readonly reason: FailureReason;
  readonly detail: string | null;
  constructor(status: SettledTaskStatus, reason: FailureReason, detail: string | null = null) {
    super(`settle ${status} (${reason})`);
    this.name = 'SettleSignal';
    this.status = status;
    this.reason = reason;
    this.detail = detail;
  }
}

/** Another actor owns the task (§13.9) or the worker fenced itself (§13.1): no further DB writes. */
export class SupersededSignal extends Error {
  constructor(why: string) {
    super(`attempt superseded: ${why}`);
    this.name = 'SupersededSignal';
  }
}

/** The attempt controller was aborted (cancel, timeout, shutdown, quota, ...). */
export class AbortedSignal extends Error {
  readonly reason: AbortReason;
  constructor(reason: AbortReason) {
    super(`attempt aborted: ${reason}`);
    this.name = 'AbortedSignal';
    this.reason = reason;
  }
}

/** The workspace lock or the attempt lease stayed busy: hand the attempt back through infra recovery. */
export class WorkspaceBusySignal extends Error {
  constructor(what: string) {
    super(`${what} is held by another owner`);
    this.name = 'WorkspaceBusySignal';
  }
}
