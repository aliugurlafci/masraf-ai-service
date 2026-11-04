// §5.1-§5.2: every TaskStateStore method is ONE transaction writing Tasks + TaskAttempts + TaskEvents + AuditLogs.
// API paths run as orc_api, worker paths as orc_worker (proves the column grants cover them).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, InvalidTransitionError, PreconditionFailedError } from '@orc/shared';
import type { AuditLog, TaskEvent } from '@orc/shared';
import type { Database, TaskRecord } from '@orc/database';
import { openDb, resetDb } from '../../helpers/database/db';
import { WORKER_ID, createQueuedTask, createTaskWorld, userActor, workerActor } from '../../helpers/database/fixtures';
import type { TaskWorld } from '../../helpers/database/fixtures';

describe('task state persistence', () => {
  let api: Database;
  let worker: Database;
  let w: TaskWorld;

  const events = (taskId: string): Promise<TaskEvent[]> => api.repos.taskEvents.listByTask({ taskId, limit: 1000 });
  const audits = async (taskId: string): Promise<AuditLog[]> =>
    (await api.repos.audit.list({ limit: 1000, entityId: taskId })).reverse();

  async function claimed(): Promise<{ task: TaskRecord; attemptId: string }> {
    const { attempt } = await createQueuedTask(api, w);
    const c = await worker.repos.taskState.claimAttempt({ attemptId: attempt.id, workerId: WORKER_ID, actor: workerActor });
    if (!c) throw new Error('claim failed');
    return { task: c.task, attemptId: c.attempt.id };
  }

  beforeAll(async () => {
    api = await openDb('orc_api');
    worker = await openDb('orc_worker');
    w = await createTaskWorld(api);
  });

  afterAll(async () => {
    await api.close();
    await worker.close();
    await resetDb();
  });

  it('createTask: created -> queued with attempt #1, events, audit and the idempotency row in one transaction', async () => {
    const keyValue = randomUUID();
    const started = await api.repos.idempotency.tryBegin({
      userId: w.user.id,
      scope: 'POST /tasks',
      keyValue,
      requestHash: createHash('sha256').update(randomBytes(8)).digest(),
      lockSeconds: 30,
      ttlSeconds: 3600,
    });
    if (started.kind !== 'started') throw new Error('expected started');
    const result = await api.repos.taskState.createTask({
      task: {
        projectId: w.project.id,
        agentId: w.agent.id,
        createdByUserId: w.user.id,
        title: 'Add endpoint',
        prompt: 'Implement GET /health',
        acceptanceCriteria: 'returns 200',
        scope: 'apps/api',
        baseRef: 'main',
        model: 'sonnet',
        effort: 'high',
        timeoutSeconds: 900,
        maxBudgetUsd: 1.25,
        correlationId: 'corr-create-1',
      },
      actor: userActor(w.user),
      audit: { requestId: 'req-create-1', ip: '10.0.0.1', userAgent: 'vitest' },
      idempotency: {
        id: started.id,
        responseFactory: (task) => ({ status: 201, headers: { location: `/api/v1/tasks/${task.id}` }, body: JSON.stringify({ id: task.id }) }),
      },
    });
    const { task, attempt } = result;
    expect(task).toMatchObject({ status: 'queued', currentAttemptId: attempt.id, attemptCount: 1, maxBudgetUsd: 1.25, effort: 'high' });
    expect(task.queuedAt).not.toBeNull();
    expect(attempt).toMatchObject({ attemptNumber: 1, trigger: 'initial', mode: 'fresh', status: 'queued', timeoutSeconds: 900, correlationId: 'corr-create-1' });

    expect((await events(task.id)).map((e) => [e.type, e.fromStatus, e.toStatus])).toEqual([
      ['task_created', null, 'created'],
      ['attempt_created', null, null],
      ['status_changed', 'created', 'queued'],
    ]);
    const [audit] = await audits(task.id);
    expect(audit).toMatchObject({
      action: 'task.created',
      actorType: 'user',
      actorUserId: w.user.id,
      entityType: 'task',
      requestId: 'req-create-1',
      correlationId: 'corr-create-1',
      ip: '10.0.0.1',
    });
    expect(audit?.after).toMatchObject({ status: 'queued', attemptId: attempt.id, promptBytes: 21 });

    const replay = await api.repos.idempotency.tryBegin({
      userId: w.user.id,
      scope: 'POST /tasks',
      keyValue,
      requestHash: Buffer.alloc(32),
      lockSeconds: 1,
      ttlSeconds: 60,
    });
    expect(replay).toMatchObject({ kind: 'existing', record: { status: 'completed', responseStatus: 201, resourceId: task.id } });
  });

  it('createTask rolls back everything when the idempotency row is gone', async () => {
    const before = (await api.repos.tasks.list({ limit: 1000, ownerUserId: w.user.id })).length;
    await expect(
      api.repos.taskState.createTask({
        task: {
          projectId: w.project.id,
          agentId: w.agent.id,
          createdByUserId: w.user.id,
          title: 'never',
          prompt: 'never',
          acceptanceCriteria: null,
          scope: null,
          baseRef: null,
          model: 'sonnet',
          effort: null,
          timeoutSeconds: 600,
          maxBudgetUsd: null,
          correlationId: 'corr-none',
        },
        actor: userActor(w.user),
        audit: {},
        idempotency: { id: '999999999', responseFactory: () => ({ status: 201, headers: {}, body: '{}' }) },
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await api.repos.tasks.list({ limit: 1000, ownerUserId: w.user.id })).length).toBe(before);
  });

  it('claimAttempt (worker): queued -> preparing_workspace, attempt active with deadline; second claim no-ops', async () => {
    const { task, attempt } = await createQueuedTask(api, w, { timeoutSeconds: 1200 });
    const c = await worker.repos.taskState.claimAttempt({ attemptId: attempt.id, workerId: WORKER_ID, actor: workerActor });
    expect(c?.task).toMatchObject({ id: task.id, status: 'preparing_workspace' });
    expect(c?.task.startedAt).not.toBeNull();
    expect(c?.attempt).toMatchObject({ status: 'active', workerId: WORKER_ID, stage: 'preparing_workspace' });
    const start = Date.parse(c!.attempt.startedAt!);
    expect(Date.parse(c!.attempt.deadlineAt!) - start).toBe(1_200_000);
    expect(await worker.repos.taskState.claimAttempt({ attemptId: attempt.id, workerId: 'worker-2', actor: workerActor })).toBeNull();

    const ev = await events(task.id);
    expect(ev.slice(-2).map((e) => [e.type, e.fromStatus, e.toStatus, e.actorType, e.actorLabel])).toEqual([
      ['attempt_claimed', null, null, 'worker', WORKER_ID],
      ['status_changed', 'queued', 'preparing_workspace', 'worker', WORKER_ID],
    ]);
    const last = (await audits(task.id)).at(-1);
    expect(last).toMatchObject({ action: 'task.status_changed', actorType: 'worker', actorLabel: WORKER_ID, before: { status: 'queued' } });
  });

  it('persists the happy path to completed with one event and one audit row per transition', async () => {
    const { task, attemptId } = await claimed();
    const steps = [
      ['preparing_workspace', 'running'],
      ['running', 'testing'],
      ['testing', 'reviewing'],
      ['reviewing', 'completed'],
    ] as const;
    let current = task;
    for (const [from, to] of steps) {
      const evBefore = (await events(task.id)).length;
      const auBefore = (await audits(task.id)).length;
      current = await worker.repos.taskState.transition({
        taskId: task.id,
        from,
        to,
        attemptId,
        actor: workerActor,
        correlationId: 'corr-flow',
        data: { step: to },
      });
      expect(current.status).toBe(to);
      const ev = await events(task.id);
      const au = await audits(task.id);
      expect(ev).toHaveLength(evBefore + 1);
      expect(au).toHaveLength(auBefore + 1);
      expect(ev.at(-1)).toMatchObject({ type: 'status_changed', fromStatus: from, toStatus: to, data: { step: to }, attemptId });
      expect(au.at(-1)).toMatchObject({ action: 'task.status_changed', before: { status: from }, after: { status: to, reason: null } });
    }
    expect(current.finishedAt).not.toBeNull();
    const attempt = await worker.repos.attempts.findById(attemptId);
    expect(attempt).toMatchObject({ status: 'succeeded', stage: 'reviewing' });
    expect(attempt?.endedAt).not.toBeNull();
  });

  it('records failure reason and a capped, masked detail', async () => {
    const { task, attemptId } = await claimed();
    const failed = await worker.repos.taskState.transition({
      taskId: task.id,
      from: 'preparing_workspace',
      to: 'failed',
      attemptId,
      reason: 'workspace_error',
      detail: `boom ${'x'.repeat(5000)}`,
      actor: workerActor,
      correlationId: null,
    });
    expect(failed).toMatchObject({ status: 'failed', statusReason: 'workspace_error' });
    expect(failed.statusDetail?.length).toBe(2000);
    const attempt = await worker.repos.attempts.findById(attemptId);
    expect(attempt).toMatchObject({ status: 'failed', failureReason: 'workspace_error' });
    expect((await events(task.id)).at(-1)?.reason).toBe('workspace_error');
  });

  it('rejects stale and illegal transitions without writing anything', async () => {
    const { task, attemptId } = await claimed();
    const evCount = (await events(task.id)).length;
    const auCount = (await audits(task.id)).length;
    const base = { taskId: task.id, attemptId, actor: workerActor, correlationId: null } as const;

    await expect(worker.repos.taskState.transition({ ...base, from: 'running', to: 'testing' })).rejects.toBeInstanceOf(ConflictError);
    await expect(
      worker.repos.taskState.transition({ ...base, from: 'preparing_workspace', to: 'running', expectedRowVer: 'AAAAAAAAAAA' }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
    await expect(worker.repos.taskState.transition({ ...base, from: 'preparing_workspace', to: 'completed' })).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    await expect(worker.repos.taskState.transition({ ...base, from: 'preparing_workspace', to: 'queued' })).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    // The Tasks update succeeds but the attempt is not live: the whole transaction must roll back.
    await expect(
      worker.repos.taskState.transition({ ...base, attemptId: randomUUID(), from: 'preparing_workspace', to: 'running' }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      worker.repos.taskState.transition({ ...base, taskId: randomUUID(), from: 'preparing_workspace', to: 'running' }),
    ).rejects.toMatchObject({ code: 'not_found' });

    expect((await worker.repos.tasks.findById(task.id))?.status).toBe('preparing_workspace');
    expect(await events(task.id)).toHaveLength(evCount);
    expect(await audits(task.id)).toHaveLength(auCount);

    const current = await worker.repos.tasks.findById(task.id);
    const moved = await worker.repos.taskState.transition({ ...base, from: 'preparing_workspace', to: 'running', expectedRowVer: current!.rowVer });
    expect(moved.status).toBe('running');
  });

  it('createAttempt(user_retry) from a settled task opens attempt #2 and clears the settlement', async () => {
    const { task, attemptId } = await claimed();
    const failed = await worker.repos.taskState.transition({
      taskId: task.id, from: 'preparing_workspace', to: 'failed', attemptId, reason: 'internal_error', actor: workerActor, correlationId: null,
    });
    await expect(
      api.repos.taskState.createAttempt({
        taskId: task.id, from: 'running', trigger: 'user_retry', mode: 'fresh', previousAttemptId: attemptId,
        workspaceId: null, additionalInstructions: null, actor: userActor(w.user), audit: {}, correlationId: null,
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);

    const { task: retried, attempt } = await api.repos.taskState.createAttempt({
      taskId: task.id,
      from: 'failed',
      expectedRowVer: failed.rowVer,
      trigger: 'user_retry',
      mode: 'continue',
      previousAttemptId: attemptId,
      workspaceId: null,
      baseRefOverride: 'release',
      additionalInstructions: 'try harder',
      actor: userActor(w.user),
      audit: { requestId: 'req-retry' },
      correlationId: 'corr-retry',
    });
    expect(retried).toMatchObject({ status: 'queued', statusReason: null, finishedAt: null, attemptCount: 2, currentAttemptId: attempt.id });
    expect(attempt).toMatchObject({ attemptNumber: 2, trigger: 'user_retry', mode: 'continue', previousAttemptId: attemptId, baseRefOverride: 'release', additionalInstructions: 'try harder' });
    expect((await audits(task.id)).slice(-2).map((a) => a.action)).toEqual(['task.retry_requested', 'task.status_changed']);
    expect((await api.repos.attempts.listByTask(task.id)).map((a) => a.attemptNumber)).toEqual([1, 2]);
    await expect(
      api.repos.taskState.createAttempt({
        taskId: task.id, from: 'failed', expectedRowVer: failed.rowVer, trigger: 'user_retry', mode: 'fresh', previousAttemptId: attemptId,
        workspaceId: null, additionalInstructions: null, actor: userActor(w.user), audit: {}, correlationId: null,
      }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
  });

  it('createAttempt(infra_recovery) by the worker interrupts the old attempt and queues a resume attempt', async () => {
    const { task, attemptId } = await claimed();
    await worker.repos.taskState.transition({ taskId: task.id, from: 'preparing_workspace', to: 'running', attemptId, actor: workerActor, correlationId: null });
    const { task: recovered, attempt } = await worker.repos.taskState.createAttempt({
      taskId: task.id,
      from: 'running',
      trigger: 'infra_recovery',
      mode: 'resume',
      previousAttemptId: attemptId,
      previousAttemptFinalStatus: 'interrupted',
      interruptionReason: 'worker_lost',
      workspaceId: null,
      additionalInstructions: null,
      actor: workerActor,
      audit: {},
      correlationId: 'corr-recover',
    });
    expect(recovered).toMatchObject({ status: 'queued', autoRecoveryCount: 1, attemptCount: 2, currentAttemptId: attempt.id });
    expect(attempt).toMatchObject({ trigger: 'infra_recovery', mode: 'resume', status: 'queued', attemptNumber: 2 });
    expect(await worker.repos.attempts.findById(attemptId)).toMatchObject({ status: 'interrupted', failureReason: 'worker_lost' });
    expect((await events(task.id)).slice(-3).map((e) => e.type)).toEqual(['recovery_scheduled', 'attempt_created', 'status_changed']);
    expect((await api.repos.audit.list({ limit: 10, entityId: attemptId, action: 'task.recovered' }))).toHaveLength(1);
  });

  it('cancelPending and requestCancel persist cancellation (idempotent while active)', async () => {
    const { task } = await createQueuedTask(api, w);
    const cancelled = await api.repos.taskState.cancelPending({ taskId: task.id, from: 'queued', actor: userActor(w.user), audit: {}, reasonText: 'not needed' });
    expect(cancelled).toMatchObject({ status: 'cancelled', statusReason: 'cancelled_by_user', cancelRequestedByUserId: w.user.id });
    expect((await api.repos.attempts.listByTask(task.id))[0]).toMatchObject({ status: 'cancelled', failureReason: 'cancelled_by_user' });
    await expect(
      api.repos.taskState.requestCancel({ taskId: task.id, actor: userActor(w.user), audit: {}, reasonText: null }),
    ).rejects.toBeInstanceOf(ConflictError);

    const active = await claimed();
    const r1 = await api.repos.taskState.requestCancel({ taskId: active.task.id, actor: userActor(w.user), audit: {}, reasonText: 'stop' });
    expect(r1.cancelRequestedAt).not.toBeNull();
    const evCount = (await events(active.task.id)).length;
    const r2 = await api.repos.taskState.requestCancel({ taskId: active.task.id, actor: userActor(w.user), audit: {}, reasonText: 'again' });
    expect(r2.cancelRequestedAt).toBe(r1.cancelRequestedAt);
    expect(await events(active.task.id)).toHaveLength(evCount);
    expect((await worker.repos.tasks.findCancelRequested([active.task.id, task.id])).map((x) => x.id).sort()).toEqual(
      [active.task.id, task.id].sort(),
    );
    // A cancel-requested task is never auto-recovered.
    await expect(
      worker.repos.taskState.createAttempt({
        taskId: active.task.id, from: 'preparing_workspace', trigger: 'infra_recovery', mode: 'resume', previousAttemptId: active.attemptId,
        interruptionReason: 'worker_shutdown', workspaceId: null, additionalInstructions: null, actor: workerActor, audit: {}, correlationId: null,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('transactions see their own writes and roll back on error (Database.transaction)', async () => {
    const { task } = await createQueuedTask(api, w);
    await expect(
      api.transaction(
        async ({ repos }) => {
          await repos.taskState.cancelPending({ taskId: task.id, from: 'queued', actor: userActor(w.user), audit: {}, reasonText: null });
          expect((await repos.tasks.findById(task.id))?.status).toBe('cancelled');
          throw new Error('abort');
        },
        { name: 'test.rollback' },
      ),
    ).rejects.toThrow('abort');
    expect((await api.repos.tasks.findById(task.id))?.status).toBe('queued');
  });
});
