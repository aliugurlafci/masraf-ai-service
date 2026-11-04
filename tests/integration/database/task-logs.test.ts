// TaskLogs chunk ordering, UNIQUE(AttemptId, Seq), retention; TaskEvents (§2.5, §6.5). Writer = orc_worker.
import sql from 'mssql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database, NewTaskLog } from '@orc/database';
import { openDb, openPool, query, resetDb } from '../../helpers/database/db';
import { createQueuedTask, createTaskWorld } from '../../helpers/database/fixtures';
import type { TaskWorld } from '../../helpers/database/fixtures';

function logs(taskId: string, attemptId: string, from: number, count: number, stream: NewTaskLog['stream'] = 'claude'): NewTaskLog[] {
  return Array.from({ length: count }, (_, i) => {
    const content = `line ${from + i} ünïcødé ✓`;
    return { taskId, attemptId, seq: from + i, stream, source: 'claude', content, byteLength: Buffer.byteLength(content) };
  });
}

describe('task logs and events', () => {
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

  it('appends > 200 rows in ordered multi-row statements and reads them back in Seq order', async () => {
    const { task, attempt } = await createQueuedTask(api, w);
    const rows = logs(task.id, attempt.id, 0, 450);
    // Shuffle the stdout/stderr streams a little to exercise the stream filter.
    rows.forEach((r, i) => {
      if (i % 10 === 0) r.stream = 'stderr';
    });
    await worker.repos.taskLogs.appendBatch(rows);
    await worker.repos.taskLogs.appendBatch([]);

    const all = await api.repos.taskLogs.listByAttempt({ attemptId: attempt.id, limit: 1000 });
    expect(all.map((l) => l.seq)).toEqual(rows.map((r) => r.seq));
    expect(all[1]).toMatchObject({ content: 'line 1 ünïcødé ✓', byteLength: rows[1]!.byteLength, source: 'claude', taskId: task.id });

    const tail = await api.repos.taskLogs.listByAttempt({ attemptId: attempt.id, afterSeq: 440, limit: 5 });
    expect(tail.map((l) => l.seq)).toEqual([441, 442, 443, 444, 445]);
    const errs = await api.repos.taskLogs.listByAttempt({ attemptId: attempt.id, stream: 'stderr', limit: 1000 });
    expect(errs).toHaveLength(45);

    // Id order equals insertion (Seq) order within a batch.
    const byId = await api.repos.taskLogs.listByTaskAfterId({ taskId: task.id, afterId: null, limit: 1000 });
    expect(byId.map((l) => l.seq)).toEqual(rows.map((r) => r.seq));
    const next = await api.repos.taskLogs.listByTaskAfterId({ taskId: task.id, afterId: byId[99]!.id, limit: 3 });
    expect(next.map((l) => l.seq)).toEqual([100, 101, 102]);
    expect(typeof next[0]?.id).toBe('string');
  });

  it('enforces UNIQUE(AttemptId, Seq): the whole batch is rejected and nothing is written', async () => {
    const { task, attempt } = await createQueuedTask(api, w);
    await worker.repos.taskLogs.appendBatch(logs(task.id, attempt.id, 0, 10));
    const overlapping = logs(task.id, attempt.id, 5, 300);
    await expect(worker.repos.taskLogs.appendBatch(overlapping)).rejects.toMatchObject({ code: 'unique_violation' });
    expect(await api.repos.taskLogs.listByAttempt({ attemptId: attempt.id, limit: 1000 })).toHaveLength(10);
    // Duplicates inside the second 200-row statement also roll back the first statement.
    const late = [...logs(task.id, attempt.id, 10, 250), ...logs(task.id, attempt.id, 0, 1)];
    await expect(worker.repos.taskLogs.appendBatch(late)).rejects.toMatchObject({ code: 'unique_violation' });
    expect(await api.repos.taskLogs.listByAttempt({ attemptId: attempt.id, limit: 1000 })).toHaveLength(10);
  });

  it('validates rows before sending them', async () => {
    const { task, attempt } = await createQueuedTask(api, w);
    await expect(
      worker.repos.taskLogs.appendBatch([{ ...logs(task.id, attempt.id, 0, 1)[0]!, stream: 'bogus' as 'stdout' }]),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(worker.repos.taskLogs.appendBatch([{ ...logs(task.id, attempt.id, 0, 1)[0]!, seq: -1 }])).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('orc_api cannot write logs (worker-owned table)', async () => {
    const { task, attempt } = await createQueuedTask(api, w);
    await expect(api.repos.taskLogs.appendBatch(logs(task.id, attempt.id, 0, 1))).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('retention deletes logs older than the cut-off in batches (worker)', async () => {
    const { task, attempt } = await createQueuedTask(api, w);
    await worker.repos.taskLogs.appendBatch(logs(task.id, attempt.id, 0, 7));
    await query(
      migrator,
      'UPDATE orc.TaskLogs SET CreatedAt = DATEADD(DAY, -31, CreatedAt) WHERE AttemptId = @a AND Seq < 5;',
      [['a', sql.UniqueIdentifier, attempt.id]],
    );
    const cutoff = new Date(Date.now() - 30 * 86_400_000);
    expect(await worker.repos.taskLogs.deleteOlderThan(cutoff, 3)).toBe(3);
    expect(await worker.repos.taskLogs.deleteOlderThan(cutoff, 3)).toBe(2);
    expect(await worker.repos.taskLogs.deleteOlderThan(cutoff, 3)).toBe(0);
    expect((await api.repos.taskLogs.listByAttempt({ attemptId: attempt.id, limit: 100 })).map((l) => l.seq)).toEqual([5, 6]);
  });

  it('inserts and pages task events by Id', async () => {
    const { task, attempt } = await createQueuedTask(api, w);
    const inserted = await worker.repos.taskEvents.insert({
      taskId: task.id,
      attemptId: attempt.id,
      type: 'warning',
      fromStatus: null,
      toStatus: null,
      actorType: 'worker',
      actorUserId: null,
      actorLabel: 'worker-test-1',
      reason: null,
      data: { message: 'index failed but not required' },
      correlationId: 'corr-ev',
    });
    expect(inserted).toMatchObject({ type: 'warning', data: { message: 'index failed but not required' } });
    const all = await api.repos.taskEvents.listByTask({ taskId: task.id, limit: 100 });
    expect(all.at(-1)?.id).toBe(inserted.id);
    const after = await api.repos.taskEvents.listByTask({ taskId: task.id, afterId: all[0]!.id, limit: 100 });
    expect(after).toHaveLength(all.length - 1);
  });
});
