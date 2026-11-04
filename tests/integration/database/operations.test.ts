// GitOperations, McpIndexOperations (F3 visibility), WorkerNodes and AuditLogs incl. §6.5 retention queries.
import { randomUUID } from 'node:crypto';
import sql from 'mssql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@orc/database';
import { openDb, openPool, query, resetDb } from '../../helpers/database/db';
import { WORKER_ID, createQueuedTask, createTaskWorld, createUser, userActor } from '../../helpers/database/fixtures';
import type { TaskWorld } from '../../helpers/database/fixtures';

const DAY = 86_400_000;

describe('operations, workers and audit', () => {
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

  it('git operations: insert, list by attempt, retention', async () => {
    const { task, attempt } = await createQueuedTask(api, w);
    for (let i = 0; i < 3; i += 1) {
      await worker.repos.gitOperations.insert({
        projectId: w.project.id, taskId: task.id, attemptId: attempt.id, workerId: WORKER_ID, operation: 'worktree_add',
        args: ['worktree', 'add', `/ws/${i}`], cwd: '/projects/acme', exitCode: i === 2 ? 128 : 0, signal: null,
        success: i !== 2, timedOut: false, durationMs: 10 + i, stderrTail: i === 2 ? 'fatal: token=ghp_abcdefghijklmnopqrstuvwxyz0123456789' : null,
        correlationId: 'corr-git', startedAt: new Date().toISOString(),
      });
    }
    const ops = await api.repos.gitOperations.listByAttempt(attempt.id, 10);
    expect(ops.map((o) => o.args[2])).toEqual(['/ws/0', '/ws/1', '/ws/2']);
    expect(ops[2]).toMatchObject({ success: false, exitCode: 128 });
    expect(ops[2]?.stderrTail).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    await query(migrator, 'UPDATE orc.GitOperations SET CreatedAt = DATEADD(DAY, -31, CreatedAt) WHERE AttemptId = @a AND DurationMs < 12;', [
      ['a', sql.UniqueIdentifier, attempt.id],
    ]);
    expect(await worker.repos.gitOperations.deleteOlderThan(new Date(Date.now() - 30 * DAY), 5000)).toBe(2);
    expect(await api.repos.gitOperations.listByAttempt(attempt.id, 10)).toHaveLength(1);
  });

  it('mcp operations: one active project index, lifecycle, visibility (F3) and retention keeping the latest success', async () => {
    const owner = w.user;
    const stranger = await createUser(api);
    const { task, attempt } = await createQueuedTask(api, w);
    const base = { projectId: w.project.id, workspaceId: null, indexName: `orc-p-${w.project.id}`, mode: 'moderate' as const, requestedByUserId: owner.id, workerId: null };

    const op = await api.repos.mcpOperations.insert({ ...base, taskId: null, attemptId: null, kind: 'project_index', status: 'queued' });
    await expect(
      api.repos.mcpOperations.insert({ ...base, taskId: null, attemptId: null, kind: 'project_index', status: 'queued' }),
    ).rejects.toMatchObject({ code: 'index_in_progress' });
    expect((await worker.repos.mcpOperations.findActiveProjectOp(w.project.id))?.id).toBe(op.id);
    expect(await worker.repos.mcpOperations.markRunning(op.id, WORKER_ID)).toBe(true);
    expect(await worker.repos.mcpOperations.markRunning(op.id, WORKER_ID)).toBe(false);
    await worker.repos.mcpOperations.finish(op.id, { status: 'succeeded', nodeCount: 9_000_000_000, edgeCount: 12, result: { files: 3 }, errorCode: null, errorMessage: null, durationMs: 1500 });
    const done = await api.repos.mcpOperations.findById(op.id);
    expect(done).toMatchObject({ status: 'succeeded', nodeCount: 9_000_000_000, edgeCount: 12, result: { files: 3 }, workerId: WORKER_ID });
    expect(await worker.repos.mcpOperations.findActiveProjectOp(w.project.id)).toBeNull();

    const taskOp = await worker.repos.mcpOperations.insert({ ...base, taskId: task.id, attemptId: attempt.id, kind: 'task_index', status: 'running', requestedByUserId: null, workerId: WORKER_ID });
    expect((await worker.repos.mcpOperations.findLatest({ projectId: w.project.id, kind: 'task_index', attemptId: attempt.id }))?.id).toBe(taskOp.id);
    expect(await worker.repos.mcpOperations.findLatest({ projectId: w.project.id, kind: 'task_index', status: 'succeeded' })).toBeNull();

    const ownerView = await api.repos.mcpOperations.listByProject({ projectId: w.project.id, viewer: { userId: owner.id, canReadAny: false }, limit: 50 });
    expect(ownerView.map((o) => o.id).sort()).toEqual([op.id, taskOp.id].sort());
    const strangerView = await api.repos.mcpOperations.listByProject({ projectId: w.project.id, viewer: { userId: stranger.id, canReadAny: false }, limit: 50 });
    expect(strangerView.map((o) => o.id)).toEqual([op.id]);
    const adminView = await api.repos.mcpOperations.findRecent({ limit: 50, viewer: { userId: stranger.id, canReadAny: true } });
    expect(adminView.map((o) => o.id)).toEqual(expect.arrayContaining([op.id, taskOp.id]));
    expect((await api.repos.mcpOperations.findRecent({ limit: 50, viewer: { userId: stranger.id, canReadAny: false } })).map((o) => o.id)).not.toContain(taskOp.id);

    // Stale running operations fail with mcp_timeout.
    await query(migrator, 'UPDATE orc.McpIndexOperations SET UpdatedAt = DATEADD(MINUTE, -30, UpdatedAt) WHERE Id = @id;', [['id', sql.UniqueIdentifier, taskOp.id]]);
    expect(await worker.repos.mcpOperations.failStaleRunning(60_000)).toBe(1);
    expect(await api.repos.mcpOperations.findById(taskOp.id)).toMatchObject({ status: 'failed', errorCode: 'mcp_timeout' });

    // Retention: both are old, only the failed one is deleted (latest succeeded project_index is kept).
    await query(migrator, 'UPDATE orc.McpIndexOperations SET CreatedAt = DATEADD(DAY, -100, CreatedAt) WHERE ProjectId = @p;', [['p', sql.UniqueIdentifier, w.project.id]]);
    expect(await worker.repos.mcpOperations.deleteOlderThan(new Date(Date.now() - 90 * DAY), 5000)).toBe(1);
    expect(await api.repos.mcpOperations.findById(op.id)).not.toBeNull();
    expect(await api.repos.mcpOperations.findById(taskOp.id)).toBeNull();
  });

  it('worker nodes: heartbeat upsert, stale marking and offline retention', async () => {
    const id = `worker-${randomUUID()}`;
    const hb = { id, hostname: 'host-a', pid: 123, appVersion: '1.0.0', cliVersion: '2.1.0', mcpVersion: '0.12.0', concurrency: 2, activeJobs: 1, status: 'ready' as const, diskFreeBytes: 50_000_000_000, startedAt: new Date() };
    await worker.repos.workerNodes.upsertHeartbeat(hb);
    await worker.repos.workerNodes.upsertHeartbeat({ ...hb, activeJobs: 2 });
    let node = (await api.repos.workerNodes.list()).find((n) => n.id === id);
    expect(node).toMatchObject({ activeJobs: 2, status: 'ready', diskFreeBytes: 50_000_000_000, stoppedAt: null });
    await worker.repos.workerNodes.setStatus(id, 'draining');
    expect((await api.repos.workerNodes.list()).find((n) => n.id === id)?.status).toBe('draining');

    await query(migrator, 'UPDATE orc.WorkerNodes SET LastHeartbeatAt = DATEADD(DAY, -8, LastHeartbeatAt) WHERE Id = @id;', [['id', sql.NVarChar(128), id]]);
    expect(await worker.repos.workerNodes.markStaleOffline(60_000)).toBeGreaterThanOrEqual(1);
    node = (await api.repos.workerNodes.list()).find((n) => n.id === id);
    expect(node?.status).toBe('offline');
    expect(node?.stoppedAt).not.toBeNull();
    expect(await worker.repos.workerNodes.deleteOfflineOlderThan(new Date(Date.now() - 7 * DAY))).toBe(1);
    expect((await api.repos.workerNodes.list()).find((n) => n.id === id)).toBeUndefined();
  });

  it('audit: masks secrets before insert, filters and pages; the worker can only insert', async () => {
    const actor = userActor(w.user);
    for (let i = 0; i < 4; i += 1) {
      await api.repos.audit.insert({
        action: 'project.updated',
        actor,
        entityType: 'project',
        entityId: w.project.id,
        outcome: 'success',
        before: { name: `n${i}` },
        after: { name: `n${i + 1}`, password: 'hunter2-hunter2', token: 'orc_pat_secretsecretsecretsecret' },
        detail: 'plain scalar',
        requestId: `req-${i}`,
        ip: '192.0.2.1',
      });
    }
    await worker.repos.audit.insert({ action: 'maintenance.retention_run', actor: { type: 'worker', workerId: WORKER_ID }, entityType: 'system', entityId: null, outcome: 'success', detail: { counts: { taskLogs: 1 } } });
    await expect(worker.repos.audit.list({ limit: 1 })).rejects.toMatchObject({ code: 'internal_error' });

    const page1 = await api.repos.audit.list({ limit: 2, entityType: 'project', entityId: w.project.id });
    expect(page1).toHaveLength(3);
    expect(JSON.stringify(page1[0]?.after)).not.toContain('hunter2-hunter2');
    expect(JSON.stringify(page1[0]?.after)).not.toContain('orc_pat_secretsecretsecretsecret');
    expect(page1[0]?.detail).toEqual({ value: 'plain scalar' });
    const page2 = await api.repos.audit.list({ limit: 2, entityType: 'project', entityId: w.project.id, after: { createdAt: page1[1]!.occurredAt, id: page1[1]!.id } });
    expect(page2.map((a) => a.requestId)).toEqual(['req-1', 'req-0']);
    expect(await api.repos.audit.list({ limit: 10, action: 'maintenance.retention_run' })).toHaveLength(1);
    expect(await api.repos.audit.list({ limit: 10, actorUserId: w.user.id, from: new Date(Date.now() + DAY) })).toHaveLength(0);
  });
});
