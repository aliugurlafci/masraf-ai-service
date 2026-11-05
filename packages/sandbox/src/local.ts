// SANDBOX_MODE=local (development/test hosts incl. win32; contract §10.11): same interface as the
// runner client, current user, no isolation. Requests get the runner's key, path, cwd, env-key and
// argv checks, with one deliberate exception: the lease-containment check for path-valued env
// (`validateSpawnEnvPaths`) is not applied. CBM_RUNTIME_DIR is only checked for kind (`mcp`) and for
// being absolute, because local mode uses a per-cache temp dir outside the lease (ADR-0032).
// `credentialFd` gets the runner's rules (`validateSpawnCredential`, ADR-0036 m.4).
import { spawn as nodeSpawn } from 'node:child_process';
import { realpath as fsRealpath } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@orc/logger';
import { assertSafeArgv, WINDOWS_BASE_ENV } from '@orc/security';
import { cryptoIdGenerator, isOrcError } from '@orc/shared';
import {
  spawnSupervised,
  type HostPlatform,
  type KillResult,
  type LaunchLease,
  type LaunchLeaseRequest,
  type LaunchSpec,
  type LeaseInfo,
  type LeaseMeasurement,
  type SpawnFn,
  type SupervisedProcess,
} from '@orc/shared/node';
import type { ReleaseOutcome, SandboxLauncher } from './client';
import { busyError, leaseExpiredError, runnerError } from './errors';
import { measureTree } from './fs-walk';
import { MAX_LEASE_PATHS } from './protocol';
import {
  pathsOverlap,
  resolveInLease,
  validateLeaseKey,
  validateSpawnArgv,
  validateSpawnCredential,
  validateSpawnEnv,
} from './validation';

export interface LocalLauncherOptions {
  platform?: HostPlatform;
  spawn?: SpawnFn;
  /** Grace period of the per-process stop on release (default 10000). */
  killGraceMs?: number;
  /** Only reported in `expiresAt`; local leases are never fenced (default 40000). */
  leaseTtlMs?: number;
  now?: () => number;
  newId?: () => string;
  realpath?: (p: string) => Promise<string>;
  logger?: Logger;
}

export interface LocalLauncher extends SandboxLauncher {
  readonly mode: 'local';
}

interface LocalLeaseRecord {
  info: Omit<LeaseInfo, 'pids' | 'expiresAt'>;
  paths: string[];
  expiresAt: number;
  sessions: Map<number, SupervisedProcess>;
  releasing: Promise<ReleaseOutcome> | null;
  released: boolean;
}

const hostPlatform = (): HostPlatform => (process.platform === 'win32' ? 'win32' : 'posix');

export function createLocalLauncher(o: LocalLauncherOptions = {}): LocalLauncher {
  const platform = o.platform ?? hostPlatform();
  const spawnFn = o.spawn ?? nodeSpawn;
  const killGraceMs = o.killGraceMs ?? 10_000;
  const ttl = o.leaseTtlMs ?? 40_000;
  const now = o.now ?? Date.now;
  const newId = o.newId ?? (() => cryptoIdGenerator.uuid());
  const realpath = o.realpath ?? ((p: string) => fsRealpath(p));
  const leases = new Map<string, LocalLeaseRecord>();
  let closed = false;

  const ensureOpen = (): void => {
    if (closed) throw runnerError('process_spawn_failed', 'closed', 'Launcher is closed');
  };

  const infoOf = (r: LocalLeaseRecord): LeaseInfo => ({
    ...r.info,
    pids: [...r.sessions.keys()].sort((a, b) => a - b),
    expiresAt: new Date(r.expiresAt).toISOString(),
  });

  const live = (id: string): LocalLeaseRecord => {
    const r = leases.get(id);
    if (r === undefined || r.released || r.releasing !== null) throw leaseExpiredError();
    return r;
  };

  const doRelease = async (r: LocalLeaseRecord): Promise<ReleaseOutcome> => {
    const started = now();
    const results = await Promise.all(
      [...r.sessions.values()].map((p) =>
        p.stop({ graceMs: killGraceMs }).catch((): KillResult => ({
          graceful: false,
          forced: true,
          survivors: [p.pid],
          durationMs: 0,
        })),
      ),
    );
    const kill: KillResult = {
      graceful: results.every((x) => x.graceful),
      forced: results.some((x) => x.forced),
      survivors: results.flatMap((x) => x.survivors),
      durationMs: Math.max(0, now() - started),
    };
    r.released = true;
    leases.delete(r.info.id);
    if (kill.survivors.length > 0) {
      o.logger?.error(
        { leaseId: r.info.id, survivors: kill.survivors },
        'local lease release left survivors',
      );
    }
    return { kill, reclaimed: true };
  };

  const releaseRecord = (r: LocalLeaseRecord): Promise<ReleaseOutcome> => {
    r.releasing ??= doRelease(r);
    return r.releasing;
  };

  const releaseLease = (id: string): Promise<ReleaseOutcome> => {
    const r = leases.get(id);
    if (r === undefined) {
      return Promise.resolve({
        kill: { graceful: true, forced: false, survivors: [], durationMs: 0 },
        reclaimed: true,
      });
    }
    return releaseRecord(r);
  };

  class LocalLease implements LaunchLease {
    readonly id: string;
    readonly key: string;
    readonly uid = null;
    private readonly record: LocalLeaseRecord;

    constructor(record: LocalLeaseRecord) {
      this.record = record;
      this.id = record.info.id;
      this.key = record.info.key;
    }

    renew(): Promise<void> {
      try {
        live(this.id).expiresAt = now() + ttl;
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : leaseExpiredError());
      }
    }

    async measure(target: string, maxEntries: number): Promise<LeaseMeasurement> {
      const r = live(this.id);
      const real = await resolveInLease(target, r.paths, realpath, 'path_rejected');
      return measureTree(real, maxEntries);
    }

    release(): Promise<ReleaseOutcome> {
      return releaseRecord(this.record);
    }
  }

  return {
    mode: 'local',
    async acquire(req: LaunchLeaseRequest) {
      ensureOpen();
      validateLeaseKey(req.key);
      if (req.paths.length < 1 || req.paths.length > MAX_LEASE_PATHS) {
        throw runnerError(
          'path_escape',
          'path_rejected',
          `A lease needs 1..${MAX_LEASE_PATHS} paths`,
        );
      }
      const paths: string[] = [];
      for (const p of req.paths) {
        if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) {
          throw runnerError('path_escape', 'path_rejected', 'Lease path must be absolute');
        }
        try {
          paths.push(await realpath(p));
        } catch (e) {
          throw runnerError('path_escape', 'path_rejected', 'Lease path does not exist', e);
        }
      }
      // Same rule as the runner (resolveLeasePaths): a request's own paths must not overlap.
      for (let i = 0; i < paths.length; i++) {
        for (let j = i + 1; j < paths.length; j++) {
          if (pathsOverlap(paths[i] as string, paths[j] as string)) {
            throw runnerError(
              'path_escape',
              'path_rejected',
              'Lease paths must not overlap each other',
            );
          }
        }
      }
      ensureOpen();
      for (const r of leases.values()) {
        if (r.info.key === req.key) throw busyError('A lease with this key is still held');
        if (paths.some((p) => r.paths.some((q) => pathsOverlap(p, q)))) {
          throw busyError('Lease paths overlap a live lease');
        }
      }
      const record: LocalLeaseRecord = {
        info: {
          id: newId(),
          key: req.key,
          attemptId: req.attemptId,
          workerId: req.workerId,
          uid: null,
        },
        paths,
        expiresAt: now() + ttl,
        sessions: new Map(),
        releasing: null,
        released: false,
      };
      leases.set(record.info.id, record);
      return new LocalLease(record);
    },
    async spawn(lease: LaunchLease, spec: LaunchSpec) {
      ensureOpen();
      const r = live(lease.id);
      const argv = [spec.cmd, ...spec.args];
      validateSpawnArgv(argv);
      if (platform === 'win32') {
        try {
          assertSafeArgv(argv, { platform: 'win32' });
        } catch (e) {
          throw runnerError(
            'unsafe_argument',
            'argv_rejected',
            isOrcError(e) ? e.message : 'Unsafe argv',
            e,
          );
        }
      }
      validateSpawnEnv(spec.kind, spec.env, platform === 'win32' ? WINDOWS_BASE_ENV : []);
      validateSpawnCredential(spec.kind, spec.env, spec.credentialFd);
      const cwd = await resolveInLease(spec.cwd, r.paths, realpath, 'cwd_rejected');
      live(lease.id);
      const proc = spawnSupervised(spec.cmd, spec.args, {
        cwd,
        env: { ...spec.env },
        spawn: spawnFn,
        platform,
        // ADR-0036 m.4: fd 3 pipe, POSIX only (spawnSupervised rejects it on win32); never logged.
        ...(spec.credentialFd === undefined ? {} : { credentialFd: spec.credentialFd }),
      });
      r.sessions.set(proc.pid, proc);
      void proc.exited.then(() => {
        r.sessions.delete(proc.pid);
      });
      return proc;
    },
    listLeases() {
      return Promise.resolve([...leases.values()].map(infoOf));
    },
    releaseLease,
    async close() {
      closed = true;
      await Promise.allSettled([...leases.values()].map((r) => releaseRecord(r)));
    },
  };
}
