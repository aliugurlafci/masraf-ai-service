// TaskService rules with in-memory fakes (contract §2.9, §5, §15.5): ownership, transitions, enqueue,
// cancel race outcomes (200 immediate / 202 requested / 409), retry If-Match (412) and worker-side recovery.
import { beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError, OrcError, PreconditionFailedError, ValidationError } from '@orc/shared';
import type { CreateTaskRequest } from '@orc/shared';
import { createControlChannel, createTaskService } from '@orc/task-manager';
import type { RedisFactory, TaskService, TaskServiceConfig } from '@orc/task-manager';
import type { AgentRecord, ProjectRecord, UserRecord } from '@orc/database';
import {
  createFakeControl,
  createFakePublisher,
  createFakeQueues,
  createFakeWorld,
  etagOf,
  makeAgent,
  makeProject,
  makeUser,
  makeWorkspace,
  requestCtx,
  silentLogger,
  viewerFor,
} from '../../helpers/task-manager/fakes';
import type {
  FakeControl,
  FakePublisher,
  FakeQueues,
  FakeWorld,
} from '../../helpers/task-manager/fakes';

const CONFIG: TaskServiceConfig = {
  maxAttemptsPerTask: 3,
  maxTimeoutSeconds: 3600,
  allowedModels: ['sonnet', 'opus'],
  defaultModel: 'sonnet',
  promptMaxChars: 1000,
  maxAutoRecoveries: 2,
};

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof OrcError && e.code === code);
}

describe('TaskService (unit)', () => {
  let w: FakeWorld;
  let queues: FakeQueues;
  let publisher: FakePublisher;
  let control: FakeControl;
  let svc: TaskService;
  let owner: UserRecord;
  let agent: AgentRecord;
  let project: ProjectRecord;
  let nowMs: number;
  const ownerViewer = () => viewerFor('operator', { userId: owner.id });

  beforeEach(() => {
    w = createFakeWorld();
    queues = createFakeQueues();
    publisher = createFakePublisher();
    control = createFakeControl();
    nowMs = Date.parse('2026-11-03T10:00:00.000Z');
    svc = createTaskService({
      db: w.db,
      queues,
      publisher,
      control,
      logger: silentLogger(),
      clock: { now: () => new Date(nowMs), nowMs: () => nowMs },
      config: CONFIG,
    });
    owner = makeUser();
    agent = makeAgent({ maxTimeoutSeconds: 1800 });
    project = makeProject({ defaultAgentId: agent.id, defaultTimeoutSeconds: 7200 });
    w.users.set(owner.id, owner);
    w.agents.set(agent.id, agent);
    w.projects.set(project.id, project);
  });

  const createReq = (o: Partial<CreateTaskRequest> = {}): CreateTaskRequest => ({
    projectId: project.id,
    title: 'Add feature',
    prompt: 'Implement it.',
    ...o,
  });

  describe('create', () => {
    it('creates task + attempt #1, persists the stream, publishes status and enqueues with jobId = attemptId', async () => {
      const res = await svc.create(createReq(), ownerViewer(), requestCtx());
      expect(res.enqueued).toBe(true);
      expect(res.task.status).toBe('queued');
      expect(res.attempt.attemptNumber).toBe(1);
      expect('rowVer' in res.task).toBe(false);
      expect(queues.enqueued).toEqual([
        {
          v: 1,
          taskId: res.task.id,
          attemptId: res.attempt.id,
          attemptNumber: 1,
          correlationId: res.task.correlationId,
        },
      ]);
      expect(publisher.persisted).toEqual([res.task.id]);
      expect(publisher.events[0]?.event).toMatchObject({
        type: 'status',
        status: 'queued',
        previousStatus: 'created',
      });
      // defaults: project default agent, agent model, timeout clamped to min(config, agent max)
      expect(res.task.agentId).toBe(agent.id);
      expect(res.task.model).toBe('sonnet');
      expect(res.task.timeoutSeconds).toBe(1800);
    });

    it('enqueue failure still answers (reconciler repairs) with enqueued:false', async () => {
      queues.failEnqueue = true;
      const res = await svc.create(createReq(), ownerViewer(), requestCtx());
      expect(res.enqueued).toBe(false);
      expect(res.task.status).toBe('queued');
    });

    it('rejects a not-ready project, inactive agent, disallowed model and oversize text', async () => {
      w.projects.set(project.id, { ...project, status: 'validating' });
      await expectCode(svc.create(createReq(), ownerViewer(), requestCtx()), 'project_not_ready');
      w.projects.set(project.id, project);
      w.agents.set(agent.id, { ...agent, isActive: false });
      await expectCode(svc.create(createReq(), ownerViewer(), requestCtx()), 'agent_inactive');
      w.agents.set(agent.id, agent);
      await expectCode(
        svc.create(createReq({ model: 'gpt' }), ownerViewer(), requestCtx()),
        'model_not_allowed',
      );
      await expectCode(
        svc.create(
          createReq({ acceptanceCriteria: 'x'.repeat(98_304) }),
          ownerViewer(),
          requestCtx(),
        ),
        'prompt_too_large',
      );
      await expectCode(
        svc.create(createReq({ prompt: 'p'.repeat(1001) }), ownerViewer(), requestCtx()),
        'validation_failed',
      );
      await expectCode(
        svc.create(createReq({ timeoutSeconds: 1801 }), ownerViewer(), requestCtx()),
        'validation_failed',
      );
      await expectCode(
        svc.create(createReq({ baseRef: '../evil' }), ownerViewer(), requestCtx()),
        'validation_failed',
      );
      await expect(
        svc.create(createReq({ projectId: makeProject().id }), ownerViewer(), requestCtx()),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('requires an agent when the project has no default (400 body.agentId)', async () => {
      w.projects.set(project.id, { ...project, defaultAgentId: null });
      const err = await svc
        .create(createReq(), ownerViewer(), requestCtx())
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).issues[0]?.path).toBe('body.agentId');
    });

    it('auditors and read-only tokens cannot create', async () => {
      await expectCode(svc.create(createReq(), viewerFor('auditor'), requestCtx()), 'forbidden');
      await expectCode(
        svc.create(createReq(), viewerFor('operator', { readOnly: true }), requestCtx()),
        'forbidden',
      );
    });
  });

  describe('visibility', () => {
    it('other operators get NotFound; admin reads and cancels; auditor reads but cannot cancel/retry', async () => {
      const { task } = w.addTask({ owner, project, agent });
      const stranger = viewerFor('operator');
      await expect(svc.get(task.id, stranger)).rejects.toBeInstanceOf(NotFoundError);
      await expect(svc.attempts(task.id, stranger)).rejects.toBeInstanceOf(NotFoundError);
      await expect(svc.cancel(task.id, {}, stranger, requestCtx())).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(
        svc.retry(task.id, { mode: 'fresh' }, stranger, requestCtx()),
      ).rejects.toBeInstanceOf(NotFoundError);

      const auditor = viewerFor('auditor');
      const seen = await svc.get(task.id, auditor);
      expect(seen.detail.actions).toEqual({
        canCancel: false,
        canRetry: false,
        canRetryContinue: false,
      });
      await expectCode(svc.cancel(task.id, {}, auditor, requestCtx()), 'forbidden');

      const admin = viewerFor('admin');
      const detail = await svc.get(task.id, admin);
      expect(detail.detail.actions.canCancel).toBe(true);
      expect(detail.detail.createdBy.username).toBe(owner.username);
      expect((await svc.cancel(task.id, {}, admin, requestCtx())).immediate).toBe(true);
    });

    it('list: operators see only their own; createdBy needs task:read:any', async () => {
      w.addTask({ owner, project, agent });
      w.addTask({ owner: makeUser(), project, agent });
      const page = await svc.list({ limit: 25 }, ownerViewer());
      expect(page.items.every((t) => t.createdByUserId === owner.id)).toBe(true);
      expect(page.items).toHaveLength(1);
      await expectCode(svc.list({ limit: 25, createdBy: owner.id }, ownerViewer()), 'forbidden');
      expect((await svc.list({ limit: 25 }, viewerFor('admin'))).items).toHaveLength(2);
    });
  });

  describe('cancel (§5.4)', () => {
    it('queued => cancelPending, job removal, status + end + EXPIRE (immediate:true)', async () => {
      const { task, attempt } = w.addTask({ owner, project, agent });
      const res = await svc.cancel(
        task.id,
        { reason: 'no longer needed' },
        ownerViewer(),
        requestCtx(),
      );
      expect(res).toMatchObject({ immediate: true, task: { status: 'cancelled' } });
      expect(queues.removed).toEqual([attempt.id]);
      expect(publisher.events.map((e) => e.event.type)).toEqual(['status', 'end']);
      expect(publisher.expired).toEqual([task.id]);
      expect(control.published).toHaveLength(0);
    });

    it('claim won the race => requestCancel + control message (202 immediate:false)', async () => {
      const { task, attempt } = w.addTask({ owner, project, agent });
      w.beforeCancelPending = (id) => {
        w.beforeCancelPending = null;
        w.claim(id);
      };
      const res = await svc.cancel(task.id, {}, ownerViewer(), requestCtx());
      expect(res.immediate).toBe(false);
      expect(res.task.status).toBe('preparing_workspace');
      expect(res.task.cancelRequestedAt).not.toBeNull();
      expect(control.published).toEqual([
        expect.objectContaining({
          type: 'cancel',
          taskId: task.id,
          attemptId: attempt.id,
          requestedByUserId: owner.id,
        }),
      ]);
      expect(queues.removed).toHaveLength(0);
    });

    it('claim won and the task settled meanwhile => 409 task_not_cancellable', async () => {
      const { task } = w.addTask({ owner, project, agent });
      w.beforeCancelPending = (id) => {
        w.beforeCancelPending = null;
        w.claim(id);
        w.setStatus(id, 'failed');
      };
      await expectCode(
        svc.cancel(task.id, {}, ownerViewer(), requestCtx()),
        'task_not_cancellable',
      );
    });

    it('active with cancel already requested is idempotent (no second control message)', async () => {
      const { task } = w.addTask({ owner, project, agent, status: 'running' });
      expect((await svc.cancel(task.id, {}, ownerViewer(), requestCtx())).immediate).toBe(false);
      expect(control.published).toHaveLength(1);
      expect((await svc.cancel(task.id, {}, ownerViewer(), requestCtx())).immediate).toBe(false);
      expect(control.published).toHaveLength(1);
    });

    it('a hanging control PUBLISH is bounded: cancel answers (immediate:false) with CancelRequestedAt set', async () => {
      const hungFactory = {
        create: () => ({ publish: () => new Promise<number>(() => undefined) }),
        closeAll: () => Promise.resolve(),
      } as unknown as RedisFactory;
      const bounded = createTaskService({
        db: w.db,
        queues,
        publisher,
        control: createControlChannel(hungFactory, { prefix: 'orc', logger: silentLogger(), opTimeoutMs: 50 }),
        logger: silentLogger(),
        clock: { now: () => new Date(nowMs), nowMs: () => nowMs },
        config: CONFIG,
      });
      const { task } = w.addTask({ owner, project, agent, status: 'running' });
      const started = Date.now();
      const res = await bounded.cancel(task.id, {}, ownerViewer(), requestCtx());
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(res.immediate).toBe(false);
      expect(res.task.cancelRequestedAt).not.toBeNull();
      expect(w.tasks.get(task.id)?.cancelRequestedAt).not.toBeNull();
      expect(publisher.events.map((e) => e.event.type)).toContain('status');
    });

    it('settled tasks are not cancellable', async () => {
      for (const status of ['completed', 'failed', 'timed_out', 'cancelled', 'blocked'] as const) {
        const { task } = w.addTask({ owner, project, agent, status });
        await expectCode(
          svc.cancel(task.id, {}, ownerViewer(), requestCtx()),
          'task_not_cancellable',
        );
      }
    });
  });

  describe('retry', () => {
    it('failed/timed_out/cancelled/blocked => attempt n+1 queued and enqueued', async () => {
      for (const status of ['failed', 'timed_out', 'cancelled', 'blocked'] as const) {
        const { task } = w.addTask({ owner, project, agent, status });
        const res = await svc.retry(
          task.id,
          { mode: 'fresh', additionalInstructions: 'try again' },
          ownerViewer(),
          requestCtx(),
        );
        expect(res.task.status).toBe('queued');
        expect(res.attempt).toMatchObject({
          attemptNumber: 2,
          trigger: 'user_retry',
          mode: 'fresh',
        });
        expect(res.enqueued).toBe(true);
        expect(queues.enqueued.at(-1)?.attemptId).toBe(res.attempt.id);
        expect(publisher.persisted).toContain(task.id);
      }
    });

    it('completed, queued and active tasks are not retryable; limit => retry_limit_reached', async () => {
      for (const status of ['completed', 'queued', 'running'] as const) {
        const { task } = w.addTask({ owner, project, agent, status });
        await expectCode(
          svc.retry(task.id, { mode: 'fresh' }, ownerViewer(), requestCtx()),
          'task_not_retryable',
        );
      }
      const { task } = w.addTask({ owner, project, agent, status: 'failed' });
      w.tasks.set(task.id, {
        ...(w.tasks.get(task.id) ?? task),
        attemptCount: CONFIG.maxAttemptsPerTask,
      });
      await expectCode(
        svc.retry(task.id, { mode: 'fresh' }, ownerViewer(), requestCtx()),
        'retry_limit_reached',
      );
    });

    it('If-Match: current ETag succeeds, stale ETag => PreconditionFailedError (412)', async () => {
      const { task } = w.addTask({ owner, project, agent, status: 'failed' });
      const stale = etagOf(task);
      const current = w.tasks.get(task.id);
      if (!current) throw new Error('missing');
      w.tasks.set(task.id, { ...current, rowVer: 'AAAAAAAAAAE' });
      await expect(
        svc.retry(task.id, { mode: 'fresh' }, ownerViewer(), requestCtx(), stale),
      ).rejects.toBeInstanceOf(PreconditionFailedError);
      const ok = await svc.retry(
        task.id,
        { mode: 'fresh' },
        ownerViewer(),
        requestCtx(),
        '"AAAAAAAAAAE"',
      );
      expect(ok.attempt.attemptNumber).toBe(2);
    });

    it('continue reuses a retained workspace and refuses when nothing can be continued', async () => {
      const { task, attempt } = w.addTask({ owner, project, agent, status: 'failed' });
      await expectCode(
        svc.retry(task.id, { mode: 'continue' }, ownerViewer(), requestCtx()),
        'task_not_retryable',
      );
      const ws = makeWorkspace({ status: 'retained' });
      w.workspaces.set(ws.id, ws);
      w.attempts.set(attempt.id, {
        ...(w.attempts.get(attempt.id) ?? attempt),
        workspaceId: ws.id,
      });
      expect((await svc.get(task.id, ownerViewer())).detail.actions.canRetryContinue).toBe(true);
      await expectCode(
        svc.retry(task.id, { mode: 'continue', baseRef: 'main' }, ownerViewer(), requestCtx()),
        'validation_failed',
      );
      const res = await svc.retry(task.id, { mode: 'continue' }, ownerViewer(), requestCtx());
      expect(res.attempt).toMatchObject({ mode: 'continue', workspaceId: ws.id });
    });

    it('project not ready => project_not_ready', async () => {
      const { task } = w.addTask({ owner, project, agent, status: 'failed' });
      w.projects.set(project.id, { ...project, status: 'invalid' });
      await expectCode(
        svc.retry(task.id, { mode: 'fresh' }, ownerViewer(), requestCtx()),
        'project_not_ready',
      );
    });
  });

  describe('worker-side operations', () => {
    it('recoverInterruptedAttempt requeues (resume, same workspace) and enqueues', async () => {
      const { task, attempt } = w.addTask({ owner, project, agent, status: 'running' });
      const res = await svc.recoverInterruptedAttempt({
        attemptId: attempt.id,
        reason: 'worker_lost',
        workerId: 'w1',
      });
      expect(res.kind).toBe('requeued');
      const next = w.tasks.get(task.id);
      expect(next?.status).toBe('queued');
      expect(w.attempts.get(attempt.id)?.status).toBe('interrupted');
      const newAttempt = next?.currentAttemptId ? w.attempts.get(next.currentAttemptId) : undefined;
      expect(newAttempt).toMatchObject({ trigger: 'infra_recovery', mode: 'resume' });
      expect(queues.enqueued.at(-1)?.attemptId).toBe(newAttempt?.id);
    });

    it('recoverInterruptedAttempt settles cancelled / timed_out / recovery_limit_reached and retains the workspace', async () => {
      const ws = makeWorkspace({ status: 'in_use' });
      const a = w.addTask({ owner, project, agent, status: 'running' });
      w.attempts.set(a.attempt.id, {
        ...(w.attempts.get(a.attempt.id) ?? a.attempt),
        workspaceId: ws.id,
      });
      w.setStatus(a.task.id, 'running', { cancelRequested: true });
      expect(
        await svc.recoverInterruptedAttempt({
          attemptId: a.attempt.id,
          reason: 'worker_shutdown',
          workerId: 'w1',
        }),
      ).toEqual({
        kind: 'cancelled',
      });
      expect(w.retained).toEqual([ws.id]);
      expect(publisher.events.map((e) => e.event.type)).toEqual(['status', 'end']);

      const b = w.addTask({ owner, project, agent, status: 'testing' });
      w.attempts.set(b.attempt.id, {
        ...(w.attempts.get(b.attempt.id) ?? b.attempt),
        deadlineAt: '2026-11-03T09:59:59.000Z',
      });
      expect(
        (
          await svc.recoverInterruptedAttempt({
            attemptId: b.attempt.id,
            reason: 'worker_lost',
            workerId: 'w1',
          })
        ).kind,
      ).toBe('timed_out');

      const c = w.addTask({ owner, project, agent, status: 'running' });
      w.tasks.set(c.task.id, { ...(w.tasks.get(c.task.id) ?? c.task), autoRecoveryCount: 2 });
      expect(
        await svc.recoverInterruptedAttempt({
          attemptId: c.attempt.id,
          reason: 'worker_lost',
          workerId: 'w1',
        }),
      ).toEqual({
        kind: 'failed',
        reason: 'recovery_limit_reached',
      });
      expect(w.tasks.get(c.task.id)?.statusReason).toBe('recovery_limit_reached');
      // Every settle decision is audited as task.recovered on the interrupted attempt (§15.6).
      const recovered = w.audits
        .filter((x) => x.action === 'task.recovered')
        .map((x) => x.entityId);
      expect(recovered).toEqual([a.attempt.id, b.attempt.id, c.attempt.id]);
    });

    it('recoverInterruptedAttempt is a noop for settled or superseded attempts', async () => {
      const { attempt } = w.addTask({ owner, project, agent, status: 'completed' });
      expect(
        await svc.recoverInterruptedAttempt({
          attemptId: attempt.id,
          reason: 'worker_lost',
          workerId: 'w1',
        }),
      ).toEqual({
        kind: 'noop',
      });
    });

    it('failUnclaimedAttempt fails only still-queued attempts', async () => {
      const queued = w.addTask({ owner, project, agent });
      expect(
        await svc.failUnclaimedAttempt({
          attemptId: queued.attempt.id,
          reason: 'queue_exhausted',
          detail: 'x',
        }),
      ).toBe(true);
      expect(w.tasks.get(queued.task.id)).toMatchObject({
        status: 'failed',
        statusReason: 'queue_exhausted',
      });
      const active = w.addTask({ owner, project, agent, status: 'running' });
      expect(
        await svc.failUnclaimedAttempt({
          attemptId: active.attempt.id,
          reason: 'invalid_job',
          detail: 'x',
        }),
      ).toBe(false);
    });

    it('reconcileQueued re-adds lost jobs, fails exhausted ones and re-adds lost sync jobs', async () => {
      const lost = w.addTask({ owner, project, agent });
      const exhausted = w.addTask({ owner, project, agent });
      queues.states.set(exhausted.attempt.id, 'failed');
      const fine = w.addTask({ owner, project, agent });
      queues.states.set(fine.attempt.id, 'waiting');
      const stale = makeProject({ status: 'validating', updatedAt: '2026-11-03T09:00:00.000Z' });
      w.projects.set(stale.id, stale);
      expect(await svc.reconcileQueued({ minAgeMs: 30_000, limit: 200 })).toBe(3);
      expect(queues.enqueued.map((j) => j.attemptId)).toEqual([lost.attempt.id]);
      expect(w.tasks.get(exhausted.task.id)?.status).toBe('failed');
      expect(queues.projectJobs).toEqual([
        expect.objectContaining({ kind: 'sync', projectId: stale.id }),
      ]);
    });
  });
});
