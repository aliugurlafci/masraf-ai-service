// F16 (§5.4): cancelPending racing the worker claim. Exactly one side wins; the loser gets ConflictError / null.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError } from '@orc/shared';
import type { Database } from '@orc/database';
import { openDb, resetDb } from '../../helpers/database/db';
import { WORKER_ID, createQueuedTask, createTaskWorld, userActor, workerActor } from '../../helpers/database/fixtures';
import type { TaskWorld } from '../../helpers/database/fixtures';

describe('cancel / claim race', () => {
  let api: Database;
  let worker: Database;
  let w: TaskWorld;

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

  it('claim won first: cancelPending conflicts, the service falls back to requestCancel', async () => {
    const { task, attempt } = await createQueuedTask(api, w);
    expect(await worker.repos.taskState.claimAttempt({ attemptId: attempt.id, workerId: WORKER_ID, actor: workerActor })).not.toBeNull();
    await expect(
      api.repos.taskState.cancelPending({ taskId: task.id, from: 'queued', actor: userActor(w.user), audit: {}, reasonText: null }),
    ).rejects.toBeInstanceOf(ConflictError);
    const reloaded = await api.repos.tasks.findById(task.id);
    expect(reloaded?.status).toBe('preparing_workspace');
    const requested = await api.repos.taskState.requestCancel({ taskId: task.id, actor: userActor(w.user), audit: {}, reasonText: null });
    expect(requested.cancelRequestedAt).not.toBeNull();
    expect(requested.status).toBe('preparing_workspace');
  });

  it('cancel won first: the claim no-ops', async () => {
    const { task, attempt } = await createQueuedTask(api, w);
    await api.repos.taskState.cancelPending({ taskId: task.id, from: 'queued', actor: userActor(w.user), audit: {}, reasonText: null });
    expect(await worker.repos.taskState.claimAttempt({ attemptId: attempt.id, workerId: WORKER_ID, actor: workerActor })).toBeNull();
    expect((await api.repos.attempts.findById(attempt.id))?.status).toBe('cancelled');
  });

  it('concurrent claim and cancel: exactly one wins and the state stays consistent', async () => {
    for (let i = 0; i < 6; i += 1) {
      const { task, attempt } = await createQueuedTask(api, w);
      const [claim, cancel] = await Promise.allSettled([
        worker.repos.taskState.claimAttempt({ attemptId: attempt.id, workerId: WORKER_ID, actor: workerActor }),
        api.repos.taskState.cancelPending({ taskId: task.id, from: 'queued', actor: userActor(w.user), audit: {}, reasonText: null }),
      ]);
      const claimWon = claim.status === 'fulfilled' && claim.value !== null;
      const cancelWon = cancel.status === 'fulfilled';
      expect(claimWon !== cancelWon).toBe(true);
      if (claimWon) expect(cancel.status === 'rejected' && cancel.reason instanceof ConflictError).toBe(true);
      else expect(claim.status === 'fulfilled' && claim.value === null).toBe(true);

      const finalTask = await api.repos.tasks.findById(task.id);
      const finalAttempt = await api.repos.attempts.findById(attempt.id);
      if (claimWon) {
        expect([finalTask?.status, finalAttempt?.status]).toEqual(['preparing_workspace', 'active']);
      } else {
        expect([finalTask?.status, finalAttempt?.status]).toEqual(['cancelled', 'cancelled']);
      }
    }
  });
});
