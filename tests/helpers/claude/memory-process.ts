// In-memory SupervisedProcess / ProcessLauncher for deterministic claude-runner unit tests
// (no real processes). The test drives stdout/stderr and exit; stop() records its options.
import { PassThrough, Writable } from 'node:stream';
import { createLogger } from '@orc/logger';
import type { Logger } from '@orc/logger';
import type {
  KillResult,
  LaunchLease,
  LaunchSpec,
  ProcessLauncher,
  SupervisedProcess,
} from '@orc/shared/node';

export interface MemoryProcess extends SupervisedProcess {
  readonly stdinText: () => string;
  readonly stdinEnded: () => boolean;
  readonly stops: { graceMs: number; forceImmediately?: boolean }[];
  writeStdout(text: string | Buffer): void;
  writeStderr(text: string | Buffer): void;
  line(obj: unknown): void;
  /** Ends both output streams and resolves `exited`. */
  exit(exitCode: number | null, signal?: string | null): void;
}

export interface MemoryProcessOptions {
  /** What stop() does: 'exit' (default) ends the process with SIGTERM/SIGKILL; 'survive' keeps it alive. */
  onStop?: 'exit' | 'survive';
  pid?: number;
}

let nextPid = 40_000;

export function createMemoryProcess(o: MemoryProcessOptions = {}): MemoryProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdinData = '';
  let ended = false;
  const stdin = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      stdinData += chunk.toString();
      cb();
    },
    final(cb) {
      ended = true;
      cb();
    },
  });
  let resolveExit!: (x: { exitCode: number | null; signal: string | null }) => void;
  const exited = new Promise<{ exitCode: number | null; signal: string | null }>((r) => {
    resolveExit = r;
  });
  let isExited = false;
  const pid = o.pid ?? nextPid++;
  const stops: { graceMs: number; forceImmediately?: boolean }[] = [];
  const doExit = (exitCode: number | null, signal: string | null = null): void => {
    if (isExited) return;
    isExited = true;
    stdout.end();
    stderr.end();
    resolveExit({ exitCode, signal });
  };
  const proc: MemoryProcess = {
    pid,
    pgid: process.platform === 'win32' ? null : pid,
    startedAt: new Date(),
    stdout,
    stderr,
    stdin,
    exited,
    stops,
    stdinText: () => stdinData,
    stdinEnded: () => ended,
    writeStdout: (t) => {
      stdout.write(t);
    },
    writeStderr: (t) => {
      stderr.write(t);
    },
    line: (obj) => {
      stdout.write(`${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`);
    },
    exit: doExit,
    stop(opts): Promise<KillResult> {
      stops.push(opts);
      const forced = opts.forceImmediately === true || opts.graceMs <= 0;
      if ((o.onStop ?? 'exit') === 'survive') {
        return Promise.resolve({ graceful: false, forced: true, survivors: isExited ? [] : [pid], durationMs: 1 });
      }
      const wasAlive = !isExited;
      doExit(null, forced ? 'SIGKILL' : 'SIGTERM');
      return Promise.resolve({ graceful: !forced, forced: forced && wasAlive, survivors: [], durationMs: 1 });
    },
  };
  return proc;
}

export interface MemoryLauncher extends ProcessLauncher {
  readonly specs: LaunchSpec[];
}

/** Launcher whose spawn() returns the processes produced by `factory` (or rejects with its error). */
export function createMemoryLauncher(factory: (spec: LaunchSpec) => SupervisedProcess | Error): MemoryLauncher {
  const specs: LaunchSpec[] = [];
  const lease: LaunchLease = {
    id: 'lease-1',
    key: 'attempt-test',
    uid: null,
    renew: () => Promise.resolve(),
    measure: () => Promise.resolve({ bytes: 0, entries: 0, truncated: false }),
    release: () =>
      Promise.resolve({ kill: { graceful: true, forced: false, survivors: [], durationMs: 0 }, reclaimed: true }),
  };
  return {
    mode: 'local',
    specs,
    acquire: () => Promise.resolve(lease),
    spawn(_lease, spec) {
      specs.push(spec);
      const p = factory(spec);
      return p instanceof Error ? Promise.reject(p) : Promise.resolve(p);
    },
    listLeases: () => Promise.resolve([]),
    close: () => Promise.resolve(),
  };
}

export const memoryLease: LaunchLease = {
  id: 'lease-mem',
  key: 'attempt-mem',
  uid: null,
  renew: () => Promise.resolve(),
  measure: () => Promise.resolve({ bytes: 0, entries: 0, truncated: false }),
  release: () =>
    Promise.resolve({ kill: { graceful: true, forced: false, survivors: [], durationMs: 0 }, reclaimed: true }),
};

/** Logger writing JSON lines into `lines` (assert that secrets never reach logs). */
export function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const logger = createLogger({ service: 'test', level: 'debug', version: 'test', env: 'test', destination });
  return { logger, lines };
}

export function silentLogger(): Logger {
  return createLogger({ service: 'test', level: 'silent', version: 'test', env: 'test' });
}
