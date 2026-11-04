// Authentication, CSRF and PAT behaviour against mssql-test + redis-test (contract §9.1, §9.2, §15.2-§15.4).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { UserRecord } from '@orc/database';
import { resetDb } from '../helpers/database/db';
import { cleanupPrefix } from '../helpers/task-manager/redis';
import {
  COOKIE_NAME,
  PUBLIC_ORIGIN,
  TEST_PASSWORD,
  call,
  createApiHarness,
  createLoginUser,
  createPat,
  login,
  problemOf,
} from '../helpers/api/harness';
import type { ApiHarness } from '../helpers/api/harness';

describe('API authentication (session, PAT, CSRF, lockout)', () => {
  let h: ApiHarness;
  let admin: UserRecord;
  let operator: UserRecord;

  beforeAll(async () => {
    h = await createApiHarness({ env: { LOGIN_MAX_FAILURES: '3', LOGIN_LOCK_SECONDS: '600' } });
    admin = await createLoginUser(h.db, { role: 'admin' });
    operator = await createLoginUser(h.db, { role: 'operator' });
  });

  afterAll(async () => {
    await h.close();
    expect(await cleanupPrefix(h.prefix)).toBe(0);
    await resetDb();
  });

  it('logs in: 200 LoginResponse, HttpOnly SameSite=Strict cookie, csrf token, audit auth.login', async () => {
    const res = await request(h.app).post('/api/v1/auth/login').send({ username: operator.username.toUpperCase(), password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    const body = res.body as { user: { id: string; username: string }; csrfToken: string; permissions: string[]; expiresAt: string };
    expect(body.user.id).toBe(operator.id);
    expect(body.csrfToken.length).toBeGreaterThan(20);
    expect(body.permissions).toContain('task:create');
    expect(body.permissions).not.toContain('task:read:any');
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const cookie = cookies.find((c) => c.startsWith(`${COOKIE_NAME}=`)) ?? '';
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=43200/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    const audit = await h.db.repos.audit.list({ limit: 50, action: 'auth.login', actorUserId: operator.id });
    expect(audit.some((a) => a.outcome === 'success')).toBe(true);
  });

  it('rejects bad credentials with 401 invalid_credentials (unknown user and wrong password alike)', async () => {
    const wrong = await request(h.app).post('/api/v1/auth/login').send({ username: admin.username, password: 'nope-nope-nope' });
    expect(wrong.status).toBe(401);
    expect(problemOf(wrong).code).toBe('invalid_credentials');
    const unknown = await request(h.app).post('/api/v1/auth/login').send({ username: 'ghost-user', password: 'whatever-whatever' });
    expect(unknown.status).toBe(401);
    expect(problemOf(unknown).code).toBe('invalid_credentials');
    expect(unknown.headers['content-type']).toMatch(/^application\/problem\+json/);
  });

  it('requires application/json on login (415) and validates the body (400)', async () => {
    const form = await request(h.app).post('/api/v1/auth/login').type('form').send('username=a&password=b');
    expect(form.status).toBe(415);
    expect(problemOf(form).code).toBe('unsupported_media_type');
    const invalid = await request(h.app).post('/api/v1/auth/login').send({ username: 'x' });
    expect(invalid.status).toBe(400);
    expect(problemOf(invalid).code).toBe('validation_failed');
    expect(problemOf(invalid).errors?.some((e) => e.path === 'body.password')).toBe(true);
  });

  it('locks a username after LOGIN_MAX_FAILURES failures (429 login_throttled + Retry-After, audit auth.lockout); unlock clears it', async () => {
    const victim = await createLoginUser(h.db, { role: 'operator' });
    for (let i = 0; i < 3; i += 1) {
      const r = await request(h.app).post('/api/v1/auth/login').send({ username: victim.username, password: 'bad-password-123' });
      expect(r.status).toBe(401);
    }
    const locked = await request(h.app).post('/api/v1/auth/login').send({ username: victim.username, password: TEST_PASSWORD });
    expect(locked.status).toBe(429);
    expect(problemOf(locked).code).toBe('login_throttled');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    const row = await h.db.repos.users.findById(victim.id);
    expect(row?.lockedUntil).not.toBeNull();
    const lockouts = await h.db.repos.audit.list({ limit: 10, action: 'auth.lockout', entityId: victim.id });
    expect(lockouts).toHaveLength(1);

    const adminSession = await login(h.app, admin.username);
    const unlock = await call(h.app, 'post', `/api/v1/users/${victim.id}/unlock`, adminSession);
    expect(unlock.status).toBe(204);
    await login(h.app, victim.username);
  });

  it('serves /auth/me for sessions and PATs; logout revokes the session and clears the cookie', async () => {
    const s = await login(h.app, operator.username);
    const me = await call(h.app, 'get', '/api/v1/auth/me', s);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ authMethod: 'session', csrfToken: s.csrf, tokenReadOnly: false });

    const pat = await createPat(h.app, s);
    const meToken = await call(h.app, 'get', '/api/v1/auth/me', pat);
    expect(meToken.status).toBe(200);
    expect(meToken.body).toMatchObject({ authMethod: 'token', csrfToken: null, sessionExpiresAt: null });

    const logout = await call(h.app, 'post', '/api/v1/auth/logout', s);
    expect(logout.status).toBe(204);
    expect(String(logout.headers['set-cookie'])).toMatch(/Max-Age=0/);
    const after = await call(h.app, 'get', '/api/v1/auth/me', s);
    expect(after.status).toBe(401);
    expect(problemOf(after).code).toBe('session_expired');
    expect(String(after.headers['set-cookie'])).toMatch(new RegExp(`${COOKIE_NAME}=;`));
    // PAT stays valid after the session logout.
    expect((await call(h.app, 'get', '/api/v1/auth/me', pat)).status).toBe(200);
  });

  it('returns 401 unauthenticated without credentials and for an unknown bearer token', async () => {
    const none = await request(h.app).get('/api/v1/tasks');
    expect(none.status).toBe(401);
    expect(problemOf(none).code).toBe('unauthenticated');
    const bogus = await request(h.app).get('/api/v1/tasks').set('Authorization', `Bearer orc_pat_${'x'.repeat(43)}`);
    expect(bogus.status).toBe(401);
  });

  it('requires X-CSRF-Token for cookie-authenticated unsafe methods (403 csrf_failed + audit), never for PATs', async () => {
    const s = await login(h.app, operator.username);
    const noCsrf = await request(h.app).post('/api/v1/auth/tokens').set('Cookie', s.cookie).send({ name: 'x-token' });
    expect(noCsrf.status).toBe(403);
    expect(problemOf(noCsrf).code).toBe('csrf_failed');
    const wrongCsrf = await request(h.app)
      .post('/api/v1/auth/logout')
      .set('Cookie', s.cookie)
      .set('X-CSRF-Token', 'not-the-token');
    expect(wrongCsrf.status).toBe(403);
    const audit = await h.db.repos.audit.list({ limit: 10, action: 'auth.csrf_rejected', actorUserId: operator.id });
    expect(audit.length).toBeGreaterThanOrEqual(2);

    const pat = await createPat(h.app, s);
    const viaPat = await request(h.app)
      .post('/api/v1/projects/00000000-0000-0000-0000-000000000000/sync')
      .set('Authorization', `Bearer ${pat.token}`);
    // operator lacks project:index => 403 forbidden (not csrf_failed): CSRF does not apply to PATs.
    expect(viaPat.status).toBe(403);
    expect(problemOf(viaPat).code).toBe('forbidden');
  });

  it('rejects a foreign Origin on unsafe methods (also on login)', async () => {
    const res = await request(h.app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ username: operator.username, password: TEST_PASSWORD });
    expect(res.status).toBe(403);
    expect(problemOf(res).code).toBe('csrf_failed');
    const ok = await request(h.app)
      .post('/api/v1/auth/login')
      .set('Origin', PUBLIC_ORIGIN)
      .send({ username: operator.username, password: TEST_PASSWORD });
    expect(ok.status).toBe(200);
  });

  it('PAT rules: token_not_allowed on /auth/tokens and /users, read-only tokens only GET, revoke => 401', async () => {
    const s = await login(h.app, admin.username);
    const pat = await createPat(h.app, s);
    const tokens = await call(h.app, 'get', '/api/v1/auth/tokens', pat);
    expect(tokens.status).toBe(403);
    expect(problemOf(tokens).code).toBe('token_not_allowed');
    const users = await call(h.app, 'get', '/api/v1/users', pat);
    expect(problemOf(users).code).toBe('token_not_allowed');

    const ro = await createPat(h.app, s, true);
    expect((await call(h.app, 'get', '/api/v1/projects', ro)).status).toBe(200);
    const write = await call(h.app, 'post', '/api/v1/tasks', ro).send({});
    expect(write.status).toBe(403);
    expect(problemOf(write).code).toBe('forbidden');

    const list = await call(h.app, 'get', '/api/v1/auth/tokens', s);
    expect(list.status).toBe(200);
    const ids = (list.body as { id: string; prefix: string }[]).map((t) => t.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(list.body)).not.toContain('orc_pat_');
    const roId = (list.body as { id: string; readOnly: boolean }[]).find((t) => t.readOnly)?.id ?? '';
    expect((await call(h.app, 'delete', `/api/v1/auth/tokens/${roId}`, s)).status).toBe(204);
    expect((await call(h.app, 'delete', `/api/v1/auth/tokens/${roId}`, s)).status).toBe(404);
    expect((await call(h.app, 'get', '/api/v1/projects', ro)).status).toBe(401);
  });

  it('changes the password (401 on a wrong current password; other sessions revoked)', async () => {
    const user = await createLoginUser(h.db, { role: 'auditor' });
    const a = await login(h.app, user.username);
    const b = await login(h.app, user.username);
    const bad = await call(h.app, 'post', '/api/v1/auth/password', a).send({
      currentPassword: 'wrong-wrong-wrong',
      newPassword: 'Another-Secret-77',
    });
    expect(bad.status).toBe(401);
    const ok = await call(h.app, 'post', '/api/v1/auth/password', a).send({
      currentPassword: TEST_PASSWORD,
      newPassword: 'Another-Secret-77',
    });
    expect(ok.status).toBe(204);
    expect((await call(h.app, 'get', '/api/v1/auth/me', a)).status).toBe(200);
    expect((await call(h.app, 'get', '/api/v1/auth/me', b)).status).toBe(401);
    await login(h.app, user.username, 'Another-Secret-77');
  });

  it('echoes valid X-Request-Id / X-Correlation-Id and replaces invalid ones', async () => {
    const res = await request(h.app)
      .get('/api/v1/health/live')
      .set('X-Request-Id', 'req-12345678')
      .set('X-Correlation-Id', 'corr-abcdefgh');
    expect(res.headers['x-request-id']).toBe('req-12345678');
    expect(res.headers['x-correlation-id']).toBe('corr-abcdefgh');
    const bad = await request(h.app).get('/api/v1/health/live').set('X-Request-Id', 'bad id!');
    expect(bad.headers['x-request-id']).not.toBe('bad id!');
    expect(bad.headers['x-correlation-id']).toBe(bad.headers['x-request-id']);
  });
});
