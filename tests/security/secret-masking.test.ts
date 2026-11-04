// Requirements §15 "secret masking" (contract §17.2, §18.5): secrets never leave the process in
// clear text through logs, TaskLogs (database), SSE payloads (the Redis task stream the SSE endpoint
// serves), Problem Details or audit before/after JSON. Pattern secrets (`@@fake secret`,
// password=...) and registered runtime secrets (worker DB password, API key) are both covered.
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '@orc/database';
import type { Database, ProjectRecord, UserRecord } from '@orc/database';
import { createLogger } from '@orc/logger';
import { createSecretRegistry } from '@orc/security';
import type { SecretRegistry } from '@orc/security';
import { OrcError } from '@orc/shared';
import { resetDb } from '../helpers/database/db';
import { silentLogger, testDbConfig, testEnv } from '../helpers/database/env';
import { createReadyProject, seededAgent } from '../helpers/database/fixtures';
import { cleanupPrefix } from '../helpers/task-manager/redis';
import { TEST_API_KEY } from '../helpers/claude/fake-claude';
import { call, createApiHarness, createLoginUser, login } from '../helpers/api/harness';
import type { ApiHarness, SessionAuth } from '../helpers/api/harness';
import { createWorkerWorld } from '../helpers/worker/world';
import type { WorkerWorld } from '../helpers/worker/world';

const FAKE_SECRET = 'sk-ant-FAKE0000000000000000000000';
const REGISTERED = 'Registered-Runtime-Secret-0042';
const PATTERN_PASSWORD = 'hunter2hunter2hunter2';

function capture(registry: SecretRegistry): { logger: ReturnType<typeof createLogger>; text: () => string } {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
  const logger = createLogger({ service: 'test', level: 'debug', version: 'test', env: 'test', destination, secrets: registry });
  return { logger, text: () => chunks.join('') };
}

describe('structured logs (@orc/logger)', () => {
  it('masks registered values, secret patterns, redact keys and error messages', () => {
    const registry = createSecretRegistry();
    registry.add(REGISTERED);
    const { logger, text } = capture(registry);
    logger.info(`connecting with ${REGISTERED} and ${FAKE_SECRET}`);
    logger.info(
      {
        req: { headers: { authorization: 'Bearer abcdefghijklmnop', cookie: 'orc_sid=abcdefghijklmnop' } },
        config: { db: { password: 'db-pass-in-config' } },
        body: { password: 'pw-in-body-123', token: 'tok-in-body-123', note: `password=${PATTERN_PASSWORD}` },
        url: 'redis://:redis-url-pass@redis:6379',
      },
      'request',
    );
    logger.error({ err: new Error(`Login failed: Server=db;Password=${PATTERN_PASSWORD};User Id=sa ${REGISTERED}`) }, 'boom');
    const out = text();
    for (const leaked of [
      REGISTERED,
      FAKE_SECRET,
      'abcdefghijklmnop',
      'db-pass-in-config',
      'pw-in-body-123',
      'tok-in-body-123',
      PATTERN_PASSWORD,
      'redis-url-pass',
    ]) {
      expect(out, leaked).not.toContain(leaked);
    }
    expect(out).toContain('[REDACTED]');
  });
});

describe('API: Problem Details and audit JSON', () => {
  let h: ApiHarness;
  let db: Database;
  let registry: SecretRegistry;
  let logText: () => string;
  let admin: UserRecord;
  let sAdmin: SessionAuth;
  let project: ProjectRecord;

  beforeAll(async () => {
    registry = createSecretRegistry();
    registry.add(REGISTERED);
    db = await createDatabase(testDbConfig('orc_api'), { logger: silentLogger(), secrets: registry }, { nodeEnv: 'test' });
    const cap = capture(registry);
    logText = cap.text;
    h = await createApiHarness({
      db,
      patchDeps: (deps) => ({
        ...deps,
        logger: cap.logger,
        tasks: {
          ...deps.tasks,
          // A dependency failure whose message carries credentials (e.g. a driver error).
          get: () =>
            Promise.reject(
              new Error(`Login failed for user 'orc_api'. Server=mssql;Password=${PATTERN_PASSWORD};${REGISTERED}`),
            ),
          list: () =>
            Promise.reject(
              new OrcError('db_unavailable', `pool error mssql://orc_api:${REGISTERED}@mssql:1433/orc`),
            ),
        },
      }),
    });
    admin = await createLoginUser(db, { role: 'admin' });
    sAdmin = await login(h.app, admin.username);
    project = await createReadyProject(db, admin, await seededAgent(db));
  });

  afterAll(async () => {
    await h?.close();
    await db?.close();
    expect(await cleanupPrefix(h.prefix)).toBe(0);
    await resetDb();
  });

  it('500/503 Problem Details expose no internal message; the log line is masked', async () => {
    const internal = await call(h.app, 'get', `/api/v1/tasks/${project.id}`, sAdmin);
    expect(internal.status).toBe(500);
    expect(internal.headers['content-type']).toMatch(/application\/problem\+json/);
    const unavailable = await call(h.app, 'get', '/api/v1/tasks', sAdmin);
    expect(unavailable.status).toBe(503);
    for (const res of [internal, unavailable]) {
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(PATTERN_PASSWORD);
      expect(body).not.toContain(REGISTERED);
      expect(body).not.toMatch(/Login failed|mssql:\/\//);
    }
    const logs = logText();
    expect(logs).toContain('Login failed');
    expect(logs).not.toContain(PATTERN_PASSWORD);
    expect(logs).not.toContain(REGISTERED);
  });

  it('Problem Details never echo query strings (tokens in URLs stay out of the instance)', async () => {
    const res = await call(h.app, 'get', `/api/v1/projects/not-a-uuid?access_token=${REGISTERED}&password=${PATTERN_PASSWORD}`, sAdmin);
    expect(res.status).toBe(400);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(REGISTERED);
    expect(body).not.toContain(PATTERN_PASSWORD);
  });

  it('audit before/after JSON is masked (registered value and secret patterns)', async () => {
    const get = await call(h.app, 'get', `/api/v1/projects/${project.id}`, sAdmin);
    const description = `deploy key ${REGISTERED}; password=${PATTERN_PASSWORD}; ${FAKE_SECRET}`;
    const patched = await call(h.app, 'patch', `/api/v1/projects/${project.id}`, sAdmin)
      .set('If-Match', String(get.headers['etag']))
      .send({ description });
    expect(patched.status).toBe(200);
    const rows = await db.repos.audit.list({ limit: 10, action: 'project.updated', entityId: project.id });
    expect(rows.length).toBeGreaterThan(0);
    const text = JSON.stringify(rows);
    expect(text).toContain('[REDACTED]');
    for (const leaked of [REGISTERED, PATTERN_PASSWORD, FAKE_SECRET]) expect(text, leaked).not.toContain(leaked);
  });
});

describe('worker pipeline: TaskLogs, task stream (SSE source) and task events', () => {
  let world: WorkerWorld;
  let workerDbPassword: string;
  let taskId: string;
  let attemptId: string;

  beforeAll(async () => {
    world = await createWorkerWorld();
    await world.startWorker({ workerId: 'sec-masking-1' });
    workerDbPassword = testEnv()['DB_WORKER_PASSWORD'] ?? '';
    expect(workerDbPassword.length).toBeGreaterThanOrEqual(8);
    const project = await world.project(world.repo());
    const created = await world.createTask(project, {
      directives: [
        '@@fake secret',
        `@@fake text db password is ${workerDbPassword} ok`,
        `@@fake stderr connect Server=mssql;Password=${PATTERN_PASSWORD};`,
        `@@fake stderr api key ${TEST_API_KEY}`,
        `@@fake text Authorization: Bearer ${'Z'.repeat(32)}`,
      ],
    });
    taskId = created.task.id;
    attemptId = created.attempt.id;
    const settled = await world.waitSettled(taskId, 120_000);
    expect(settled.status).toBe('completed');
  }, 180_000);

  afterAll(async () => {
    await world?.dispose();
    await resetDb();
  });

  it('TaskLogs (claude and stderr streams) contain the masked text only', async () => {
    const claude = await world.db.repos.taskLogs.listByAttempt({ attemptId, stream: 'claude', limit: 1000 });
    const stderr = await world.db.repos.taskLogs.listByAttempt({ attemptId, stream: 'stderr', limit: 1000 });
    const all = [...claude, ...stderr].map((l) => l.content).join('');
    expect(all).toContain('[REDACTED]');
    expect(all).toContain('db password is');
    for (const leaked of [FAKE_SECRET, workerDbPassword, PATTERN_PASSWORD, TEST_API_KEY, 'Z'.repeat(32)]) {
      expect(all, leaked).not.toContain(leaked);
    }
  });

  it('the Redis task stream served by SSE carries no secret', async () => {
    const events = await world.streamEvents(taskId);
    expect(events.length).toBeGreaterThan(0);
    const text = JSON.stringify(events);
    for (const leaked of [FAKE_SECRET, workerDbPassword, PATTERN_PASSWORD, TEST_API_KEY, 'Z'.repeat(32)]) {
      expect(text, leaked).not.toContain(leaked);
    }
  });

  it('worker-written task events, audit rows and the Claude session result carry no secret', async () => {
    // The task row itself (and its task.created audit) was written by the test setup with the
    // user's prompt, which deliberately contains the secrets; only worker output is checked here.
    const { default: mssql } = await import('mssql');
    const rows = await world.sql<{ J: string | null }>(
      `SELECT (SELECT * FROM orc.TaskEvents WHERE TaskId = @t AND ActorType = 'worker' FOR JSON PATH) AS J
       UNION ALL SELECT (SELECT * FROM orc.AuditLogs WHERE EntityId = CONVERT(NVARCHAR(100), @t) AND ActorType = 'worker' FOR JSON PATH)
       UNION ALL SELECT (SELECT ResultText FROM orc.ClaudeSessions WHERE AttemptId = @a FOR JSON PATH);`,
      [
        ['t', mssql.UniqueIdentifier, taskId],
        ['a', mssql.UniqueIdentifier, attemptId],
      ],
    );
    expect(rows.some((r) => (r.J ?? '').length > 0)).toBe(true);
    const text = rows.map((r) => r.J ?? '').join('\n');
    for (const leaked of [FAKE_SECRET, workerDbPassword, TEST_API_KEY]) expect(text, leaked).not.toContain(leaked);
  });
});
