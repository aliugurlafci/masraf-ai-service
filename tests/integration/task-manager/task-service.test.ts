// TaskService against mssql-test (orc_api / orc_worker logins) and redis-test (contract §2.9, §5, §6.3, §15.5):
// create -> rows + BullMQ job (jobId = attemptId); cancel queued/active; retry from every retryable state; ownership.
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import sql from 'mssql';
import { NotFoundError, OrcError, PreconditionFailedError } from '@orc/shared';
import type { ControlMessage, TaskStatus } from '@orc/shared';
import type { AgentRecord, Database, ProjectRecord, UserRecord } from '@orc/database';
import { rowVerToEtag } from '@orc/database';
import {
  createControlChannel,
  createQueueRegistry,
  createRedisFactory,
  createTaskService,
  createTaskStreamPublisher,
  createTaskStreamReader,
  taskStreamKey,
} from '@orc/task-manager';
import type {
  QueueRegistry,
  RedisFactory,
  TaskService,
  TaskServiceConfig,
  TaskStreamPublisher,
} from '@orc/task-manager';
import { openDb, query, openPool, resetDb } from '../../helpers/database/db';
import { silentLogger } from '../../helpers/database/env';
import {
  WORKER_ID,
  createReadyProject,
  createUser,
  seededAgent,
  workerActor,
} from '../../helpers/database/fixtures';
import { requestCtx, viewerFor } from '../../helpers/task-manager/fakes';
import {
  cleanupPrefix,
  rawRedis,
  testRedisFactory,
  uniquePrefix,
} from '../../helpers/task-manager/redis';

const prefix = uniquePrefix();

/** A TCP server that accepts connections and never answers: Redis commands on it wait forever (ioredis queue). */
async function startBlackhole(): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof OrcError && e.code === code);
}

describe('TaskService (mssql-test + redis-test)', () => {
  let api: Database;
  let worker: Database;
  let factory: RedisFactory;
  let raw: Redis;
  let queues: QueueRegistry;
  let svc: TaskService;
  let workerSvc: TaskService;
  let received: ControlMessage[];
  let publisher: TaskStreamPublisher;
  let config: TaskServiceConfig;
  let unsubscribe: () => Promise<void>;
  let owner: UserRecord;
  let admin: UserRecord;
  let auditor: UserRecord;
  let stranger: UserRecord;
  let agent: AgentRecord;
  let project: ProjectRecord;

  const ownerV = () => viewerFor('operator', { userId: owner.id });

  beforeAll(async () => {
    api = await openDb('orc_api');
    worker = await openDb('orc_worker');
    factory = testRedisFactory(prefix);
    raw = rawRedis(prefix);
    queues = createQueueRegistry(factory, { prefix, jobAttempts: 3, backoffMs: 5000 });
    const logger = silentLogger();
    publisher = createTaskStreamPublisher(factory.create('command', 'svc-publisher'), {
      prefix,
      logger,
    });
    const control = createControlChannel(factory, { prefix, logger });
    received = [];
    unsubscribe = await control.subscribe((m) => received.push(m));
    owner = await createUser(api);
    admin = await createUser(api, { role: 'admin' });
    auditor = await createUser(api, { role: 'auditor' });
    stranger = await createUser(api);
    agent = await seededAgent(api);
    project = await createReadyProject(api, owner, agent);
    config = {
      maxAttemptsPerTask: 10,
      maxTimeoutSeconds: 3600,
      allowedModels: [agent.model, 'sonnet'],
      defaultModel: agent.model,
      promptMaxChars: 32_000,
      maxAutoRecoveries: 2,
    };
    svc = createTaskService({ db: api, queues, publisher, control, logger, config });
    workerSvc = createTaskService({ db: worker, queues, publisher, control, logger, config });
  });

  afterAll(async () => {
    await unsubscribe();
    await queues.close();
    await factory.closeAll();
    await raw.quit();
    await api.close();
    await worker.close();
    await resetDb();
    expect(await cleanupPrefix(prefix)).toBe(0);
  });

  async function newTask() {
    return svc.create(
      {
        projectId: project.id,
        agentId: agent.id,
        title: 'Integration task',
        prompt: 'Do the thing.',
      },
      ownerV(),
      requestCtx(),
    );
  }

  /** Moves a fresh task into `status` through the real TaskStateStore (worker login). */
  async function settle(status: Exclude<TaskStatus, 'created' | 'queued'>) {
    const created = await newTask();
    const claimed = await worker.repos.taskState.claimAttempt({
      attemptId: created.attempt.id,
      workerId: WORKER_ID,
      actor: workerActor,
    });
    if (!claimed) throw new Error('claim failed');
    if (status === 'preparing_workspace') return created;
    await worker.repos.taskState.transition({
      taskId: created.task.id,
      from: 'preparing_workspace',
      to: status,
      attemptId: created.attempt.id,
      ...(status === 'blocked' ? { reason: 'project_unavailable' as const } : {}),
      ...(status === 'failed' ? { reason: 'internal_error' as const } : {}),
      ...(status === 'timed_out' ? { reason: 'timeout' as const } : {}),
      actor: workerActor,
      correlationId: null,
    });
    return created;
  }

  it('create writes Task + Attempt #1 + events/audit in one tx and adds a BullMQ job with jobId = attemptId', async () => {
    const res = await newTask();
    expect(res.enqueued).toBe(true);
    const job = await queues.tasks.getJob(res.attempt.id);
    expect(job?.data).toEqual({
      v: 1,
      taskId: res.task.id,
      attemptId: res.attempt.id,
      attemptNumber: 1,
      correlationId: res.task.correlationId,
    });
    const events = await api.repos.taskEvents.listByTask({ taskId: res.task.id, limit: 50 });
    expect(events.map((e) => e.type)).toEqual([
      'task_created',
      'attempt_created',
      'status_changed',
    ]);
    const pool = await openPool('orc_migrator', 1);
    try {
      const rows = await query<{ N: number }>(
        pool,
        "SELECT COUNT(*) AS N FROM orc.AuditLogs WHERE EntityId = @id AND Action = 'task.created'",
        [['id', sql.NVarChar(128), res.task.id]],
      );
      expect(rows[0]?.N).toBe(1);
    } finally {
      await pool.close();
    }
    const reader = createTaskStreamReader(factory, { prefix });
    try {
      const entries = await reader.range(res.task.id, null, 10);
      expect(entries.map((e) => e.event)).toEqual([
        expect.objectContaining({ type: 'status', status: 'queued', previousStatus: 'created' }),
      ]);
    } finally {
      await reader.close();
    }
    const detail = await svc.get(res.task.id, ownerV());
    expect(detail.detail).toMatchObject({
      project: { id: project.id },
      agent: { id: agent.id },
      createdBy: { id: owner.id },
      actions: { canCancel: true, canRetry: false },
    });
  });

  it('cancel of a queued task removes the job and settles cancelled (immediate)', async () => {
    const res = await newTask();
    const out = await svc.cancel(
      res.task.id,
      { reason: 'changed my mind' },
      ownerV(),
      requestCtx(),
    );
    expect(out).toMatchObject({
      immediate: true,
      task: { status: 'cancelled', statusReason: 'cancelled_by_user' },
    });
    expect(await queues.tasks.getJob(res.attempt.id)).toBeUndefined();
    expect((await api.repos.attempts.findById(res.attempt.id))?.status).toBe('cancelled');
    expect(await raw.ttl(taskStreamKey(prefix, res.task.id))).toBeGreaterThan(0);
    await expectCode(svc.cancel(res.task.id, {}, ownerV(), requestCtx()), 'task_not_cancellable');
  });

  it('cancel of an active task sets CancelRequestedAt and publishes a control message (202 semantics)', async () => {
    const res = await settle('preparing_workspace');
    received.length = 0;
    const out = await svc.cancel(res.task.id, {}, ownerV(), requestCtx());
    expect(out.immediate).toBe(false);
    expect(out.task.status).toBe('preparing_workspace');
    expect(out.task.cancelRequestedAt).not.toBeNull();
    const deadline = Date.now() + 5000;
    while (received.length === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    expect(received).toEqual([
      expect.objectContaining({
        type: 'cancel',
        taskId: res.task.id,
        attemptId: res.attempt.id,
        requestedByUserId: owner.id,
      }),
    ]);
    expect((await api.repos.tasks.findById(res.task.id))?.cancelRequestedByUserId).toBe(owner.id);
    // idempotent: no new event, no second message
    expect((await svc.cancel(res.task.id, {}, ownerV(), requestCtx())).immediate).toBe(false);
    const cancelEvents = (
      await api.repos.taskEvents.listByTask({ taskId: res.task.id, limit: 50 })
    ).filter((e) => e.type === 'cancel_requested');
    expect(cancelEvents).toHaveLength(1);
  });

  it('cancel of an active task is bounded when the control PUBLISH hangs; the worker DB poll still sees the request', async () => {
    const blackhole = await startBlackhole();
    const hung = createRedisFactory(
      { host: '127.0.0.1', port: blackhole.port, password: null, db: 0, prefix: uniquePrefix() },
      { logger: silentLogger() },
    );
    try {
      const logger = silentLogger();
      const hungControl = createControlChannel(hung, { prefix, logger, opTimeoutMs: 300 });
      const bounded = createTaskService({ db: api, queues, publisher, control: hungControl, logger, config });
      const res = await settle('preparing_workspace');
      received.length = 0;
      const started = Date.now();
      const out = await bounded.cancel(res.task.id, {}, ownerV(), requestCtx());
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(out.immediate).toBe(false);
      expect(out.task.cancelRequestedAt).not.toBeNull();
      expect(received).toEqual([]);
      // The worker heartbeat's DB poll (orc_worker login) observes the request and cancels the attempt.
      const polled = await worker.repos.tasks.findCancelRequested([res.task.id]);
      expect(polled.map((r) => r.id)).toEqual([res.task.id]);
      await expect(hungControl.publishCancel({
        taskId: res.task.id,
        attemptId: res.attempt.id,
        requestedByUserId: owner.id,
        requestedAt: out.task.cancelRequestedAt ?? '',
        correlationId: null,
      })).rejects.toSatisfy((e: unknown) => e instanceof OrcError && e.code === 'redis_unavailable');
    } finally {
      await hung.closeAll();
      await blackhole.close();
    }
  }, 30_000);

  it('claim won the race against cancelPending => falls back to requestCancel (F16)', async () => {
    const res = await newTask();
    const before = await api.repos.tasks.findById(res.task.id);
    // The worker claims between the service's read and its cancelPending CAS.
    const originalCancel = api.repos.taskState.cancelPending.bind(api.repos.taskState);
    api.repos.taskState.cancelPending = async (i) => {
      api.repos.taskState.cancelPending = originalCancel;
      await worker.repos.taskState.claimAttempt({
        attemptId: res.attempt.id,
        workerId: WORKER_ID,
        actor: workerActor,
      });
      return originalCancel(i);
    };
    try {
      const out = await svc.cancel(res.task.id, {}, ownerV(), requestCtx());
      expect(before?.status).toBe('queued');
      expect(out).toMatchObject({ immediate: false, task: { status: 'preparing_workspace' } });
      expect(out.task.cancelRequestedAt).not.toBeNull();
    } finally {
      api.repos.taskState.cancelPending = originalCancel;
    }
  });

  it('retry from failed / timed_out / cancelled / blocked creates attempt n+1 and enqueues it; completed cannot retry', async () => {
    for (const status of ['failed', 'timed_out', 'blocked'] as const) {
      const res = await settle(status);
      const retried = await svc.retry(
        res.task.id,
        { mode: 'fresh', additionalInstructions: 'again' },
        ownerV(),
        requestCtx(),
      );
      expect(retried.task.status).toBe('queued');
      expect(retried.attempt).toMatchObject({
        attemptNumber: 2,
        trigger: 'user_retry',
        previousAttemptId: res.attempt.id,
      });
      expect((await queues.tasks.getJob(retried.attempt.id))?.data.attemptNumber).toBe(2);
      expect(await raw.ttl(taskStreamKey(prefix, res.task.id))).toBe(-1);
    }
    const cancelled = await newTask();
    await svc.cancel(cancelled.task.id, {}, ownerV(), requestCtx());
    expect(
      (await svc.retry(cancelled.task.id, { mode: 'fresh' }, ownerV(), requestCtx())).attempt
        .attemptNumber,
    ).toBe(2);

    const done = await settle('running');
    await worker.repos.taskState.transition({
      taskId: done.task.id,
      from: 'running',
      to: 'reviewing',
      attemptId: done.attempt.id,
      actor: workerActor,
      correlationId: null,
    });
    await worker.repos.taskState.transition({
      taskId: done.task.id,
      from: 'reviewing',
      to: 'completed',
      attemptId: done.attempt.id,
      actor: workerActor,
      correlationId: null,
    });
    await expectCode(
      svc.retry(done.task.id, { mode: 'fresh' }, ownerV(), requestCtx()),
      'task_not_retryable',
    );
  });

  it('retry honours If-Match: stale ETag => 412, current ETag => new attempt', async () => {
    const res = await settle('failed');
    const current = await api.repos.tasks.findById(res.task.id);
    if (!current) throw new Error('task missing');
    await expect(
      svc.retry(res.task.id, { mode: 'fresh' }, ownerV(), requestCtx(), '"AAAAAAAAAAE"'),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
    const ok = await svc.retry(
      res.task.id,
      { mode: 'fresh' },
      ownerV(),
      requestCtx(),
      rowVerToEtag(current.rowVer),
    );
    expect(ok.attempt.attemptNumber).toBe(2);
  });

  it('another operator cannot read/cancel/retry; admin can; auditor reads only', async () => {
    const res = await settle('failed');
    const other = viewerFor('operator', { userId: stranger.id });
    await expect(svc.get(res.task.id, other)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      svc.logs(res.task.id, { afterSeq: -1, limit: 10, format: 'json' }, other),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.cancel(res.task.id, {}, other, requestCtx())).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      svc.retry(res.task.id, { mode: 'fresh' }, other, requestCtx()),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(
      (await svc.list({ limit: 100 }, other)).items.find((t) => t.id === res.task.id),
    ).toBeUndefined();

    const auditorV = viewerFor('auditor', { userId: auditor.id });
    expect((await svc.get(res.task.id, auditorV)).detail.actions).toEqual({
      canCancel: false,
      canRetry: false,
      canRetryContinue: false,
    });
    expect(await svc.attempts(res.task.id, auditorV)).toHaveLength(1);
    await expectCode(
      svc.retry(res.task.id, { mode: 'fresh' }, auditorV, requestCtx()),
      'forbidden',
    );

    const adminV = viewerFor('admin', { userId: admin.id });
    const retried = await svc.retry(res.task.id, { mode: 'fresh' }, adminV, requestCtx());
    expect(retried.attempt.attemptNumber).toBe(2);
    expect((await svc.cancel(res.task.id, {}, adminV, requestCtx())).immediate).toBe(true);
    const events = await svc.events(res.task.id, { limit: 3 }, adminV);
    expect(events.items).toHaveLength(3);
    expect(events.nextCursor).not.toBeNull();
    const more = await svc.events(
      res.task.id,
      { limit: 100, cursor: events.nextCursor ?? undefined },
      adminV,
    );
    expect(Number(more.items[0]?.id)).toBeGreaterThan(Number(events.items[2]?.id));
  });

  it('worker recovery requeues an interrupted active attempt and reconcileQueued re-adds a lost job', async () => {
    const res = await settle('running');
    const decision = await workerSvc.recoverInterruptedAttempt({
      attemptId: res.attempt.id,
      reason: 'worker_lost',
      workerId: WORKER_ID,
    });
    expect(decision.kind).toBe('requeued');
    if (decision.kind !== 'requeued') return;
    expect((await worker.repos.attempts.findById(res.attempt.id))?.status).toBe('interrupted');
    const job = await queues.tasks.getJob(decision.newAttemptId);
    expect(job?.data.attemptNumber).toBe(2);
    await job?.remove();
    expect(await workerSvc.reconcileQueued({ minAgeMs: 0, limit: 200 })).toBeGreaterThanOrEqual(1);
    expect(await queues.jobState(decision.newAttemptId)).toBe('waiting');
  });

  it('worker recovery of a cancel-requested attempt settles cancelled with a task.recovered audit in the same tx', async () => {
    const res = await settle('running');
    await svc.cancel(res.task.id, {}, ownerV(), requestCtx());
    const decision = await workerSvc.recoverInterruptedAttempt({
      attemptId: res.attempt.id,
      reason: 'worker_shutdown',
      workerId: WORKER_ID,
    });
    expect(decision).toEqual({ kind: 'cancelled' });
    expect((await worker.repos.tasks.findById(res.task.id))?.status).toBe('cancelled');
    expect((await worker.repos.attempts.findById(res.attempt.id))?.status).toBe('interrupted');
    const audit = await api.repos.audit.list({ limit: 10, entityId: res.attempt.id });
    expect(audit.map((a) => a.action)).toContain('task.recovered');
    expect(await raw.ttl(taskStreamKey(prefix, res.task.id))).toBeGreaterThan(0);
  });
});
