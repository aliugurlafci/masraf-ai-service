// Requirements §15 "audit records are created" (contract §15.6, §18.5): authentication events,
// authorization denials and state changes write AuditLogs rows with actor, outcome and request
// context; credentials never appear in them; the API login cannot alter or delete audit rows.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type sql from 'mssql';
import type { AuditLog } from '@orc/shared';
import type { ProjectRecord, UserRecord } from '@orc/database';
import { openPool, query, resetDb } from '../helpers/database/db';
import { createReadyProject, seededAgent, uniq } from '../helpers/database/fixtures';
import { cleanupPrefix } from '../helpers/task-manager/redis';
import { TEST_PASSWORD, call, createApiHarness, createLoginUser, createPat, login } from '../helpers/api/harness';
import type { ApiHarness, SessionAuth } from '../helpers/api/harness';

let h: ApiHarness;
let apiPool: sql.ConnectionPool;
let operator: UserRecord;
let auditor: UserRecord;
let admin: UserRecord;
let project: ProjectRecord;
let sOperator: SessionAuth;
let sAuditor: SessionAuth;
let sAdmin: SessionAuth;

type AuditQuery = Omit<Parameters<ApiHarness['db']['repos']['audit']['list']>[0], 'limit'>;

async function auditOf(q: AuditQuery): Promise<AuditLog[]> {
  return h.db.repos.audit.list({ ...q, limit: 100 });
}

function noCredentials(rows: readonly AuditLog[], ...secrets: string[]): void {
  const text = JSON.stringify(rows);
  for (const s of secrets) expect(text).not.toContain(s);
  expect(text).not.toMatch(/scrypt\$|orc_pat_[A-Za-z0-9_-]{20,}/);
}

beforeAll(async () => {
  h = await createApiHarness();
  apiPool = await openPool('orc_api', 1);
  operator = await createLoginUser(h.db, { role: 'operator' });
  auditor = await createLoginUser(h.db, { role: 'auditor' });
  admin = await createLoginUser(h.db, { role: 'admin' });
  project = await createReadyProject(h.db, admin, await seededAgent(h.db));
  [sOperator, sAuditor, sAdmin] = await Promise.all([
    login(h.app, operator.username),
    login(h.app, auditor.username),
    login(h.app, admin.username),
  ]);
});

afterAll(async () => {
  await apiPool?.close();
  await h.close();
  expect(await cleanupPrefix(h.prefix)).toBe(0);
  await resetDb();
});

describe('authentication events', () => {
  it('auth.login success and failure (wrong password) with request context, never the password', async () => {
    const wrong = 'Wrong-Password-For-Audit-1';
    const failed = await request(h.app).post('/api/v1/auth/login').send({ username: operator.username, password: wrong });
    expect(failed.status).toBe(401);
    const rows = await auditOf({ action: 'auth.login' });
    const mine = rows.filter((r) => r.actorUserId === operator.id || JSON.stringify(r).includes(operator.username));
    expect(mine.some((r) => r.outcome === 'success')).toBe(true);
    const failure = mine.find((r) => r.outcome === 'failure');
    expect(failure).toBeDefined();
    expect(failure?.requestId).toBeTruthy();
    expect(failure?.ip).toBeTruthy();
    noCredentials(mine, wrong, TEST_PASSWORD);
  });

  it('auth.logout, auth.token_created / auth.token_revoked (token value never stored)', async () => {
    const s = await login(h.app, operator.username);
    const pat = await createPat(h.app, s);
    const list = await call(h.app, 'get', '/api/v1/auth/tokens', s);
    const tokenId = (list.body as { id: string }[])[0]?.id;
    expect(tokenId).toBeDefined();
    expect((await call(h.app, 'delete', `/api/v1/auth/tokens/${String(tokenId)}`, s)).status).toBe(204);
    expect((await call(h.app, 'post', '/api/v1/auth/logout', s).send({})).status).toBe(204);
    const created = await auditOf({ action: 'auth.token_created', actorUserId: operator.id });
    const revoked = await auditOf({ action: 'auth.token_revoked', actorUserId: operator.id });
    const logout = await auditOf({ action: 'auth.logout', actorUserId: operator.id });
    expect(created.length).toBeGreaterThan(0);
    expect(revoked.length).toBeGreaterThan(0);
    expect(logout.length).toBeGreaterThan(0);
    noCredentials([...created, ...revoked, ...logout], pat.token, s.csrf, s.cookie.split('=')[1] ?? '');
  });

  it('auth.csrf_rejected and authz.denied are recorded with outcome denied', async () => {
    const csrf = await call(h.app, 'post', '/api/v1/tasks')
      .set('Cookie', sOperator.cookie)
      .set('X-CSRF-Token', 'not-the-token')
      .send({ projectId: project.id, title: 't', prompt: 'p' });
    expect(csrf.status).toBe(403);
    const denied = await call(h.app, 'post', '/api/v1/tasks', sAuditor).send({ projectId: project.id, title: 't', prompt: 'p' });
    expect(denied.status).toBe(403);
    const csrfRows = await auditOf({ action: 'auth.csrf_rejected', actorUserId: operator.id });
    const deniedRows = await auditOf({ action: 'authz.denied', actorUserId: auditor.id });
    expect(csrfRows.length).toBeGreaterThan(0);
    expect(deniedRows.length).toBeGreaterThan(0);
    for (const r of [...csrfRows, ...deniedRows]) expect(['denied', 'failure']).toContain(r.outcome);
    noCredentials(csrfRows, sOperator.csrf);
  });
});

describe('state changes', () => {
  it('task.created, task.cancel_requested and task.status_changed carry actor and entity', async () => {
    const created = await call(h.app, 'post', '/api/v1/tasks', sOperator).send({
      projectId: project.id,
      title: 'Audited task',
      prompt: 'Audit me.',
    });
    expect(created.status).toBe(202);
    const taskId = (created.body as { id: string }).id;
    const cancel = await call(h.app, 'post', `/api/v1/tasks/${taskId}/cancel`, sOperator).send({ reason: 'stop' });
    expect([200, 202]).toContain(cancel.status);
    const rows = await auditOf({ entityId: taskId });
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['task.created']));
    expect(actions.some((a) => a === 'task.cancel_requested' || a === 'task.status_changed')).toBe(true);
    for (const r of rows.filter((x) => x.action === 'task.created')) {
      expect(r).toMatchObject({ actorType: 'user', actorUserId: operator.id, entityType: 'task', outcome: 'success' });
      expect(r.requestId).toBeTruthy();
    }
  });

  it('project.created / project.updated store before/after', async () => {
    const created = await call(h.app, 'post', '/api/v1/projects', sAdmin).send({
      name: uniq('AuditProj'),
      repoPath: `acme/${uniq('repo')}`,
    });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;
    const get = await call(h.app, 'get', `/api/v1/projects/${id}`, sAdmin);
    const patched = await call(h.app, 'patch', `/api/v1/projects/${id}`, sAdmin)
      .set('If-Match', String(get.headers['etag']))
      .send({ description: 'audited change' });
    expect(patched.status).toBe(200);
    const rows = await auditOf({ entityId: id });
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['project.created', 'project.updated']));
    const update = rows.find((r) => r.action === 'project.updated');
    expect(JSON.stringify(update?.after)).toContain('audited change');
    expect(update?.before).toBeDefined();
  });

  it('user.created never stores the password or its hash', async () => {
    const password = 'Fresh-User-Password-77';
    const username = uniq('audituser').toLowerCase();
    const res = await call(h.app, 'post', '/api/v1/users', sAdmin).send({
      username,
      displayName: 'Audit User',
      role: 'operator',
      password,
    });
    expect(res.status).toBe(201);
    const rows = await auditOf({ action: 'user.created', entityId: (res.body as { id: string }).id });
    expect(rows).toHaveLength(1);
    noCredentials(rows, password);
  });
});

describe('audit rows are append-only for the API login', () => {
  it('UPDATE and DELETE on orc.AuditLogs are denied to orc_api', async () => {
    await expect(query(apiPool, 'UPDATE orc.AuditLogs SET ActorLabel = N\'x\' WHERE 1 = 0;')).rejects.toThrow(/permission|denied/i);
    await expect(query(apiPool, 'DELETE FROM orc.AuditLogs WHERE 1 = 0;')).rejects.toThrow(/permission|denied/i);
  });
});
