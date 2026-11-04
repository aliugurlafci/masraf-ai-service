// Runner-side lease management (contract §10.11 items 2, 3, 5, 6). All privileged operations
// (chown/chmod, uid-wide kill, uid-switching spawn, state files) are injected so the logic is
// unit-testable without root.
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { realpath as fsRealpath } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@orc/logger';
import { cryptoIdGenerator, isOrcError, type Uuid } from '@orc/shared';
import {
  spawnSupervised,
  type KillResult,
  type LaunchKind,
  type LaunchLimits,
  type LeaseInfo,
  type LeaseMeasurement,
  type SpawnFn,
  type SupervisedProcess,
} from '@orc/shared/node';
import { busyError, leaseExpiredError, runnerError } from './errors';
import {
  chownTree,
  handoffMode,
  measureTree,
  nodeWalkFs,
  reclaimMode,
  type WalkFs,
} from './fs-walk';
import { killUidProcesses, type ProcessTable } from './proc-scan';
import type { LeaseState, LeaseStateStore } from './state-store';
import {
  buildPrlimitCommand,
  effectiveLimits,
  isPathInside,
  pathsOverlap,
  resolveInLease,
  resolveLeasePaths,
  validateLeaseKey,
  validateSpawnArgv,
  validateSpawnEnv,
  validateSpawnEnvPaths,
  type EffectiveLimits,
} from './validation';

/** `switch`: children run under the lease uid, paths are re-owned, release kills uid-wide. */
export type IdentityMode = 'switch' | 'none';

export interface LaunchProcessOptions {
  cwd: string;
  env: Record<string, string>;
  uid: number | null;
  gid: number | null;
}
export type LaunchProcessFn = (
  cmd: string,
  args: readonly string[],
  opts: LaunchProcessOptions,
) => SupervisedProcess;

/** Wraps a spawn function so every child gets `uid`/`gid` (libuv also drops supplementary groups). */
export function spawnAs(base: SpawnFn, uid: number, gid: number): SpawnFn {
  const wrapped = (cmd: string, args: readonly string[], options: SpawnOptions) =>
    base(cmd, args, { ...options, uid, gid });
  return wrapped as unknown as SpawnFn;
}

/** `spawnSupervised` (detached process group, shell:false) with the lease identity applied. */
export function createDefaultLaunch(spawnFn: SpawnFn = nodeSpawn): LaunchProcessFn {
  return (cmd, args, o) =>
    spawnSupervised(cmd, args, {
      cwd: o.cwd,
      env: o.env,
      platform: 'posix',
      spawn: o.uid === null ? spawnFn : spawnAs(spawnFn, o.uid, o.gid ?? o.uid),
    });
}

export interface ReleaseResult {
  kill: KillResult;
  reclaimed: boolean;
}

export interface AcquireInput {
  key: string;
  attemptId: Uuid | null;
  workerId: string;
  paths: readonly string[];
}

export interface SpawnInput {
  kind: LaunchKind;
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  limits?: LaunchLimits;
}

export interface LeaseManagerOptions {
  /** WORKSPACES_ROOT, CLAUDE_HOME_ROOT, CBM_CACHE_DIR. */
  roots: readonly string[];
  /** Roots whose `<root>/probe` dir may be leased (CLAUDE_HOME_ROOT, CBM_CACHE_DIR); default: every root. */
  probeRoots?: readonly string[];
  workerUid: number;
  workerGid: number;
  uidBase: number;
  maxLeases: number;
  leaseTtlMs: number;
  killGraceMs: number;
  /** Ceilings from RUNNER_NPROC / RUNNER_NOFILE / RUNNER_FSIZE_BYTES. */
  limits: EffectiveLimits;
  identity: IdentityMode;
  /** Absolute path of util-linux prlimit; null => children are not wrapped (hosts without it). */
  prlimitPath: string | null;
  logger: Logger;
  stateStore: LeaseStateStore;
  /** Required when identity is `switch`. */
  processTable?: ProcessTable;
  fs?: WalkFs;
  launch?: LaunchProcessFn;
  realpath?: (p: string) => Promise<string>;
  realpathWithin?: (root: string, ...segments: string[]) => Promise<string>;
  now?: () => number;
  newId?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** Reaper period; default min(5000, leaseTtlMs / 4). */
  reapIntervalMs?: number;
  /** Maximum SIGKILL phase of a uid-wide kill (default 5000). */
  killForceWaitMs?: number;
}

export interface RecoveryReport {
  released: number;
  failed: number;
  invalidStateFiles: number;
  strayProcessesKilled: number;
}

export interface LeaseManager {
  acquire(input: AcquireInput): Promise<LeaseInfo>;
  renew(id: string): Promise<{ expiresAt: string }>;
  release(id: string): Promise<ReleaseResult>;
  measure(id: string, target: string, maxEntries: number): Promise<LeaseMeasurement>;
  list(): LeaseInfo[];
  spawn(id: string, input: SpawnInput): Promise<{ proc: SupervisedProcess; uid: number | null }>;
  /** Startup: releases every persisted lease (previous runner instance) and stray sandbox processes. */
  recoverStale(): Promise<RecoveryReport>;
  /** Releases expired leases and retries failed releases (runner-side fencing). */
  reapExpired(): Promise<void>;
  startReaper(): void;
  /** Stops the reaper and releases every lease. */
  close(): Promise<void>;
}

type LeaseRecordState = 'acquiring' | 'live' | 'releasing' | 'release_failed';

interface LeaseRecord {
  id: string;
  key: string;
  attemptId: Uuid | null;
  workerId: string;
  uid: number;
  gid: number;
  paths: string[];
  acquiredAt: number;
  expiresAt: number;
  state: LeaseRecordState;
  sessions: Map<number, SupervisedProcess>;
  releasing: Promise<ReleaseResult> | null;
}

const noKill = (): KillResult => ({ graceful: true, forced: false, survivors: [], durationMs: 0 });

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createLeaseManager(o: LeaseManagerOptions): LeaseManager {
  if (o.identity === 'switch' && o.processTable === undefined) {
    throw new Error('processTable is required when identity is switch');
  }
  const fs = o.fs ?? nodeWalkFs;
  const realpath = o.realpath ?? ((p: string) => fsRealpath(p));
  const launch = o.launch ?? createDefaultLaunch();
  const now = o.now ?? Date.now;
  const newId = o.newId ?? (() => cryptoIdGenerator.uuid());
  const sleep = o.sleep ?? defaultSleep;
  const log = o.logger;
  const switching = o.identity === 'switch';
  const records = new Map<string, LeaseRecord>();
  const reapIntervalMs =
    o.reapIntervalMs ?? Math.max(50, Math.min(5000, Math.floor(o.leaseTtlMs / 4)));
  let reaper: NodeJS.Timeout | null = null;
  let reaping = false;
  let closed = false;
  let nextUidIndex = 0;

  const iso = (ms: number): string => new Date(ms).toISOString();

  const ensureOpen = (): void => {
    if (closed) throw runnerError('process_spawn_failed', 'closed', 'Runner is shutting down');
  };

  const infoOf = (r: LeaseRecord): LeaseInfo => ({
    id: r.id,
    key: r.key,
    attemptId: r.attemptId,
    workerId: r.workerId,
    uid: switching ? r.uid : null,
    pids: [...r.sessions.keys()].sort((a, b) => a - b),
    expiresAt: iso(r.expiresAt),
  });

  const allocateUid = (): number | null => {
    const used = new Set([...records.values()].map((r) => r.uid));
    for (let i = 0; i < o.maxLeases; i++) {
      const index = (nextUidIndex + i) % o.maxLeases;
      const uid = o.uidBase + index;
      if (!used.has(uid)) {
        nextUidIndex = (index + 1) % o.maxLeases;
        return uid;
      }
    }
    return null;
  };

  const killUid = (uid: number, graceMs: number): Promise<KillResult> =>
    killUidProcesses(uid, o.processTable as ProcessTable, {
      graceMs,
      forceWaitMs: o.killForceWaitMs,
      now,
      sleep,
    });

  const walk = (paths: readonly string[], toLease: LeaseRecord | null): Promise<void> =>
    paths.reduce<Promise<void>>(
      (prev, p) =>
        prev.then(async () => {
          await chownTree(
            p,
            toLease === null
              ? { uid: o.workerUid, gid: o.workerGid, mode: reclaimMode, apply: switching }
              : { uid: toLease.uid, gid: toLease.gid, mode: handoffMode, apply: switching },
            fs,
          );
        }),
      Promise.resolve(),
    );

  const stopSessions = async (r: LeaseRecord): Promise<KillResult> => {
    const started = now();
    const results = await Promise.all(
      [...r.sessions.values()].map((p) =>
        p.stop({ graceMs: o.killGraceMs }).catch((): KillResult => ({
          graceful: false,
          forced: true,
          survivors: [p.pid],
          durationMs: 0,
        })),
      ),
    );
    return {
      graceful: results.every((x) => x.graceful),
      forced: results.some((x) => x.forced),
      survivors: results.flatMap((x) => x.survivors),
      durationMs: Math.max(0, now() - started),
    };
  };

  const doRelease = async (r: LeaseRecord): Promise<ReleaseResult> => {
    r.state = 'releasing';
    let kill: KillResult;
    try {
      kill = switching ? await killUid(r.uid, o.killGraceMs) : await stopSessions(r);
    } catch (e) {
      r.state = 'release_failed';
      log.error({ err: e, leaseId: r.id, key: r.key }, 'lease release: kill failed');
      return { kill: { ...noKill(), graceful: false }, reclaimed: false };
    }
    if (kill.survivors.length > 0) {
      r.state = 'release_failed';
      log.error(
        { leaseId: r.id, key: r.key, uid: r.uid, survivors: kill.survivors },
        'lease release: processes survived the kill',
      );
      return { kill, reclaimed: false };
    }
    try {
      await walk(r.paths, null);
      await o.stateStore.remove(r.id);
    } catch (e) {
      r.state = 'release_failed';
      log.error({ err: e, leaseId: r.id, key: r.key }, 'lease release: reclaim failed');
      return { kill, reclaimed: false };
    }
    records.delete(r.id);
    log.info(
      { leaseId: r.id, key: r.key, uid: r.uid, forced: kill.forced },
      'lease released and paths reclaimed',
    );
    return { kill, reclaimed: true };
  };

  const release = (id: string): Promise<ReleaseResult> => {
    const r = records.get(id);
    if (r === undefined) return Promise.resolve({ kill: noKill(), reclaimed: true });
    if (r.state === 'acquiring') return Promise.reject(busyError('Lease is still being acquired'));
    if (r.releasing !== null) return r.releasing;
    const p = doRelease(r).finally(() => {
      r.releasing = null;
    });
    r.releasing = p;
    return p;
  };

  const liveRecord = (id: string): LeaseRecord => {
    const r = records.get(id);
    if (r === undefined || r.state !== 'live') throw leaseExpiredError();
    if (now() >= r.expiresAt) {
      release(id).catch((e: unknown) =>
        log.error({ err: e, leaseId: id }, 'expired lease release failed'),
      );
      throw leaseExpiredError();
    }
    return r;
  };

  const acquire = async (input: AcquireInput): Promise<LeaseInfo> => {
    ensureOpen();
    validateLeaseKey(input.key);
    const paths = await resolveLeasePaths(input.paths, o.roots, {
      realpath,
      ...(o.realpathWithin === undefined ? {} : { realpathWithin: o.realpathWithin }),
      ...(o.probeRoots === undefined ? {} : { probeRoots: o.probeRoots }),
    });
    ensureOpen();
    // From here to the registration below everything is synchronous: no interleaving acquire can
    // pass the overlap check for the same paths.
    for (const r of records.values()) {
      if (r.key === input.key) throw busyError('A lease with this key is still held');
      for (const p of paths) {
        if (r.paths.some((q) => pathsOverlap(p, q))) {
          throw busyError('Lease paths overlap a live lease');
        }
      }
    }
    const uid = allocateUid();
    if (uid === null) throw busyError('No free sandbox uid');
    const t = now();
    const r: LeaseRecord = {
      id: newId(),
      key: input.key,
      attemptId: input.attemptId,
      workerId: input.workerId,
      uid,
      gid: uid,
      paths,
      acquiredAt: t,
      expiresAt: t + o.leaseTtlMs,
      state: 'acquiring',
      sessions: new Map(),
      releasing: null,
    };
    records.set(r.id, r);
    try {
      if (switching) {
        const stray = await killUid(uid, 0);
        if (stray.survivors.length > 0) throw busyError('Sandbox uid still has processes');
        if (stray.forced) log.warn({ uid }, 'killed stray processes of a free sandbox uid');
      }
      const state: LeaseState = {
        v: 1,
        id: r.id,
        key: r.key,
        attemptId: r.attemptId,
        workerId: r.workerId,
        uid: r.uid,
        gid: r.gid,
        paths: r.paths,
        acquiredAt: iso(t),
      };
      await o.stateStore.write(state);
      await walk(r.paths, r);
    } catch (e) {
      r.state = 'releasing';
      try {
        await walk(r.paths, null);
        await o.stateStore.remove(r.id);
        records.delete(r.id);
      } catch (rollback) {
        r.state = 'release_failed';
        log.error({ err: rollback, leaseId: r.id, key: r.key }, 'lease acquire rollback failed');
      }
      if (isOrcError(e)) throw e;
      throw runnerError('process_spawn_failed', 'internal', 'Lease handoff failed', e);
    }
    r.state = 'live';
    r.expiresAt = now() + o.leaseTtlMs;
    if (closed) {
      // close() ran during the handoff and could not release a lease that was still acquiring.
      await release(r.id);
      ensureOpen();
    }
    log.info(
      { leaseId: r.id, key: r.key, uid: r.uid, workerId: r.workerId, paths: r.paths.length },
      'lease acquired',
    );
    return infoOf(r);
  };

  const spawn = async (
    id: string,
    input: SpawnInput,
  ): Promise<{ proc: SupervisedProcess; uid: number | null }> => {
    ensureOpen();
    const r = liveRecord(id);
    validateSpawnArgv(input.argv);
    validateSpawnEnv(input.kind, input.env);
    const cwd = await resolveInLease(input.cwd, r.paths, realpath, 'cwd_rejected');
    await validateSpawnEnvPaths(input.env, r.paths, realpath);
    liveRecord(id);
    const limits = effectiveLimits(input.limits, o.limits);
    const [exe, ...rest] = input.argv as [string, ...string[]];
    const { cmd, args } =
      o.prlimitPath === null
        ? { cmd: exe, args: rest }
        : buildPrlimitCommand(o.prlimitPath, limits, input.argv);
    let proc: SupervisedProcess;
    try {
      proc = launch(cmd, args, {
        cwd,
        env: { ...input.env },
        uid: switching ? r.uid : null,
        gid: switching ? r.gid : null,
      });
    } catch (e) {
      throw runnerError(
        'process_spawn_failed',
        'spawn_failed',
        `Failed to spawn ${path.basename(exe)}`,
        e,
      );
    }
    r.sessions.set(proc.pid, proc);
    void proc.exited.then(() => {
      r.sessions.delete(proc.pid);
    });
    log.info(
      {
        leaseId: r.id,
        key: r.key,
        kind: input.kind,
        pid: proc.pid,
        uid: switching ? r.uid : null,
        command: path.basename(exe),
      },
      'sandbox child spawned',
    );
    return { proc, uid: switching ? r.uid : null };
  };

  const measure = async (
    id: string,
    target: string,
    maxEntries: number,
  ): Promise<LeaseMeasurement> => {
    const r = liveRecord(id);
    const real = await resolveInLease(target, r.paths, realpath, 'path_rejected');
    return measureTree(real, maxEntries, fs);
  };

  const recoverStale = async (): Promise<RecoveryReport> => {
    const report: RecoveryReport = {
      released: 0,
      failed: 0,
      invalidStateFiles: 0,
      strayProcessesKilled: 0,
    };
    const realRoots = await Promise.all(
      o.roots.map(async (root) => {
        try {
          return [path.resolve(root), await realpath(root)];
        } catch {
          return [path.resolve(root)];
        }
      }),
    );
    const insideRoots = (p: string): boolean =>
      realRoots.flat().some((root) => isPathInside(root, p) && path.relative(root, p) !== '');
    const uidMax = o.uidBase + o.maxLeases - 1;
    for (const stored of await o.stateStore.list()) {
      const s = stored.state;
      if (s === null || s.uid < o.uidBase || s.uid > uidMax || records.has(s.id)) {
        report.invalidStateFiles++;
        log.warn({ leaseId: stored.id }, 'invalid lease state file removed');
        await o.stateStore.remove(stored.id);
        continue;
      }
      const paths = s.paths.filter((p) => {
        const ok = path.isAbsolute(p) && insideRoots(p);
        if (!ok) log.warn({ leaseId: s.id }, 'lease state path outside the runner roots ignored');
        return ok;
      });
      records.set(s.id, {
        id: s.id,
        key: s.key,
        attemptId: s.attemptId,
        workerId: s.workerId,
        uid: s.uid,
        gid: s.gid,
        paths,
        acquiredAt: Date.parse(s.acquiredAt),
        expiresAt: now(),
        state: 'release_failed',
        sessions: new Map(),
        releasing: null,
      });
    }
    for (const r of [...records.values()]) {
      if (r.state !== 'release_failed') continue;
      const result = await release(r.id);
      if (result.reclaimed) report.released++;
      else report.failed++;
    }
    if (switching) {
      const held = new Set([...records.values()].map((r) => r.uid));
      for (let uid = o.uidBase; uid <= uidMax; uid++) {
        if (held.has(uid)) continue;
        const k = await killUid(uid, 0);
        if (k.forced) {
          report.strayProcessesKilled++;
          log.warn({ uid, survivors: k.survivors }, 'stray sandbox processes killed at startup');
        }
      }
    }
    log.info(report, 'runner lease recovery finished');
    return report;
  };

  const reapExpired = async (): Promise<void> => {
    if (reaping) return;
    reaping = true;
    try {
      const t = now();
      // Expired live leases, failed releases (retried) and releases already in flight (awaited).
      const due = [...records.values()].filter(
        (r) =>
          r.releasing !== null ||
          (r.state === 'live' && t >= r.expiresAt) ||
          r.state === 'release_failed',
      );
      await Promise.all(
        due.map(async (r) => {
          if (r.state === 'live' && r.releasing === null) {
            log.warn(
              { leaseId: r.id, key: r.key, workerId: r.workerId },
              'lease expired; releasing',
            );
          }
          try {
            await release(r.id);
          } catch (e) {
            log.error({ err: e, leaseId: r.id }, 'lease reaper release failed');
          }
        }),
      );
    } finally {
      reaping = false;
    }
  };

  return {
    acquire,
    renew(id) {
      try {
        const r = liveRecord(id);
        r.expiresAt = now() + o.leaseTtlMs;
        return Promise.resolve({ expiresAt: iso(r.expiresAt) });
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : leaseExpiredError());
      }
    },
    release,
    measure,
    list: () => [...records.values()].filter((r) => r.state !== 'acquiring').map(infoOf),
    spawn,
    recoverStale,
    reapExpired,
    startReaper() {
      if (reaper !== null || closed) return;
      reaper = setInterval(() => {
        reapExpired().catch((e: unknown) => log.error({ err: e }, 'lease reaper failed'));
      }, reapIntervalMs);
      reaper.unref();
    },
    async close() {
      closed = true;
      if (reaper !== null) clearInterval(reaper);
      reaper = null;
      const results = await Promise.allSettled([...records.keys()].map((id) => release(id)));
      const failed = results.filter(
        (x) => x.status === 'rejected' || (x.status === 'fulfilled' && !x.value.reclaimed),
      ).length;
      if (failed > 0) log.error({ failed }, 'leases not fully released at shutdown');
    },
  };
}
