// Redis outage behaviour (contract §8.1, §8.3, §9.6, F8) with a cuttable TCP proxy in front of redis-test:
// every rate-limit class fails open except `login` (503 dependency_unavailable), SSE admission falls back to the
// in-memory per-user cap + DB replay, a live SSE stream switches to DB tail mode, and POST /tasks still answers 202.
// The per-IP authentication throttle falls back to an in-memory counter, so bogus credentials stay bounded.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Database, ProjectRecord, UserRecord } from '@orc/database';
import { openDb, resetDb } from '../helpers/database/db';
import { createReadyProject, seededAgent } from '../helpers/database/fixtures';
import { cleanupPrefix, testRedisConfig } from '../helpers/task-manager/redis';
import { TEST_PASSWORD, authHeaders, call, createApiHarness, createLoginUser, createPat, listen, login, problemOf } from '../helpers/api/harness';
import type { ApiHarness, SessionAuth, TokenAuth } from '../helpers/api/harness';
import { SseClient } from '../helpers/api/sse-client';
import { startTcpProxy } from '../helpers/api/tcp-proxy';
import { callsOf, withCallCounts } from '../helpers/api/counting-db';
import type { CallCounts } from '../helpers/api/counting-db';
import type { TcpProxy } from '../helpers/api/tcp-proxy';
import { claim, seedLogs, settleFailed } from '../helpers/api/world';

interface TaskBody {
  id: string;
  currentAttemptId: string;
  status: string;
}

describe('Redis outage (F8)', () => {
  let proxy: TcpProxy;
  let h: ApiHarness;
  let server: { url: string; close(): Promise<void> };
  let worker: Database;
  let admin: UserRecord;
  let project: ProjectRecord;
  let s: SessionAuth;
  let pat: TokenAuth;
  const clients: SseClient[] = [];
  const counts: CallCounts = new Map();

  beforeAll(async () => {
    const target = testRedisConfig('x');
    proxy = await startTcpProxy(target.host, target.port);
    h = await createApiHarness({
      redis: { host: '127.0.0.1', port: proxy.port },
      sseRedisTimeoutMs: 1_000,
      queueOpTimeoutMs: 1_000,
      env: { SSE_DB_POLL_MS: '100', SSE_HEARTBEAT_MS: '1000', SSE_MAX_PER_USER: '2' },
      patchDeps: (deps) => ({ ...deps, db: withCallCounts(deps.db, counts) }),
    });
    server = await listen(h.app);
    worker = await openDb('orc_worker');
    admin = await createLoginUser(h.db, { role: 'admin' });
    project = await createReadyProject(h.db, admin, await seededAgent(h.db));
    s = await login(h.app, admin.username);
    pat = await createPat(h.app, s);
  });

  afterAll(async () => {
    for (const c of clients) c.close();
    await server.close();
    await h.close();
    await proxy.close();
    await worker.close();
    expect(await cleanupPrefix(h.prefix)).toBe(0);
    await resetDb();
  });

  const createTask = async (): Promise<TaskBody> => {
    const res = await call(h.app, 'post', '/api/v1/tasks', pat).send({ projectId: project.id, title: 'Outage', prompt: 'Run.' });
    expect(res.status).toBe(202);
    return res.body as TaskBody;
  };

  it('switches a live SSE stream to DB tail mode when Redis fails mid-stream', async () => {
    const task = await createTask();
    await claim(worker, task.currentAttemptId);
    const c = await SseClient.open(`${server.url}/api/v1/tasks/${task.id}/stream`, authHeaders(s));
    clients.push(c);
    expect(c.status).toBe(200);
    await c.until((ev) => ev.some((e) => e.id?.startsWith('r-') === true));

    await proxy.cut();
    await seedLogs(worker, { taskId: task.id, attemptId: task.currentAttemptId });
    await c.until((ev) => ev.some((e) => e.event === 'log' && e.id?.startsWith('d-') === true), 20_000);
    await settleFailed(worker, task.id, task.currentAttemptId);
    await c.waitEnd(10_000);
    expect(c.events.at(-1)).toMatchObject({ id: 'd-end', event: 'end', data: { status: 'failed' } });
    expect(c.events.filter((e) => e.event === 'claude')).toHaveLength(1);
  });

  it('fails open for read, write, auth, task_create, stream and public; POST /tasks still answers 202', async () => {
    const read = await call(h.app, 'get', '/api/v1/projects', s);
    expect(read.status).toBe(200);
    expect(read.headers['ratelimit-limit']).toBeUndefined();

    const get = await call(h.app, 'get', `/api/v1/projects/${project.id}`, s);
    const write = await call(h.app, 'patch', `/api/v1/projects/${project.id}`, s)
      .set('If-Match', String(get.headers['etag']))
      .send({ description: 'during outage' });
    expect(write.status).toBe(200);

    const auth = await call(h.app, 'post', '/api/v1/auth/tokens', s).send({ name: 'outage-token' });
    expect(auth.status).toBe(201);

    const task = await createTask();
    expect(task.status).toBe('queued');
    expect((await h.db.repos.tasks.findById(task.id))?.status).toBe('queued');

    const pub = await request(h.app).get('/api/v1/problems/not_found');
    expect(pub.status).toBe(200);

    // stream: admission uses the in-memory per-user cap (2) and replays from MSSQL.
    const a = await SseClient.open(`${server.url}/api/v1/tasks/${task.id}/stream`, authHeaders(s));
    const b = await SseClient.open(`${server.url}/api/v1/tasks/${task.id}/stream`, authHeaders(s));
    clients.push(a, b);
    expect([a.status, b.status]).toEqual([200, 200]);
    await a.until((ev) => ev.length >= 1);
    expect(a.events[0]).toMatchObject({ event: 'status', data: { snapshot: true, status: 'queued' } });
    const third = await SseClient.open(`${server.url}/api/v1/tasks/${task.id}/stream`, authHeaders(s));
    clients.push(third);
    expect(third.status).toBe(429);
    expect(await third.json()).toMatchObject({ code: 'sse_connection_limit' });
    a.close();
    b.close();
  });

  it('fails closed for login (503 dependency_unavailable + Retry-After: 5)', async () => {
    const res = await request(h.app).post('/api/v1/auth/login').send({ username: admin.username, password: TEST_PASSWORD });
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(problemOf(res).code).toBe('dependency_unavailable');
  });

  it('GET /system/queue answers 503 dependency_unavailable', async () => {
    const res = await call(h.app, 'get', '/api/v1/system/queue', s);
    expect(res.status).toBe(503);
    expect(problemOf(res).code).toBe('dependency_unavailable');
    expect(res.headers['retry-after']).toBe('5');
  });

  // Last: it exhausts the in-memory auth budget of the test client's IP, which then refuses even valid credentials.
  it('bounds bogus bearer-token lookups per IP with the in-memory fallback (auth class: 30, then 429)', async () => {
    const before = callsOf(counts, 'apiTokens.findActiveByHash');
    const answers = new Map<number, number>();
    for (let i = 0; i < 36; i += 1) {
      const r = await request(h.app)
        .get('/api/v1/projects')
        .set('Authorization', `Bearer orc_pat_${randomBytes(24).toString('base64url')}`);
      answers.set(r.status, (answers.get(r.status) ?? 0) + 1);
    }
    expect(Object.fromEntries(answers)).toEqual({ 401: 30, 429: 6 });
    expect(callsOf(counts, 'apiTokens.findActiveByHash') - before).toBe(30);
  });
});
