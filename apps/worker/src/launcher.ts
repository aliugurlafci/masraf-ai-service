// Runner-loss adapter (contract §10.11 item 5, §5.2): in SANDBOX_MODE=runner an unexpected runner disconnect or a
// runner restart during an attempt interrupts that attempt as `worker_lost` (infra recovery). The adapter maps every
// attempt lease (`attempt-<attemptId>`) to its attempt and reports the attempt as lost when
//  - a spawn connection of that lease drops before its `exit` frame (`RunnerClientOptions.onDisconnect`), or
//  - an acquire/spawn/measure for that lease fails because the runner is unreachable, closed the connection or no
//    longer knows the lease (a restarted runner released every lease at startup).
// A failed heartbeat renewal of the lease is mapped by the pipeline itself (`ActiveAttemptRegistry.markRunnerLost`).
import type { Logger } from '@orc/logger';
import type { RunnerDisconnectInfo, SandboxLauncher } from '@orc/sandbox';
import { isOrcError } from '@orc/shared';
import type { Uuid } from '@orc/shared';
import type {
  LaunchLease,
  LaunchLeaseRequest,
  LaunchSpec,
  LeaseMeasurement,
  SupervisedProcess,
} from '@orc/shared/node';

/** `details.reason` of runner client errors that mean the runner (not the request) failed. */
const RUNNER_LOSS_REASONS: ReadonlySet<string> = new Set([
  'runner_unavailable',
  'runner_disconnected',
  'lease_expired',
]);

export function isRunnerLossError(err: unknown): boolean {
  if (!isOrcError(err)) return false;
  const reason = err.details?.['reason'];
  return typeof reason === 'string' && RUNNER_LOSS_REASONS.has(reason);
}

export interface RunnerLossMonitorOptions {
  logger: Logger;
  /** Called once per detection; the worker aborts the attempt and the pipeline interrupts it as `worker_lost`. */
  onAttemptLost: (attemptId: Uuid, cause: 'disconnect' | 'runner_error') => void;
}

export interface RunnerLossMonitor {
  /** Wraps the runner client; leases acquired for an attempt are tracked until released. */
  wrap(launcher: SandboxLauncher): SandboxLauncher;
  /** `RunnerClientOptions.onDisconnect` (a spawn connection dropped before `exit`). */
  onDisconnect(info: RunnerDisconnectInfo): void;
  /** Attempt of a tracked live lease (tests, diagnostics). */
  attemptOf(leaseId: string): Uuid | null;
}

export function createRunnerLossMonitor(o: RunnerLossMonitorOptions): RunnerLossMonitor {
  const attemptByLease = new Map<string, Uuid>();
  let closing = false;

  const lost = (
    attemptId: Uuid | null | undefined,
    cause: 'disconnect' | 'runner_error',
    err?: unknown,
  ): void => {
    if (closing || attemptId === null || attemptId === undefined) return;
    o.logger.error(
      {
        attemptId,
        cause,
        ...(err === undefined ? {} : { reason: isOrcError(err) ? err.details?.['reason'] : null }),
      },
      'runner lost during an attempt: interrupting it as worker_lost',
    );
    try {
      o.onAttemptLost(attemptId, cause);
    } catch (e) {
      o.logger.error({ err: e, attemptId }, 'runner-loss handler failed');
    }
  };

  const guard = async <T>(attemptId: Uuid | null | undefined, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (isRunnerLossError(err)) lost(attemptId, 'runner_error', err);
      throw err;
    }
  };

  const trackedLease = (inner: LaunchLease, attemptId: Uuid): LaunchLease => ({
    get id() {
      return inner.id;
    },
    get key() {
      return inner.key;
    },
    get uid() {
      return inner.uid;
    },
    // Renewal failures are reported by the pipeline's heartbeat hook (it knows whether the lease is still in use).
    renew: () => inner.renew(),
    measure: (path: string, maxEntries: number): Promise<LeaseMeasurement> =>
      guard(attemptId, () => inner.measure(path, maxEntries)),
    async release() {
      try {
        return await inner.release();
      } finally {
        attemptByLease.delete(inner.id);
      }
    },
  });

  return {
    attemptOf: (leaseId) => attemptByLease.get(leaseId) ?? null,
    onDisconnect(info) {
      const attemptId = attemptByLease.get(info.leaseId);
      if (attemptId === undefined) {
        if (!closing)
          o.logger.warn(
            { leaseId: info.leaseId, pid: info.pid },
            'runner connection dropped (no attempt lease)',
          );
        return;
      }
      lost(attemptId, 'disconnect');
    },
    wrap(launcher) {
      return {
        get mode() {
          return launcher.mode;
        },
        async acquire(r: LaunchLeaseRequest) {
          const lease = await guard(r.attemptId, () => launcher.acquire(r));
          if (r.attemptId === null) return lease;
          attemptByLease.set(lease.id, r.attemptId);
          return trackedLease(lease, r.attemptId);
        },
        spawn(lease: LaunchLease, spec: LaunchSpec): Promise<SupervisedProcess> {
          return guard(attemptByLease.get(lease.id), () => launcher.spawn(lease, spec));
        },
        listLeases: () => launcher.listLeases(),
        async releaseLease(id) {
          try {
            return await launcher.releaseLease(id);
          } finally {
            attemptByLease.delete(id);
          }
        },
        close() {
          // Closing the client drops every session connection on purpose: not a runner loss.
          closing = true;
          return launcher.close();
        },
      };
    },
  };
}
