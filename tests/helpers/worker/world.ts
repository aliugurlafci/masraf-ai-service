// Integration world for @orc/orchestrator + apps/worker (contract §13, §14, §18.2): temp roots, a real source
// repository, mssql-test rows (setup as orc_migrator, worker as orc_worker), redis-test under a unique prefix,
// fake-claude and fake-cbm through the local launcher (SANDBOX_MODE=local).
import { chmodSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import sql from 'mssql';
import { WorkerConfigSchema } from '@orc/shared/node';
import type { WorkerConfig } from '@orc/shared/node';
import { SETTLED_TASK_STATUSES, TaskStreamEventSchema } from '@orc/shared';
import type { TaskStatus, TaskStreamEvent, Uuid } from '@orc/shared';
import type { AgentRecord, AttemptRecord, Database, NewProject, ProjectRecord, TaskRecord, UserRecord } from '@orc/database';
import {
  createControlChannel,
  createQueueRegistry,
  createTaskStreamPublisher,
  taskStreamKey,
} from '@orc/task-manager';
import type { QueueRegistry, RedisFactory } from '@orc/task-manager';
import { createWorkerRuntime } from '../../../apps/worker/src/runtime';
import type { WorkerRuntime, WorkerRuntimeOverrides } from '../../../apps/worker/src/runtime';
import { openDb, openPool, query } from '../database/db';
import { silentLogger, testEnv } from '../database/env';
import { createUser, seededAgent, uniq, userActor } from '../database/fixtures';
import { cleanupPrefix, rawRedis, testRedisFactory, uniquePrefix } from '../task-manager/redis';
import { FAKE_CLAUDE_PATH, TEST_API_KEY } from '../claude/fake-claude';
import { FAKE_CBM_PATH } from '../mcp/support';
import { createSourceRepo, makeTempDir, removeTempDir } from '../git/fixtures';
import { waitFor } from '../common/wait-for';

export const IS_WIN32 = process.platform === 'win32';

/** Test runner of the sample repository: writes a JUnit report and prints a summary. */
export const RUN_TESTS_MJS = `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('reports', { recursive: true });
writeFileSync('reports/junit.xml', \`<?xml version="1.0" encoding="UTF-8"?>
<testsuites><testsuite name="sample" tests="2">
<testcase classname="sample" name="adds" time="0.004"/>
<testcase classname="sample" name="multiplies" time="0.002"/>
</testsuite></testsuites>\`);
console.log('2 tests passed');
`;

export const SAMPLE_FILES: Record<string, string> = {
  'README.md': '# sample\n',
  'src/math.js': 'export const add = (a, b) => a + b;\n',
  'run-tests.mjs': RUN_TESTS_MJS,
  '.gitignore': 'reports/\n',
};

export interface WorldOptions {
  /** Extra env for every worker config of this world. */
  env?: Record<string, string>;
}

export interface WorkerWorld {
  readonly root: string;
  readonly projectsRoot: string;
  readonly workspacesRoot: string;
  readonly claudeHomeRoot: string;
  readonly cbmCacheDir: string;
  readonly hooksDir: string;
  readonly gitHome: string;
  readonly prefix: string;
  readonly db: Database;
  readonly queues: QueueRegistry;
  readonly redis: Redis;
  readonly user: UserRecord;
  readonly agent: AgentRecord;
  /** Creates a source repository below PROJECTS_ROOT; returns its repoPath (relative) and directory. */
  repo(files?: Record<string, string>): { repoPath: string; dir: string; sha: string };
  /** A `ready` project for `repoPath` (as a finished sync would leave it). */
  project(repo: { repoPath: string; sha: string }, o?: Partial<NewProject>): Promise<ProjectRecord>;
  workerEnv(o?: { workerId?: string; env?: Record<string, string> }): Record<string, string>;
  workerConfig(o?: { workerId?: string; env?: Record<string, string> }): WorkerConfig;
  /** Creates and starts a runtime (stopped by dispose()). */
  startWorker(o?: { workerId?: string; env?: Record<string, string>; overrides?: WorkerRuntimeOverrides }): Promise<WorkerRuntime>;
  /** Task + attempt #1 queued, stream persisted, job enqueued (unless `enqueue: false`). */
  createTask(project: ProjectRecord, o?: { prompt?: string; directives?: string[]; timeoutSeconds?: number; enqueue?: boolean }): Promise<{ task: TaskRecord; attempt: AttemptRecord }>;
  waitStatus(taskId: Uuid, statuses: readonly TaskStatus[], timeoutMs?: number): Promise<TaskRecord>;
  waitSettled(taskId: Uuid, timeoutMs?: number): Promise<TaskRecord>;
  streamEvents(taskId: Uuid): Promise<TaskStreamEvent[]>;
  requestCancel(task: TaskRecord): Promise<void>;
  /** Raw SQL as orc_migrator (backdating, assertions). */
  sql<R = Record<string, unknown>>(text: string, inputs?: readonly (readonly [string, sql.ISqlType | (() => sql.ISqlType), unknown])[]): Promise<R[]>;
  freePort(): Promise<number>;
  dispose(): Promise<void>;
}

export function directives(lines: readonly string[]): string {
  return ['Implement the sample feature.', ...lines, ''].join('\n');
}

export function writeDirective(rel: string, content: string): string {
  return `@@fake write ${rel} ${Buffer.from(content, 'utf8').toString('base64')}`;
}

export async function createWorkerWorld(o: WorldOptions = {}): Promise<WorkerWorld> {
  const root = makeTempDir('orc-wk-');
  const projectsRoot = path.join(root, 'projects');
  const workspacesRoot = path.join(root, 'workspaces');
  const claudeHomeRoot = path.join(root, 'claude-home');
  const cbmCacheDir = path.join(root, 'cbm-cache');
  const hooksDir = path.join(root, 'empty-hooks');
  const gitHome = path.join(root, 'git-home');
  for (const d of [projectsRoot, workspacesRoot, claudeHomeRoot, cbmCacheDir, hooksDir, gitHome]) mkdirSync(d, { recursive: true });
  if (!IS_WIN32) chmodSync(hooksDir, 0o555);
  const prefix = uniquePrefix();
  const db = await openDb('orc_migrator');
  const pool = await openPool('orc_migrator', 2);
  const factory: RedisFactory = testRedisFactory(prefix);
  const queues = createQueueRegistry(factory, { prefix, jobAttempts: 3, backoffMs: 500 });
  const commandRedis = factory.create('command', 'world-command');
  const publisher = createTaskStreamPublisher(commandRedis, { prefix, logger: silentLogger() });
  const control = createControlChannel(factory, { prefix, logger: silentLogger() });
  const redis = rawRedis(prefix);
  const user = await createUser(db);
  const agent = await seededAgent(db);
  const runtimes: WorkerRuntime[] = [];
  const env = testEnv();

  const workerEnv = (w: { workerId?: string; env?: Record<string, string> } = {}): Record<string, string> => ({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    APP_VERSION: 'it',
    DB_HOST: env['DB_HOST'] ?? '127.0.0.1',
    DB_PORT: env['DB_PORT'] ?? '14331',
    DB_NAME: env['DB_NAME'] ?? 'orchestrator_test',
    DB_USER: 'orc_worker',
    DB_PASSWORD: env['DB_WORKER_PASSWORD'] ?? '',
    DB_ENCRYPT: env['DB_ENCRYPT'] ?? 'true',
    DB_TRUST_SERVER_CERTIFICATE: env['DB_TRUST_SERVER_CERTIFICATE'] ?? 'true',
    REDIS_HOST: env['REDIS_HOST'] ?? '127.0.0.1',
    REDIS_PORT: env['REDIS_PORT'] ?? '16380',
    ...(env['REDIS_PASSWORD'] ? { REDIS_PASSWORD: env['REDIS_PASSWORD'] } : {}),
    REDIS_PREFIX: prefix,
    WORKER_ID: w.workerId ?? `it-${randomUUID().slice(0, 8)}`,
    WORKER_CONCURRENCY: '2',
    WORKER_HEALTH_HOST: '127.0.0.1',
    HEARTBEAT_INTERVAL_MS: '1000',
    ATTEMPT_STALE_MS: '3000',
    DB_WRITE_RETRY_WINDOW_MS: '500',
    CLAUDE_KILL_GRACE_MS: '1500',
    SHUTDOWN_TIMEOUT_MS: '30000',
    ORPHAN_SWEEP_INTERVAL_MS: '60000',
    QUEUE_JOB_ATTEMPTS: '3',
    QUEUE_BACKOFF_MS: '500',
    PROJECTS_ROOT: projectsRoot,
    WORKSPACES_ROOT: workspacesRoot,
    CLAUDE_HOME_ROOT: claudeHomeRoot,
    CBM_CACHE_DIR: cbmCacheDir,
    GIT_HOOKS_DIR: hooksDir,
    WORKSPACES_MIN_FREE_BYTES: '0',
    LOG_FLUSH_INTERVAL_MS: '100',
    SANDBOX_MODE: 'local',
    CLAUDE_BIN: process.execPath,
    CLAUDE_BIN_PREFIX_ARGS: JSON.stringify([FAKE_CLAUDE_PATH]),
    CLAUDE_BARE: 'true',
    ANTHROPIC_API_KEY: TEST_API_KEY,
    CLAUDE_INIT_TIMEOUT_MS: '30000',
    TEST_KILL_GRACE_MS: '1000',
    MCP_ENABLED: 'true',
    CODEBASE_MEMORY_MCP_BIN: process.execPath,
    CODEBASE_MEMORY_MCP_BIN_PREFIX_ARGS: JSON.stringify([FAKE_CBM_PATH]),
    ...(o.env ?? {}),
    ...(w.env ?? {}),
  });

  const workerConfig = (w: { workerId?: string; env?: Record<string, string> } = {}): WorkerConfig =>
    WorkerConfigSchema.parse(workerEnv(w));

  const world: WorkerWorld = {
    root,
    projectsRoot,
    workspacesRoot,
    claudeHomeRoot,
    cbmCacheDir,
    hooksDir,
    gitHome,
    prefix,
    db,
    queues,
    redis,
    user,
    agent,

    repo(files = SAMPLE_FILES) {
      const repoPath = `acme/${uniq('repo')}`;
      const dir = path.join(projectsRoot, ...repoPath.split('/'));
      const sha = createSourceRepo(dir, files, gitHome);
      return { repoPath, dir, sha };
    },

    async project(repo, p = {}) {
      const project = await db.repos.projects.insert({
        name: uniq('proj'),
        description: 'worker integration project',
        repoPath: repo.repoPath,
        testCommand: ['node', 'run-tests.mjs'],
        testTimeoutSeconds: 60,
        junitReportPath: 'reports/junit.xml',
        requireIndex: false,
        autoIndex: false,
        indexMode: 'fast',
        defaultAgentId: agent.id,
        defaultTimeoutSeconds: 600,
        workspaceMaxBytes: null,
        createdByUserId: user.id,
        defaultBranch: 'main',
        ...p,
      });
      await db.repos.projects.updateSyncState(project.id, {
        status: 'ready',
        statusDetail: null,
        defaultBranch: 'main',
        headSha: repo.sha,
        synced: true,
      });
      const ready = await db.repos.projects.findById(project.id);
      if (!ready) throw new Error('project vanished');
      return ready;
    },

    workerEnv,
    workerConfig,

    async startWorker(w = {}) {
      const rt = createWorkerRuntime(workerConfig(w), { healthPort: 0, ...(w.overrides ?? {}) });
      runtimes.push(rt);
      await rt.start();
      return rt;
    },

    async createTask(project, t = {}) {
      const created = await db.repos.taskState.createTask({
        task: {
          projectId: project.id,
          agentId: agent.id,
          createdByUserId: user.id,
          title: uniq('task'),
          prompt: t.prompt ?? directives(t.directives ?? []),
          acceptanceCriteria: 'The sample tests pass.',
          scope: null,
          baseRef: null,
          model: 'sonnet',
          effort: null,
          timeoutSeconds: t.timeoutSeconds ?? 600,
          maxBudgetUsd: null,
          correlationId: randomUUID(),
        },
        actor: userActor(user),
        audit: { requestId: uniq('req'), ip: '127.0.0.1', userAgent: 'vitest' },
      });
      await publisher.persist(created.task.id);
      if (t.enqueue !== false) {
        await queues.enqueueAttempt({
          v: 1,
          taskId: created.task.id,
          attemptId: created.attempt.id,
          attemptNumber: created.attempt.attemptNumber,
          correlationId: created.task.correlationId,
        });
      }
      return created;
    },

    async waitStatus(taskId, statuses, timeoutMs = 60_000) {
      return waitFor(
        async () => {
          const t = await db.repos.tasks.findById(taskId);
          return t !== null && statuses.includes(t.status) ? t : null;
        },
        { timeoutMs, intervalMs: 200, description: `task ${taskId} to reach ${statuses.join('|')}` },
      );
    },

    async waitSettled(taskId, timeoutMs = 90_000) {
      return world.waitStatus(taskId, SETTLED_TASK_STATUSES, timeoutMs);
    },

    async streamEvents(taskId) {
      const entries = await redis.xrange(taskStreamKey(prefix, taskId), '-', '+');
      return entries.map(([, fields]) => {
        const idx = fields.indexOf('e');
        return TaskStreamEventSchema.parse(JSON.parse(fields[idx + 1] ?? 'null'));
      });
    },

    async requestCancel(task) {
      const updated = await db.repos.taskState.requestCancel({
        taskId: task.id,
        actor: userActor(user),
        audit: { requestId: uniq('req') },
        reasonText: 'test cancel',
      });
      const attemptId = updated.currentAttemptId;
      if (attemptId === null) throw new Error('no current attempt');
      await control.publishCancel({
        taskId: task.id,
        attemptId,
        requestedByUserId: user.id,
        requestedAt: new Date().toISOString(),
        correlationId: null,
      });
    },

    async sql(text, inputs = []) {
      return query(pool, text, inputs);
    },

    freePort() {
      return new Promise((resolve, reject) => {
        const s = createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => {
          const a = s.address();
          const port = typeof a === 'object' && a !== null ? a.port : 0;
          s.close(() => resolve(port));
        });
      });
    },

    async dispose() {
      for (const rt of runtimes) {
        await rt.stop().catch(() => undefined);
      }
      await queues.close().catch(() => undefined);
      await factory.closeAll().catch(() => undefined);
      await redis.quit().catch(() => undefined);
      await cleanupPrefix(prefix);
      await pool.close().catch(() => undefined);
      await db.close().catch(() => undefined);
      removeTempDir(root);
    },
  };
  return world;
}

export { sql };
