// Process execution and tree-kill (contract §2.2, §10.7). Node-only.
// Every spawn: args array, shell:false, windowsHide; POSIX children get their own process group.
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { OrcError, type OrcErrorOptions } from '../errors';

export type SpawnFn = typeof nodeSpawn;
export type HostPlatform = 'posix' | 'win32';

export class ProcessSpawnError extends OrcError {
  constructor(message: string, options?: OrcErrorOptions) {
    super('process_spawn_failed', message, options);
  }
}

/** Survivors are listed in `details.survivors`. */
export class ProcessKillError extends OrcError {
  constructor(message: string, options?: OrcErrorOptions) {
    super('process_kill_failed', message, options);
  }
}

export interface KillResult {
  graceful: boolean;
  forced: boolean;
  survivors: number[];
  durationMs: number;
}

export interface RunProcessOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  stdin?: string | Uint8Array;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  killGraceMs: number;
  spawn?: SpawnFn;
  platform?: HostPlatform;
  onSpawn?(pid: number): void;
}

export interface RunProcessResult {
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  stdout: Buffer;
  stderr: Buffer;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  spawnError: NodeJS.ErrnoException | null;
  durationMs: number;
}

export interface SupervisedProcess {
  readonly pid: number;
  readonly pgid: number | null;
  readonly startedAt: Date;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  readonly stdin: NodeJS.WritableStream;
  readonly exited: Promise<{ exitCode: number | null; signal: string | null }>;
  /** graceful (SIGTERM to -pgid | taskkill /T) -> wait graceMs -> forced (SIGKILL -pgid | taskkill /T /F) -> verify. */
  stop(opts: { graceMs: number; forceImmediately?: boolean }): Promise<KillResult>;
}

export interface SpawnSupervisedOptions {
  cwd: string;
  env: Record<string, string>;
  spawn?: SpawnFn;
  platform?: HostPlatform;
  /**
   * Credential handed to the child on file descriptor 3 (ADR-0036; POSIX only, kind `claude`). The child is
   * spawned with `stdio: ['pipe','pipe','pipe','pipe']`; the value is written to `stdio[3]` and that pipe is
   * ended at once. The value never enters argv or env. Rejected on win32 (the fd path does not work there).
   */
  credentialFd?: string;
}

// ---- internals ------------------------------------------------------------------------------

export const MARKER_ENV = 'ORC_ATTEMPT_ID';
const POLL_MS = 200;
const FORCE_WAIT_MS = 5000;
const MARKER_RECHECK_MS = 1000;
const CLOSE_AFTER_EXIT_MS = 5000;
const HELPER_TIMEOUT_MS = 15_000;
const HELPER_MAX_OUTPUT = 8 * 1024 * 1024;
const WIN_SNAPSHOT_SCRIPT =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress';

export function hostPlatform(): HostPlatform {
  return process.platform === 'win32' ? 'win32' : 'posix';
}

export function errnoCode(e: unknown): string | undefined {
  return e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : undefined;
}

function toErrno(e: unknown): NodeJS.ErrnoException {
  return e instanceof Error ? e : new Error(String(e));
}

const MAX_TIMER_MS = 2_147_483_647;
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, Math.min(ms, MAX_TIMER_MS)));

async function waitUntil(
  pred: () => boolean,
  timeoutMs: number,
  everyMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return true;
    const left = deadline - Date.now();
    if (left <= 0) return pred();
    await sleep(Math.min(everyMs, left));
  }
}

class BoundedBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private readonly max: number;
  truncated = false;
  constructor(max: number) {
    this.max = max;
  }
  push(chunk: Buffer): void {
    const room = this.max - this.size;
    if (room <= 0) {
      if (chunk.length > 0) this.truncated = true;
      return;
    }
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.size += room;
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }
  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.size);
  }
}

/** Runs a fixed helper command (taskkill, tasklist, powershell) without a shell; never rejects. */
export function execHelper(
  spawnFn: SpawnFn,
  cmd: string,
  args: readonly string[],
  timeoutMs = HELPER_TIMEOUT_MS,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnFn(cmd, [...args], { shell: false, windowsHide: true });
    } catch {
      resolve({ code: null, stdout: '' });
      return;
    }
    const out = new BoundedBuffer(HELPER_MAX_OUTPUT);
    let done = false;
    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: out.toBuffer().toString('utf8') });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.resume();
    child.stdin.on('error', () => undefined);
    child.stdin.end();
    child.once('error', () => finish(null));
    child.once('close', (code) => finish(code));
  });
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errnoCode(e) === 'EPERM';
  }
}

/** POSIX: process.kill(-pgid, 0). */
export function isGroupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return errnoCode(e) === 'EPERM';
  }
}

function sendSignal(target: number, group: boolean, signal: NodeJS.Signals): void {
  try {
    process.kill(group ? -target : target, signal);
  } catch {
    // ESRCH (already gone) and EPERM are reported by the verification step.
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

/** Linux: pids whose /proc/<pid>/stat process group equals pgid. */
async function groupMembers(pgid: number, procRoot: string): Promise<number[]> {
  const members: number[] = [];
  let names: string[];
  try {
    names = await readdir(procRoot);
  } catch {
    return isGroupAlive(pgid) ? [pgid] : [];
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = await readFile(join(procRoot, name, 'stat'), 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === pgid) members.push(Number(name));
    } catch {
      // process exited while scanning
    }
  }
  return members;
}

/** Linux: value of `name` in /proc/<pid>/environ, or null. */
export async function readProcEnvVar(
  procRoot: string,
  pid: number,
  name: string,
): Promise<string | null> {
  try {
    const environ = await readFile(join(procRoot, String(pid), 'environ'), 'utf8');
    const prefix = `${name}=`;
    for (const entry of environ.split('\0')) {
      if (entry.startsWith(prefix)) return entry.slice(prefix.length);
    }
  } catch {
    // unreadable (other uid) or gone
  }
  return null;
}

/** Linux marker sweep: SIGKILL every process (except this one) whose environ carries ORC_ATTEMPT_ID=<id>. */
async function markerSweep(attemptId: string, procRoot: string): Promise<number[]> {
  const target = attemptId.toLowerCase();
  const scan = async (): Promise<number[]> => {
    let names: string[];
    try {
      names = await readdir(procRoot);
    } catch {
      return [];
    }
    const hits: number[] = [];
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (pid === process.pid) continue;
      const value = await readProcEnvVar(procRoot, pid, MARKER_ENV);
      if (value !== null && value.toLowerCase() === target) hits.push(pid);
    }
    return hits;
  };
  const first = await scan();
  if (first.length === 0) return [];
  for (const pid of first) sendSignal(pid, false, 'SIGKILL');
  await sleep(MARKER_RECHECK_MS);
  return (await scan()).filter((pid) => isProcessAlive(pid));
}

/** Windows: descendants of `pid` from a Win32_Process snapshot (fixed script, no interpolation). */
async function windowsDescendants(pid: number, spawnFn: SpawnFn): Promise<number[]> {
  const { stdout } = await execHelper(spawnFn, 'powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    WIN_SNAPSHOT_SCRIPT,
  ]);
  let rows: unknown;
  try {
    rows = JSON.parse(stdout.trim() || '[]');
  } catch {
    return [];
  }
  const list = Array.isArray(rows) ? (rows as unknown[]) : [rows];
  const children = new Map<number, number[]>();
  for (const row of list) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as { ProcessId?: unknown; ParentProcessId?: unknown };
    if (typeof r.ProcessId !== 'number' || typeof r.ParentProcessId !== 'number') continue;
    if (r.ProcessId === r.ParentProcessId) continue;
    const siblings = children.get(r.ParentProcessId) ?? [];
    siblings.push(r.ProcessId);
    children.set(r.ParentProcessId, siblings);
  }
  const out: number[] = [];
  const seen = new Set<number>([pid]);
  const queue = [pid];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const child of children.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

export interface KillTreeOptions {
  pgid: number | null;
  /** <= 0 => skip the graceful step. */
  graceMs: number;
  platform: HostPlatform;
  spawn: SpawnFn;
  /** Liveness of the leader when it is our own child (reaped pids must not be probed). */
  leaderAlive?: () => boolean;
  /** Linux: marker sweep for ORC_ATTEMPT_ID=<markerAttemptId> after the kill. */
  markerAttemptId?: string | null;
  procRoot?: string;
}

export async function killTree(pid: number, o: KillTreeOptions): Promise<KillResult> {
  const started = Date.now();
  const leaderAlive = o.leaderAlive ?? (() => isProcessAlive(pid));
  const elapsed = (): number => Date.now() - started;
  let graceful = false;
  let forced = false;
  let survivors: number[] = [];

  if (o.platform === 'posix') {
    const group = o.pgid !== null && o.pgid > 0;
    const target = group ? (o.pgid as number) : pid;
    const alive = (): boolean => leaderAlive() || (group && isGroupAlive(target));
    if (alive()) {
      if (o.graceMs > 0) {
        sendSignal(target, group, 'SIGTERM');
        graceful = await waitUntil(() => !alive(), o.graceMs, POLL_MS);
      }
      if (!graceful) {
        forced = true;
        sendSignal(target, group, 'SIGKILL');
        await waitUntil(() => !alive(), FORCE_WAIT_MS, 100);
      }
      if (leaderAlive()) survivors.push(pid);
      if (group && isGroupAlive(target)) {
        for (const m of await groupMembers(target, o.procRoot ?? '/proc')) {
          if (!survivors.includes(m)) survivors.push(m);
        }
      }
    } else {
      graceful = true;
    }
    const procRoot = o.procRoot ?? '/proc';
    if (o.markerAttemptId && process.platform === 'linux' && (await isDirectory(procRoot))) {
      for (const m of await markerSweep(o.markerAttemptId, procRoot)) {
        if (!survivors.includes(m)) survivors.push(m);
      }
    }
    return { graceful, forced, survivors, durationMs: elapsed() };
  }

  // win32
  const descendants = await windowsDescendants(pid, o.spawn);
  const anyAlive = (): boolean => leaderAlive() || descendants.some((d) => isProcessAlive(d));
  if (!anyAlive()) return { graceful: true, forced: false, survivors: [], durationMs: elapsed() };
  if (o.graceMs > 0) {
    // Windowless console processes ignore WM_CLOSE: taskkill then fails with "can only be terminated
    // forcefully" (non-zero exit). Waiting the grace period would only delay the forced kill.
    const graceful0 = await execHelper(o.spawn, 'taskkill', ['/PID', String(pid), '/T']);
    if (graceful0.code === 0) graceful = await waitUntil(() => !anyAlive(), o.graceMs, POLL_MS);
    else graceful = !anyAlive();
  }
  if (!graceful) {
    forced = true;
    await execHelper(o.spawn, 'taskkill', ['/PID', String(pid), '/T', '/F']);
    for (const d of descendants) {
      if (isProcessAlive(d)) await execHelper(o.spawn, 'taskkill', ['/PID', String(d), '/F']);
    }
    await waitUntil(() => !anyAlive(), FORCE_WAIT_MS, 100);
  }
  survivors = [...(leaderAlive() ? [pid] : []), ...descendants.filter((d) => isProcessAlive(d))];
  return { graceful, forced, survivors, durationMs: elapsed() };
}

// ---- public API -------------------------------------------------------------------------------

export function killProcessTree(
  pid: number,
  opts: { pgid: number | null; graceMs: number; platform?: HostPlatform; spawn?: SpawnFn },
): Promise<KillResult> {
  return killTree(pid, {
    pgid: opts.pgid,
    graceMs: opts.graceMs,
    platform: opts.platform ?? hostPlatform(),
    spawn: opts.spawn ?? nodeSpawn,
  });
}

/** spawn(cmd, args, {shell:false, windowsHide:true, detached: platform==='posix'}); bounded capture; tree-kill on timeout/abort. Never rejects for non-zero exit. */
export function runProcess(
  cmd: string,
  args: readonly string[],
  opts: RunProcessOptions,
): Promise<RunProcessResult> {
  const platform = opts.platform ?? hostPlatform();
  const spawnFn = opts.spawn ?? nodeSpawn;
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  const empty: RunProcessResult = {
    pid: null,
    exitCode: null,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    spawnError: null,
    durationMs: 0,
  };
  if (opts.signal?.aborted) return Promise.resolve({ ...empty, aborted: true });

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnFn(cmd, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      windowsHide: true,
      detached: platform === 'posix',
    });
  } catch (e) {
    return Promise.resolve({ ...empty, spawnError: toErrno(e), durationMs: elapsed() });
  }

  return new Promise<RunProcessResult>((resolve) => {
    const stdout = new BoundedBuffer(opts.maxStdoutBytes);
    const stderr = new BoundedBuffer(opts.maxStderrBytes);
    const pid = child.pid ?? null;
    let timedOut = false;
    let aborted = false;
    let exited = false;
    let done = false;
    let killing: Promise<unknown> | null = null;
    const timers: NodeJS.Timeout[] = [];

    const startKill = (): void => {
      if (killing !== null || pid === null) return;
      killing = killTree(pid, {
        pgid: platform === 'posix' ? pid : null,
        graceMs: opts.killGraceMs,
        platform,
        spawn: spawnFn,
        leaderAlive: () => !exited,
      }).catch(() => undefined);
      // If stdio stays open after the kill (escaped grandchild), close our ends so 'close' fires.
      void killing.then(() => {
        if (!done) timers.push(setTimeout(destroyStdio, 2000));
      });
    };
    const destroyStdio = (): void => {
      if (done) return;
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      timers.push(setTimeout(() => finish(child.exitCode, child.signalCode), 1000));
    };
    const onAbort = (): void => {
      aborted = true;
      startKill();
    };
    const finish = (code: number | null, sig: NodeJS.Signals | null): void => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      clearTimeout(deadline);
      opts.signal?.removeEventListener('abort', onAbort);
      const result = (): RunProcessResult => ({
        pid,
        exitCode: code,
        signal: sig,
        stdout: stdout.toBuffer(),
        stderr: stderr.toBuffer(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut,
        aborted,
        spawnError: null,
        durationMs: elapsed(),
      });
      void (killing ?? Promise.resolve()).then(() => resolve(result()));
    };

    const deadline = setTimeout(
      () => {
        timedOut = true;
        startKill();
      },
      Math.min(Math.max(opts.timeoutMs, 0), MAX_TIMER_MS),
    );
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (c: Buffer) => stdout.push(c));
    child.stderr.on('data', (c: Buffer) => stderr.push(c));
    child.stdin.on('error', () => undefined);
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();

    child.once('spawn', () => {
      if (pid !== null) {
        try {
          opts.onSpawn?.(pid);
        } catch {
          // observer failures never affect the process
        }
      }
    });
    child.once('error', (err) => {
      if (pid === null && !done) {
        done = true;
        clearTimeout(deadline);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve({ ...empty, spawnError: err, durationMs: elapsed() });
      }
    });
    child.once('exit', () => {
      exited = true;
      // Leader gone but a descendant may keep our pipes open: stop waiting after a bounded delay.
      timers.push(
        setTimeout(() => {
          if (done) return;
          if (platform === 'posix' && pid !== null) sendSignal(pid, true, 'SIGKILL');
          destroyStdio();
        }, CLOSE_AFTER_EXIT_MS),
      );
    });
    child.once('close', (code, sig) => finish(code, sig));
  });
}

/** Spawns a long-running supervised child (Claude). Throws ProcessSpawnError when the process cannot start. */
export function spawnSupervised(
  cmd: string,
  args: readonly string[],
  opts: SpawnSupervisedOptions,
): SupervisedProcess {
  const platform = opts.platform ?? hostPlatform();
  const spawnFn = opts.spawn ?? nodeSpawn;
  const command = basename(cmd);
  const credential = opts.credentialFd;
  if (credential !== undefined && platform !== 'posix') {
    throw new ProcessSpawnError(`Failed to spawn ${command}`, {
      details: { command, reason: 'credential_fd_unsupported' },
    });
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnFn(cmd, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      windowsHide: true,
      detached: platform === 'posix',
      ...(credential === undefined
        ? {}
        : { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe', 'pipe'] }),
    });
  } catch (e) {
    throw new ProcessSpawnError(`Failed to spawn ${command}`, {
      cause: e,
      details: { command, errno: errnoCode(e) ?? null },
    });
  }
  child.on('error', () => undefined);
  const pid = child.pid;
  if (pid === undefined) {
    throw new ProcessSpawnError(`Failed to spawn ${command}`, { details: { command } });
  }
  const pgid = platform === 'posix' ? pid : null;
  const startedAt = new Date();
  let exitedFlag = false;
  const exited = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
    child.once('exit', (code, sig) => {
      exitedFlag = true;
      resolve({ exitCode: code, signal: sig });
    });
  });
  child.stdin.on('error', () => undefined);
  if (credential !== undefined) {
    const fd3 = child.stdio[3];
    if (fd3 === null || fd3 === undefined || !('write' in fd3)) {
      // The child is already running and would start without its credential: kill its whole group
      // (it is detached, pgid = pid) and close our pipe ends before reporting the failure.
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      throw new ProcessSpawnError(`Failed to spawn ${command}`, {
        details: { command, reason: 'credential_fd_missing' },
      });
    }
    fd3.on('error', () => undefined);
    fd3.end(credential);
  }
  const markerAttemptId = opts.env[MARKER_ENV] ?? null;
  let graceful: Promise<KillResult> | null = null;
  let forced: Promise<KillResult> | null = null;

  const run = (graceMs: number): Promise<KillResult> =>
    killTree(pid, {
      pgid,
      graceMs,
      platform,
      spawn: spawnFn,
      leaderAlive: () => !exitedFlag,
      markerAttemptId,
    });

  return {
    pid,
    pgid,
    startedAt,
    stdout: child.stdout,
    stderr: child.stderr,
    stdin: child.stdin,
    exited,
    stop({ graceMs, forceImmediately }) {
      if (forceImmediately || graceMs <= 0) {
        forced ??= run(0);
        return forced;
      }
      graceful ??= run(graceMs);
      return graceful;
    },
  };
}
