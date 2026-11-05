// Runner client (worker side, SANDBOX_MODE=runner): ProcessLauncher over the runner socket
// (contract §2.2, §10.11 item 5). One connection per request; a spawn keeps its connection open.
import net from 'node:net';
import { PassThrough, Writable, type Duplex } from 'node:stream';
import type { Logger } from '@orc/logger';
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
import { fromErrorFrame, protocolError, runnerError } from './errors';
import { encodeFrame, FrameDecoder, parseFrame } from './framing';
import {
  MAX_CHUNK_BYTES,
  MAX_STOP_GRACE_MS,
  PROTOCOL_VERSION,
  ServerFrameSchema,
  type RequestFrame,
  type RunnerHello,
  type ServerFrame,
  type SpawnRequest,
} from './protocol';
import { encodeCredentialFd, validateSpawnCredential } from './validation';

export interface ReleaseOutcome {
  kill: KillResult;
  reclaimed: boolean;
}

/** ProcessLauncher plus release-by-id (startup recovery and workspace cleanup use `listLeases`). */
export interface SandboxLauncher extends ProcessLauncher {
  releaseLease(id: string): Promise<ReleaseOutcome>;
}

export interface RunnerClient extends SandboxLauncher {
  readonly mode: 'runner';
  /** `hello` (worker start-up probe, §14.2; check with `checkRunnerHello`). */
  hello(): Promise<RunnerHello>;
}

export interface RunnerDisconnectInfo {
  leaseId: string;
  pid: number;
}

export interface RunnerClientOptions {
  socketPath: string;
  /** Opens one connection; defaults to `net.createConnection(socketPath)`. */
  connect?: () => Duplex;
  /** Timeout of short requests (default 30000). */
  requestTimeoutMs?: number;
  /** Timeout of lease_acquire / lease_release / lease_measure, which walk whole trees (default 600000). */
  longRequestTimeoutMs?: number;
  /**
   * Called when a spawn connection drops before `exit` (runner restart or crash). `exited` then
   * resolves with `{exitCode: null, signal: null}`; the worker maps this to `worker_lost` (§10.11).
   */
  onDisconnect?: (info: RunnerDisconnectInfo) => void;
  logger?: Logger;
}

type FrameOf<T extends ServerFrame['type']> = Extract<ServerFrame, { type: T }>;

const noop = (): void => undefined;

const unavailable = (cause: unknown): Error =>
  runnerError('process_spawn_failed', 'runner_unavailable', 'Runner is unavailable', cause);
const disconnected = (): Error =>
  runnerError(
    'process_spawn_failed',
    'runner_disconnected',
    'Runner closed the connection without a response',
  );

export function createRunnerClient(o: RunnerClientOptions): RunnerClient {
  const connect = o.connect ?? (() => net.createConnection(o.socketPath));
  const requestTimeoutMs = o.requestTimeoutMs ?? 30_000;
  const longTimeoutMs = o.longRequestTimeoutMs ?? 600_000;
  const sessions = new Set<Duplex>();
  let closed = false;

  const ensureOpen = (): void => {
    if (closed) throw runnerError('process_spawn_failed', 'closed', 'Runner client is closed');
  };

  function request<T extends ServerFrame['type']>(
    frame: Exclude<RequestFrame, SpawnRequest>,
    expect: T,
    timeoutMs: number,
  ): Promise<FrameOf<T>> {
    return new Promise<FrameOf<T>>((resolve, reject) => {
      let conn: Duplex;
      try {
        conn = connect();
      } catch (e) {
        reject(unavailable(e));
        return;
      }
      const decoder = new FrameDecoder();
      let settled = false;
      const done = (err: unknown, value?: FrameOf<T>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        conn.destroy();
        if (value !== undefined) resolve(value);
        else reject(err instanceof Error ? err : disconnected());
      };
      const timer = setTimeout(
        () =>
          done(
            runnerError('process_spawn_failed', 'runner_unavailable', 'Runner request timed out'),
          ),
        timeoutMs,
      );
      conn.on('error', (e) => done(unavailable(e)));
      conn.on('close', () => done(disconnected()));
      conn.on('data', (chunk: Buffer) => {
        try {
          for (const line of decoder.push(chunk)) {
            const f = parseFrame(ServerFrameSchema, line);
            if (f.type === 'error') {
              done(fromErrorFrame(f));
            } else if (f.type !== expect) {
              done(protocolError(`Unexpected ${f.type} frame from the runner`));
            } else {
              done(null, f as FrameOf<T>);
            }
            return;
          }
        } catch (e) {
          done(e);
        }
      });
      try {
        conn.write(encodeFrame(frame));
      } catch (e) {
        done(e);
      }
    });
  }

  async function releaseLease(id: string): Promise<ReleaseOutcome> {
    const f = await request(
      { v: PROTOCOL_VERSION, type: 'lease_release', leaseId: id },
      'lease_released',
      longTimeoutMs,
    );
    return { kill: f.kill, reclaimed: f.reclaimed };
  }

  class RunnerLease implements LaunchLease {
    readonly id: string;
    readonly key: string;
    readonly uid: number | null;
    private releasing: Promise<ReleaseOutcome> | null = null;

    constructor(info: LeaseInfo) {
      this.id = info.id;
      this.key = info.key;
      this.uid = info.uid;
    }

    async renew(): Promise<void> {
      await request(
        { v: PROTOCOL_VERSION, type: 'lease_renew', leaseId: this.id },
        'lease_renewed',
        requestTimeoutMs,
      );
    }

    async measure(path: string, maxEntries: number): Promise<LeaseMeasurement> {
      const f = await request(
        { v: PROTOCOL_VERSION, type: 'lease_measure', leaseId: this.id, path, maxEntries },
        'lease_measured',
        longTimeoutMs,
      );
      return { bytes: f.bytes, entries: f.entries, truncated: f.truncated };
    }

    release(): Promise<ReleaseOutcome> {
      if (this.releasing === null) {
        const p = releaseLease(this.id);
        this.releasing = p;
        // A failed release may be retried; a successful one is cached (idempotent).
        p.catch(() => {
          if (this.releasing === p) this.releasing = null;
        });
      }
      return this.releasing;
    }
  }

  function openSession(frame: SpawnRequest): Promise<SupervisedProcess> {
    // The session object keeps only the lease id, never the frame (it may carry `credentialFd`).
    const leaseId = frame.leaseId;
    return new Promise<SupervisedProcess>((resolve, reject) => {
      let conn: Duplex;
      try {
        conn = connect();
      } catch (e) {
        reject(unavailable(e));
        return;
      }
      sessions.add(conn);
      const decoder = new FrameDecoder();
      let proc: RemoteProcess | null = null;
      let failed = false;
      const fail = (e: unknown): void => {
        if (failed) return;
        failed = true;
        clearTimeout(timer);
        conn.destroy();
        if (proc === null) reject(e instanceof Error ? e : disconnected());
      };
      const timer = setTimeout(
        () =>
          fail(runnerError('process_spawn_failed', 'runner_unavailable', 'Runner spawn timed out')),
        requestTimeoutMs,
      );
      conn.on('error', (e) => {
        if (proc === null) fail(unavailable(e));
        else o.logger?.warn({ err: e, pid: proc.pid }, 'runner session connection error');
      });
      conn.on('close', () => {
        sessions.delete(conn);
        clearTimeout(timer);
        if (proc === null) fail(disconnected());
        else proc.onClose();
      });
      conn.on('data', (chunk: Buffer) => {
        try {
          for (const line of decoder.push(chunk)) {
            const f = parseFrame(ServerFrameSchema, line);
            if (proc !== null) {
              proc.onFrame(f);
              continue;
            }
            if (f.type === 'error') {
              fail(fromErrorFrame(f));
              return;
            }
            if (f.type !== 'spawned')
              throw protocolError(`Unexpected ${f.type} frame before spawned`);
            clearTimeout(timer);
            proc = new RemoteProcess(conn, f, leaseId, o);
            resolve(proc);
          }
        } catch (e) {
          o.logger?.warn({ err: e }, 'runner session protocol violation; closing');
          fail(e);
        }
      });
      try {
        conn.write(encodeFrame(frame));
      } catch (e) {
        fail(e);
      }
    });
  }

  return {
    mode: 'runner',
    async hello() {
      const f = await request({ v: PROTOCOL_VERSION, type: 'hello' }, 'hello_ok', requestTimeoutMs);
      return {
        protocol: f.protocol,
        uidBase: f.uidBase,
        maxLeases: f.maxLeases,
        leaseTtlMs: f.leaseTtlMs,
        caps: f.caps,
      };
    },
    async acquire(r: LaunchLeaseRequest) {
      ensureOpen();
      const f = await request(
        {
          v: PROTOCOL_VERSION,
          type: 'lease_acquire',
          key: r.key,
          attemptId: r.attemptId,
          workerId: r.workerId,
          paths: [...r.paths],
        },
        'lease_acquired',
        longTimeoutMs,
      );
      return new RunnerLease(f.lease);
    },
    async spawn(lease: LaunchLease, spec: LaunchSpec) {
      ensureOpen();
      const limits: SpawnRequest['limits'] = {};
      if (spec.limits?.nproc !== undefined) limits.nproc = spec.limits.nproc;
      if (spec.limits?.nofile !== undefined) limits.nofile = spec.limits.nofile;
      if (spec.limits?.fsizeBytes !== undefined) limits.fsizeBytes = spec.limits.fsizeBytes;
      // The runner re-checks; failing here keeps a misrouted credential off the socket.
      validateSpawnCredential(spec.kind, spec.env, spec.credentialFd);
      return openSession({
        v: PROTOCOL_VERSION,
        type: 'spawn',
        leaseId: lease.id,
        kind: spec.kind,
        argv: [spec.cmd, ...spec.args],
        cwd: spec.cwd,
        env: { ...spec.env },
        limits,
        ...(spec.credentialFd === undefined
          ? {}
          : { credentialFd: encodeCredentialFd(spec.credentialFd) }),
      });
    },
    async listLeases() {
      const f = await request(
        { v: PROTOCOL_VERSION, type: 'lease_list' },
        'lease_listed',
        requestTimeoutMs,
      );
      return f.leases;
    },
    releaseLease,
    close() {
      closed = true;
      // Dropping a session connection makes the runner stop its child (pipes cannot be reattached).
      for (const c of sessions) c.destroy();
      sessions.clear();
      return Promise.resolve();
    },
  };
}

/** True when `proc` is a runner child whose connection dropped before its `exit` frame. */
export function isRunnerDisconnected(proc: SupervisedProcess): boolean {
  return proc instanceof RemoteProcess && proc.disconnected;
}

/** A child running in the runner, driven through its spawn connection. */
class RemoteProcess implements SupervisedProcess {
  readonly pid: number;
  readonly pgid: number | null;
  readonly startedAt: Date;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly exited: Promise<{ exitCode: number | null; signal: string | null }>;
  disconnected = false;
  private resolveExited: (v: { exitCode: number | null; signal: string | null }) => void = noop;
  private exitInfo: { exitCode: number | null; signal: string | null } | null = null;
  private closed = false;
  private readonly conn: Duplex;
  private readonly leaseId: string;
  private readonly opts: RunnerClientOptions;
  private readonly pendingStops: ((r: KillResult) => void)[] = [];
  private readonly pausedOutputs = new Set<PassThrough>();
  private pendingStdinCallback: (() => void) | null = null;
  private graceful: Promise<KillResult> | null = null;
  private forced: Promise<KillResult> | null = null;

  constructor(
    conn: Duplex,
    spawned: FrameOf<'spawned'>,
    leaseId: string,
    opts: RunnerClientOptions,
  ) {
    this.conn = conn;
    this.leaseId = leaseId;
    this.opts = opts;
    this.pid = spawned.pid;
    this.pgid = spawned.pgid;
    this.startedAt = new Date(spawned.startedAt);
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        if (this.closed || this.exitInfo !== null) {
          callback(); // like a closed pipe: data to a finished child is dropped
          return;
        }
        let ok = true;
        for (let off = 0; off < chunk.length; off += MAX_CHUNK_BYTES) {
          ok =
            this.send({
              v: PROTOCOL_VERSION,
              type: 'stdin',
              b64: chunk.subarray(off, off + MAX_CHUNK_BYTES).toString('base64'),
            }) && ok;
        }
        if (ok) {
          callback();
          return;
        }
        this.pendingStdinCallback = () => callback();
        this.conn.once('drain', () => this.flushStdinCallback());
      },
      final: (callback) => {
        if (!this.closed && this.exitInfo === null)
          this.send({ v: PROTOCOL_VERSION, type: 'stdin_end' });
        callback();
      },
    });
    this.stdin.on('error', noop);
  }

  private send(frame: object): boolean {
    if (this.closed || this.conn.destroyed || this.conn.writableEnded) return true;
    return this.conn.write(encodeFrame(frame));
  }

  private flushStdinCallback(): void {
    const cb = this.pendingStdinCallback;
    this.pendingStdinCallback = null;
    cb?.();
  }

  private pushOutput(stream: PassThrough, b64: string): void {
    if (stream.writableEnded) return;
    const ok = stream.write(Buffer.from(b64, 'base64'));
    if (!ok && !this.pausedOutputs.has(stream)) {
      this.pausedOutputs.add(stream);
      this.conn.pause();
      stream.once('drain', () => {
        this.pausedOutputs.delete(stream);
        if (this.pausedOutputs.size === 0) this.conn.resume();
      });
    }
  }

  onFrame(f: ServerFrame): void {
    switch (f.type) {
      case 'stdout':
        this.pushOutput(this.stdout, f.b64);
        return;
      case 'stderr':
        this.pushOutput(this.stderr, f.b64);
        return;
      case 'exit':
        if (this.exitInfo !== null) throw protocolError('Duplicate exit frame');
        this.exitInfo = { exitCode: f.exitCode, signal: f.signal };
        this.stdout.end();
        this.stderr.end();
        this.flushStdinCallback();
        this.resolveExited(this.exitInfo);
        return;
      case 'stopped':
        this.pendingStops.shift()?.({
          graceful: f.graceful,
          forced: f.forced,
          survivors: f.survivors,
          durationMs: f.durationMs,
        });
        return;
      case 'error':
        // A failed stop: report the leader as a survivor (the lease release kills uid-wide).
        this.opts.logger?.warn({ code: f.code, pid: this.pid }, 'runner reported a stop failure');
        this.pendingStops.shift()?.({
          graceful: false,
          forced: true,
          survivors: [this.pid],
          durationMs: 0,
        });
        return;
      default:
        throw protocolError(`Unexpected ${f.type} frame in a spawn session`);
    }
  }

  onClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.exitInfo === null) {
      this.disconnected = true;
      this.exitInfo = { exitCode: null, signal: null };
      this.stdout.end();
      this.stderr.end();
      this.resolveExited(this.exitInfo);
      this.opts.logger?.warn(
        { leaseId: this.leaseId, pid: this.pid },
        'runner connection dropped before exit',
      );
      try {
        this.opts.onDisconnect?.({ leaseId: this.leaseId, pid: this.pid });
      } catch (e) {
        this.opts.logger?.error({ err: e }, 'onDisconnect handler failed');
      }
    }
    this.flushStdinCallback();
    for (const resolve of this.pendingStops.splice(0)) resolve(this.closedStopResult());
  }

  private closedStopResult(): KillResult {
    return this.disconnected
      ? { graceful: false, forced: false, survivors: [this.pid], durationMs: 0 }
      : { graceful: true, forced: false, survivors: [], durationMs: 0 };
  }

  stop(opts: { graceMs: number; forceImmediately?: boolean }): Promise<KillResult> {
    if (opts.forceImmediately === true || opts.graceMs <= 0) {
      this.forced ??= this.sendStop(0, true);
      return this.forced;
    }
    this.graceful ??= this.sendStop(opts.graceMs, false);
    return this.graceful;
  }

  private sendStop(graceMs: number, force: boolean): Promise<KillResult> {
    if (this.closed) return Promise.resolve(this.closedStopResult());
    return new Promise<KillResult>((resolve) => {
      this.pendingStops.push(resolve);
      // The frame schema accepts only integers in [0, MAX_STOP_GRACE_MS]; anything else would be a
      // protocol violation that drops the connection instead of stopping gracefully.
      const ms = Number.isFinite(graceMs) ? Math.floor(graceMs) : MAX_STOP_GRACE_MS;
      this.send({
        v: PROTOCOL_VERSION,
        type: 'stop',
        graceMs: Math.max(0, Math.min(ms, MAX_STOP_GRACE_MS)),
        force,
      });
    });
  }
}
