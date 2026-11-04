// Users, projects (+ index operations), agents, teams, system and audit endpoints against mssql-test + redis-test
// (contract §9.2-§9.5, §15.1, §15.2).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { ProjectRecord, UserRecord } from '@orc/database';
import { resetDb } from '../helpers/database/db';
import { createReadyProject, seededAgent, uniq } from '../helpers/database/fixtures';
import { cleanupPrefix } from '../helpers/task-manager/redis';
import { TEST_PASSWORD, call, createApiHarness, createLoginUser, createPat, login, problemOf } from '../helpers/api/harness';
import type { ApiHarness, SessionAuth, TokenAuth } from '../helpers/api/harness';

describe('admin and catalogue endpoints', () => {
  let h: ApiHarness;
  let admin: UserRecord;
  let operator: UserRecord;
  let auditor: UserRecord;
  let sAdmin: SessionAuth;
  let sOperator: SessionAuth;
  let sAuditor: SessionAuth;
  let patAdmin: TokenAuth;
  let ready: ProjectRecord;

  beforeAll(async () => {
    h = await createApiHarness();
    admin = await createLoginUser(h.db, { role: 'admin' });
    operator = await createLoginUser(h.db, { role: 'operator' });
    auditor = await createLoginUser(h.db, { role: 'auditor' });
    [sAdmin, sOperator, sAuditor] = await Promise.all([
      login(h.app, admin.username),
      login(h.app, operator.username),
      login(h.app, auditor.username),
    ]);
    patAdmin = await createPat(h.app, sAdmin);
    ready = await createReadyProject(h.db, admin, await seededAgent(h.db));
  });

  afterAll(async () => {
    await h.close();
    expect(await cleanupPrefix(h.prefix)).toBe(0);
    await resetDb();
  });

  describe('users', () => {
    it('lists with cursor pagination; creates (201 + Location, 409 username_taken); gets with ETag / 304', async () => {
      const username = uniq('newuser').toLowerCase();
      const created = await call(h.app, 'post', '/api/v1/users', sAdmin).send({
        username,
        displayName: 'New User',
        role: 'operator',
        password: 'Some-Strong-Pass-1',
      });
      expect(created.status).toBe(201);
      const user = created.body as { id: string; username: string };
      expect(created.headers['location']).toBe(`/api/v1/users/${user.id}`);
      expect(JSON.stringify(created.body)).not.toMatch(/passwordHash|scrypt/);
      await login(h.app, username, 'Some-Strong-Pass-1');
      const dup = await call(h.app, 'post', '/api/v1/users', sAdmin).send({
        username,
        displayName: 'Dup',
        role: 'operator',
        password: 'Some-Strong-Pass-1',
      });
      expect(dup.status).toBe(409);
      expect(problemOf(dup).code).toBe('username_taken');
      const weak = await call(h.app, 'post', '/api/v1/users', sAdmin).send({
        username: uniq('weak').toLowerCase(),
        displayName: 'Weak',
        role: 'operator',
        password: 'short',
      });
      expect(weak.status).toBe(400);

      const p1 = await call(h.app, 'get', '/api/v1/users?limit=2', sAdmin);
      const page = p1.body as { items: { id: string }[]; nextCursor: string };
      expect(page.items).toHaveLength(2);
      const p2 = await call(h.app, 'get', `/api/v1/users?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`, sAdmin);
      expect((p2.body as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(1);

      const one = await call(h.app, 'get', `/api/v1/users/${user.id}`, sAdmin);
      expect(one.status).toBe(200);
      const etag = String(one.headers['etag']);
      expect(etag).toMatch(/^"[A-Za-z0-9_-]{11}"$/);
      expect((await call(h.app, 'get', `/api/v1/users/${user.id}`, sAdmin).set('If-None-Match', etag)).status).toBe(304);
      expect((await call(h.app, 'get', `/api/v1/users/${randomUUID()}`, sAdmin)).status).toBe(404);
      expect((await call(h.app, 'get', '/api/v1/users', sOperator)).status).toBe(403);
    });

    it('PATCH: 428 without If-Match, 412 when stale, disable revokes sessions + tokens, last_admin protected', async () => {
      const target = await createLoginUser(h.db, { role: 'operator' });
      const sTarget = await login(h.app, target.username);
      const patTarget = await createPat(h.app, sTarget);
      const get = await call(h.app, 'get', `/api/v1/users/${target.id}`, sAdmin);
      expect((await call(h.app, 'patch', `/api/v1/users/${target.id}`, sAdmin).send({ displayName: 'X' })).status).toBe(428);
      const stale = await call(h.app, 'patch', `/api/v1/users/${target.id}`, sAdmin)
        .set('If-Match', '"AAAAAAAAAAA"')
        .send({ displayName: 'X' });
      expect(stale.status).toBe(412);
      const disabled = await call(h.app, 'patch', `/api/v1/users/${target.id}`, sAdmin)
        .set('If-Match', String(get.headers['etag']))
        .send({ isActive: false, displayName: 'Disabled User' });
      expect(disabled.status).toBe(200);
      expect(disabled.body).toMatchObject({ isActive: false, displayName: 'Disabled User' });
      expect(disabled.headers['etag']).not.toBe(get.headers['etag']);
      expect((await call(h.app, 'get', '/api/v1/auth/me', sTarget)).status).toBe(401);
      expect((await call(h.app, 'get', '/api/v1/auth/me', patTarget)).status).toBe(401);
      const failed = await request(h.app).post('/api/v1/auth/login').send({ username: target.username, password: TEST_PASSWORD });
      expect(failed.status).toBe(401);

      // Demoting every other admin first leaves `admin` as the last active one.
      const others = (await h.db.repos.users.list({ limit: 200 })).filter(
        (u) => u.role === 'admin' && u.isActive && u.id !== admin.id,
      );
      for (const o of others) {
        const cur = await call(h.app, 'get', `/api/v1/users/${o.id}`, sAdmin);
        await call(h.app, 'patch', `/api/v1/users/${o.id}`, sAdmin)
          .set('If-Match', String(cur.headers['etag']))
          .send({ role: 'operator' });
      }
      const self = await call(h.app, 'get', `/api/v1/users/${admin.id}`, sAdmin);
      const demote = await call(h.app, 'patch', `/api/v1/users/${admin.id}`, sAdmin)
        .set('If-Match', String(self.headers['etag']))
        .send({ role: 'operator' });
      expect(demote.status).toBe(409);
      expect(problemOf(demote).code).toBe('last_admin');
      expect((await h.db.repos.users.findById(admin.id))?.role).toBe('admin');
    });
  });

  describe('projects', () => {
    it('creates (201 validating, Location, idempotent replay), lists, gets with ETag, patches with If-Match', async () => {
      const key = `proj-${randomUUID()}`;
      const body = { name: uniq('Proj'), repoPath: `acme/${uniq('repo')}`, testCommand: ['npm', 'test'] };
      const created = await call(h.app, 'post', '/api/v1/projects', sAdmin).set('Idempotency-Key', key).send(body);
      expect(created.status).toBe(201);
      const project = created.body as { id: string; status: string };
      expect(project.status).toBe('validating');
      expect(created.headers['location']).toBe(`/api/v1/projects/${project.id}`);
      expect(await h.deps.queues.projects.getJob(`sync-${project.id}`)).toBeTruthy();
      const replay = await call(h.app, 'post', '/api/v1/projects', sAdmin).set('Idempotency-Key', key).send(body);
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(created.body);
      const taken = await call(h.app, 'post', '/api/v1/projects', sAdmin).send({ ...body, repoPath: `acme/${uniq('r')}` });
      expect(taken.status).toBe(409);
      expect(problemOf(taken).code).toBe('project_name_taken');
      const forbidden = await call(h.app, 'post', '/api/v1/projects', sOperator).send(body);
      expect(forbidden.status).toBe(403);

      const list = await call(h.app, 'get', '/api/v1/projects?status=validating', sOperator);
      expect((list.body as { items: { id: string }[] }).items.map((p) => p.id)).toContain(project.id);
      const get = await call(h.app, 'get', `/api/v1/projects/${project.id}`, patAdmin);
      expect(get.status).toBe(200);
      const patched = await call(h.app, 'patch', `/api/v1/projects/${project.id}`, patAdmin)
        .set('If-Match', String(get.headers['etag']))
        .send({ description: 'updated' });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ description: 'updated' });
      expect((await call(h.app, 'get', `/api/v1/projects/${randomUUID()}`, sOperator)).status).toBe(404);
    });

    it('sync 202, index 202 + Location, index status and operations', async () => {
      const sync = await call(h.app, 'post', `/api/v1/projects/${ready.id}/sync`, sAdmin);
      expect(sync.status).toBe(202);
      expect(sync.body).toMatchObject({ jobId: `sync-${ready.id}` });
      const index = await call(h.app, 'post', `/api/v1/projects/${ready.id}/index`, sAdmin).send({ mode: 'fast' });
      expect(index.status).toBe(202);
      const op = index.body as { id: string; kind: string; mode: string; status: string };
      expect(op).toMatchObject({ kind: 'project_index', mode: 'full', status: 'queued' });
      expect(index.headers['location']).toBe(`/api/v1/projects/${ready.id}/index-operations/${op.id}`);
      const again = await call(h.app, 'post', `/api/v1/projects/${ready.id}/index`, sAdmin).send({});
      expect(again.status).toBe(409);
      expect(problemOf(again).code).toBe('index_in_progress');
      const status = await call(h.app, 'get', `/api/v1/projects/${ready.id}/index-status`, sOperator);
      expect(status.body).toMatchObject({ projectId: ready.id, activeOperation: { id: op.id } });
      const ops = await call(h.app, 'get', `/api/v1/projects/${ready.id}/index-operations`, sOperator);
      expect((ops.body as { items: { id: string }[] }).items.map((o) => o.id)).toContain(op.id);
      const one = await call(h.app, 'get', `/api/v1/projects/${ready.id}/index-operations/${op.id}`, sOperator);
      expect(one.status).toBe(200);
      const none = await call(h.app, 'get', `/api/v1/projects/${ready.id}/index-operations/${randomUUID()}`, sOperator);
      expect(none.status).toBe(404);
    });
  });

  describe('agents and teams', () => {
    it('lists, gets (ETag), creates and patches teams and agents; PATs cannot manage the catalogue', async () => {
      const teams = await call(h.app, 'get', '/api/v1/teams', sOperator);
      expect((teams.body as unknown[]).length).toBeGreaterThanOrEqual(11);
      const team = await call(h.app, 'post', '/api/v1/teams', sAdmin).send({ name: uniq('Team'), ownedPaths: ['apps/x'] });
      expect(team.status).toBe(201);
      const teamId = (team.body as { id: string }).id;
      expect(team.headers['location']).toBe(`/api/v1/teams/${teamId}`);
      const teamGet = await call(h.app, 'get', `/api/v1/teams/${teamId}`, sOperator);
      expect(teamGet.body).toMatchObject({ id: teamId, agents: [] });
      const teamPatch = await call(h.app, 'patch', `/api/v1/teams/${teamId}`, sAdmin)
        .set('If-Match', String(teamGet.headers['etag']))
        .send({ description: 'desc' });
      expect(teamPatch.status).toBe(200);

      const agent = await call(h.app, 'post', '/api/v1/agents', sAdmin).send({
        teamId,
        name: uniq('Agent'),
        title: 'Engineer',
        model: 'sonnet',
        allowedTools: ['Read'],
        disallowedTools: [],
        maxTimeoutSeconds: 3600,
      });
      expect(agent.status).toBe(201);
      const agentId = (agent.body as { id: string }).id;
      const badModel = await call(h.app, 'post', '/api/v1/agents', sAdmin).send({
        teamId,
        name: uniq('Agent'),
        title: 'Engineer',
        model: 'gpt-9',
        allowedTools: [],
        disallowedTools: [],
        maxTimeoutSeconds: 3600,
      });
      expect(badModel.status).toBe(422);
      expect(problemOf(badModel).code).toBe('model_not_allowed');
      const listed = await call(h.app, 'get', `/api/v1/agents?teamId=${teamId}&includeInactive=true`, sOperator);
      expect((listed.body as { id: string }[]).map((a) => a.id)).toEqual([agentId]);
      const agentGet = await call(h.app, 'get', `/api/v1/agents/${agentId}`, sOperator);
      const agentPatch = await call(h.app, 'patch', `/api/v1/agents/${agentId}`, sAdmin)
        .set('If-Match', String(agentGet.headers['etag']))
        .send({ title: 'Senior Engineer' });
      expect(agentPatch.body).toMatchObject({ title: 'Senior Engineer' });
      const viaPat = await call(h.app, 'post', '/api/v1/teams', patAdmin).send({ name: uniq('T') });
      expect(viaPat.status).toBe(403);
      expect(problemOf(viaPat).code).toBe('token_not_allowed');
    });
  });

  describe('system and audit', () => {
    it('serves workers, queue status, dlq (session + system:manage), mcp status and audit logs', async () => {
      expect((await call(h.app, 'get', '/api/v1/system/workers', sOperator)).status).toBe(200);
      const queue = await call(h.app, 'get', '/api/v1/system/queue', sOperator);
      expect(queue.status).toBe(200);
      expect(queue.body).toMatchObject({ deadLetterCount: 0 });
      expect((queue.body as { queues: { name: string }[] }).queues.map((q) => q.name)).toContain('orc-tasks');
      expect((await call(h.app, 'get', '/api/v1/system/dlq', sAdmin)).body).toEqual({ items: [], nextCursor: null });
      expect((await call(h.app, 'get', '/api/v1/system/dlq', sOperator)).status).toBe(403);
      expect((await call(h.app, 'get', '/api/v1/system/dlq', patAdmin)).status).toBe(403);
      const mcp = await call(h.app, 'get', '/api/v1/system/mcp', sAuditor);
      expect(mcp.body).toMatchObject({ mcpEnabled: true });

      const audit1 = await call(h.app, 'get', '/api/v1/audit-logs?limit=2', sAuditor);
      expect(audit1.status).toBe(200);
      const page = audit1.body as { items: { id: string }[]; nextCursor: string };
      expect(page.items).toHaveLength(2);
      const audit2 = await call(h.app, 'get', `/api/v1/audit-logs?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`, sAuditor);
      const ids2 = (audit2.body as { items: { id: string }[] }).items.map((a) => a.id);
      expect(ids2.some((id) => page.items.some((a) => a.id === id))).toBe(false);
      const filtered = await call(h.app, 'get', '/api/v1/audit-logs?action=user.created', sAdmin);
      expect((filtered.body as { items: { action: string }[] }).items.every((a) => a.action === 'user.created')).toBe(true);
      expect((await call(h.app, 'get', '/api/v1/audit-logs', sOperator)).status).toBe(403);
    });

    it('serves the problem type catalogue', async () => {
      const res = await request(h.app).get('/api/v1/problems/precondition_failed');
      expect(res.body).toEqual({ code: 'precondition_failed', status: 412, title: 'Resource has changed' });
      expect((await request(h.app).get('/api/v1/problems/nope')).status).toBe(404);
    });
  });
});
