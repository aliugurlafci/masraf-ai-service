// Dead-letter handling (contract §6.4 step 6, T-m1) with real BullMQ on redis-test and mssql-test: exhausted infra
// retries and invalid payloads => orc-tasks-dlq entry + attempt failed (queue_exhausted | invalid_job) + audit.
import { QueueEvents, Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sql from 'mssql';
import { OrcError, QUEUE_NAMES } from '@orc/shared';
import type { Database } from '@orc/database';
import {
  createControlChannel,
  createQueueRegistry,
  createTaskService,
  createTaskStreamPublisher,
} from '@orc/task-manager';
import type { QueueRegistry, RedisFactory, TaskService } from '@orc/task-manager';
import {
  createActiveAttemptRegistry,
  createDeadLetterHandler,
  createRunAttemptProcessor,
} from '@orc/orchestrator';
import type { OrchestratorDeps } from '@orc/orchestrator';
import { openDb, openPool, query, resetDb } from '../../helpers/database/db';
import { silentLogger } from '../../helpers/database/env';
import { createQueuedTask, createTaskWorld } from '../../helpers/database/fixtures';
import type { TaskWorld } from '../../helpers/database/fixtures';
import { cleanupPrefix, testRedisFactory, uniquePrefix } from '../../helpers/task-manager/redis';
import { waitFor } from '../../helpers/common/wait-for';
import { orchestratorTestConfig } from '../../helpers/worker/fakes';

const prefix = uniquePrefix();
let setupDb: Database;
let workerDb: Database;
let factory: RedisFactory;
let queues: QueueRegistry;
let tasks: TaskService;
let taskWorld: TaskWorld;
let worker: Worker;
let events: QueueEvents;
let pool: sql.ConnectionPool;

beforeAll(async () => {
  setupDb = await openDb('orc_migrator');
  workerDb = await openDb('orc_worker');
  pool = await openPool('orc_migrator', 1);
  factory = testRedisFactory(prefix);
  queues = createQueueRegistry(factory, { prefix, jobAttempts: 2, backoffMs: 100 });
  const logger = silentLogger();
  const publisher = createTaskStreamPublisher(factory.create('command', 'dlq-publisher'), { prefix, logger });
  tasks = createTaskService({
    db: workerDb,
    queues,
    publisher,
    control: createControlChannel(factory, { prefix, logger }),
    logger,
    config: { maxAttemptsPerTask: 10, maxTimeoutSeconds: 14_400, allowedModels: ['sonnet'], defaultModel: 'sonnet', promptMaxChars: 32_000, maxAutoRecoveries: 2 },
  });
  taskWorld = await createTaskWorld(setupDb);
  const deps = {
    db: workerDb,
    queues,
    tasks,
    publisher,
    logger,
    config: orchestratorTestConfig({ workerId: 'it-dlq-worker', redisPrefix: prefix }),
  } as unknown as OrchestratorDeps;
  const processor = createRunAttemptProcessor({
    ...deps,
    active: createActiveAttemptRegistry(),
    // every claim attempt hits an infrastructure failure (BullMQ retries, then gives up)
    pipeline: { run: () => Promise.reject(new OrcError('db_unavailable', 'simulated database outage')) },
  });
  worker = new Worker(QUEUE_NAMES.tasks, processor, {
    connection: factory.create('worker', 'dlq-worker'),
    prefix,
    concurrency: 2,
    autorun: false,
  });
  worker.on('error', () => undefined);
  const dlq = createDeadLetterHandler(deps);
  events = new QueueEvents(QUEUE_NAMES.tasks, { connection: factory.create('blocking', 'dlq-events'), prefix });
  events.on('failed', ({ jobId, failedReason }) => {
    void dlq({ queue: 'orc-tasks', jobId, failedReason });
  });
  await events.waitUntilReady();
  void worker.run();
});

afterAll(async () => {
  await worker?.close();
  await events?.close();
  await queues?.close();
  await factory?.closeAll();
  await cleanupPrefix(prefix);
  await pool?.close();
  await workerDb?.close();
  await setupDb?.close();
  await resetDb();
});

describe('dead-letter handler', () => {
  it('dead-letters a run-attempt job after exhausted infra retries and fails the queued attempt', async () => {
    const { task, attempt } = await createQueuedTask(setupDb, taskWorld);
    await queues.enqueueAttempt({ v: 1, taskId: task.id, attemptId: attempt.id, attemptNumber: 1, correlationId: null });
    const failed = await waitFor(
      async () => {
        const t = await setupDb.repos.tasks.findById(task.id);
        return t?.status === 'failed' ? t : null;
      },
      { timeoutMs: 30_000, intervalMs: 200, description: 'task failed by the DLQ handler' },
    );
    expect(failed.statusReason).toBe('queue_exhausted');
    const a = await setupDb.repos.attempts.findById(attempt.id);
    expect(a).toMatchObject({ status: 'failed', failureReason: 'queue_exhausted' });
    const page = await queues.listDeadLetters({ limit: 50 });
    const entry = page.items.find((e) => e.data.jobId === attempt.id);
    expect(entry).toMatchObject({ jobId: `dlq-${attempt.id}` });
    expect(entry?.data).toMatchObject({ sourceQueue: 'orc-tasks', jobName: 'run-attempt', attemptsMade: 2 });
    expect(entry?.data.failedReason).toContain('simulated database outage');
    const audits = await query<{ n: number }>(
      pool,
      "SELECT COUNT(*) AS n FROM orc.AuditLogs WHERE Action = 'queue.job_dead_lettered' AND EntityId = @id",
      [['id', sql.NVarChar(200), attempt.id]],
    );
    expect(audits[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it('dead-letters an invalid payload at once and fails the attempt with invalid_job', async () => {
    const { task, attempt } = await createQueuedTask(setupDb, taskWorld);
    await queues.tasks.add('run-attempt', { v: 1, taskId: task.id, attemptId: attempt.id, attemptNumber: 0, correlationId: null }, { jobId: attempt.id, attempts: 3 });
    const failed = await waitFor(
      async () => {
        const t = await setupDb.repos.tasks.findById(task.id);
        return t?.status === 'failed' ? t : null;
      },
      { timeoutMs: 30_000, intervalMs: 200, description: 'task failed as invalid_job' },
    );
    expect(failed.statusReason).toBe('invalid_job');
    const page = await queues.listDeadLetters({ limit: 50 });
    const entry = page.items.find((e) => e.data.jobId === attempt.id);
    expect(entry?.data.failedReason).toMatch(/^invalid:/);
    expect(entry?.data.attemptsMade).toBe(1);
  });
});
