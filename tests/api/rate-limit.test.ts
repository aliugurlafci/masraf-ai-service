// Route-class rate limiting on redis-test (contract §9.2, §9.6): 429 rate_limited + Retry-After + RateLimit-* headers,
// keys per user (else IP) under `<P>:rl:<class>:`, health routes unlimited, login per-IP limit => 429 login_throttled.
// Authentication is throttled per client IP (`auth` class, key `ip:<ip>`) before any credential DB lookup.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Redis } from 'ioredis';
import type { UserRecord } from '@orc/database';
import { resetDb } from '../helpers/database/db';
import { cleanupPrefix, keysUnder, rawRedis } from '../helpers/task-manager/redis';
import { COOKIE_NAME, call, createApiHarness, createLoginUser, createPat, login, problemOf } from '../helpers/api/harness';
import { callsOf, withCallCounts } from '../helpers/api/counting-db';
import type { CallCounts } from '../helpers/api/counting-db';
import type { ApiHarness, SessionAuth } from '../helpers/api/harness';

describe('rate limiting', () => {
  let h: ApiHarness;
  let raw: Redis;
  let a: UserRecord;
  let b: UserRecord;
  let sA: SessionAuth;
  let sB: SessionAuth;

  beforeAll(async () => {
    h = await createApiHarness({
      env: { LOGIN_IP_MAX: '6', LOGIN_IP_WINDOW_SECONDS: '600' },
      rateLimits: { read: { points: 3, durationSeconds: 60 }, public: { points: 2, durationSeconds: 60 } },
    });
    raw = rawRedis(h.prefix);
    a = await createLoginUser(h.db);
    b = await createLoginUser(h.db);
    sA = await login(h.app, a.username);
    sB = await login(h.app, b.username);
  });

  afterAll(async () => {
    await raw.quit();
    await h.close();
    expect(await cleanupPrefix(h.prefix)).toBe(0);
    await resetDb();
  });

  it('limits the read class per user: RateLimit-* headers, then 429 rate_limited + Retry-After', async () => {
    for (let i = 0; i < 3; i += 1) {
      const ok = await call(h.app, 'get', '/api/v1/projects', sA);
      expect(ok.status).toBe(200);
      expect(ok.headers['ratelimit-limit']).toBe('3');
      expect(ok.headers['ratelimit-remaining']).toBe(String(2 - i));
      expect(Number(ok.headers['ratelimit-reset'])).toBeGreaterThan(0);
    }
    const limited = await call(h.app, 'get', '/api/v1/agents', sA);
    expect(limited.status).toBe(429);
    expect(problemOf(limited)).toMatchObject({ code: 'rate_limited', status: 429 });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(problemOf(limited).retryAfterSeconds).toBe(Number(limited.headers['retry-after']));
    // Another user has an independent budget.
    expect((await call(h.app, 'get', '/api/v1/projects', sB)).status).toBe(200);
    const keys = await keysUnder(raw, h.prefix);
    expect(keys).toContain(`${h.prefix}:rl:read:u:${a.id}`);
  });

  it('limits public routes per IP and never limits health routes', async () => {
    expect((await request(h.app).get('/api/v1/problems/not_found')).status).toBe(200);
    expect((await request(h.app).get('/api/openapi.json')).status).toBe(200);
    expect((await request(h.app).get('/api/v1/problems/not_found')).status).toBe(429);
    for (let i = 0; i < 10; i += 1) expect((await request(h.app).get('/api/v1/health/live')).status).toBe(200);
  });

  it('limits login attempts per IP (429 login_throttled)', async () => {
    let throttled = 0;
    for (let i = 0; i < 8; i += 1) {
      const r = await request(h.app).post('/api/v1/auth/login').send({ username: `nobody${i}`, password: 'wrong-wrong-wrong' });
      if (r.status === 429) {
        throttled += 1;
        expect(problemOf(r).code).toBe('login_throttled');
        expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      } else {
        expect(r.status).toBe(401);
      }
    }
    // beforeAll used 2 of the 6 attempts.
    expect(throttled).toBe(4);
  });
});

describe('authentication throttle (auth class per client IP, checked before credential lookups)', () => {
  let h: ApiHarness;
  let raw: Redis;
  const counts: CallCounts = new Map();
  const bogusPat = (): string => `orc_pat_${randomBytes(24).toString('base64url')}`;
  const bogusSession = (): string => randomBytes(32).toString('base64url');
  const tokenLookups = (): number => callsOf(counts, 'apiTokens.findActiveByHash');
  const sessionLookups = (): number => callsOf(counts, 'authSessions.findActiveByTokenHash');
  const fromIp = (ip: string, method: 'get' | 'post' = 'get', path = '/api/v1/projects') =>
    request(h.app)[method](path).set('X-Forwarded-For', ip);

  beforeAll(async () => {
    h = await createApiHarness({
      env: { TRUST_PROXY: '1' },
      rateLimits: { auth: { points: 3, durationSeconds: 60 } },
      patchDeps: (deps) => ({ ...deps, db: withCallCounts(deps.db, counts) }),
    });
    raw = rawRedis(h.prefix);
  });

  afterAll(async () => {
    await raw.quit();
    await h.close();
    expect(await cleanupPrefix(h.prefix)).toBe(0);
    await resetDb();
  });

  it('bogus bearer tokens cost at most `points` lookups per IP, then 429 rate_limited without any DB lookup', async () => {
    const ip = '203.0.113.10';
    const before = tokenLookups();
    const answers: number[] = [];
    let last: Awaited<ReturnType<typeof fromIp>> | null = null;
    for (let i = 0; i < 8; i += 1) {
      last = await fromIp(ip).set('Authorization', `Bearer ${bogusPat()}`);
      answers.push(last.status);
    }
    expect(answers).toEqual([401, 401, 401, 429, 429, 429, 429, 429]);
    expect(tokenLookups() - before).toBe(3);
    if (last === null) throw new Error('no response');
    expect(problemOf(last)).toMatchObject({ code: 'rate_limited', status: 429 });
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
    expect(last.headers['ratelimit-limit']).toBe('3');
    expect(await keysUnder(raw, h.prefix)).toContain(`${h.prefix}:rl:auth:ip:${ip}`);
    // Public and health routes are not affected by the exhausted auth budget.
    const live = await fromIp(ip, 'get', '/api/v1/health/live').set('Authorization', `Bearer ${bogusPat()}`);
    expect(live.status).toBe(200);
    expect(tokenLookups() - before).toBe(3);
  });

  it('valid credentials never consume the budget; an exhausted IP is refused before the lookup, other IPs are not', async () => {
    const user = await createLoginUser(h.db);
    const pat = await createPat(h.app, await login(h.app, user.username));
    const ip = '203.0.113.20';
    for (let i = 0; i < 6; i += 1) {
      expect((await call(h.app, 'get', '/api/v1/projects', pat).set('X-Forwarded-For', ip)).status).toBe(200);
    }
    for (let i = 0; i < 3; i += 1) {
      expect((await fromIp(ip).set('Authorization', `Bearer ${bogusPat()}`)).status).toBe(401);
    }
    const before = tokenLookups();
    const refused = await call(h.app, 'get', '/api/v1/projects', pat).set('X-Forwarded-For', ip);
    expect(refused.status).toBe(429);
    expect(problemOf(refused).code).toBe('rate_limited');
    expect(tokenLookups()).toBe(before);
    expect((await call(h.app, 'get', '/api/v1/projects', pat).set('X-Forwarded-For', '203.0.113.21')).status).toBe(200);
  });

  it('requests without credentials and bogus session cookies are throttled per IP too (401 x points, then 429)', async () => {
    const anonymous: number[] = [];
    for (let i = 0; i < 5; i += 1) anonymous.push((await fromIp('203.0.113.30')).status);
    expect(anonymous).toEqual([401, 401, 401, 429, 429]);

    const before = sessionLookups();
    const cookies: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await fromIp('203.0.113.31').set('Cookie', `${COOKIE_NAME}=${bogusSession()}`);
      cookies.push(r.status === 401 ? problemOf(r).code : String(r.status));
    }
    expect(cookies).toEqual(['session_expired', 'session_expired', 'session_expired', '429', '429']);
    expect(sessionLookups() - before).toBe(3);
  });

  it('anonymous CSRF/Origin rejections count too: once exhausted they answer 429 without an audit insert', async () => {
    const ip = '203.0.113.40';
    const before = callsOf(counts, 'audit.insert');
    const answers: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await fromIp(ip, 'post', '/api/v1/tasks').set('Origin', 'http://evil.example').send({});
      answers.push(r.status);
    }
    expect(answers).toEqual([403, 403, 403, 429, 429]);
    expect(callsOf(counts, 'audit.insert') - before).toBe(3);
  });
});
