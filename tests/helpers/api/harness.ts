// API test harness (contract §18.2): createApp against mssql-test (orc_api login) and redis-test with a unique
// REDIS_PREFIX per test file. close() releases connections; every test file also calls resetDb() + cleanupPrefix().
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import request from 'supertest';
import type { Response as SupertestResponse } from 'supertest';
import { DEFAULT_SCRYPT_PARAMS, hashPassword } from '@orc/security';
import { loadApiConfig } from '@orc/shared/node';
import type { ApiConfig } from '@orc/shared/node';
import type { Role } from '@orc/shared';
import type { Database, UserRecord } from '@orc/database';
import { createRedisFactory } from '@orc/task-manager';
import type { RedisConfig, RedisFactory } from '@orc/task-manager';
import { createApiRuntime, createApp } from '../../../apps/api/src/app';
import { composeDeps } from '../../../apps/api/src/compose';
import type { AppDeps, RateLimitRule } from '../../../apps/api/src/types';
import { openDb } from '../database/db';
import { silentLogger, testEnv } from '../database/env';
import { uniq } from '../database/fixtures';
import { testRedisConfig, uniquePrefix } from '../task-manager/redis';

export const TEST_PASSWORD = 'Correct-Horse-9-Battery';
export const PUBLIC_ORIGIN = 'http://127.0.0.1:5173';
export const COOKIE_NAME = 'orc_sid';
export const TEST_SCRYPT = { ...DEFAULT_SCRYPT_PARAMS, N: 16_384 };

export interface HarnessOptions {
  /** Extra API environment (SSE_*, LOGIN_*, ...). */
  env?: Record<string, string>;
  rateLimits?: Partial<Record<'login' | 'auth' | 'write' | 'task_create' | 'read' | 'stream' | 'public', RateLimitRule>>;
  /** Redis endpoint override (e.g. a cuttable TCP proxy). */
  redis?: Partial<Pick<RedisConfig, 'host' | 'port'>>;
  sseRedisTimeoutMs?: number;
  queueOpTimeoutMs?: number;
  /** Replace / wrap dependencies before createApp (fault injection). */
  patchDeps?: (deps: AppDeps) => AppDeps;
  /** Use this database handle instead of opening one (it is not closed by the harness). */
  db?: Database;
}

export interface ApiHarness {
  app: Express;
  deps: AppDeps;
  config: ApiConfig;
  db: Database;
  prefix: string;
  redis: RedisFactory;
  close(): Promise<void>;
}

export function apiTestConfig(prefix: string, extra: Record<string, string> = {}): ApiConfig {
  const env = testEnv();
  return loadApiConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DB_HOST: env['DB_HOST'] ?? '127.0.0.1',
    DB_PORT: env['DB_PORT'] ?? '14331',
    DB_NAME: env['DB_NAME'] ?? 'orchestrator_test',
    DB_USER: 'orc_api',
    DB_PASSWORD: env['DB_API_PASSWORD'] ?? '',
    DB_ENCRYPT: env['DB_ENCRYPT'] ?? 'true',
    DB_TRUST_SERVER_CERTIFICATE: env['DB_TRUST_SERVER_CERTIFICATE'] ?? 'true',
    REDIS_HOST: env['REDIS_HOST'] ?? '127.0.0.1',
    REDIS_PORT: env['REDIS_PORT'] ?? '16380',
    ...(env['REDIS_PASSWORD'] ? { REDIS_PASSWORD: env['REDIS_PASSWORD'] } : {}),
    REDIS_PREFIX: prefix,
    PUBLIC_ORIGIN,
    COOKIE_SECURE: 'false',
    PASSWORD_SCRYPT_N: '16384',
    CLAUDE_ALLOWED_MODELS: 'sonnet,opus',
    CLAUDE_DEFAULT_MODEL: env['CLAUDE_DEFAULT_MODEL'] ?? 'sonnet',
    APP_VERSION: '9.9.9-test',
    ...extra,
  });
}

export async function createApiHarness(o: HarnessOptions = {}): Promise<ApiHarness> {
  const prefix = uniquePrefix();
  const config = apiTestConfig(prefix, o.env);
  const ownDb = o.db === undefined;
  const db = o.db ?? (await openDb('orc_api'));
  const redis = createRedisFactory({ ...testRedisConfig(prefix), ...o.redis }, { logger: silentLogger() });
  const runtime = createApiRuntime();
  runtime.ready = true;
  let deps = composeDeps({
    config,
    logger: silentLogger(),
    db,
    redis,
    runtime,
    queueOpTimeoutMs: o.queueOpTimeoutMs ?? 2_000,
    ...(o.rateLimits !== undefined ? { rateLimits: o.rateLimits } : {}),
    ...(o.sseRedisTimeoutMs !== undefined ? { sseRedisTimeoutMs: o.sseRedisTimeoutMs } : {}),
  });
  if (o.patchDeps) deps = o.patchDeps(deps);
  const app = createApp(deps);
  return {
    app,
    deps,
    config,
    db,
    prefix,
    redis,
    async close() {
      runtime.sse.closeAll();
      await deps.queues.close().catch(() => undefined);
      await redis.closeAll();
      if (ownDb) await db.close();
    },
  };
}

/** A user with a real scrypt hash of TEST_PASSWORD (N=16384). */
export async function createLoginUser(
  db: Database,
  o: { role?: Role; username?: string; password?: string } = {},
): Promise<UserRecord> {
  return db.repos.users.insert({
    username: o.username ?? uniq('apiuser').toLowerCase(),
    displayName: 'API Test User',
    email: null,
    role: o.role ?? 'operator',
    passwordHash: await hashPassword(o.password ?? TEST_PASSWORD, TEST_SCRYPT),
  });
}

export interface SessionAuth {
  kind: 'session';
  cookie: string;
  csrf: string;
  userId: string;
}

export interface TokenAuth {
  kind: 'token';
  token: string;
}

export type Auth = SessionAuth | TokenAuth;

export function sessionCookieOf(res: SupertestResponse): string {
  const raw = res.headers['set-cookie'] as unknown;
  const list = Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
  const cookie = list.find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (cookie === undefined) throw new Error('no session cookie in response');
  return cookie.split(';')[0] ?? '';
}

export async function login(app: Express, username: string, password = TEST_PASSWORD): Promise<SessionAuth> {
  const res = await request(app).post('/api/v1/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const body = res.body as { csrfToken: string; user: { id: string } };
  return { kind: 'session', cookie: sessionCookieOf(res), csrf: body.csrfToken, userId: body.user.id };
}

export async function createPat(app: Express, s: SessionAuth, readOnly = false): Promise<TokenAuth> {
  const res = await request(app)
    .post('/api/v1/auth/tokens')
    .set('Cookie', s.cookie)
    .set('X-CSRF-Token', s.csrf)
    .send({ name: uniq('pat'), readOnly });
  if (res.status !== 201) throw new Error(`token creation failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { kind: 'token', token: (res.body as { token: string }).token };
}

/** Request headers for an authenticated call (CSRF included for sessions). */
export function authHeaders(a: Auth): Record<string, string> {
  return a.kind === 'session'
    ? { Cookie: a.cookie, 'X-CSRF-Token': a.csrf }
    : { Authorization: `Bearer ${a.token}` };
}

type Method = 'get' | 'post' | 'patch' | 'delete';

/** supertest call with auth headers applied. */
export function call(app: Express, method: Method, path: string, a?: Auth): request.Test {
  let t = request(app)[method](path);
  if (a) for (const [k, v] of Object.entries(authHeaders(a))) t = t.set(k, v);
  return t;
}

/** Starts a real HTTP server (SSE tests need a long-lived socket). */
export async function listen(app: Express): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Problem Details shape assertion helper (§9.6). */
export function problemOf(res: SupertestResponse): {
  type: string;
  title: string;
  status: number;
  code: string;
  requestId: string;
  correlationId: string;
  instance?: string;
  detail?: string;
  errors?: { path: string; message: string; code: string }[];
  retryAfterSeconds?: number;
} {
  return res.body as ReturnType<typeof problemOf>;
}
