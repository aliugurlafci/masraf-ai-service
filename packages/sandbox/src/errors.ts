// Runner error mapping between OrcError and protocol `error` frames.
import { isOrcError, OrcError, type ErrorCode } from '@orc/shared';
import { PROTOCOL_VERSION, type ErrorFrame } from './protocol';

/** Machine-readable `details.reason` values used by the runner protocol. */
export type RunnerErrorReason =
  | 'busy'
  | 'lease_expired'
  | 'protocol'
  | 'path_rejected'
  | 'cwd_rejected'
  | 'env_rejected'
  | 'argv_rejected'
  | 'spawn_failed'
  | 'runner_unavailable'
  | 'runner_disconnected'
  | 'closed'
  | 'internal';

export function runnerError(
  code: ErrorCode,
  reason: RunnerErrorReason,
  message: string,
  cause?: unknown,
): OrcError {
  return new OrcError(code, message, {
    details: { reason },
    ...(cause === undefined ? {} : { cause }),
  });
}

/** Lease overlap, duplicate key or exhausted uid pool (contract §2.2: worker backs off). */
export const busyError = (message: string): OrcError =>
  runnerError('process_spawn_failed', 'busy', message);

/** Unknown, expired or releasing lease (a rejected renewal => the worker interrupts the attempt as worker_lost). */
export const leaseExpiredError = (): OrcError =>
  runnerError('process_spawn_failed', 'lease_expired', 'Lease expired or unknown');

export const protocolError = (message: string, cause?: unknown): OrcError =>
  runnerError('validation_failed', 'protocol', message, cause);

const REASON_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Builds the `error` frame for any thrown value; messages of non-Orc errors are never echoed. */
export function toErrorFrame(e: unknown): ErrorFrame {
  if (isOrcError(e)) {
    const reason = e.details?.reason;
    return {
      v: PROTOCOL_VERSION,
      type: 'error',
      code: e.code,
      message: e.message.slice(0, 1024),
      ...(typeof reason === 'string' && REASON_RE.test(reason) ? { reason } : {}),
    };
  }
  return {
    v: PROTOCOL_VERSION,
    type: 'error',
    code: 'internal_error',
    message: 'Runner internal error',
    reason: 'internal',
  };
}

/** Rebuilds the OrcError carried by an `error` frame (client side). */
export function fromErrorFrame(f: ErrorFrame): OrcError {
  return new OrcError(f.code, f.message, {
    details: { reason: f.reason ?? 'internal', source: 'runner' },
  });
}
