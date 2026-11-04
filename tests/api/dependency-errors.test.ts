// Problem Details shape and error mapping (contract §9.1, §9.6, F9): toPublicError maps db_unavailable / db_deadlock /
// redis_unavailable to 503 dependency_unavailable + Retry-After: 5, every other internal code (and unknown errors) to a
// generic 500 that never leaks messages, SQL or stacks; body-parser failures map to 400/413/415.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { OrcError } from '@orc/shared';
import type { ErrorCode } from '@orc/shared';
import type { UserRecord } from '@orc/database';
import { resetDb } from '../helpers/database/db';
import { cleanupPrefix } from '../helpers/task-manager/redis';
import { call, createApiHarness, createLoginUser, login, problemOf } from '../helpers/api/harness';
import type { ApiHarness, SessionAuth } from '../helpers/api/harness';

describe('error handler (Problem Details, toPublicError)', () => {
  let h: ApiHarness;
  let user: UserRecord;
  let s: SessionAuth;
  /** Rejection injected into TaskService.list (non-Error values are smuggled in through a cast). */
  let nextError: Error | null = null;

  beforeAll(async () => {
    h = await createApiHarness({
      env: { JSON_BODY_LIMIT_BYTES: '2048' },
      patchDeps: (deps) => ({
        ...deps,
        tasks: {
          ...deps.tasks,
          list: (q, v) => (nextError !== null ? Promise.reject(nextError) : deps.tasks.list(q, v)),
        },
      }),
    });
    user = await createLoginUser(h.db, { role: 'operator' });
    s = await login(h.app, user.username);
  });

  afterAll(async () => {
    await h.close();
    expect(await cleanupPrefix(h.prefix)).toBe(0);
    await resetDb();
  });

  const listWith = async (err: Error) => {
    nextError = err;
    try {
      return await call(h.app, 'get', '/api/v1/tasks', s).set('X-Request-Id', 'req-err-12345');
    } finally {
      nextError = null;
    }
  };

  it.each<[ErrorCode]>([['db_unavailable'], ['db_deadlock'], ['redis_unavailable']])(
    '%s => 503 dependency_unavailable + Retry-After: 5',
    async (code) => {
      const res = await listWith(new OrcError(code, 'Connection to 10.0.0.5:1433 failed'));
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(problemOf(res)).toMatchObject({
        type: '/api/v1/problems/dependency_unavailable',
        title: 'Dependency unavailable',
        status: 503,
        code: 'dependency_unavailable',
        requestId: 'req-err-12345',
        instance: '/api/v1/tasks',
        retryAfterSeconds: 5,
        detail: 'An internal error occurred. Reference: req-err-12345',
      });
      expect(res.text).not.toContain('10.0.0.5');
    },
  );

  it.each<[Error]>([
    [new OrcError('git_failed', 'git exited 128: fatal: secret path /srv/x')],
    [new Error("Invalid column name 'Secret' in SELECT * FROM orc.Users")],
    ['a thrown string' as unknown as Error],
  ])('internal failures => generic 500 internal_error without leaks (%#)', async (err) => {
    const res = await listWith(err);
    expect(res.status).toBe(500);
    const p = problemOf(res);
    expect(p).toMatchObject({ code: 'internal_error', status: 500, title: 'Internal error' });
    expect(p.detail).toBe('An internal error occurred. Reference: req-err-12345');
    expect(res.text).not.toMatch(/SELECT|secret|fatal|stack|at /i);
  });

  it('every 503 carries Retry-After (service_unavailable, mcp_disabled)', async () => {
    for (const code of ['service_unavailable', 'mcp_disabled'] as const) {
      const res = await listWith(new OrcError(code, 'Temporarily off'));
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(problemOf(res)).toMatchObject({ code, retryAfterSeconds: 5 });
    }
  });

  it('public OrcErrors pass through with their status and message', async () => {
    const res = await listWith(new OrcError('conflict', 'Something conflicted'));
    expect(res.status).toBe(409);
    expect(problemOf(res)).toMatchObject({ code: 'conflict', detail: 'Something conflicted' });
  });

  it('maps validation (400 + errors[]), malformed JSON (400), oversized body (413) and wrong media type (415)', async () => {
    const invalid = await call(h.app, 'get', '/api/v1/tasks?limit=1000&status=bogus', s);
    expect(invalid.status).toBe(400);
    const p = problemOf(invalid);
    expect(p.code).toBe('validation_failed');
    expect(p.errors?.map((e) => e.path)).toEqual(expect.arrayContaining(['query.limit', 'query.status.0']));
    expect(p.correlationId).toBe(invalid.headers['x-correlation-id']);

    const malformed = await call(h.app, 'post', '/api/v1/tasks', s).set('Content-Type', 'application/json').send('{"a":');
    expect(malformed.status).toBe(400);
    expect(problemOf(malformed).code).toBe('invalid_json');

    const big = await call(h.app, 'post', '/api/v1/tasks', s).send({ prompt: 'x'.repeat(4096) });
    expect(big.status).toBe(413);
    expect(problemOf(big).code).toBe('payload_too_large');

    const text = await call(h.app, 'post', '/api/v1/tasks', s).set('Content-Type', 'text/plain').send('hello');
    expect(text.status).toBe(415);
    expect(problemOf(text).code).toBe('unsupported_media_type');

    const params = await call(h.app, 'get', '/api/v1/tasks/not-a-guid', s);
    expect(params.status).toBe(400);
    expect(problemOf(params).errors?.[0]?.path).toBe('params.taskId');
  });

  it('sets security headers (helmet, no CSP on the API, no x-powered-by, Cache-Control: no-store)', async () => {
    const res = await request(h.app).get('/api/v1/health/live');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
