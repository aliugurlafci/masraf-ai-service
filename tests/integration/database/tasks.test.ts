// TaskRepository (read side) and AttemptRepository (§2.5).
import { randomUUID } from 'node:crypto';
import sql from 'mssql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@orc/database';
import { openDb, openPool, query, resetDb } from '../../helpers/database/db';
import { WORKER_ID, createQueuedTask, createReadyProject, createTaskWorld, createUser, workerActor } from '../../helpers/database/fixtures';
import type { TaskWorld } from '../../helpers/database/fixtures';

describe('tasks and attempts', () => {
  let api: Database;
  let worker: Database;
  let migrator: sql.ConnectionPool;
  let w: TaskWorld;

  beforeAll(async () => {
    api = await openDb('orc_api');
    worker = await openDb('orc_worker');
    migrator = await openPool('orc_migrator', 1);
    w = await createTaskWorld(api);
  });

  afterAll(async () => {
    await api.close();
    await worker.close();
    await migrator.close();
    await resetDb();
  });

  it('findVisible enforces ownership in SQL', async () => {
    const { task } = await createQueuedTask(api, w);
    const stranger = await createUser(api);
    expect((await api.repos.tasks.findVisible(task.id, { userId: w.user.id, canReadAny: false }))?.id).toBe(task.id);
    expect(await api.repos.tasks.findVisible(task.id, { userId: stranger.id, canReadAny: false })).toBeNull();
    expect((await api.repos.tasks.findVisible(task.id, { userId: stranger.id, canReadAny: true }))?.id).toBe(task.id);
    expect(await api.repos.tasks.findVisible(randomUUID(), { userId: w.user.id, canReadAny: true })).toBeNull();
  });

  it('lists with owner/project/status filters and keyset pagination (limit + 1 rows)', async () => {
    const owner = await createUser(api);
    const project = await createReadyProject(api, owner, w.agent);
    const mine = { ...w, user: owner, project };
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push((await createQueuedTask(api, mine)).task.id);
    await api.repos.taskState.cancelPending({ taskId: ids[0]!, from: 'queued', actor: { type: 'system', label: 't' }, audit: {}, reasonText: null });

    const page1 = await api.repos.tasks.list({ limit: 2, ownerUserId: owner.id });
    expect(page1).toHaveLength(3);
    const seen = page1.slice(0, 2).map((t) => t.id);
    let after = { createdAt: page1[1]!.createdAt, id: page1[1]!.id };
    for (;;) {
      const page = await api.repos.tasks.list({ limit: 2, ownerUserId: owner.id, after });
      seen.push(...page.slice(0, 2).map((t) => t.id));
      if (page.length <= 2) break;
      after = { createdAt: page[1]!.createdAt, id: page[1]!.id };
    }
    expect(seen.sort()).toEqual([...ids].sort());
    expect((await api.repos.tasks.list({ limit: 50, projectId: project.id, statuses: ['cancelled'] })).map((t) => t.id)).toEqual([ids[0]]);
    expect(await api.repos.tasks.list({ limit: 50, projectId: project.id, statuses: ['queued', 'cancelled'] })).toHaveLength(5);
    expect(await api.repos.tasks.list({ limit: 50, projectId: project.id, statuses: ['completed'] })).toHaveLength(0);
  });

  it('findQueuedForReconcile returns old queued tasks with their queued attempt', async () => {
    const { task, attempt } = await createQueuedTask(api, w);
    expect((await worker.repos.tasks.findQueuedForReconcile(60_000, 500)).some((r) => r.taskId === task.id)).toBe(false);
    await query(migrator, 'UPDATE orc.Tasks SET QueuedAt = DATEADD(MINUTE, -5, QueuedAt) WHERE Id = @id;', [['id', sql.UniqueIdentifier, task.id]]);
    const rows = await worker.repos.tasks.findQueuedForReconcile(60_000, 500);
    expect(rows.find((r) => r.taskId === task.id)).toEqual({
      taskId: task.id,
      attemptId: attempt.id,
      attemptNumber: 1,
      correlationId: task.correlationId,
    });
    await expect(worker.repos.tasks.findCancelRequested(['bad'])).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('records process data, workspace and review on the attempt', async () => {
    const { attempt } = await createQueuedTask(api, w);
    const claimed = await worker.repos.taskState.claimAttempt({ attemptId: attempt.id, workerId: WORKER_ID, actor: workerActor });
    expect(claimed).not.toBeNull();
    await worker.repos.attempts.setProcess(attempt.id, { pid: 4242, pgid: 4242, workerId: WORKER_ID });
    await worker.repos.attempts.setProcessExit(attempt.id, { exitCode: 0, exitSignal: null });
    const ws = await worker.repos.workspaces.insert({
      projectId: w.project.id, taskId: attempt.taskId, kind: 'attempt', createdByAttemptId: attempt.id,
      path: `/workspaces/${randomUUID()}`, branchName: 'orc/t/a1', baseSha: 'c'.repeat(40), quotaBytes: 1_000_000_000, workerId: WORKER_ID,
    });
    await worker.repos.attempts.setWorkspace(attempt.id, { workspaceId: ws.id, branchName: 'orc/t/a1', baseSha: 'c'.repeat(40) });
    const commits = [{ sha: 'd'.repeat(40), authorName: 'Claude', authorEmail: 'c@example.com', authoredAt: '2026-01-01T00:00:00.000Z', subject: 'feat: x' }];
    const mergeCheck = {
      status: 'clean' as const, baseBranch: 'main', latestBaseSha: 'c'.repeat(40), headSha: 'd'.repeat(40), conflicts: [],
      isFastForward: true, error: null, checkedAt: '2026-01-01T00:00:01.000Z',
    };
    await worker.repos.attempts.setReview(attempt.id, { headSha: 'd'.repeat(40), filesChanged: 3, additions: 10, deletions: 2, commits, mergeCheck });
    const a = await worker.repos.attempts.findById(attempt.id);
    expect(a).toMatchObject({
      pid: 4242, pgid: 4242, exitCode: 0, exitSignal: null, workspaceId: ws.id, branchName: 'orc/t/a1',
      headSha: 'd'.repeat(40), filesChanged: 3, additions: 10, deletions: 2, commits, mergeCheck,
    });
    expect(a?.processStartedAt).not.toBeNull();
    expect(a?.processEndedAt).not.toBeNull();
  });

  it('heartbeat returns only attempts still owned; stale and per-worker queries', async () => {
    const { attempt: a1 } = await createQueuedTask(api, w);
    const { attempt: a2 } = await createQueuedTask(api, w);
    await worker.repos.taskState.claimAttempt({ attemptId: a1.id, workerId: WORKER_ID, actor: workerActor });
    await worker.repos.taskState.claimAttempt({ attemptId: a2.id, workerId: 'worker-other', actor: workerActor });
    expect(await worker.repos.attempts.heartbeat([a1.id, a2.id], WORKER_ID)).toEqual([a1.id]);
    expect(await worker.repos.attempts.heartbeat([], WORKER_ID)).toEqual([]);
    expect((await worker.repos.attempts.findActiveByWorker(WORKER_ID)).map((x) => x.id)).toContain(a1.id);
    expect((await worker.repos.attempts.findActiveByWorker(WORKER_ID)).map((x) => x.id)).not.toContain(a2.id);

    expect((await worker.repos.attempts.findStaleActive(60_000, 100)).map((x) => x.id)).not.toContain(a2.id);
    await query(migrator, 'UPDATE orc.TaskAttempts SET LastHeartbeatAt = DATEADD(MINUTE, -10, LastHeartbeatAt) WHERE Id = @id;', [
      ['id', sql.UniqueIdentifier, a2.id],
    ]);
    expect((await worker.repos.attempts.findStaleActive(60_000, 100)).map((x) => x.id)).toContain(a2.id);
  });
});
