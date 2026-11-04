// Minimal local-mode ProcessLauncher for claude-runner tests (contract §10.11 SANDBOX_MODE=local):
// same interface as @orc/sandbox createLocalLauncher, current user, no isolation. Every spawn goes
// through @orc/shared/node spawnSupervised; release() force-kills every process of the lease.
import { randomUUID } from 'node:crypto';
import { toIso } from '@orc/shared';
import { spawnSupervised } from '@orc/shared/node';
import type {
  KillResult,
  LaunchLease,
  LaunchLeaseRequest,
  LaunchSpec,
  LeaseInfo,
  LeaseMeasurement,
  ProcessLauncher,
  SupervisedProcess,
} from '@orc/shared/node';

export interface TestLaunchRecord {
  leaseKey: string;
  spec: LaunchSpec;
  proc: SupervisedProcess;
}

export interface TestLocalLauncher extends ProcessLauncher {
  /** Every process spawned so far (spec as received, for argv/env assertions). */
  readonly launches: readonly TestLaunchRecord[];
}

interface LeaseState {
  info: LeaseInfo;
  procs: SupervisedProcess[];
  released: boolean;
}

export function createTestLocalLauncher(): TestLocalLauncher {
  const leases = new Map<string, LeaseState>();
  const launches: TestLaunchRecord[] = [];

  const release = async (state: LeaseState): Promise<{ kill: KillResult; reclaimed: boolean }> => {
    const started = Date.now();
    if (state.released) {
      return { kill: { graceful: true, forced: false, survivors: [], durationMs: 0 }, reclaimed: true };
    }
    state.released = true;
    leases.delete(state.info.id);
    const results = await Promise.all(state.procs.map((p) => p.stop({ graceMs: 0, forceImmediately: true })));
    return {
      kill: {
        graceful: results.every((r) => r.graceful),
        forced: results.some((r) => r.forced),
        survivors: results.flatMap((r) => r.survivors),
        durationMs: Date.now() - started,
      },
      reclaimed: true,
    };
  };

  return {
    mode: 'local',
    launches,
    acquire(request: LaunchLeaseRequest): Promise<LaunchLease> {
      for (const s of leases.values()) {
        if (s.info.key === request.key) {
          return Promise.reject(new Error(`lease key ${request.key} is busy`));
        }
      }
      const state: LeaseState = {
        info: {
          id: randomUUID(),
          key: request.key,
          attemptId: request.attemptId,
          workerId: request.workerId,
          uid: null,
          pids: [],
          expiresAt: toIso(new Date(Date.now() + 40_000)),
        },
        procs: [],
        released: false,
      };
      leases.set(state.info.id, state);
      const lease: LaunchLease = {
        id: state.info.id,
        key: request.key,
        uid: null,
        renew: () => (state.released ? Promise.reject(new Error('lease released')) : Promise.resolve()),
        measure: (): Promise<LeaseMeasurement> => Promise.resolve({ bytes: 0, entries: 0, truncated: false }),
        release: () => release(state),
      };
      return Promise.resolve(lease);
    },
    spawn(lease: LaunchLease, spec: LaunchSpec): Promise<SupervisedProcess> {
      const state = leases.get(lease.id);
      if (state === undefined || state.released) {
        return Promise.reject(new Error(`lease ${lease.key} is not live`));
      }
      try {
        const proc = spawnSupervised(spec.cmd, spec.args, { cwd: spec.cwd, env: spec.env });
        state.procs.push(proc);
        state.info.pids.push(proc.pid);
        launches.push({ leaseKey: lease.key, spec, proc });
        return Promise.resolve(proc);
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },
    listLeases: () => Promise.resolve([...leases.values()].map((s) => ({ ...s.info, pids: [...s.info.pids] }))),
    async close(): Promise<void> {
      await Promise.all([...leases.values()].map((s) => release(s)));
    },
  };
}
