// Test doubles for @orc/sandbox (privileged operations, processes, sockets).
import { lstat, readdir } from 'node:fs/promises';
import { duplexPair, PassThrough, type Duplex } from 'node:stream';
import { createLogger, type Logger } from '@orc/logger';
import type { ProcessTable, KillSignal, WalkFs, LaunchProcessFn } from '@orc/sandbox';
import { spawnSupervised, type KillResult, type SupervisedProcess } from '@orc/shared/node';

export function silentLogger(): Logger {
  return createLogger({ service: 'test', level: 'silent', version: 'test', env: 'test' });
}

export interface FsCall {
  op: 'lchown' | 'chmod';
  path: string;
  uid?: number;
  gid?: number;
  mode?: number;
}

/** Real lstat/readdir, recorded (never executed) lchown/chmod. */
export function recordingFs(
  opts: { failLchownOn?: (p: string, uid: number) => boolean } = {},
): WalkFs & {
  calls: FsCall[];
} {
  const calls: FsCall[] = [];
  return {
    calls,
    lstat: (p) => lstat(p),
    readdir: (p) => readdir(p),
    lchown(p, uid, gid) {
      if (opts.failLchownOn?.(p, uid)) return Promise.reject(new Error('EPERM simulated'));
      calls.push({ op: 'lchown', path: p, uid, gid });
      return Promise.resolve();
    },
    chmod(p, mode) {
      calls.push({ op: 'chmod', path: p, mode });
      return Promise.resolve();
    },
  };
}

export interface FakeProcEntry {
  uid: number;
  /** Signals that terminate it (default both). */
  diesOn: KillSignal[];
}

/** In-memory process table: processes die on the configured signals. */
export function fakeProcessTable(): ProcessTable & {
  procs: Map<number, FakeProcEntry>;
  signals: { pid: number; signal: KillSignal }[];
  add(pid: number, uid: number, diesOn?: KillSignal[]): void;
} {
  const procs = new Map<number, FakeProcEntry>();
  const signals: { pid: number; signal: KillSignal }[] = [];
  return {
    procs,
    signals,
    add(pid, uid, diesOn = ['SIGTERM', 'SIGKILL']) {
      procs.set(pid, { uid, diesOn });
    },
    listByUid(uid) {
      return Promise.resolve(
        [...procs.entries()].filter(([, p]) => p.uid === uid).map(([pid]) => pid),
      );
    },
    signal(pid, signal) {
      signals.push({ pid, signal });
      const p = procs.get(pid);
      if (p?.diesOn.includes(signal)) procs.delete(pid);
    },
  };
}

/** SupervisedProcess double controlled by the test. */
export class FakeProcess implements SupervisedProcess {
  readonly pid: number;
  readonly pgid: number | null;
  readonly startedAt = new Date('2026-11-02T10:00:00.000Z');
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly exited: Promise<{ exitCode: number | null; signal: string | null }>;
  readonly stops: { graceMs: number; forceImmediately?: boolean }[] = [];
  private resolveExit: (v: { exitCode: number | null; signal: string | null }) => void = () =>
    undefined;

  constructor(pid: number) {
    this.pid = pid;
    this.pgid = pid;
    this.exited = new Promise((r) => {
      this.resolveExit = r;
    });
  }

  exit(exitCode: number | null, signal: string | null = null): void {
    this.stdout.end();
    this.stderr.end();
    this.resolveExit({ exitCode, signal });
  }

  stop(opts: { graceMs: number; forceImmediately?: boolean }): Promise<KillResult> {
    this.stops.push(opts);
    this.exit(null, 'SIGTERM');
    return Promise.resolve({ graceful: true, forced: false, survivors: [], durationMs: 1 });
  }
}

export interface LaunchCall {
  cmd: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  uid: number | null;
  gid: number | null;
}

export function fakeLaunch(): LaunchProcessFn & { calls: LaunchCall[]; procs: FakeProcess[] } {
  const calls: LaunchCall[] = [];
  const procs: FakeProcess[] = [];
  let nextPid = 4000;
  const fn: LaunchProcessFn = (cmd, args, o) => {
    calls.push({ cmd, args, ...o });
    const p = new FakeProcess(nextPid++);
    procs.push(p);
    return p;
  };
  return Object.assign(fn, { calls, procs });
}

/**
 * Real child process (spawnSupervised streams) whose `stop` signals only the leader and waits for
 * its exit. Avoids the slow win32 tree snapshot in client/server unit tests; tree kill itself is
 * covered by @orc/shared tests.
 */
export const leaderOnlyLaunch: LaunchProcessFn = (cmd, args, o) => {
  const p = spawnSupervised(cmd, args, { cwd: o.cwd, env: o.env });
  let exitedFlag = false;
  void p.exited.then(() => {
    exitedFlag = true;
  });
  let stopping: Promise<KillResult> | null = null;
  const stop = (opts: { graceMs: number; forceImmediately?: boolean }): Promise<KillResult> => {
    stopping ??= (async () => {
      const started = Date.now();
      if (exitedFlag) return { graceful: true, forced: false, survivors: [], durationMs: 0 };
      const force = opts.forceImmediately === true || opts.graceMs <= 0;
      try {
        process.kill(p.pid, force ? 'SIGKILL' : 'SIGTERM');
      } catch {
        // already gone
      }
      const graceEnd = Date.now() + Math.max(opts.graceMs, 0);
      while (!exitedFlag && Date.now() < graceEnd) await new Promise((r) => setTimeout(r, 20));
      let forced = force;
      if (!exitedFlag) {
        forced = true;
        try {
          process.kill(p.pid, 'SIGKILL');
        } catch {
          // already gone
        }
        await Promise.race([p.exited, new Promise((r) => setTimeout(r, 5000))]);
      }
      return {
        graceful: !forced,
        forced,
        survivors: exitedFlag ? [] : [p.pid],
        durationMs: Date.now() - started,
      };
    })();
    return stopping;
  };
  return {
    pid: p.pid,
    pgid: p.pgid,
    startedAt: p.startedAt,
    stdout: p.stdout,
    stderr: p.stderr,
    stdin: p.stdin,
    exited: p.exited,
    stop,
  };
};

/** Manual clock. */
export function manualClock(start = Date.parse('2026-11-02T10:00:00.000Z')): {
  now: () => number;
  advance(ms: number): void;
} {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
  };
}

/**
 * In-memory socket pair with net.Socket close semantics (allowHalfOpen false): when one side ends
 * or is destroyed, both sides are destroyed after pending data was delivered.
 */
export function socketPair(): [Duplex, Duplex] {
  const [a, b] = duplexPair();
  const link = (x: Duplex, y: Duplex): void => {
    x.on('end', () => {
      x.destroy();
      y.destroy();
    });
    x.on('close', () => {
      if (!y.destroyed) y.destroy();
    });
  };
  link(a, b);
  link(b, a);
  return [a, b];
}

export const waitFor = async (pred: () => boolean, ms = 5000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
};

export const ATTEMPT_ID = '0b6f1c2e-3d4a-4b5c-8d9e-0f1a2b3c4d5e';
export const ATTEMPT_ID_2 = '1c7a2d3f-4e5b-4c6d-9e0f-1a2b3c4d5e6f';
export const OP_ID = '2d8b3e4a-5f6c-4d7e-8f9a-2b3c4d5e6f7a';
