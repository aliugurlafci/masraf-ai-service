// Task endpoints + RBAC matrix + idempotency against mssql-test + redis-test (contract §9.3-§9.5, §15.1, §15.5).
// Task creation only records and enqueues (202 + Location); nothing ever executes it (no worker in this test).
import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Database, ProjectRecord, UserRecord } from '@orc/database';
import { openDb, resetDb } from '../helpers/database/db';
import { createReadyProject, seededAgent } from '../helpers/database/fixtures';
import { cleanupPrefix } from '../helpers/task-manager/redis';
import { call, createApiHarness, createLoginUser, createPat, login, problemOf } from '../helpers/api/harness';
import type { ApiHarness, SessionAuth, TokenAuth } from '../helpers/api/harness';
import { SAMPLE_PATCH_A, SAMPLE_PATCH_B, claim, seedArtefacts, seedLogs, settleFailed } from '../helpers/api/world';

interface TaskBody {
  id: string;
  status: string;
  createdByUserId: string;
  currentAttemptId: string;
  attemptCount: number;
}

describe('task endpoints (create/list/get/cancel/retry/read models) and RBAC', () => {
  let h: ApiHarness;
  let worker: Database;
  let project: ProjectRecord;
  let opA: UserRecord;
  let opB: UserRecord;
  let auditor: UserRecord;
  let admin: UserRecord;
  let sA: SessionAuth;
  let sB: SessionAuth;
  let sAuditor: SessionAuth;
  let sAdmin: SessionAuth;
  let patA: TokenAuth;

  const createTask = (auth: SessionAuth | TokenAuth, extra: Record<string, unknown> = {}) =>
    call(h.app, 'post', '/api/v1/tasks', auth).send({
      projectId: project.id,
      title: 'Implement feature',
      prompt: 'Please implement the feature.',
      ...extra,
    });

  beforeAll(async () => {
    h = await createApiHarness();
    worker = await openDb('orc_worker');
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
    patA = await createPat(h.app, sA);
  });

  afterAll(async () => {
    await h.close();
    await worker.close();
    expect(await cleanupPrefix(h.prefix)).toBe(0);
    await resetDb();
  });

  it('POST /tasks => 202 + Location, task queued, run-attempt job enqueued (jobId = attemptId), never executed', async () => {
    const res = await createTask(sA);
    expect(res.status).toBe(202);
    const task = res.body as TaskBody;
    expect(res.headers['location']).toBe(`/api/v1/tasks/${task.id}`);
    expect(task.status).toBe('queued');
    expect(task.createdByUserId).toBe(opA.id);
    const job = await h.deps.queues.tasks.getJob(task.currentAttemptId);
    expect(job?.data).toMatchObject({ v: 1, taskId: task.id, attemptId: task.currentAttemptId, attemptNumber: 1 });
    expect(await job?.getState()).toBe('waiting');
    const row = await h.db.repos.tasks.findById(task.id);
    expect(row?.status).toBe('queued');
    expect(row?.correlationId).toBe(res.headers['x-correlation-id']);
  });

  it('validates the body (400 validation_failed with field errors) and maps service errors (404, 422)', async () => {
    const invalid = await call(h.app, 'post', '/api/v1/tasks', sA).send({ projectId: 'nope', title: '' });
    expect(invalid.status).toBe(400);
    const p = problemOf(invalid);
    expect(p).toMatchObject({ code: 'validation_failed', status: 400, type: '/api/v1/problems/validation_failed' });
    expect(p.errors?.map((e) => e.path)).toEqual(expect.arrayContaining(['body.projectId', 'body.title', 'body.prompt']));
    const missing = await call(h.app, 'post', '/api/v1/tasks', sA).send({
      projectId: randomUUID(),
      title: 't',
      prompt: 'p',
    });
    expect(missing.status).toBe(404);
    expect(problemOf(missing).code).toBe('not_found');
    const model = await createTask(sA, { model: 'gpt-9' });
    expect(model.status).toBe(422);
    expect(problemOf(model).code).toBe('model_not_allowed');
  });

  it('Idempotency-Key: replay returns the same response, a different body => 422, in-progress => 409, invalid => 400', async () => {
    const key = `idem-${randomUUID()}`;
    const first = await createTask(sA).set('Idempotency-Key', key);
    expect(first.status).toBe(202);
    const replay = await createTask(sA).set('Idempotency-Key', key);
    expect(replay.status).toBe(202);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['location']).toBe(first.headers['location']);
    const mismatch = await createTask(sA, { title: 'Other title' }).set('Idempotency-Key', key);
    expect(mismatch.status).toBe(422);
    expect(problemOf(mismatch).code).toBe('idempotency_key_mismatch');

    // A concurrent request holding the key (lock still valid) => 409 + Retry-After: 1.
    const busyKey = `busy-${randomUUID()}`;
    const body = { projectId: project.id, title: 'Busy', prompt: 'Busy prompt' };
    const { sha256 } = await import('@orc/security');
    const { canonicalJson } = await import('../../apps/api/src/idempotency');
    await h.db.repos.idempotency.tryBegin({
      userId: opA.id,
      scope: 'POST /api/v1/tasks',
      keyValue: busyKey,
      requestHash: sha256(canonicalJson({ params: {}, body })),
      lockSeconds: 60,
      ttlSeconds: 3600,
    });
    const busy = await call(h.app, 'post', '/api/v1/tasks', sA).set('Idempotency-Key', busyKey).send(body);
    expect(busy.status).toBe(409);
    expect(problemOf(busy).code).toBe('idempotency_key_in_use');
    expect(busy.headers['retry-after']).toBe('1');

    const bad = await createTask(sA).set('Idempotency-Key', 'short');
    expect(bad.status).toBe(400);
    expect(problemOf(bad).code).toBe('idempotency_key_invalid');

    // 4xx outcomes are stored and replayed too.
    const k404 = `nf-${randomUUID()}`;
    const nf = { projectId: randomUUID(), title: 'x', prompt: 'y' };
    const a = await call(h.app, 'post', '/api/v1/tasks', sA).set('Idempotency-Key', k404).send(nf);
    const b = await call(h.app, 'post', '/api/v1/tasks', sA).set('Idempotency-Key', k404).send(nf);
    expect([a.status, b.status]).toEqual([404, 404]);
    expect(b.headers['idempotent-replayed']).toBe('true');
  });

  it('lists with cursor pagination; operators see only their own tasks; createdBy needs task:read:any', async () => {
    await createTask(sB);
    await createTask(sB);
    await createTask(sB);
    const page1 = await call(h.app, 'get', '/api/v1/tasks?limit=2', sB);
    expect(page1.status).toBe(200);
    const p1 = page1.body as { items: TaskBody[]; nextCursor: string | null };
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const page2 = await call(h.app, 'get', `/api/v1/tasks?limit=2&cursor=${encodeURIComponent(p1.nextCursor ?? '')}`, sB);
    const p2 = page2.body as { items: TaskBody[]; nextCursor: string | null };
    expect(p2.items.length).toBeGreaterThanOrEqual(1);
    const ids = [...p1.items, ...p2.items].map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...p1.items, ...p2.items].every((t) => t.createdByUserId === opB.id)).toBe(true);
    const badCursor = await call(h.app, 'get', '/api/v1/tasks?cursor=garbage', sB);
    expect(badCursor.status).toBe(400);
    expect(problemOf(badCursor).code).toBe('invalid_cursor');
    const byOther = await call(h.app, 'get', `/api/v1/tasks?createdBy=${opA.id}`, sB);
    expect(byOther.status).toBe(403);
    const auditorView = await call(h.app, 'get', `/api/v1/tasks?createdBy=${opB.id}&limit=100`, sAuditor);
    expect((auditorView.body as { items: TaskBody[] }).items.length).toBeGreaterThanOrEqual(3);
  });

  it('RBAC: other operators get 404 for read/cancel/stream; auditors read but cannot create/cancel; admin may cancel any', async () => {
    const created = (await createTask(sA)).body as TaskBody;
    for (const path of ['', '/logs', '/events', '/attempts', '/stream']) {
      const r = await call(h.app, 'get', `/api/v1/tasks/${created.id}${path}`, sB);
      expect(r.status, `GET ${path}`).toBe(404);
      expect(problemOf(r).code).toBe('not_found');
    }
    const cancelOther = await call(h.app, 'post', `/api/v1/tasks/${created.id}/cancel`, sB).send({});
    expect(cancelOther.status).toBe(404);

    const read = await call(h.app, 'get', `/api/v1/tasks/${created.id}`, sAuditor);
    expect(read.status).toBe(200);
    const auditorCreate = await call(h.app, 'post', '/api/v1/tasks', sAuditor).send({
      projectId: project.id,
      title: 't',
      prompt: 'p',
    });
    expect(auditorCreate.status).toBe(403);
    expect(problemOf(auditorCreate).code).toBe('forbidden');
    const auditorCancel = await call(h.app, 'post', `/api/v1/tasks/${created.id}/cancel`, sAuditor).send({});
    expect(auditorCancel.status).toBe(403);
    const denied = await h.db.repos.audit.list({ limit: 20, action: 'authz.denied', actorUserId: auditor.id });
    expect(denied.length).toBeGreaterThanOrEqual(2);

    const adminCancel = await call(h.app, 'post', `/api/v1/tasks/${created.id}/cancel`, sAdmin).send({ reason: 'stop' });
    expect(adminCancel.status).toBe(200);
    expect((adminCancel.body as TaskBody).status).toBe('cancelled');
    const again = await call(h.app, 'post', `/api/v1/tasks/${created.id}/cancel`, sAdmin).send({});
    expect(again.status).toBe(409);
    expect(problemOf(again).code).toBe('task_not_cancellable');
  });

  it('GET /tasks/:id => TaskDetail + strong ETag; If-None-Match => 304; cancel of an active task => 202', async () => {
    const created = (await createTask(patA)).body as TaskBody;
    const res = await call(h.app, 'get', `/api/v1/tasks/${created.id}`, patA);
    expect(res.status).toBe(200);
    expect(res.headers['etag']).toMatch(/^"[A-Za-z0-9_-]{11}"$/);
    expect(res.body).toMatchObject({ task: { id: created.id }, project: { id: project.id }, actions: { canCancel: true } });
    const cached = await call(h.app, 'get', `/api/v1/tasks/${created.id}`, patA).set('If-None-Match', String(res.headers['etag']));
    expect(cached.status).toBe(304);

    await claim(worker, created.currentAttemptId);
    const requested = await call(h.app, 'post', `/api/v1/tasks/${created.id}/cancel`, patA).send({});
    expect(requested.status).toBe(202);
  });

  it('retry: 202 + Location with a new attempt; stale If-Match => 412; non-retryable => 409', async () => {
    const created = (await createTask(sA)).body as TaskBody;
    const notYet = await call(h.app, 'post', `/api/v1/tasks/${created.id}/retry`, sA).send({});
    expect(notYet.status).toBe(409);
    expect(problemOf(notYet).code).toBe('task_not_retryable');
    await claim(worker, created.currentAttemptId);
    await settleFailed(worker, created.id, created.currentAttemptId);
    const stale = await call(h.app, 'post', `/api/v1/tasks/${created.id}/retry`, sA)
      .set('If-Match', '"AAAAAAAAAAA"')
      .send({ mode: 'fresh' });
    expect(stale.status).toBe(412);
    expect(problemOf(stale).code).toBe('precondition_failed');
    const current = await call(h.app, 'get', `/api/v1/tasks/${created.id}`, sA);
    const retried = await call(h.app, 'post', `/api/v1/tasks/${created.id}/retry`, sA)
      .set('If-Match', String(current.headers['etag']))
      .send({ mode: 'fresh', additionalInstructions: 'try again' });
    expect(retried.status).toBe(202);
    expect(retried.headers['location']).toBe(`/api/v1/tasks/${created.id}`);
    const body = retried.body as TaskBody;
    expect(body).toMatchObject({ status: 'queued', attemptCount: 2 });
    expect(body.currentAttemptId).not.toBe(created.currentAttemptId);
    const attempts = await call(h.app, 'get', `/api/v1/tasks/${created.id}/attempts`, sA);
    expect((attempts.body as unknown[]).length).toBe(2);
    const one = await call(h.app, 'get', `/api/v1/tasks/${created.id}/attempts/${created.currentAttemptId}`, sA);
    expect(one.status).toBe(200);
    expect((await call(h.app, 'get', `/api/v1/tasks/${created.id}/attempts/${randomUUID()}`, sA)).status).toBe(404);
  });

  it('serves logs (json + text), events, tests, results, changed files, diff, patch, merge check, session, impact', async () => {
    const created = (await createTask(sA)).body as TaskBody;
    const attemptId = created.currentAttemptId;
    await claim(worker, attemptId);
    const seeded = await seedArtefacts(worker, { projectId: project.id, taskId: created.id, attemptId });
    await seedLogs(worker, { taskId: created.id, attemptId });
    const base = `/api/v1/tasks/${created.id}`;

    const logs = await call(h.app, 'get', `${base}/logs?limit=2`, sA);
    expect(logs.status).toBe(200);
    const lp = logs.body as { items: { seq: number }[]; nextCursor: string | null };
    expect(lp.items.map((l) => l.seq)).toEqual([0, 1]);
    expect(lp.nextCursor).toBe('1');
    const text = await call(h.app, 'get', `${base}/logs?format=text&stream=stdout`, sA);
    expect(text.headers['content-type']).toMatch(/^text\/plain/);
    expect(text.text).toBe('first line\n');
    const textNoStream = await call(h.app, 'get', `${base}/logs?format=text`, sA);
    expect(textNoStream.status).toBe(400);

    const events = await call(h.app, 'get', `${base}/events?limit=1`, sA);
    expect(events.status).toBe(200);
    const ep = events.body as { items: unknown[]; nextCursor: string | null };
    expect(ep.items).toHaveLength(1);
    expect(ep.nextCursor).not.toBeNull();

    const tests = await call(h.app, 'get', `${base}/tests`, sA);
    expect((tests.body as { id: string }[]).map((t) => t.id)).toEqual([seeded.testRunId]);
    const results = await call(h.app, 'get', `${base}/tests/${seeded.testRunId}/results?status=failed`, sA);
    expect((results.body as { items: { name: string }[] }).items.map((r) => r.name)).toEqual(['case 2']);
    expect((await call(h.app, 'get', `${base}/tests/${randomUUID()}/results`, sA)).status).toBe(404);

    const files = await call(h.app, 'get', `${base}/changed-files`, sA);
    expect((files.body as { path: string }[]).map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    const diff = await call(h.app, 'get', `${base}/diff?limit=1`, sA);
    const dp = diff.body as { items: { patch: string }[]; nextCursor: string | null };
    expect(dp.items[0]?.patch).toBe(SAMPLE_PATCH_A);
    expect(dp.nextCursor).not.toBeNull();
    const rawDiff = await call(h.app, 'get', `${base}/diff`, sA).set('Accept', 'text/x-diff');
    expect(rawDiff.headers['content-type']).toMatch(/^text\/x-diff/);
    expect(rawDiff.text).toBe(SAMPLE_PATCH_A + SAMPLE_PATCH_B);

    const plain = await call(h.app, 'get', `${base}/patch`, sA).set('Accept-Encoding', 'identity');
    expect(plain.status).toBe(200);
    expect(plain.headers['content-type']).toMatch(/^application\/x-patch/);
    expect(plain.headers['content-disposition']).toMatch(/^attachment; filename="task-[0-9a-f]{8}-a1\.patch"$/);
    expect(plain.headers['content-encoding']).toBeUndefined();
    const plainBody = Buffer.isBuffer(plain.body) ? plain.body.toString('utf8') : plain.text;
    expect(plainBody).toBe(SAMPLE_PATCH_A + SAMPLE_PATCH_B);
    const gz = await call(h.app, 'get', `${base}/patch`, sA)
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(gz.headers['content-encoding']).toBe('gzip');
    const gzBody = gz.body as Buffer;
    // superagent may already have inflated the body; both forms must yield the patch.
    const inflated = gzBody[0] === 0x1f && gzBody[1] === 0x8b ? gunzipSync(gzBody) : gzBody;
    expect(inflated.toString('utf8')).toBe(SAMPLE_PATCH_A + SAMPLE_PATCH_B);

    expect((await call(h.app, 'get', `${base}/merge-check`, sA)).body).toMatchObject({ status: 'clean', isFastForward: true });
    expect((await call(h.app, 'get', `${base}/session`, sA)).body).toMatchObject({ attemptId, model: 'sonnet' });
    expect((await call(h.app, 'get', `${base}/impact`, sA)).body).toMatchObject({
      id: seeded.impactOperationId,
      kind: 'impact_analysis',
      result: { changedSymbols: 2 },
    });

    const other = (await createTask(sA)).body as TaskBody;
    const noPatch = await call(h.app, 'get', `/api/v1/tasks/${other.id}/patch`, sA);
    expect(noPatch.status).toBe(404);
    expect(problemOf(noPatch).code).toBe('patch_unavailable');
    const noMerge = await call(h.app, 'get', `/api/v1/tasks/${other.id}/merge-check`, sA);
    expect(problemOf(noMerge).code).toBe('merge_check_unavailable');
  });

  it('If-Match handling on PATCH: missing => 428, stale => 412', async () => {
    const res = await call(h.app, 'patch', `/api/v1/projects/${project.id}`, sAdmin).send({ description: 'x' });
    expect(res.status).toBe(428);
    expect(problemOf(res).code).toBe('precondition_required');
    const stale = await call(h.app, 'patch', `/api/v1/projects/${project.id}`, sAdmin)
      .set('If-Match', '"AAAAAAAAAAA"')
      .send({ description: 'x' });
    expect(stale.status).toBe(412);
    expect(problemOf(stale).code).toBe('precondition_failed');
  });

  it('rejects unknown routes (404 route_not_found) and wrong methods (405 + Allow)', async () => {
    const nf = await request(h.app).get('/api/v1/nope');
    expect(nf.status).toBe(404);
    expect(problemOf(nf).code).toBe('route_not_found');
    const m = await call(h.app, 'delete', '/api/v1/tasks', sA);
    expect(m.status).toBe(405);
    expect(problemOf(m).code).toBe('method_not_allowed');
    expect(m.headers['allow']).toBe('GET, HEAD, POST');
  });
});
