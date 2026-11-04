// Test ProcessLauncher (local spawn via spawnSupervised) that also emulates the runner's lease rules:
// one live lease per key, spawn cwd inside a leased path, release kills every process of the lease.
import { isAbsolute, relative, resolve } from 'node:path';
import { OrcError, cryptoIdGenerator } from '@orc/shared';
import { isProcessAlive, spawnSupervised } from '@orc/shared/node';
import type {
  KillResult,
  LaunchLease,
  LaunchLeaseRequest,
  LaunchSpec,
  LeaseInfo,
  ProcessLauncher,
  SupervisedProcess,
} from '@orc/shared/node';

export interface LeaseRecord {
  id: string;
  key: string;
  paths: readonly string[];
  released: boolean;
  pids: number[];
}

export interface SpawnRecord {
  leaseKey: string;
  spec: LaunchSpec;
  pid: number;
  /** Set from the child's own exit event (a PID probe can hit a reused PID on Windows). */
  exited: boolean;
}

export interface TestLauncher extends ProcessLauncher {
  readonly leases: LeaseRecord[];
  readonly spawns: SpawnRecord[];
  /** PIDs spawned through this launcher that are still alive. */
  alivePids(): number[];
}

function within(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  const norm = process.platform === 'win32' ? rel.toLowerCase() : rel;
  return norm === '' || (!norm.startsWith('..') && !isAbsolute(norm));
}

const NO_KILL: KillResult = { graceful: true, forced: false, survivors: [], durationMs: 0 };

export function createTestLauncher(opts: { mode?: 'local' | 'runner' } = {}): TestLauncher {
  const leases: LeaseRecord[] = [];
  const spawns: SpawnRecord[] = [];
  const procs = new Map<string, SupervisedProcess[]>();

  async function stopAll(leaseId: string): Promise<KillResult> {
    const list = procs.get(leaseId) ?? [];
    procs.delete(leaseId);
    let result = NO_KILL;
    for (const p of list) {
      if (!isProcessAlive(p.pid)) continue;
      result = await p.stop({ graceMs: 500 });
      await Promise.race([p.exited, new Promise((r) => setTimeout(r, 2000))]);
    }
    return result;
  }

  const launcher: TestLauncher = {
    mode: opts.mode ?? 'local',
    leases,
    spawns,
    acquire(request: LaunchLeaseRequest): Promise<LaunchLease> {
      if (leases.some((l) => l.key === request.key && !l.released)) {
        return Promise.reject(
          new OrcError('process_spawn_failed', `lease ${request.key} is busy`, { details: { reason: 'busy' } }),
        );
      }
      const record: LeaseRecord = {
        id: cryptoIdGenerator.uuid(),
        key: request.key,
        paths: [...request.paths],
        released: false,
        pids: [],
      };
      leases.push(record);
      const lease: LaunchLease = {
        id: record.id,
        key: record.key,
        uid: null,
        renew: () => (record.released ? Promise.reject(new Error('lease expired')) : Promise.resolve()),
        measure: () => Promise.resolve({ bytes: 0, entries: 0, truncated: false }),
        async release() {
          const kill = await stopAll(record.id);
          record.released = true;
          return { kill, reclaimed: true };
        },
      };
      return Promise.resolve(lease);
    },
    spawn(lease: LaunchLease, spec: LaunchSpec): Promise<SupervisedProcess> {
      const record = leases.find((l) => l.id === lease.id);
      if (!record || record.released) {
        return Promise.reject(new OrcError('process_spawn_failed', 'unknown or released lease'));
      }
      if (!record.paths.some((p) => within(p, spec.cwd))) {
        return Promise.reject(new OrcError('process_spawn_failed', 'cwd outside the leased paths'));
      }
      try {
        const proc = spawnSupervised(spec.cmd, spec.args, { cwd: spec.cwd, env: spec.env });
        record.pids.push(proc.pid);
        const spawned: SpawnRecord = { leaseKey: record.key, spec, pid: proc.pid, exited: false };
        spawns.push(spawned);
        void proc.exited.then(() => {
          spawned.exited = true;
        });
        const list = procs.get(record.id) ?? [];
        list.push(proc);
        procs.set(record.id, list);
        return Promise.resolve(proc);
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },
    listLeases(): Promise<LeaseInfo[]> {
      return Promise.resolve(
        leases
          .filter((l) => !l.released)
          .map((l) => ({
            id: l.id,
            key: l.key,
            attemptId: null,
            workerId: 'test',
            uid: null,
            pids: [...l.pids],
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          })),
      );
    },
    async close() {
      for (const l of leases) {
        if (!l.released) {
          await stopAll(l.id);
          l.released = true;
        }
      }
    },
    alivePids() {
      return spawns.filter((s) => !s.exited).map((s) => s.pid);
    },
  };
  return launcher;
}
