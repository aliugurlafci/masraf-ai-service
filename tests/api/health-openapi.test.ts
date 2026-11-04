// Health endpoints (contract §9.5, §14.7) and the OpenAPI 3.1 document / Swagger UI generated from the Zod route table.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { openDb, resetDb } from '../helpers/database/db';
import { cleanupPrefix } from '../helpers/task-manager/redis';
import { createApiHarness } from '../helpers/api/harness';
import type { ApiHarness } from '../helpers/api/harness';
import { startTcpProxy } from '../helpers/api/tcp-proxy';
import type { TcpProxy } from '../helpers/api/tcp-proxy';
import { testRedisConfig } from '../helpers/task-manager/redis';

/** Every endpoint of the §9.5 table (method + OpenAPI path). */
const CONTRACT_ENDPOINTS: readonly [string, string][] = [
  ['post', '/api/v1/auth/login'],
  ['post', '/api/v1/auth/logout'],
  ['get', '/api/v1/auth/me'],
  ['post', '/api/v1/auth/password'],
  ['get', '/api/v1/auth/tokens'],
  ['post', '/api/v1/auth/tokens'],
  ['delete', '/api/v1/auth/tokens/{tokenId}'],
  ['get', '/api/v1/users'],
  ['post', '/api/v1/users'],
  ['get', '/api/v1/users/{userId}'],
  ['patch', '/api/v1/users/{userId}'],
  ['post', '/api/v1/users/{userId}/unlock'],
  ['get', '/api/v1/projects'],
  ['post', '/api/v1/projects'],
  ['get', '/api/v1/projects/{projectId}'],
  ['patch', '/api/v1/projects/{projectId}'],
  ['post', '/api/v1/projects/{projectId}/sync'],
  ['post', '/api/v1/projects/{projectId}/index'],
  ['get', '/api/v1/projects/{projectId}/index-status'],
  ['get', '/api/v1/projects/{projectId}/index-operations'],
  ['get', '/api/v1/projects/{projectId}/index-operations/{operationId}'],
  ['get', '/api/v1/tasks'],
  ['post', '/api/v1/tasks'],
  ['get', '/api/v1/tasks/{taskId}'],
  ['post', '/api/v1/tasks/{taskId}/cancel'],
  ['post', '/api/v1/tasks/{taskId}/retry'],
  ['get', '/api/v1/tasks/{taskId}/stream'],
  ['get', '/api/v1/tasks/{taskId}/logs'],
  ['get', '/api/v1/tasks/{taskId}/events'],
  ['get', '/api/v1/tasks/{taskId}/attempts'],
  ['get', '/api/v1/tasks/{taskId}/attempts/{attemptId}'],
  ['get', '/api/v1/tasks/{taskId}/tests'],
  ['get', '/api/v1/tasks/{taskId}/tests/{testRunId}/results'],
  ['get', '/api/v1/tasks/{taskId}/changed-files'],
  ['get', '/api/v1/tasks/{taskId}/diff'],
  ['get', '/api/v1/tasks/{taskId}/patch'],
  ['get', '/api/v1/tasks/{taskId}/merge-check'],
  ['get', '/api/v1/tasks/{taskId}/session'],
  ['get', '/api/v1/tasks/{taskId}/impact'],
  ['get', '/api/v1/agents'],
  ['get', '/api/v1/agents/{agentId}'],
  ['post', '/api/v1/agents'],
  ['patch', '/api/v1/agents/{agentId}'],
  ['get', '/api/v1/teams'],
  ['get', '/api/v1/teams/{teamId}'],
  ['post', '/api/v1/teams'],
  ['patch', '/api/v1/teams/{teamId}'],
  ['get', '/api/v1/system/workers'],
  ['get', '/api/v1/system/queue'],
  ['get', '/api/v1/system/dlq'],
  ['get', '/api/v1/system/mcp'],
  ['get', '/api/v1/audit-logs'],
  ['get', '/api/v1/health/live'],
  ['get', '/api/v1/health/ready'],
  ['get', '/api/v1/problems/{code}'],
  ['get', '/api/openapi.json'],
  ['get', '/api/docs'],
];

type Json = Record<string, unknown>;

function collectRefs(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const v of node) collectRefs(v, out);
  } else if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Json)) {
      if (k === '$ref' && typeof v === 'string') out.push(v);
      else collectRefs(v, out);
    }
  }
}

function resolvePointer(doc: Json, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let cur: unknown = doc;
  for (const part of ref.slice(2).split('/')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Json)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return cur;
}

describe('health and OpenAPI', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness();
  });

  afterAll(async () => {
    await h.close();
    expect(await cleanupPrefix(h.prefix)).toBe(0);
    await resetDb();
  });

  it('GET /health/live => 200 Health (process only)', async () => {
    const res = await request(h.app).get('/api/v1/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', version: '9.9.9-test', checks: { process: { status: 'ok' } } });
  });

  it('GET /health/ready => 200 with db, redis and migrations checks; 503 while not ready (shutdown)', async () => {
    const res = await request(h.app).get('/api/v1/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      checks: { db: { status: 'ok' }, redis: { status: 'ok' }, migrations: { status: 'ok' }, lifecycle: { status: 'ok' } },
    });
    h.deps.runtime.ready = false;
    try {
      const down = await request(h.app).get('/api/v1/health/ready');
      expect(down.status).toBe(503);
      expect(down.body).toMatchObject({ status: 'fail', checks: { lifecycle: { status: 'fail' } } });
    } finally {
      h.deps.runtime.ready = true;
    }
  });

  it('readiness is 503 when the database is down', async () => {
    const db = await openDb('orc_api');
    const dbDown = await createApiHarness({ db });
    try {
      await db.close();
      const res = await request(dbDown.app).get('/api/v1/health/ready');
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ status: 'fail', checks: { db: { status: 'fail' }, redis: { status: 'ok' } } });
      // Public endpoint: driver messages (hosts, ports, logins) never leave the process.
      expect((res.body as { checks: { db: { detail: string } } }).checks.db.detail).toMatch(/^[a-z_]+$/);
      expect(res.text).not.toMatch(/127\.0\.0\.1|login failed|orc_api/i);
    } finally {
      await dbDown.close();
      await cleanupPrefix(dbDown.prefix);
    }
  });

  it('readiness is 503 when Redis is down', async () => {
    const target = testRedisConfig('x');
    const proxy: TcpProxy = await startTcpProxy(target.host, target.port);
    const redisDown = await createApiHarness({ redis: { host: '127.0.0.1', port: proxy.port } });
    try {
      expect((await request(redisDown.app).get('/api/v1/health/ready')).status).toBe(200);
      await proxy.cut();
      const res = await request(redisDown.app).get('/api/v1/health/ready');
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ status: 'fail', checks: { db: { status: 'ok' }, redis: { status: 'fail' } } });
      expect(res.headers['retry-after']).toBe('5');
    } finally {
      await redisDown.close();
      await proxy.close();
      await cleanupPrefix(redisDown.prefix);
    }
  });

  it('serves a valid OpenAPI 3.1 document listing every contract endpoint', async () => {
    const res = await request(h.app).get('/api/openapi.json');
    expect(res.status).toBe(200);
    const doc = res.body as Json & { openapi: string; info: Json; paths: Record<string, Record<string, Json>> };
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info).toMatchObject({ title: expect.any(String) as unknown, version: '9.9.9-test' });

    const listed = Object.entries(doc.paths).flatMap(([path, item]) => Object.keys(item).map((m) => `${m} ${path}`));
    const expected = CONTRACT_ENDPOINTS.map(([m, p]) => `${m} ${p}`);
    expect([...listed].sort()).toEqual([...expected].sort());

    const operationIds = new Set<string>();
    for (const [path, item] of Object.entries(doc.paths)) {
      const params = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      for (const [method, op] of Object.entries(item)) {
        const opId = op['operationId'];
        expect(typeof opId, `${method} ${path} operationId`).toBe('string');
        expect(operationIds.has(String(opId))).toBe(false);
        operationIds.add(String(opId));
        const responses = op['responses'] as Record<string, Json> | undefined;
        expect(Object.keys(responses ?? {}).length, `${method} ${path} responses`).toBeGreaterThan(0);
        for (const [status, r] of Object.entries(responses ?? {})) {
          expect(/^[1-5]\d\d$/.test(status)).toBe(true);
          expect(typeof r['description']).toBe('string');
        }
        const declared = ((op['parameters'] as Json[] | undefined) ?? [])
          .filter((p) => p['in'] === 'path')
          .map((p) => p['name']);
        expect([...declared].sort(), `${method} ${path} path params`).toEqual([...params].sort());
      }
    }

    const refs: string[] = [];
    collectRefs(doc, refs);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(resolvePointer(doc, ref), ref).toBeDefined();
    const schemes = (doc['components'] as Json)['securitySchemes'] as Json;
    expect(Object.keys(schemes).sort()).toEqual(['bearerToken', 'sessionCookie']);
  });

  it('serves Swagger UI at /api/docs with a CSP (helmet defaults on the docs only)', async () => {
    const res = await request(h.app).get('/api/docs/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.text).toContain('swagger-ui');
    expect(res.headers['content-security-policy']).toBeDefined();
  });
});
