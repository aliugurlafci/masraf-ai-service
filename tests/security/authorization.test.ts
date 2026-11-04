// Requirements §15 "SSE authorization" and "a user cannot see another user's task" (contract §15.1,
// §15.5, §18.5): every task-scoped endpoint, including the SSE stream, cancel and retry, answers 404
// to another operator (session and PAT alike) and changes nothing; auditors read but never write;
// read-only PATs never write; anonymous callers get 401.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProjectRecord, UserRecord } from '@orc/database';
import { resetDb } from '../helpers/database/db';
import { createReadyProject, seededAgent } from '../helpers/database/fixtures';
import { cleanupPrefix } from '../helpers/task-manager/redis';
import { authHeaders, call, createApiHarness, createLoginUser, createPat, listen, login, problemOf } from '../helpers/api/harness';
import type { ApiHarness, Auth, SessionAuth, TokenAuth } from '../helpers/api/harness';
import { SseClient } from '../helpers/api/sse-client';

interface TaskBody {
  id: string;
  status: string;
  currentAttemptId: string;
}

let h: ApiHarness;
let server: { url: string; close(): Promise<void> };
let project: ProjectRecord;
let opA: UserRecord;
let opB: UserRecord;
let auditor: UserRecord;
let admin: UserRecord;
let sA: SessionAuth;
let sB: SessionAuth;
let sAuditor: SessionAuth;
let sAdmin: SessionAuth;
let patB: TokenAuth;
let patAuditorRo: TokenAuth;
let patARo: TokenAuth;
let task: TaskBody;
const clients: SseClient[] = [];

/** Every task-scoped read endpoint (contract §9.5) for task `id` / attempt `a`. */
function readPaths(id: string, a: string): string[] {
  return [
    `/api/v1/tasks/${id}`,
    `/api/v1/tasks/${id}/logs`,
    `/api/v1/tasks/${id}/events`,
    `/api/v1/tasks/${id}/attempts`,
    `/api/v1/tasks/${id}/attempts/${a}`,
    `/api/v1/tasks/${id}/tests`,
    `/api/v1/tasks/${id}/tests/${randomUUID()}/results`,
    `/api/v1/tasks/${id}/changed-files`,
    `/api/v1/tasks/${id}/diff`,
    `/api/v1/tasks/${id}/patch`,
    `/api/v1/tasks/${id}/merge-check`,
    `/api/v1/tasks/${id}/session`,
    `/api/v1/tasks/${id}/impact`,
  ];
}

async function openStream(id: string, auth: Auth | null): Promise<SseClient> {
  const c = await SseClient.open(`${server.url}/api/v1/tasks/${id}/stream`, auth ? authHeaders(auth) : {});
  clients.push(c);
  return c;
}

beforeAll(async () => {
  h = await createApiHarness();
  server = await listen(h.app);
  opA = await createLoginUser(h.db, { role: 'operator' });
  opB = await createLoginUser(h.db, { role: 'operator' });
  auditor = await createLoginUser(h.db, { role: 'auditor' });
  admin = await createLoginUser(h.db, { role: 'admin' });
  project = await createReadyProject(h.db, admin, await seededAgent(h.db));
  [sA, sB, sAuditor, sAdmin] = await Promise.all([
    login(h.app, opA.username),
    login(h.app, opB.username),
    login(h.app, auditor.username),
    login(h.app, admin.username),
  ]);
  patB = await createPat(h.app, sB);
  patAuditorRo = await createPat(h.app, sAuditor, true);
  patARo = await createPat(h.app, sA, true);
  const res = await call(h.app, 'post', '/api/v1/tasks', sA).send({
    projectId: project.id,
    title: 'Operator A private task',
    prompt: 'Only A may see this.',
  });
  expect(res.status).toBe(202);
  task = res.body as TaskBody;
});

afterAll(async () => {
  for (const c of clients) c.close();
  await server?.close();
  await h.close();
  expect(await cleanupPrefix(h.prefix)).toBe(0);
  await resetDb();
});

describe('operator B cannot see, stream, cancel, retry or diff operator A\'s task', () => {
  it('the owner can read the task (so 404 below means "invisible", not "missing")', async () => {
    for (const p of [`/api/v1/tasks/${task.id}`, `/api/v1/tasks/${task.id}/logs`, `/api/v1/tasks/${task.id}/events`, `/api/v1/tasks/${task.id}/attempts`]) {
      expect((await call(h.app, 'get', p, sA)).status, p).toBe(200);
    }
  });

  it.each([['session'], ['token']])('every read endpoint answers 404 not_found to operator B (%s)', async (kind) => {
    const auth = kind === 'session' ? sB : patB;
    for (const p of readPaths(task.id, task.currentAttemptId)) {
      const res = await call(h.app, 'get', p, auth);
      expect(res.status, p).toBe(404);
      expect(problemOf(res).code, p).toBe('not_found');
      expect(JSON.stringify(res.body), p).not.toContain('Only A may see this');
    }
  });

  it('the task list of operator B does not contain it', async () => {
    const res = await call(h.app, 'get', '/api/v1/tasks?limit=100', sB);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(task.id);
    const filtered = await call(h.app, 'get', `/api/v1/tasks?projectId=${project.id}&limit=100`, patB);
    expect(JSON.stringify(filtered.body)).not.toContain(task.id);
  });

  it('cancel and retry answer 404 and change nothing', async () => {
    const before = await h.db.repos.tasks.findById(task.id);
    for (const auth of [sB, patB]) {
      const cancel = await call(h.app, 'post', `/api/v1/tasks/${task.id}/cancel`, auth).send({ reason: 'not mine' });
      expect(cancel.status).toBe(404);
      const retry = await call(h.app, 'post', `/api/v1/tasks/${task.id}/retry`, auth).send({});
      expect(retry.status).toBe(404);
    }
    const after = await h.db.repos.tasks.findById(task.id);
    expect(after?.status).toBe(before?.status);
    expect(after?.cancelRequestedAt ?? null).toBeNull();
    expect(after?.attemptCount).toBe(before?.attemptCount);
  });

  it('the SSE stream: anonymous 401, operator B 404 (JSON, before any event), auditor/admin/owner 200', async () => {
    const anon = await openStream(task.id, null);
    expect(anon.status).toBe(401);
    expect(await anon.json()).toMatchObject({ code: 'unauthenticated' });
    for (const auth of [sB, patB]) {
      const foreign = await openStream(task.id, auth);
      expect(foreign.status).toBe(404);
      expect(foreign.headers.get('content-type')).toMatch(/^application\/problem\+json/);
      expect(await foreign.json()).toMatchObject({ code: 'not_found' });
    }
    for (const auth of [sA, sAuditor, sAdmin]) {
      const ok = await openStream(task.id, auth);
      expect(ok.status).toBe(200);
      const events = await ok.until((ev) => ev.length >= 1);
      expect(events[0]).toMatchObject({ event: 'status', data: { taskId: task.id } });
      ok.close();
    }
  });

  it('a stream of an unknown task id is indistinguishable from a foreign one', async () => {
    const res = await openStream(randomUUID(), sB);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'not_found' });
  });
});

describe('auditor is read-only; read-only tokens never write', () => {
  it('auditor reads any task', async () => {
    for (const p of readPaths(task.id, task.currentAttemptId).slice(0, 5)) {
      expect((await call(h.app, 'get', p, sAuditor)).status, p).toBe(200);
    }
    expect(JSON.stringify((await call(h.app, 'get', '/api/v1/tasks?limit=100', sAuditor)).body)).toContain(task.id);
  });

  it('auditor cannot create, cancel or retry tasks, nor change projects/agents/users (403 forbidden)', async () => {
    const attempts: [string, 'post' | 'patch', string, Record<string, unknown>][] = [
      ['create task', 'post', '/api/v1/tasks', { projectId: project.id, title: 't', prompt: 'p' }],
      ['cancel', 'post', `/api/v1/tasks/${task.id}/cancel`, {}],
      ['retry', 'post', `/api/v1/tasks/${task.id}/retry`, {}],
      ['create project', 'post', '/api/v1/projects', { name: 'Auditor Proj', repoPath: 'acme/x' }],
      ['create user', 'post', '/api/v1/users', { username: 'x', displayName: 'x', role: 'admin', password: 'Correct-Horse-9-Battery' }],
    ];
    for (const [name, method, p, body] of attempts) {
      const res = await call(h.app, method, p, sAuditor).send(body);
      expect(res.status, name).toBe(403);
    }
    expect((await h.db.repos.tasks.findById(task.id))?.cancelRequestedAt ?? null).toBeNull();
  });

  it('read-only PATs (owner and auditor) are refused on every unsafe method', async () => {
    for (const auth of [patARo, patAuditorRo]) {
      const create = await call(h.app, 'post', '/api/v1/tasks', auth).send({ projectId: project.id, title: 't', prompt: 'p' });
      expect(create.status).toBe(403);
      const cancel = await call(h.app, 'post', `/api/v1/tasks/${task.id}/cancel`, auth).send({});
      expect(cancel.status).toBe(403);
    }
    expect((await call(h.app, 'get', `/api/v1/tasks/${task.id}`, patARo)).status).toBe(200);
  });

  it('PATs can never manage tokens, passwords or users (token_not_allowed)', async () => {
    for (const [method, p] of [
      ['post', '/api/v1/auth/tokens'],
      ['post', '/api/v1/auth/password'],
      ['get', '/api/v1/users'],
    ] as const) {
      const res = await call(h.app, method, p, patB).send({});
      expect(res.status, p).toBe(403);
      expect(problemOf(res).code, p).toBe('token_not_allowed');
    }
  });

  it('unauthenticated requests are 401 on every task endpoint', async () => {
    for (const p of readPaths(task.id, task.currentAttemptId)) {
      expect((await call(h.app, 'get', p)).status, p).toBe(401);
    }
    expect((await call(h.app, 'post', `/api/v1/tasks/${task.id}/cancel`).send({})).status).toBe(401);
  });

  it('session writes need the CSRF token (403 csrf_failed) even for the owner', async () => {
    const res = await call(h.app, 'post', `/api/v1/tasks/${task.id}/cancel`)
      .set('Cookie', sA.cookie)
      .set('X-CSRF-Token', 'wrong-token')
      .send({});
    expect(res.status).toBe(403);
    expect(problemOf(res).code).toBe('csrf_failed');
    expect((await h.db.repos.tasks.findById(task.id))?.cancelRequestedAt ?? null).toBeNull();
  });
});
