// GET /api/v1/tasks/:taskId/stream (contract §8): admission, wire format, Redis replay + XREAD tail on a dedicated
// connection, DB replay / tail fallback (Redis lost data or unavailable, F8), heartbeat, re-validation and limits.
import { randomUUID } from 'node:crypto';
import { NotFoundError, OrcError, isSettledStatus, toIso } from '@orc/shared';
import type { ErrorCode, SettledTaskStatus, StatusEventPayload, TaskStatus, TaskStreamEvent, Uuid } from '@orc/shared';
import type { TaskRecord } from '@orc/database';
import { boundRedis, createTaskStreamReader, taskViewer } from '@orc/task-manager';
import type { StreamEntry, TaskStreamReader } from '@orc/task-manager';
import { viewerOf } from '../auth.js';
import { state } from '../context.js';
import { toPublicProblem } from '../problem.js';
import type { HandlerCtx } from '../route.js';
import type { AppDeps, AuthenticatedState } from '../types.js';
import { DbReplayer } from './db-replay.js';
import type { DbReplayFilter } from './db-replay.js';
import type { SseConnection } from './hub.js';

const RESUME_REGEX = /^r-\d+-\d+$|^d-\d+$|^d-end$/;
const RANGE_PAGE = 500;
const XREAD_BLOCK_MS = 5_000;
const RETRY_AFTER_SECONDS = 5;
/** Minimum lifetime of a ZSET member without a refresh; always at least 3 heartbeats (so SSE_HEARTBEAT_MS may grow). */
const ZSET_SCORE_TTL_MIN_MS = 45_000;
const ZSET_SCORE_TTL_HEARTBEATS = 3;
const SETTLED_HEARTBEATS_BEFORE_SYNTHETIC_END = 2;
const ADMISSION_REDIS_TIMEOUT_MS = 2_000;

/** Atomic per-user admission (§8.1): prune expired members, count, add. Returns 1 when admitted. */
const ADMIT_LUA = `redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[5])
return 1`;

export type ResumePoint = { kind: 'r'; id: string } | { kind: 'd'; id: string } | { kind: 'd-end' } | null;

export function parseResume(raw: string | undefined): ResumePoint {
  if (raw === undefined) return null;
  const value = raw.trim();
  if (!RESUME_REGEX.test(value)) return null;
  if (value === 'd-end') return { kind: 'd-end' };
  return value.startsWith('r-') ? { kind: 'r', id: value.slice(2) } : { kind: 'd', id: value.slice(2) };
}

function streamIdParts(id: string): [bigint, bigint] {
  const [ms, seq] = id.split('-');
  return [BigInt(ms ?? '0'), BigInt(seq ?? '0')];
}

export function compareStreamIds(a: string, b: string): number {
  const [am, as] = streamIdParts(a);
  const [bm, bs] = streamIdParts(b);
  if (am !== bm) return am < bm ? -1 : 1;
  if (as !== bs) return as < bs ? -1 : 1;
  return 0;
}

function userZsetKey(deps: AppDeps, userId: Uuid): string {
  return `${deps.config.redis.prefix}:sse:user:${userId}`;
}

/** A member lives at least 3 heartbeats; the key outlives its newest member twice over. */
function zsetTtls(deps: AppDeps): { scoreTtlMs: number; keyTtlSeconds: number } {
  const scoreTtlMs = Math.max(ZSET_SCORE_TTL_MIN_MS, ZSET_SCORE_TTL_HEARTBEATS * deps.config.sseHeartbeatMs);
  return { scoreTtlMs, keyTtlSeconds: Math.ceil((2 * scoreTtlMs) / 1000) };
}

function nowMs(deps: AppDeps): number {
  return deps.clock ? deps.clock.nowMs() : Date.now();
}

function endPayload(task: TaskRecord, at: string): TaskStreamEvent {
  return {
    v: 1,
    type: 'end',
    taskId: task.id,
    attemptId: task.currentAttemptId,
    status: task.status as SettledTaskStatus,
    reason: task.statusReason,
    at,
  };
}

async function statusPayload(
  deps: AppDeps,
  task: TaskRecord,
  extra: { snapshot?: true; gap?: true },
): Promise<StatusEventPayload> {
  const attempt = task.currentAttemptId === null ? null : await deps.db.repos.attempts.findById(task.currentAttemptId);
  return {
    v: 1,
    type: 'status',
    taskId: task.id,
    attemptId: task.currentAttemptId,
    attemptNumber: attempt?.attemptNumber ?? null,
    status: task.status,
    previousStatus: null,
    reason: task.statusReason,
    detail: task.statusDetail,
    cancelRequested: task.cancelRequestedAt !== null,
    at: toIso(new Date(nowMs(deps))),
    ...extra,
  };
}

type Slot = 'redis' | 'memory';

/** Fails fast while the command connection is (re)connecting instead of waiting for its retries (F8). */
function assertRedisReady(deps: AppDeps): void {
  if (deps.commandRedis.status !== 'ready') {
    throw new OrcError('redis_unavailable', `Redis command connection is ${deps.commandRedis.status}`);
  }
}

/** Per-user cap through the Redis ZSET; Redis errors fall back to the in-memory per-process count (F8). */
async function acquireUserSlot(deps: AppDeps, conn: SseConnection): Promise<Slot | null> {
  const max = deps.config.sseMaxPerUser;
  const now = nowMs(deps);
  const ttl = zsetTtls(deps);
  try {
    assertRedisReady(deps);
    const admitted = await boundRedis(
      deps.commandRedis.eval(
        ADMIT_LUA,
        1,
        userZsetKey(deps, conn.userId),
        String(now),
        String(now + ttl.scoreTtlMs),
        conn.id,
        String(max),
        String(ttl.keyTtlSeconds),
      ),
      ADMISSION_REDIS_TIMEOUT_MS,
      'SSE admission',
    );
    return admitted === 1 ? 'redis' : null;
  } catch (err) {
    deps.logger.warn({ err, userId: conn.userId }, 'SSE admission ZSET unavailable: using the in-memory per-user cap');
    // The hub count already includes this reserved connection.
    return deps.runtime.sse.countFor(conn.userId) > max ? null : 'memory';
  }
}

interface LogPosition {
  attemptNumbers: Map<Uuid, number>;
  attemptNumber: number;
  attemptId: Uuid;
  seq: number;
}

class TaskEventStream implements SseConnection {
  readonly id = randomUUID();
  readonly userId: Uuid;
  private closed = false;
  private readonly abort = new AbortController();
  private readonly timers: NodeJS.Timeout[] = [];
  private lastR: string | null = null;
  private lastD: string | null = null;
  private lastStatus: TaskStatus | null = null;
  private endSeen = false;
  private settledBeats = 0;
  private slot: Slot | null = null;
  private resolveFinished: () => void = () => undefined;
  readonly finished = new Promise<void>((resolve) => {
    this.resolveFinished = resolve;
  });

  private readonly c: HandlerCtx<unknown, unknown, unknown>;
  private readonly deps: AppDeps;
  private readonly auth: AuthenticatedState;
  private readonly taskId: Uuid;
  private readonly reader: TaskStreamReader;

  constructor(
    c: HandlerCtx<unknown, unknown, unknown>,
    deps: AppDeps,
    auth: AuthenticatedState,
    taskId: Uuid,
    reader: TaskStreamReader,
  ) {
    this.c = c;
    this.deps = deps;
    this.auth = auth;
    this.taskId = taskId;
    this.reader = reader;
    this.userId = auth.user.id;
  }

  setSlot(slot: Slot): void {
    this.slot = slot;
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** Writes one event; returns false once the stream is closed (also after a backpressure close). */
  send(id: string | null, type: string, data: unknown): boolean {
    const res = this.c.res;
    if (this.closed) return false;
    if (res.writableEnded || res.destroyed) {
      // The client went away without a `close` we observed (e.g. before open()): release everything now.
      this.close();
      return false;
    }
    let frame = id === null ? '' : `id: ${id}\n`;
    frame += `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    res.write(frame);
    if (res.writableLength > this.deps.config.sseMaxBufferBytes) {
      this.deps.logger.warn({ taskId: this.taskId, buffered: res.writableLength }, 'SSE client too slow: closing');
      this.close();
      return false;
    }
    return true;
  }

  private sendError(code: ErrorCode, message: string): void {
    this.send(null, 'error', { v: 1, type: 'error', code, message, at: toIso(new Date(nowMs(this.deps))) });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    for (const t of this.timers) clearInterval(t);
    const res = this.c.res;
    if (!res.writableEnded) res.end();
    this.deps.runtime.sse.release(this);
    void this.reader.close();
    if (this.slot === 'redis') {
      const key = userZsetKey(this.deps, this.userId);
      boundRedis(this.deps.commandRedis.zrem(key, this.id), ADMISSION_REDIS_TIMEOUT_MS, 'ZREM').catch(
        (err: unknown) => {
          this.deps.logger.warn({ err, userId: this.userId }, 'SSE ZSET member removal failed');
        },
      );
    }
    this.resolveFinished();
  }

  /** Starts the event stream; false (and closed) when the client already disconnected during admission. */
  open(): boolean {
    const { req, res } = this.c;
    state(res).eventStream = true;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.on('close', () => this.close());
    if (res.destroyed || req.socket.destroyed) {
      // `close` was emitted while admission was awaiting the DB/Redis and will never fire again.
      this.close();
      return false;
    }
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const cfg = this.deps.config;
    this.timers.push(
      setInterval(() => {
        this.heartbeat().catch((err: unknown) => this.deps.logger.warn({ err, taskId: this.taskId }, 'SSE heartbeat failed'));
      }, cfg.sseHeartbeatMs),
      setInterval(() => {
        this.recheck().catch((err: unknown) => this.deps.logger.warn({ err, taskId: this.taskId }, 'SSE re-validation failed'));
      }, cfg.sseSessionRecheckMs),
      setTimeout(() => this.close(), cfg.sseMaxDurationMs),
    );
    return true;
  }

  private async heartbeat(): Promise<void> {
    if (this.closed) return;
    this.send(null, 'heartbeat', { v: 1, type: 'heartbeat', at: toIso(new Date(nowMs(this.deps))) });
    if (this.slot === 'redis') {
      const key = userZsetKey(this.deps, this.userId);
      const ttl = zsetTtls(this.deps);
      try {
        assertRedisReady(this.deps);
        await boundRedis(
          this.deps.commandRedis.zadd(key, 'XX', String(nowMs(this.deps) + ttl.scoreTtlMs), this.id),
          ADMISSION_REDIS_TIMEOUT_MS,
          'ZADD',
        );
        await boundRedis(this.deps.commandRedis.expire(key, ttl.keyTtlSeconds), ADMISSION_REDIS_TIMEOUT_MS, 'EXPIRE');
      } catch (err) {
        this.deps.logger.warn({ err, userId: this.userId }, 'SSE ZSET refresh failed');
      }
    }
    const task = await this.deps.db.repos.tasks.findById(this.taskId);
    if (this.closed || task === null || !isSettledStatus(task.status) || this.endSeen) return;
    this.settledBeats += 1;
    if (this.settledBeats >= SETTLED_HEARTBEATS_BEFORE_SYNTHETIC_END) {
      // The `end` publication was lost: synthesize status + end (no ids) and close (§8.3 step 6).
      this.send(null, 'status', await statusPayload(this.deps, task, {}));
      this.send(null, 'end', endPayload(task, toIso(new Date(nowMs(this.deps)))));
      this.endSeen = true;
      this.close();
    }
  }

  private async recheck(): Promise<void> {
    if (this.closed) return;
    const repos = this.deps.db.repos;
    const cred = this.auth.credential;
    const found =
      cred.kind === 'session'
        ? await repos.authSessions.findActiveByTokenHash(cred.tokenHash)
        : await repos.apiTokens.findActiveByHash(cred.tokenHash);
    if (this.closed) return;
    if (found === null || !found.user.isActive) {
      this.sendError('session_expired', 'Session expired');
      this.close();
      return;
    }
    if ('session' in found) {
      // A live stream is session activity: extend the idle expiry (SQL caps it at the absolute ExpiresAt, §15.2).
      try {
        await repos.authSessions.touch(found.session.id, this.deps.config.sessionIdleTtlSeconds);
      } catch (err) {
        this.deps.logger.warn({ err, sessionId: found.session.id }, 'SSE session idle extension failed');
      }
      if (this.closed) return;
    }
    // Visibility is re-evaluated with the user's current role: a role change does not revoke PATs (§15.2, §15.5).
    const visible = await repos.tasks.findVisible(this.taskId, taskViewer(viewerOf(found.user, cred)));
    if (this.closed) return;
    if (visible === null) {
      this.sendError('not_found', 'Resource not found');
      this.close();
    }
  }

  async sendSnapshot(task: TaskRecord, gap: boolean): Promise<void> {
    this.lastStatus = task.status;
    this.send(null, 'status', await statusPayload(this.deps, task, gap ? { snapshot: true, gap: true } : { snapshot: true }));
  }

  // ---- Redis mode --------------------------------------------------------------------------------

  private async logPosition(rowId: string): Promise<LogPosition | null> {
    const repos = this.deps.db.repos;
    const before = BigInt(rowId) - 1n;
    const rows = await repos.taskLogs.listByTaskAfterId({
      taskId: this.taskId,
      afterId: before > 0n ? before.toString() : null,
      limit: 1,
    });
    const row = rows[0];
    if (row === undefined || row.id !== rowId) return null;
    const attempts = await repos.attempts.listByTask(this.taskId);
    const attemptNumbers = new Map(attempts.map((a) => [a.id, a.attemptNumber] as const));
    return {
      attemptNumbers,
      attemptNumber: attemptNumbers.get(row.attemptId) ?? 0,
      attemptId: row.attemptId,
      seq: row.seq,
    };
  }

  /** Forwards one stream entry; false once the stream ended or closed. */
  private forward(entry: StreamEntry, drop: LogPosition | null): boolean {
    this.lastR = entry.id;
    const e = entry.event;
    if (e.type === 'log' && drop !== null) {
      const n = drop.attemptNumbers.get(e.attemptId) ?? Number.MAX_SAFE_INTEGER;
      if (n < drop.attemptNumber || (e.attemptId === drop.attemptId && e.seq <= drop.seq)) return true;
    }
    if (e.type === 'status') this.lastStatus = e.status;
    if (!this.send(`r-${entry.id}`, e.type, e)) return false;
    if (e.type === 'end') {
      this.endSeen = true;
      this.close();
      return false;
    }
    return true;
  }

  async redisMode(resume: ResumePoint): Promise<void> {
    let after: string | null = resume?.kind === 'r' ? resume.id : null;
    let drop: LogPosition | null = null;
    if (resume?.kind === 'd') {
      this.lastD = resume.id;
      drop = await this.logPosition(resume.id);
    }
    for (;;) {
      if (this.closed) return;
      const page = await this.reader.range(this.taskId, after, RANGE_PAGE);
      for (const entry of page) {
        after = entry.id;
        if (!this.forward(entry, drop)) return;
      }
      if (page.length < RANGE_PAGE) break;
    }
    let lastId = after ?? '0-0';
    while (!this.closed) {
      const entries = await this.reader.read(this.taskId, lastId, XREAD_BLOCK_MS, this.abort.signal);
      for (const entry of entries) {
        lastId = entry.id;
        if (!this.forward(entry, drop)) return;
      }
    }
  }

  /** Where the DB replay starts after a Redis failure (§8.3 step 4, F8). */
  fallbackFilter(resume: ResumePoint): DbReplayFilter {
    if (this.lastD !== null) return { afterRowId: this.lastD };
    const r = this.lastR ?? (resume?.kind === 'r' ? resume.id : null);
    if (r !== null) return { minCreatedMs: Number(streamIdParts(r)[0]) - 1000 };
    return {};
  }

  // ---- DB mode -----------------------------------------------------------------------------------

  async dbMode(filter: DbReplayFilter): Promise<void> {
    const repos = this.deps.db.repos;
    const replayer = new DbReplayer(this.deps.db, this.taskId, filter);
    const emit = (rowId: string, event: TaskStreamEvent): boolean => {
      this.lastD = rowId;
      return this.send(`d-${rowId}`, event.type, event);
    };
    const isClosed = (): boolean => this.closed;
    if (!(await replayer.pump(emit, isClosed))) return;
    for (;;) {
      const task = await repos.tasks.findById(this.taskId);
      if (this.closed) return;
      if (task === null) {
        this.sendError('not_found', 'Resource not found');
        this.close();
        return;
      }
      if (isSettledStatus(task.status)) {
        if (!(await replayer.pump(emit, isClosed))) return;
        if (this.lastStatus !== task.status) this.send(null, 'status', await statusPayload(this.deps, task, {}));
        this.send('d-end', 'end', endPayload(task, toIso(new Date(nowMs(this.deps)))));
        this.endSeen = true;
        this.close();
        return;
      }
      if (this.lastStatus !== task.status) {
        this.lastStatus = task.status;
        this.send(null, 'status', await statusPayload(this.deps, task, {}));
      }
      await this.sleep(this.deps.config.sseDbPollMs);
      if (!(await replayer.pump(emit, isClosed))) return;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.closed) {
        resolve();
        return;
      }
      const timer = setTimeout(done, ms);
      const signal = this.abort.signal;
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    });
  }

  /** Runs the stream to completion; failures become an SSE `error` event (headers are already sent). */
  async run(task: TaskRecord, resume: ResumePoint, streamExists: boolean | null, gap: boolean): Promise<void> {
    try {
      await this.sendSnapshot(task, gap);
      if (streamExists === true) {
        try {
          await this.redisMode(resume);
          return;
        } catch (err) {
          if (this.closed) return;
          this.deps.logger.warn({ err, taskId: this.taskId }, 'SSE Redis read failed: switching to DB replay');
          await this.dbMode(this.fallbackFilter(resume));
          return;
        }
      }
      const filter: DbReplayFilter =
        resume?.kind === 'd'
          ? { afterRowId: resume.id }
          : resume?.kind === 'r'
            ? { minCreatedMs: Number(streamIdParts(resume.id)[0]) - 1000 }
            : {};
      await this.dbMode(filter);
    } catch (err) {
      if (this.closed) return;
      const p = toPublicProblem(err);
      if (p.internal) this.deps.logger.error({ err, taskId: this.taskId }, 'SSE stream failed');
      else this.deps.logger.warn({ err, taskId: this.taskId }, 'SSE stream failed');
      this.sendError(p.code, p.status >= 500 ? 'Stream interrupted' : (p.detail ?? p.code));
      this.close();
    }
  }
}

/** 204 rule (§8.3 step 2): settled task and nothing after the resume point. */
async function nothingAfter(
  reader: TaskStreamReader,
  taskId: Uuid,
  resume: ResumePoint,
  streamExists: boolean | null,
): Promise<boolean> {
  if (resume?.kind === 'd-end') return true;
  if (resume?.kind === 'r' && streamExists === true) {
    try {
      return (await reader.range(taskId, resume.id, 1)).length === 0;
    } catch {
      return false;
    }
  }
  return false;
}

export async function streamTask(
  c: HandlerCtx<unknown, unknown, unknown>,
  taskId: Uuid,
  queryLastEventId: string | undefined,
): Promise<void> {
  const deps = c.deps;
  const auth = c.auth();
  const task = await deps.db.repos.tasks.findVisible(taskId, taskViewer(auth.viewer));
  if (task === null) throw new NotFoundError('Task not found');
  const resume = parseResume(c.req.get('last-event-id') ?? queryLastEventId);
  const reader = createTaskStreamReader(deps.redis, {
    prefix: deps.config.redis.prefix,
    ...(deps.sseRedisTimeoutMs !== undefined ? { commandTimeoutMs: deps.sseRedisTimeoutMs } : {}),
  });
  const stream = new TaskEventStream(c, deps, auth, taskId, reader);
  let started = false;
  try {
    let streamExists: boolean | null;
    try {
      streamExists = await reader.exists(taskId);
    } catch (err) {
      deps.logger.warn({ err, taskId }, 'SSE stream probe failed: using DB replay');
      streamExists = null;
    }
    if (isSettledStatus(task.status) && (await nothingAfter(reader, taskId, resume, streamExists))) {
      c.res.status(204).end();
      return;
    }
    let gap = false;
    if (resume?.kind === 'r' && streamExists === true) {
      try {
        const first = await reader.firstId(taskId);
        gap = first !== null && compareStreamIds(resume.id, first) < 0;
      } catch {
        gap = false;
      }
    }
    if (!deps.runtime.sse.reserve(stream, deps.config.sseMaxPerProcess)) {
      throw new OrcError('service_unavailable', 'Too many live streams on this server', {
        details: { retryAfterSeconds: RETRY_AFTER_SECONDS },
      });
    }
    const slot = await acquireUserSlot(deps, stream);
    if (slot === null) {
      deps.runtime.sse.release(stream);
      throw new OrcError('sse_connection_limit', 'Too many live streams for this user', {
        details: { retryAfterSeconds: RETRY_AFTER_SECONDS },
      });
    }
    stream.setSlot(slot);
    started = true;
    if (stream.open()) void stream.run(task, resume, streamExists, gap);
    await stream.finished;
  } finally {
    if (!started) await reader.close();
  }
}
