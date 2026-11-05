// Runner socket server (contract §10.11 item 5): one connection per request; a `spawn` connection
// stays open as the child's stdio/exit channel. A connection dropped before `exit` stops the child.
import { chmod, chown, lstat, mkdir, unlink } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { Logger } from '@orc/logger';
import { isOrcError } from '@orc/shared';
import type { SupervisedProcess } from '@orc/shared/node';
import { protocolError, toErrorFrame } from './errors';
import { encodeFrame, FrameDecoder, parseFrame } from './framing';
import type { LeaseManager } from './lease-manager';
import {
  MAX_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  RequestFrameSchema,
  SessionFrameSchema,
  type RequestFrame,
  type RunnerCaps,
  type ServerFrame,
  type SessionFrame,
  type SpawnRequest,
} from './protocol';
import { decodeCredentialFd } from './validation';

export interface SocketFsOps {
  lstat(p: string): Promise<{ isSocket(): boolean }>;
  unlink(p: string): Promise<void>;
  mkdir(p: string, mode: number): Promise<void>;
  chmod(p: string, mode: number): Promise<void>;
  chown(p: string, uid: number, gid: number): Promise<void>;
}

const nodeSocketFs: SocketFsOps = {
  lstat: (p) => lstat(p),
  unlink: (p) => unlink(p),
  mkdir: async (p, mode) => {
    await mkdir(p, { recursive: true, mode });
  },
  chmod: (p, mode) => chmod(p, mode),
  chown: (p, uid, gid) => chown(p, uid, gid),
};

export interface RunnerServerOptions {
  socketPath: string;
  manager: LeaseManager;
  hello: { uidBase: number; maxLeases: number; leaseTtlMs: number; caps: RunnerCaps };
  logger: Logger;
  maxConnections: number;
  /**
   * Group of the socket and its directory (`0750 root:<gid>` / `0660 root:<gid>`); null on hosts
   * without CAP_CHOWN (the directory is then left untouched and only the socket mode is set).
   */
  socketGroup: number | null;
  /** Grace period used when a dropped connection stops its child. */
  killGraceMs: number;
  /** Deadline for the first frame of a connection (default 30000). */
  requestTimeoutMs?: number;
  /** After the child exits: idle time without output before `exit` is sent although a pipe is still open (default 5000). */
  exitDrainMs?: number;
  fs?: SocketFsOps;
}

export interface RunnerServer {
  listen(): Promise<void>;
  /** Serves one connection; `listen` uses it for every accepted socket (tests may pass in-memory duplexes). */
  handleConnection(conn: Duplex): void;
  /** Stops accepting new connections (existing ones continue). */
  stopAccepting(): void;
  /** Stops accepting, waits up to `graceMs` for open connections, destroys the rest, removes the socket. */
  close(graceMs?: number): Promise<void>;
  readonly connectionCount: number;
}

const MAX_QUEUED_SESSION_BYTES = 8 * MAX_FRAME_BYTES;
const noop = (): void => undefined;

export function createRunnerServer(o: RunnerServerOptions): RunnerServer {
  const log = o.logger;
  const fs = o.fs ?? nodeSocketFs;
  const requestTimeoutMs = o.requestTimeoutMs ?? 30_000;
  const exitDrainMs = o.exitDrainMs ?? 5000;
  const connections = new Set<Duplex>();
  const server = net.createServer({ allowHalfOpen: false, pauseOnConnect: false }, (socket) =>
    handleConnection(socket),
  );
  server.maxConnections = o.maxConnections;
  let listening = false;

  function handleConnection(conn: Duplex): void {
    connections.add(conn);
    const decoder = new FrameDecoder(MAX_FRAME_BYTES);
    let phase: 'request' | 'working' | 'spawning' | 'session' | 'done' = 'request';
    const queued: SessionFrame[] = [];
    let queuedBytes = 0;
    let session: Session | null = null;
    let closed = false;

    const timer = setTimeout(
      () => fail(protocolError('No request frame received in time')),
      requestTimeoutMs,
    );
    timer.unref();

    const send = (frame: ServerFrame): boolean => {
      if (closed || conn.writableEnded || conn.destroyed) return true;
      return conn.write(encodeFrame(frame));
    };
    const finish = (frame?: ServerFrame): void => {
      phase = 'done';
      clearTimeout(timer);
      if (closed || conn.writableEnded || conn.destroyed) return;
      if (frame === undefined) conn.end();
      else conn.end(encodeFrame(frame));
      // Do not wait forever for a peer that never reads.
      setTimeout(() => conn.destroy(), 10_000).unref();
    };
    const fail = (e: unknown): void => {
      if (phase === 'done') return;
      log.warn({ err: e }, 'runner connection closed after a protocol violation');
      finish(toErrorFrame(e));
    };

    conn.on('error', (e) => log.debug({ err: e }, 'runner connection error'));
    conn.on('close', () => {
      closed = true;
      connections.delete(conn);
      clearTimeout(timer);
      if (session !== null) session.onDisconnect();
    });
    const isDone = (): boolean => phase === 'done';
    conn.on('data', (chunk: Buffer) => {
      if (isDone()) return;
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (e) {
        fail(e);
        return;
      }
      for (const line of lines) {
        if (isDone()) return;
        try {
          onLine(line);
        } catch (e) {
          fail(e);
          return;
        }
      }
    });

    function onLine(line: string): void {
      if (phase === 'request') {
        const req = parseFrame(RequestFrameSchema, line);
        clearTimeout(timer);
        if (req.type === 'spawn') {
          phase = 'spawning';
          void startSession(req);
        } else {
          phase = 'working';
          void handleRequest(req);
        }
        return;
      }
      if (phase === 'spawning' || phase === 'session') {
        const frame = parseFrame(SessionFrameSchema, line);
        if (phase === 'session' && session !== null) {
          session.onFrame(frame);
        } else {
          queuedBytes += line.length;
          if (queuedBytes > MAX_QUEUED_SESSION_BYTES)
            throw protocolError('Too many frames before spawned');
          queued.push(frame);
        }
        return;
      }
      throw protocolError('Unexpected frame after the request');
    }

    async function handleRequest(req: Exclude<RequestFrame, SpawnRequest>): Promise<void> {
      try {
        let frame: ServerFrame;
        switch (req.type) {
          case 'hello':
            frame = {
              v: PROTOCOL_VERSION,
              type: 'hello_ok',
              protocol: PROTOCOL_VERSION,
              ...o.hello,
            };
            break;
          case 'lease_acquire':
            frame = {
              v: PROTOCOL_VERSION,
              type: 'lease_acquired',
              lease: await o.manager.acquire({
                key: req.key,
                attemptId: req.attemptId,
                workerId: req.workerId,
                paths: req.paths,
              }),
            };
            break;
          case 'lease_renew':
            frame = {
              v: PROTOCOL_VERSION,
              type: 'lease_renewed',
              ...(await o.manager.renew(req.leaseId)),
            };
            break;
          case 'lease_release': {
            const r = await o.manager.release(req.leaseId);
            frame = {
              v: PROTOCOL_VERSION,
              type: 'lease_released',
              kill: r.kill,
              reclaimed: r.reclaimed,
            };
            break;
          }
          case 'lease_measure':
            frame = {
              v: PROTOCOL_VERSION,
              type: 'lease_measured',
              ...(await o.manager.measure(req.leaseId, req.path, req.maxEntries)),
            };
            break;
          case 'lease_list':
            frame = { v: PROTOCOL_VERSION, type: 'lease_listed', leases: o.manager.list() };
            break;
        }
        finish(frame);
      } catch (e) {
        if (isOrcError(e) && e.status < 500)
          log.info({ err: e, request: req.type }, 'runner request rejected');
        else log.error({ err: e, request: req.type }, 'runner request failed');
        finish(toErrorFrame(e));
      }
    }

    async function startSession(req: SpawnRequest): Promise<void> {
      let proc: SupervisedProcess;
      let uid: number | null;
      try {
        // ADR-0036 m.4/m.8: the credential is decoded only here, handed to the lease manager and
        // never logged; the frame drops its reference so it does not outlive the spawn.
        const credential = req.credentialFd;
        delete req.credentialFd;
        ({ proc, uid } = await o.manager.spawn(req.leaseId, {
          kind: req.kind,
          argv: req.argv,
          cwd: req.cwd,
          env: req.env,
          limits: req.limits,
          ...(credential === undefined ? {} : { credentialFd: decodeCredentialFd(credential) }),
        }));
      } catch (e) {
        if (isOrcError(e) && e.status < 500)
          log.info({ err: e, kind: req.kind }, 'runner spawn rejected');
        else log.error({ err: e, kind: req.kind }, 'runner spawn failed');
        finish(toErrorFrame(e));
        return;
      }
      session = new Session(proc, {
        send,
        finish: () => finish(),
        isDone: () => phase === 'done' || closed,
        pauseInput: () => conn.pause(),
        resumeInput: () => conn.resume(),
        onDrain: (fn) => conn.once('drain', fn),
        log,
        killGraceMs: o.killGraceMs,
        exitDrainMs,
      });
      if (closed) {
        session.onDisconnect();
        return;
      }
      send({
        v: PROTOCOL_VERSION,
        type: 'spawned',
        pid: proc.pid,
        pgid: proc.pgid,
        uid,
        startedAt: proc.startedAt.toISOString(),
      });
      phase = 'session';
      session.start();
      for (const frame of queued.splice(0)) {
        try {
          session.onFrame(frame);
        } catch (e) {
          fail(e);
          return;
        }
      }
    }
  }

  return {
    async listen() {
      const dir = path.dirname(o.socketPath);
      await fs.mkdir(dir, 0o750);
      await removeStaleSocket(o.socketPath, fs);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(o.socketPath, () => {
          server.off('error', reject);
          resolve();
        });
      });
      listening = true;
      server.on('error', (e) => log.error({ err: e }, 'runner socket server error'));
      await fs.chmod(o.socketPath, 0o660);
      if (o.socketGroup !== null) {
        await fs.chown(dir, 0, o.socketGroup);
        await fs.chmod(dir, 0o750);
        await fs.chown(o.socketPath, 0, o.socketGroup);
      }
      log.info({ socketPath: o.socketPath, maxConnections: o.maxConnections }, 'runner listening');
    },
    handleConnection,
    stopAccepting() {
      if (listening) server.close();
      listening = false;
    },
    async close(graceMs = 5000) {
      if (listening) server.close();
      listening = false;
      const deadline = Date.now() + graceMs;
      while (connections.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      for (const c of connections) c.destroy();
      try {
        await fs.unlink(o.socketPath);
      } catch {
        // already removed
      }
    },
    get connectionCount() {
      return connections.size;
    },
  };
}

async function removeStaleSocket(socketPath: string, fs: SocketFsOps): Promise<void> {
  let isSocket: boolean;
  try {
    isSocket = (await fs.lstat(socketPath)).isSocket();
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return;
    throw e;
  }
  if (!isSocket) throw new Error('RUNNER_SOCKET_PATH exists and is not a socket');
  const inUse = await new Promise<boolean>((resolve) => {
    const probe = net.createConnection(socketPath);
    probe.setTimeout(1000);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('timeout', () => {
      probe.destroy();
      resolve(false);
    });
    probe.once('error', () => resolve(false));
  });
  if (inUse) throw new Error('Another runner is listening on RUNNER_SOCKET_PATH');
  await fs.unlink(socketPath);
}

interface SessionIo {
  send(frame: ServerFrame): boolean;
  finish(): void;
  isDone(): boolean;
  pauseInput(): void;
  resumeInput(): void;
  onDrain(fn: () => void): void;
  log: Logger;
  killGraceMs: number;
  exitDrainMs: number;
}

/** One spawned child bound to its connection. */
class Session {
  private exitSent = false;
  private stdinEnded = false;
  private paused = false;
  private lastOutput = Date.now();
  private readonly stops: Promise<void>[] = [];
  private lastStop: Promise<void> = Promise.resolve();
  private stoppingOnDisconnect = false;
  private readonly proc: SupervisedProcess;
  private readonly io: SessionIo;

  constructor(proc: SupervisedProcess, io: SessionIo) {
    this.proc = proc;
    this.io = io;
  }

  start(): void {
    this.forward(this.proc.stdout, 'stdout');
    this.forward(this.proc.stderr, 'stderr');
    void this.awaitExit();
  }

  private forward(stream: NodeJS.ReadableStream, type: 'stdout' | 'stderr'): void {
    stream.on('data', (chunk: Buffer | string) => {
      if (this.exitSent) return;
      this.lastOutput = Date.now();
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      let ok = true;
      for (let off = 0; off < buf.length; off += MAX_CHUNK_BYTES) {
        ok =
          this.io.send({
            v: PROTOCOL_VERSION,
            type,
            b64: buf.subarray(off, off + MAX_CHUNK_BYTES).toString('base64'),
          }) && ok;
      }
      if (!ok && !this.paused) {
        this.paused = true;
        this.proc.stdout.pause();
        this.proc.stderr.pause();
        this.io.onDrain(() => {
          this.paused = false;
          this.lastOutput = Date.now();
          this.proc.stdout.resume();
          this.proc.stderr.resume();
        });
      }
    });
    stream.on('error', noop);
  }

  private async awaitExit(): Promise<void> {
    const exit = await this.proc.exited;
    this.lastOutput = Date.now();
    await new Promise<void>((resolve) => {
      let done = false;
      const tick = setInterval(
        () => {
          if (
            this.io.isDone() ||
            (!this.paused && Date.now() - this.lastOutput >= this.io.exitDrainMs)
          )
            end();
        },
        Math.min(100, this.io.exitDrainMs),
      );
      const end = (): void => {
        if (done) return;
        done = true;
        clearInterval(tick);
        resolve();
      };
      void Promise.all([
        finished(this.proc.stdout).catch(noop),
        finished(this.proc.stderr).catch(noop),
      ]).then(end);
    });
    if (this.io.isDone()) return;
    this.exitSent = true;
    // Descendants may still hold the pipes: keep draining them so they never block on a full pipe.
    this.proc.stdout.resume();
    this.proc.stderr.resume();
    this.io.send({
      v: PROTOCOL_VERSION,
      type: 'exit',
      exitCode: exit.exitCode,
      signal: exit.signal,
    });
    while (this.stops.length > 0) await this.stops.shift();
    this.io.finish();
  }

  onFrame(frame: SessionFrame): void {
    switch (frame.type) {
      case 'stdin': {
        if (this.stdinEnded) throw protocolError('stdin frame after stdin_end');
        const ok = this.proc.stdin.write(Buffer.from(frame.b64, 'base64'));
        if (!ok) {
          this.io.pauseInput();
          this.proc.stdin.once('drain', () => this.io.resumeInput());
        }
        return;
      }
      case 'stdin_end':
        if (this.stdinEnded) return;
        this.stdinEnded = true;
        this.proc.stdin.end();
        return;
      case 'stop': {
        // The kill starts immediately; `stopped` frames are sent in request order so the client
        // can match them to its stop calls.
        const result = this.proc
          .stop({ graceMs: frame.graceMs, forceImmediately: frame.force })
          .then(
            (r): ServerFrame => ({ v: PROTOCOL_VERSION, type: 'stopped', ...r }),
            (e: unknown): ServerFrame => {
              this.io.log.error({ err: e, pid: this.proc.pid }, 'runner stop failed');
              return toErrorFrame(e);
            },
          );
        const sent = this.lastStop
          .then(() => result)
          .then((f) => {
            this.io.send(f);
          });
        this.lastStop = sent;
        this.stops.push(sent);
        return;
      }
    }
  }

  /** Connection closed: a child without a delivered `exit` is stopped (pipes cannot be reattached). */
  onDisconnect(): void {
    if (this.exitSent || this.stoppingOnDisconnect) return;
    this.stoppingOnDisconnect = true;
    this.proc.stdout.resume();
    this.proc.stderr.resume();
    this.io.log.warn(
      { pid: this.proc.pid },
      'runner connection dropped before exit; stopping child',
    );
    this.proc
      .stop({ graceMs: this.io.killGraceMs })
      .catch((e: unknown) =>
        this.io.log.error({ err: e, pid: this.proc.pid }, 'stopping child after disconnect failed'),
      );
  }
}
