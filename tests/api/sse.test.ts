// SSE stream endpoint against mssql-test + redis-test (contract §8): admission (401/404/429), wire format, status
// snapshot, Redis replay + Last-Event-ID resume, live XREAD tail, heartbeat, end, 204 rule, DB replay / tail fallback,
// synthetic end after lost publications and session re-validation (which extends the session idle TTL, §15.2).
import { get as httpGet } from 'node:http';
import sql from 'mssql';
import { sha256 } from '@orc/security';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import type { Database, ProjectRecord, UserRecord } from '@orc/database';
import { createTaskStreamPublisher, taskStreamKey } from '@orc/task-manager';
import type { TaskStreamPublisher } from '@orc/task-manager';
import { openDb, openPool, query, resetDb } from '../helpers/database/db';
import { createReadyProject, seededAgent } from '../helpers/database/fixtures';
import { cleanupPrefix, rawRedis } from '../helpers/task-manager/redis';
import { silentLogger } from '../helpers/database/env';
import { authHeaders, call, createApiHarness, createLoginUser, createPat, login, listen } from '../helpers/api/harness';
import type { ApiHarness, Auth, SessionAuth } from '../helpers/api/harness';
import { withDelayedFindVisible } from '../helpers/api/slow-db';
import { SseClient } from '../helpers/api/sse-client';
import type { SseEvent } from '../helpers/api/sse-client';
import { claim, seedLogs, settleFailed } from '../helpers/api/world';

interface TaskBody {
  id: string;
  currentAttemptId: string;
}

const types = (events: readonly SseEvent[]): string[] => events.map((e) => e.event);

describe('GET /api/v1/tasks/:taskId/stream', () => {
  let h: ApiHarness;
  let server: { url: string; close(): Promise<void> };
  let worker: Database;
  let raw: Redis;
  let publisher: TaskStreamPublisher;
  let project: ProjectRecord;
  let owner: UserRecord;
  let other: UserRecord;
  let sOwner: SessionAuth;
  let sOther: SessionAuth;
  let migrator: sql.ConnectionPool;
  const clients: SseClient[] = [];

  const sessionHash = (s: SessionAuth): Buffer => sha256(s.cookie.slice(s.cookie.indexOf('=') + 1));
  /** Sets the session's expiries to now + the given seconds (DB time) and marks it as just seen. */
  const expireSessionIn = async (s: SessionAuth, idleSeconds: number, absoluteSeconds: number | null): Promise<void> => {
    await query(
      migrator,
      `UPDATE orc.AuthSessions SET
         ExpiresAt = CASE WHEN @abs IS NULL THEN ExpiresAt ELSE DATEADD(SECOND, @abs, SYSUTCDATETIME()) END,
         IdleExpiresAt = DATEADD(SECOND, @idle, SYSUTCDATETIME()), LastSeenAt = SYSUTCDATETIME()
       WHERE TokenHash = @h;`,
      [
        ['h', sql.VarBinary(32), sessionHash(s)],
        ['idle', sql.Int, idleSeconds],
        ['abs', sql.Int, absoluteSeconds],
      ],
    );
  };
  const sessionExpiries = async (s: SessionAuth): Promise<{ idleLeft: number; absoluteLeft: number }> => {
    const rows = await query<{ IdleLeft: number; AbsoluteLeft: number }>(
      migrator,
      `SELECT DATEDIFF(SECOND, SYSUTCDATETIME(), IdleExpiresAt) AS IdleLeft,
              DATEDIFF(SECOND, SYSUTCDATETIME(), ExpiresAt) AS AbsoluteLeft
       FROM orc.AuthSessions WHERE TokenHash = @h;`,
      [['h', sql.VarBinary(32), sessionHash(s)]],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('session row missing');
    return { idleLeft: row.IdleLeft, absoluteLeft: row.AbsoluteLeft };
  };

  const open = async (taskId: string, auth: Auth | null, headers: Record<string, string> = {}, query = '') => {
    const c = await SseClient.open(`${server.url}/api/v1/tasks/${taskId}/stream${query}`, {
      ...(auth ? authHeaders(auth) : {}),
      ...headers,
    });
    clients.push(c);
    return c;
  };

  const createTask = async (): Promise<TaskBody> => {
    const res = await call(h.app, 'post', '/api/v1/tasks', sOwner).send({
      projectId: project.id,
      title: 'Streamed task',
      prompt: 'Do the thing.',
    });
    expect(res.status).toBe(202);
    return res.body as TaskBody;
  };

  beforeAll(async () => {
    h = await createApiHarness({
      env: {
        SSE_HEARTBEAT_MS: '1000',
        SSE_SESSION_RECHECK_MS: '1000',
        SSE_DB_POLL_MS: '100',
        SSE_MAX_PER_USER: '2',
      },
    });
    server = await listen(h.app);
    worker = await openDb('orc_worker');
    migrator = await openPool('orc_migrator', 1);
    raw = rawRedis(h.prefix);
    publisher = createTaskStreamPublisher(h.redis.create('command', 'test-publisher'), {
      prefix: h.prefix,
      logger: silentLogger(),
    });
    owner = await createLoginUser(h.db, { role: 'operator' });
    other = await createLoginUser(h.db, { role: 'operator' });
    project = await createReadyProject(h.db, owner, await seededAgent(h.db));
    sOwner = await login(h.app, owner.username);
    sOther = await login(h.app, other.username);
  });

  afterAll(async () => {
    for (const c of clients) c.close();
    await server.close();
    await h.close();
    await raw.quit();
    await worker.close();
    await migrator.close();
    expect(await cleanupPrefix(h.prefix)).toBe(0);
    await resetDb();
  });

  it('answers 401 without credentials and 404 (JSON, before any SSE bytes) for an invisible task', async () => {
    const task = await createTask();
    const anon = await open(task.id, null);
    expect(anon.status).toBe(401);
    expect(await anon.json()).toMatchObject({ code: 'unauthenticated' });
    const foreign = await open(task.id, sOther);
    expect(foreign.status).toBe(404);
    expect(foreign.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    expect(await foreign.json()).toMatchObject({ code: 'not_found' });
  });

  it('streams snapshot, replay, live events and heartbeat, then ends on `end`; resume and the 204 rule', async () => {
    const task = await createTask();
    const c = await open(task.id, sOwner);
    expect(c.status).toBe(200);
    expect(c.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(c.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(c.headers.get('x-accel-buffering')).toBe('no');
    expect(c.headers.get('x-request-id')).toBeTruthy();

    await c.until((ev) => ev.length >= 2);
    expect(c.retry).toBe(3000);
    const [snapshot, replayed] = c.events;
    expect(snapshot).toMatchObject({ id: null, event: 'status', data: { snapshot: true, status: 'queued', taskId: task.id } });
    expect(replayed?.event).toBe('status');
    expect(replayed?.id).toMatch(/^r-\d+-\d+$/);

    const logId = await publisher.publish(task.id, {
      v: 1,
      type: 'log',
      taskId: task.id,
      attemptId: task.currentAttemptId,
      seq: 0,
      stream: 'stdout',
      source: 'orchestrator',
      content: 'live line',
      at: new Date().toISOString(),
    });
    await c.until((ev) => ev.some((e) => e.event === 'log'));
    expect(c.events.find((e) => e.event === 'log')).toMatchObject({ id: `r-${logId}`, data: { content: 'live line' } });
    await c.until((ev) => ev.some((e) => e.event === 'heartbeat'), 5_000);
    expect(c.events.find((e) => e.event === 'heartbeat')?.id).toBeNull();

    const cancel = await call(h.app, 'post', `/api/v1/tasks/${task.id}/cancel`, sOwner).send({});
    expect(cancel.status).toBe(200);
    await c.waitEnd();
    const end = c.events.at(-1);
    expect(end).toMatchObject({ event: 'end', data: { status: 'cancelled', taskId: task.id } });
    expect(end?.id).toMatch(/^r-/);

    // Resume after the live log entry: only the later entries (status cancelled + end) are replayed.
    const resumed = await open(task.id, sOwner, { 'Last-Event-ID': `r-${logId}` });
    await resumed.waitEnd();
    expect(types(resumed.events)).toEqual(['status', 'status', 'end']);
    expect(resumed.events[1]).toMatchObject({ data: { status: 'cancelled' } });

    // Resume point = the final end entry (or d-end) of a settled task => 204 (EventSource stops).
    const done = await open(task.id, sOwner, { 'Last-Event-ID': end?.id ?? '' });
    expect(done.status).toBe(204);
    const dEnd = await open(task.id, sOwner, {}, '?lastEventId=d-end');
    expect(dEnd.status).toBe(204);
  });

  it('enforces SSE_MAX_PER_USER through the Redis ZSET (429 sse_connection_limit + Retry-After) and frees slots on close', async () => {
    const task = await createTask();
    const a = await open(task.id, sOwner);
    const b = await open(task.id, sOwner);
    expect([a.status, b.status]).toEqual([200, 200]);
    await a.until((ev) => ev.length >= 1);
    const third = await open(task.id, sOwner);
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBe('5');
    expect(await third.json()).toMatchObject({ code: 'sse_connection_limit' });
    expect(await raw.zcard(`${h.prefix}:sse:user:${owner.id}`)).toBe(2);

    a.close();
    const deadline = Date.now() + 5_000;
    while ((await raw.zcard(`${h.prefix}:sse:user:${owner.id}`)) > 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const fourth = await open(task.id, sOwner);
    expect(fourth.status).toBe(200);
    b.close();
    fourth.close();
  });

  it('replays from MSSQL when the Redis stream is missing (d- ids, claude lines reassembled, d-end) and resumes by d- id', async () => {
    const task = await createTask();
    await claim(worker, task.currentAttemptId);
    await seedLogs(worker, { taskId: task.id, attemptId: task.currentAttemptId });
    await settleFailed(worker, task.id, task.currentAttemptId);
    await raw.del(taskStreamKey(h.prefix, task.id));

    const c = await open(task.id, sOwner);
    expect(c.status).toBe(200);
    await c.waitEnd();
    expect(types(c.events)).toEqual(['status', 'log', 'claude', 'log', 'end']);
    expect(c.events[0]).toMatchObject({ data: { snapshot: true, status: 'failed' } });
    expect(c.events[1]).toMatchObject({ data: { type: 'log', seq: 0, content: 'first line\n' } });
    expect(c.events[2]).toMatchObject({ data: { type: 'claude', kind: 'assistant_text', line: 1, text: 'Hello from Claude' } });
    expect(c.events[3]).toMatchObject({ data: { seq: 3, stream: 'stderr' } });
    expect(c.events[4]).toMatchObject({ id: 'd-end', data: { status: 'failed' } });
    // The claude line carries the id of the row holding its final newline (seq 2, after the seq 1 fragment).
    const ids = c.events.slice(1, 4).map((e) => BigInt((e.id ?? 'd-0').slice(2)));
    expect(ids[1]).toBe((ids[0] ?? 0n) + 2n);

    const resumed = await open(task.id, sOwner, { 'Last-Event-ID': c.events[2]?.id ?? '' });
    await resumed.waitEnd();
    expect(types(resumed.events)).toEqual(['status', 'log', 'end']);
  });

  it('DB tail mode: stream missing and task active => polls TaskLogs and ends when the task settles', async () => {
    const task = await createTask();
    await claim(worker, task.currentAttemptId);
    await raw.del(taskStreamKey(h.prefix, task.id));
    const c = await open(task.id, sOwner);
    await c.until((ev) => ev.length >= 1);
    expect(c.events[0]).toMatchObject({ data: { snapshot: true, status: 'preparing_workspace' } });
    await seedLogs(worker, { taskId: task.id, attemptId: task.currentAttemptId });
    await c.until((ev) => ev.filter((e) => e.event === 'log').length >= 2);
    await settleFailed(worker, task.id, task.currentAttemptId);
    await c.waitEnd();
    expect(c.events.at(-1)).toMatchObject({ id: 'd-end', event: 'end', data: { status: 'failed' } });
  });

  it('synthesizes status + end (no ids) after 2 heartbeats when the task settled without an end publication', async () => {
    const task = await createTask();
    const c = await open(task.id, sOwner);
    await c.until((ev) => ev.length >= 2);
    await claim(worker, task.currentAttemptId);
    await settleFailed(worker, task.id, task.currentAttemptId);
    await c.waitEnd(10_000);
    const tail = c.events.slice(-2);
    expect(tail.map((e) => [e.event, e.id])).toEqual([
      ['status', null],
      ['end', null],
    ]);
    expect(tail[1]).toMatchObject({ data: { status: 'failed' } });
  });

  it('re-validates the session: logout during the stream => error session_expired and close', async () => {
    const s = await login(h.app, owner.username);
    const task = await createTask();
    const c = await open(task.id, s);
    await c.until((ev) => ev.length >= 1);
    expect((await call(h.app, 'post', '/api/v1/auth/logout', s)).status).toBe(204);
    await c.waitEnd(10_000);
    expect(c.events.at(-1)).toMatchObject({ event: 'error', id: null, data: { type: 'error', code: 'session_expired' } });
  });

  it('extends the session idle TTL on each re-check: a cookie stream outlives the idle expiry it started with', async () => {
    const s = await login(h.app, owner.username);
    const task = await createTask();
    await expireSessionIn(s, 3, null);
    const c = await open(task.id, s);
    expect(c.status).toBe(200);
    await c.until((ev) => ev.filter((e) => e.event === 'heartbeat').length >= 6, 20_000);
    expect(c.ended).toBe(false);
    expect(c.events.filter((e) => e.event === 'error')).toEqual([]);
    const { idleLeft } = await sessionExpiries(s);
    expect(idleLeft).toBeGreaterThan(h.config.sessionIdleTtlSeconds - 30);
    expect((await call(h.app, 'get', `/api/v1/tasks/${task.id}`, s)).status).toBe(200);
    c.close();
  });

  it('the idle extension is capped at the absolute expiry: the stream still ends with session_expired', async () => {
    const s = await login(h.app, owner.username);
    const task = await createTask();
    await expireSessionIn(s, 3, 3);
    const c = await open(task.id, s);
    expect(c.status).toBe(200);
    await c.waitEnd(15_000);
    expect(c.events.at(-1)).toMatchObject({ event: 'error', id: null, data: { type: 'error', code: 'session_expired' } });
    const { idleLeft, absoluteLeft } = await sessionExpiries(s);
    expect(idleLeft).toBeLessThanOrEqual(absoluteLeft);
    expect(absoluteLeft).toBeLessThanOrEqual(0);
  });

  it('re-validates visibility with the current role: a PAT of a demoted admin gets error not_found', async () => {
    const admin = await createLoginUser(h.db, { role: 'admin' });
    const pat = await createPat(h.app, await login(h.app, admin.username));
    const task = await createTask();
    const c = await open(task.id, pat);
    expect(c.status).toBe(200);
    await c.until((ev) => ev.length >= 1);
    const fresh = await h.db.repos.users.findById(admin.id);
    if (fresh === null) throw new Error('admin vanished');
    await h.db.repos.users.update(admin.id, fresh.rowVer, { role: 'operator' });
    await c.waitEnd(10_000);
    expect(c.events.at(-1)).toMatchObject({ event: 'error', id: null, data: { type: 'error', code: 'not_found' } });
  });

  it('releases the process slot and the ZSET member when the client disconnects during admission', async () => {
    let delayMs = 0;
    const slow = await createApiHarness({
      env: { SSE_MAX_PER_USER: '2' },
      patchDeps: (deps) => ({ ...deps, db: withDelayedFindVisible(deps.db, () => delayMs) }),
    });
    const slowServer = await listen(slow.app);
    const slowRaw = rawRedis(slow.prefix);
    try {
      const task = await createTask();
      delayMs = 600;
      const req = httpGet(`${slowServer.url}/api/v1/tasks/${task.id}/stream`, { headers: authHeaders(sOwner) });
      req.on('error', () => undefined);
      await new Promise((r) => setTimeout(r, 150));
      req.destroy();
      await new Promise((r) => setTimeout(r, 1_500));
      expect(slow.deps.runtime.sse.size()).toBe(0);
      expect(await slowRaw.zcard(`${slow.prefix}:sse:user:${owner.id}`)).toBe(0);
    } finally {
      delayMs = 0;
      await slowServer.close();
      await slow.close();
      await slowRaw.quit();
      expect(await cleanupPrefix(slow.prefix)).toBe(0);
    }
  });
});
