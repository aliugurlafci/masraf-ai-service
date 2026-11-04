// End-to-end system (contract §18.1 e2e row): the real API (`createApp` + `composeDeps`, orc_api login) served on
// an ephemeral HTTP port and one or more in-process worker runtimes (`createWorkerRuntime`, SANDBOX_MODE=local,
// fake-claude, fake-cbm) sharing one REDIS_PREFIX on redis-test and the mssql-test database. Every interaction a
// test asserts on goes over HTTP (JSON calls with fetch, SSE parsed from the raw text/event-stream body); the
// database handle of the worker world is used only to locate process ids and to prove cleanup.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { z } from 'zod';
import {
  ProjectSchema,
  SETTLED_TASK_STATUSES,
  TaskDetailSchema,
  TaskSchema,
} from '@orc/shared';
import type { Project, Role, Task, TaskDetail, TaskStatus, Uuid } from '@orc/shared';
import type { ApiConfig } from '@orc/shared/node';
import type { Database, UserRecord } from '@orc/database';
import { createRedisFactory } from '@orc/task-manager';
import type { RedisFactory } from '@orc/task-manager';
import { createApiRuntime, createApp } from '../../../apps/api/src/app';
import { composeDeps } from '../../../apps/api/src/compose';
import type { AppDeps } from '../../../apps/api/src/types';
import type { WorkerRuntime, WorkerRuntimeOverrides } from '../../../apps/worker/src/runtime';
import { COOKIE_NAME, TEST_PASSWORD, apiTestConfig, createLoginUser } from '../api/harness';
import { SseClient } from '../api/sse-client';
import { openDb } from '../database/db';
import { silentLogger } from '../database/env';
import { uniq } from '../database/fixtures';
import { cleanupPrefix, keysUnder, rawRedis, testRedisConfig } from '../task-manager/redis';
import { aliveProcesses } from '../common/process';
import { waitFor } from '../common/wait-for';
import { SAMPLE_FILES, createWorkerWorld, directives } from '../worker/world';
import type { WorkerWorld } from '../worker/world';

export { SAMPLE_FILES, writeDirective } from '../worker/world';
export { SseClient } from '../api/sse-client';
export type { SseEvent } from '../api/sse-client';

/** A logged-in browser-like session (cookie + CSRF token). */
export interface E2eSession {
  readonly userId: Uuid;
  readonly username: string;
  readonly cookie: string;
  readonly csrf: string;
}

export interface HttpResult {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  /** Parsed JSON body (null for empty or non-JSON answers). */
  readonly body: unknown;
}

export interface E2eOptions {
  /** Extra worker environment for every runtime of this system. */
  workerEnv?: Record<string, string>;
  /** Extra API environment. */
  apiEnv?: Record<string, string>;
}

export interface CreateTaskOptions {
  title?: string;
  timeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

export interface E2eSystem {
  readonly world: WorkerWorld;
  readonly app: Express;
  readonly deps: AppDeps;
  readonly config: ApiConfig;
  readonly apiDb: Database;
  /** Base URL of the HTTP server, e.g. http://127.0.0.1:54321 */
  readonly url: string;
  /** Creates a user with a real password hash and logs it in over HTTP. */
  user(role: Role): Promise<E2eSession>;
  startWorker(o?: { workerId?: string; env?: Record<string, string>; overrides?: WorkerRuntimeOverrides }): Promise<WorkerRuntime>;
  /** `fetch` against `/api/v1<path>` with the session cookie (and CSRF token on writes). */
  http(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', apiPath: string, auth?: E2eSession, body?: unknown, headers?: Record<string, string>): Promise<HttpResult>;
  /** Creates a source repository below PROJECTS_ROOT and registers it through `POST /projects` (admin). */
  registerProject(admin: E2eSession, files?: Record<string, string>): Promise<{ project: Project; repoDir: string }>;
  /** Polls `GET /projects/:id` until `ready` (the worker's sync job ran). */
  waitProjectReady(admin: E2eSession, projectId: Uuid, timeoutMs?: number): Promise<Project>;
  /** `POST /tasks` with a fake-claude directive prompt; asserts 202 + Location. */
  createTask(auth: E2eSession, projectId: Uuid, directiveLines: readonly string[], o?: CreateTaskOptions): Promise<Task>;
  /** `GET /tasks/:id` parsed as TaskDetail. */
  detail(auth: E2eSession, taskId: Uuid): Promise<TaskDetail>;
  waitStatus(auth: E2eSession, taskId: Uuid, statuses: readonly TaskStatus[], timeoutMs?: number): Promise<TaskDetail>;
  waitSettled(auth: E2eSession, taskId: Uuid, timeoutMs?: number): Promise<TaskDetail>;
  /** Opens `GET /tasks/:id/stream` (optionally with `Last-Event-ID`). Closed by dispose(). */
  stream(auth: E2eSession, taskId: Uuid, lastEventId?: string): Promise<SseClient>;
  /** PIDs reported by fake-claude (`fake_pid`) plus the Claude PID of every given attempt. */
  attemptPids(attemptIds: readonly Uuid[]): Promise<number[]>;
  /** Process registry files (`<WORKSPACES_ROOT>/.orc/run/<workerId>/*.json`) of one worker or of every worker. */
  registryEntries(workerId?: string): string[];
  /**
   * Waits until no process of the attempts survives, no pipeline of `runtimes` is active and their process
   * registries are empty. Registries left by workers that are not among `runtimes` (killed processes) may keep
   * entries, but every PID they record must be dead.
   */
  assertNoOrphans(attemptIds: readonly Uuid[], runtimes: readonly WorkerRuntime[]): Promise<void>;
  /** Stops workers, closes the API, cleans Redis keys of the prefix and removes the temp root. */
  dispose(): Promise<void>;
}

const RegistryPidSchema = z.object({ pid: z.int().min(1) });
const LoginBodySchema = z.object({ csrfToken: z.string(), user: z.object({ id: z.string(), username: z.string() }) });

/** Orders two SSE ids of the Redis stream (`r-<ms>-<seq>`); negative when a < b. */
export function compareStreamIds(a: string, b: string): number {
  const parse = (id: string): [bigint, bigint] => {
    const m = /^r-(\d+)-(\d+)$/.exec(id);
    if (!m?.[1] || !m[2]) throw new Error(`not a Redis stream SSE id: ${id}`);
    return [BigInt(m[1]), BigInt(m[2])];
  };
  const [am, as] = parse(a);
  const [bm, bs] = parse(b);
  if (am !== bm) return am < bm ? -1 : 1;
  if (as !== bs) return as < bs ? -1 : 1;
  return 0;
}

function listFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

export async function createE2eSystem(o: E2eOptions = {}): Promise<E2eSystem> {
  const world = await createWorkerWorld({ env: o.workerEnv ?? {} });
  const config = apiTestConfig(world.prefix, o.apiEnv ?? {});
  const apiDb = await openDb('orc_api');
  const redis: RedisFactory = createRedisFactory(testRedisConfig(world.prefix), { logger: silentLogger() });
  const runtime = createApiRuntime();
  runtime.ready = true;
  const deps = composeDeps({ config, logger: silentLogger(), db: apiDb, redis, runtime, queueOpTimeoutMs: 5_000 });
  const app = createApp(deps);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const clients: SseClient[] = [];
  const runtimes: WorkerRuntime[] = [];
  const users: UserRecord[] = [];

  const http: E2eSystem['http'] = async (method, apiPath, auth, body, headers = {}) => {
    const h: Record<string, string> = { Accept: 'application/json', ...headers };
    if (auth) {
      h['Cookie'] = auth.cookie;
      if (method !== 'GET') h['X-CSRF-Token'] = auth.csrf;
    }
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(`${url}/api/v1${apiPath}`, {
      method,
      headers: h,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const type = res.headers.get('content-type') ?? '';
    const parsed: unknown = text !== '' && type.includes('json') ? (JSON.parse(text) as unknown) : null;
    return { status: res.status, headers: res.headers, text, body: parsed };
  };

  const expectStatus = (r: HttpResult, status: number, what: string): void => {
    if (r.status !== status) throw new Error(`${what}: expected HTTP ${status}, got ${r.status} ${r.text.slice(0, 500)}`);
  };

  const sys: E2eSystem = {
    world,
    app,
    deps,
    config,
    apiDb,
    url,

    async user(role) {
      const u = await createLoginUser(apiDb, { role });
      users.push(u);
      const res = await fetch(`${url}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username: u.username, password: TEST_PASSWORD }),
      });
      const text = await res.text();
      if (res.status !== 200) throw new Error(`login failed: ${res.status} ${text}`);
      const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`));
      if (cookie === undefined) throw new Error('no session cookie');
      const body = LoginBodySchema.parse(JSON.parse(text));
      return { userId: body.user.id, username: body.user.username, cookie: cookie.split(';')[0] ?? '', csrf: body.csrfToken };
    },

    async startWorker(w = {}) {
      const rt = await world.startWorker(w);
      runtimes.push(rt);
      return rt;
    },

    http,

    async registerProject(admin, files = SAMPLE_FILES) {
      const repo = world.repo(files);
      const res = await http('POST', '/projects', admin, {
        name: uniq('e2e'),
        description: 'e2e project',
        repoPath: repo.repoPath,
        testCommand: ['node', 'run-tests.mjs'],
        testTimeoutSeconds: 60,
        junitReportPath: 'reports/junit.xml',
        requireIndex: false,
        autoIndex: true,
        indexMode: 'fast',
        defaultAgentId: world.agent.id,
        defaultTimeoutSeconds: 600,
      });
      expectStatus(res, 201, 'POST /projects');
      const created = ProjectSchema.parse(res.body);
      if (res.headers.get('location') !== `/api/v1/projects/${created.id}`) throw new Error('POST /projects without Location');
      const project = await sys.waitProjectReady(admin, created.id);
      return { project, repoDir: repo.dir };
    },

    async waitProjectReady(admin, projectId, timeoutMs = 90_000) {
      return waitFor(
        async () => {
          const r = await http('GET', `/projects/${projectId}`, admin);
          expectStatus(r, 200, 'GET /projects/:id');
          const p = ProjectSchema.parse(r.body);
          if (p.status === 'invalid' || p.status === 'archived') throw new Error(`project ${projectId} is ${p.status}: ${p.statusDetail ?? ''}`);
          return p.status === 'ready' ? p : null;
        },
        { timeoutMs, intervalMs: 300, description: `project ${projectId} to become ready` },
      );
    },

    async createTask(auth, projectId, directiveLines, t = {}) {
      const res = await http('POST', '/tasks', auth, {
        projectId,
        title: t.title ?? uniq('e2e-task'),
        prompt: directives(directiveLines),
        acceptanceCriteria: 'The sample tests pass.',
        ...(t.timeoutSeconds !== undefined ? { timeoutSeconds: t.timeoutSeconds } : {}),
        ...(t.extra ?? {}),
      });
      expectStatus(res, 202, 'POST /tasks');
      const task = TaskSchema.parse(res.body);
      if (res.headers.get('location') !== `/api/v1/tasks/${task.id}`) throw new Error('POST /tasks without Location');
      return task;
    },

    async detail(auth, taskId) {
      const r = await http('GET', `/tasks/${taskId}`, auth);
      expectStatus(r, 200, 'GET /tasks/:id');
      return TaskDetailSchema.parse(r.body);
    },

    async waitStatus(auth, taskId, statuses, timeoutMs = 90_000) {
      return waitFor(
        async () => {
          const d = await sys.detail(auth, taskId);
          return statuses.includes(d.task.status) ? d : null;
        },
        { timeoutMs, intervalMs: 250, description: `task ${taskId} to reach ${statuses.join('|')}` },
      );
    },

    async waitSettled(auth, taskId, timeoutMs = 120_000) {
      return sys.waitStatus(auth, taskId, SETTLED_TASK_STATUSES, timeoutMs);
    },

    async stream(auth, taskId, lastEventId) {
      const client = await SseClient.open(`${url}/api/v1/tasks/${taskId}/stream`, {
        Cookie: auth.cookie,
        ...(lastEventId !== undefined ? { 'Last-Event-ID': lastEventId } : {}),
      });
      clients.push(client);
      return client;
    },

    async attemptPids(attemptIds) {
      const pids: number[] = [];
      for (const attemptId of attemptIds) {
        const logs = await world.db.repos.taskLogs.listByAttempt({ attemptId, stream: 'claude', limit: 5000 });
        // every match, not one per line: chunks are concatenated as stored (a line may span two chunks and the
        // chunks need not end with a newline)
        for (const m of logs.map((l) => l.content).join('').matchAll(/"subtype":"fake_pid","pid":(\d+)/g)) {
          if (m[1]) pids.push(Number(m[1]));
        }
        const a = await world.db.repos.attempts.findById(attemptId);
        if (a?.pid != null) pids.push(a.pid);
      }
      return pids;
    },

    registryEntries(workerId) {
      const base = path.join(world.workspacesRoot, '.orc', 'run');
      return listFilesRecursive(workerId === undefined ? base : path.join(base, workerId)).filter((f) => f.endsWith('.json'));
    },

    async assertNoOrphans(attemptIds, rts) {
      const pids = await sys.attemptPids(attemptIds);
      await waitFor(() => aliveProcesses(pids).length === 0, {
        timeoutMs: 20_000,
        intervalMs: 200,
        description: `no surviving process of ${pids.join(',')}`,
      });
      // the task row settles before the pipeline's finally (lease/lock release, unregister) has run
      await waitFor(() => rts.every((rt) => rt.active.size() === 0), {
        timeoutMs: 15_000,
        intervalMs: 100,
        description: 'pipelines unregistered',
      });
      const live = new Set(rts.map((rt) => rt.config.workerId));
      await waitFor(() => [...live].every((id) => sys.registryEntries(id).length === 0), {
        timeoutMs: 15_000,
        intervalMs: 100,
        description: 'process registries empty',
      });
      const runDir = path.join(world.workspacesRoot, '.orc', 'run');
      const dead = existsSync(runDir) ? readdirSync(runDir).filter((id) => !live.has(id)) : [];
      const recorded = dead.flatMap((id) =>
        sys.registryEntries(id).map((f) => RegistryPidSchema.parse(JSON.parse(readFileSync(f, 'utf8'))).pid),
      );
      await waitFor(() => aliveProcesses(recorded).length === 0, {
        timeoutMs: 20_000,
        intervalMs: 200,
        description: `no surviving process recorded by stopped workers (${recorded.join(',')})`,
      });
    },

    async dispose() {
      for (const c of clients) c.close();
      runtime.sse.closeAll();
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      for (const rt of runtimes) await rt.stop().catch(() => undefined);
      await deps.queues.close().catch(() => undefined);
      await redis.closeAll().catch(() => undefined);
      await apiDb.close().catch(() => undefined);
      await world.dispose();
      if (existsSync(world.root)) throw new Error(`e2e temp root was not removed: ${world.root}`);
      // nothing still running may write under the prefix once every component is closed (no Redis key leak)
      await new Promise((resolve) => setTimeout(resolve, 500));
      const probe = rawRedis(world.prefix);
      try {
        const left = await keysUnder(probe, world.prefix);
        if (left.length > 0) {
          await cleanupPrefix(world.prefix);
          throw new Error(`Redis keys written after dispose under ${world.prefix}: ${left.slice(0, 10).join(', ')}`);
        }
      } finally {
        await probe.quit().catch(() => undefined);
      }
    },
  };
  return sys;
}

/** Events of a stream that carry an id (everything that moves the resume point). */
export function idsOf(events: readonly { id: string | null }[]): string[] {
  return events.flatMap((e) => (e.id !== null ? [e.id] : []));
}
