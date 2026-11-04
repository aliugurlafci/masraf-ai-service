// TaskLogs (ordered, size-bounded chunks; one writer per attempt) and TaskEvents (contract §2.5).
import { LOG_SOURCES, LOG_STREAMS, OrcError } from '@orc/shared';
import { T, assertBigId, assertGuid, assertInt, run } from '../sql.js';
import type { RepoContext } from '../sql.js';
import type { NewTaskLog, TaskEventRepository, TaskLogRepository } from '../types.js';
import { insertEvent } from './common.js';
import { mapTaskEvent, mapTaskLog } from './mappers.js';

export const TASK_LOG_ROWS_PER_STATEMENT = 200;
const MAX_LIST = 10_000;

const LOG_INSERT_BATCH = `INSERT INTO orc.TaskLogs (TaskId, AttemptId, Seq, Stream, Source, Content, ByteLength)
SELECT j.TaskId, j.AttemptId, j.Seq, j.Stream, j.Source, j.Content, j.ByteLength
FROM OPENJSON(@rows) WITH (
  Ord INT '$.o',
  TaskId UNIQUEIDENTIFIER '$.t',
  AttemptId UNIQUEIDENTIFIER '$.a',
  Seq INT '$.s',
  Stream VARCHAR(MAX) '$.st',
  Source VARCHAR(MAX) '$.so',
  Content NVARCHAR(MAX) '$.c',
  ByteLength INT '$.b'
) AS j
ORDER BY j.Ord;`;
const LOG_LIST_BY_ATTEMPT = `SELECT TOP (@limit) * FROM orc.TaskLogs
WHERE AttemptId = @attemptId
  AND (@stream IS NULL OR Stream = @stream)
  AND (@afterSeq IS NULL OR Seq > @afterSeq)
ORDER BY Seq ASC
OPTION (RECOMPILE);`;
const LOG_LIST_BY_TASK = `SELECT TOP (@limit) * FROM orc.TaskLogs
WHERE TaskId = @taskId AND (@afterId IS NULL OR Id > @afterId)
ORDER BY Id ASC
OPTION (RECOMPILE);`;
const LOG_DELETE_OLDER = 'DELETE TOP (@batch) FROM orc.TaskLogs WHERE CreatedAt < @before;';

function validateLog(row: NewTaskLog, index: number): void {
  assertGuid(row.taskId, `rows[${index}].taskId`);
  assertGuid(row.attemptId, `rows[${index}].attemptId`);
  assertInt(row.seq, `rows[${index}].seq`, 0, 2_147_483_647);
  assertInt(row.byteLength, `rows[${index}].byteLength`, 0, 2_147_483_647);
  if (!(LOG_STREAMS as readonly string[]).includes(row.stream) || !(LOG_SOURCES as readonly string[]).includes(row.source)) {
    throw new OrcError('validation_failed', `rows[${index}] has an invalid stream/source`);
  }
  if (typeof row.content !== 'string') throw new OrcError('validation_failed', `rows[${index}].content must be a string`);
}

export function createTaskLogRepository(ctx: RepoContext): TaskLogRepository {
  return {
    async appendBatch(rows) {
      if (rows.length === 0) return;
      rows.forEach(validateLog);
      await ctx.exec.atomic('taskLogs.appendBatch', async (exec) => {
        const c: RepoContext = { ...ctx, exec };
        for (let start = 0; start < rows.length; start += TASK_LOG_ROWS_PER_STATEMENT) {
          const chunk = rows.slice(start, start + TASK_LOG_ROWS_PER_STATEMENT).map((r, i) => ({
            o: start + i,
            t: r.taskId,
            a: r.attemptId,
            s: r.seq,
            st: r.stream,
            so: r.source,
            c: r.content,
            b: r.byteLength,
          }));
          await run(c, LOG_INSERT_BATCH, [['rows', T.nvarcharMax, JSON.stringify(chunk)]]);
        }
      });
    },
    async listByAttempt(q) {
      const { rows } = await run(ctx, LOG_LIST_BY_ATTEMPT, [
        ['limit', T.int, assertInt(q.limit, 'limit', 1, MAX_LIST)],
        ['attemptId', T.guid, q.attemptId],
        ['stream', T.varchar(8), q.stream ?? null],
        ['afterSeq', T.int, q.afterSeq ?? null],
      ]);
      return rows.map(mapTaskLog);
    },
    async listByTaskAfterId(q) {
      const { rows } = await run(ctx, LOG_LIST_BY_TASK, [
        ['limit', T.int, assertInt(q.limit, 'limit', 1, MAX_LIST)],
        ['taskId', T.guid, q.taskId],
        ['afterId', T.bigint, q.afterId === null ? null : assertBigId(q.afterId, 'afterId')],
      ]);
      return rows.map(mapTaskLog);
    },
    async deleteOlderThan(before, batchSize) {
      const { rowsAffected } = await run(ctx, LOG_DELETE_OLDER, [
        ['before', T.dt, before],
        ['batch', T.int, assertInt(batchSize, 'batchSize', 1, 100_000)],
      ]);
      return rowsAffected;
    },
  };
}

const EVENT_LIST_BY_TASK = `SELECT TOP (@limit) * FROM orc.TaskEvents
WHERE TaskId = @taskId AND (@afterId IS NULL OR Id > @afterId)
ORDER BY Id ASC
OPTION (RECOMPILE);`;

export function createTaskEventRepository(ctx: RepoContext): TaskEventRepository {
  return {
    insert(e) {
      return insertEvent(ctx, {
        taskId: e.taskId,
        attemptId: e.attemptId,
        type: e.type,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        actorType: e.actorType,
        actorUserId: e.actorUserId,
        actorLabel: e.actorLabel,
        reason: e.reason,
        data: e.data,
        correlationId: e.correlationId,
      });
    },
    async listByTask(q) {
      const { rows } = await run(ctx, EVENT_LIST_BY_TASK, [
        ['limit', T.int, assertInt(q.limit, 'limit', 1, MAX_LIST)],
        ['taskId', T.guid, q.taskId],
        ['afterId', T.bigint, q.afterId === undefined ? null : assertBigId(q.afterId, 'afterId')],
      ]);
      return rows.map(mapTaskEvent);
    },
  };
}
