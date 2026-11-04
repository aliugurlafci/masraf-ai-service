// Tasks (read side) and TaskAttempts (contract §2.5). Status mutations live in task-state.ts.
import { ConflictError, OrcError } from '@orc/shared';
import { T, assertGuid, assertInt, date, first, guid, int, isGuid, keysetParams, nstr, pageTake, run } from '../sql.js';
import type { RepoContext } from '../sql.js';
import type { AttemptRepository, TaskRepository } from '../types.js';
import { mapAttempt, mapTask } from './mappers.js';

const MAX_IDS = 2000;

function idsJson(ids: readonly string[], field: string): string {
  if (ids.length > MAX_IDS) throw new OrcError('validation_failed', `${field} accepts at most ${MAX_IDS} ids`);
  return JSON.stringify(ids.map((id) => assertGuid(id, field)));
}

// ---- tasks ------------------------------------------------------------------------------------

const TASK_BY_ID = 'SELECT * FROM orc.Tasks WHERE Id = @id;';
const TASK_VISIBLE = 'SELECT * FROM orc.Tasks WHERE Id = @id AND (@canReadAny = 1 OR CreatedByUserId = @userId);';
const TASK_LIST = `SELECT TOP (@take) * FROM orc.Tasks
WHERE (@ownerUserId IS NULL OR CreatedByUserId = @ownerUserId)
  AND (@projectId IS NULL OR ProjectId = @projectId)
  AND (@statuses IS NULL OR Status IN (SELECT [value] FROM OPENJSON(@statuses)))
  AND (@afterCreatedAt IS NULL OR CreatedAt < @afterCreatedAt OR (CreatedAt = @afterCreatedAt AND Id < @afterId))
ORDER BY CreatedAt DESC, Id DESC
OPTION (RECOMPILE);`;
const TASK_CANCEL_REQUESTED = `SELECT Id, CancelRequestedAt FROM orc.Tasks
WHERE Id IN (SELECT CAST([value] AS UNIQUEIDENTIFIER) FROM OPENJSON(@ids)) AND CancelRequestedAt IS NOT NULL;`;
const TASK_QUEUED_RECONCILE = `SELECT TOP (@limit) t.Id AS TaskId, a.Id AS AttemptId, a.AttemptNumber,
  COALESCE(a.CorrelationId, t.CorrelationId) AS CorrelationId
FROM orc.Tasks AS t
INNER JOIN orc.TaskAttempts AS a ON a.Id = t.CurrentAttemptId
WHERE t.Status = 'queued' AND a.Status = 'queued'
  AND t.QueuedAt < DATEADD(MILLISECOND, -@minAgeMs, SYSUTCDATETIME())
ORDER BY t.QueuedAt, t.Id;`;

export function createTaskRepository(ctx: RepoContext): TaskRepository {
  return {
    async findById(id) {
      if (!isGuid(id)) return null;
      const row = first((await run(ctx, TASK_BY_ID, [['id', T.guid, id]])).rows);
      return row ? mapTask(row) : null;
    },
    async findVisible(id, viewer) {
      if (!isGuid(id)) return null;
      const row = first(
        (
          await run(ctx, TASK_VISIBLE, [
            ['id', T.guid, id],
            ['canReadAny', T.bit, viewer.canReadAny],
            ['userId', T.guid, viewer.userId],
          ])
        ).rows,
      );
      return row ? mapTask(row) : null;
    },
    async list(o) {
      const statuses = o.statuses && o.statuses.length > 0 ? JSON.stringify(o.statuses) : null;
      const { rows } = await run(ctx, TASK_LIST, [
        ['take', T.int, pageTake(o.limit)],
        ['ownerUserId', T.guid, o.ownerUserId ?? null],
        ['projectId', T.guid, o.projectId ?? null],
        ['statuses', T.nvarchar(4000), statuses],
        ...keysetParams(o.after, 'guid'),
      ]);
      return rows.map(mapTask);
    },
    async findCancelRequested(ids) {
      if (ids.length === 0) return [];
      const { rows } = await run(ctx, TASK_CANCEL_REQUESTED, [['ids', T.nvarcharMax, idsJson(ids, 'ids')]]);
      return rows.map((r) => ({ id: guid(r, 'Id'), cancelRequestedAt: date(r, 'CancelRequestedAt') }));
    },
    async findQueuedForReconcile(minAgeMs, limit) {
      const { rows } = await run(ctx, TASK_QUEUED_RECONCILE, [
        ['minAgeMs', T.int, assertInt(minAgeMs, 'minAgeMs', 0, 2_000_000_000)],
        ['limit', T.int, assertInt(limit, 'limit', 1, 10_000)],
      ]);
      return rows.map((r) => ({
        taskId: guid(r, 'TaskId'),
        attemptId: guid(r, 'AttemptId'),
        attemptNumber: int(r, 'AttemptNumber'),
        correlationId: nstr(r, 'CorrelationId'),
      }));
    },
  };
}

// ---- attempts ---------------------------------------------------------------------------------

const ATTEMPT_BY_ID = 'SELECT * FROM orc.TaskAttempts WHERE Id = @id;';
const ATTEMPT_BY_TASK = 'SELECT * FROM orc.TaskAttempts WHERE TaskId = @taskId ORDER BY AttemptNumber ASC;';
const ATTEMPT_SET_PROCESS = `UPDATE orc.TaskAttempts SET
  Pid = @pid, Pgid = @pgid, ProcessStartedAt = SYSUTCDATETIME(), ProcessEndedAt = NULL, ExitCode = NULL, ExitSignal = NULL,
  UpdatedAt = SYSUTCDATETIME()
WHERE Id = @id AND WorkerId = @workerId AND Status = 'active';`;
const ATTEMPT_SET_PROCESS_EXIT = `UPDATE orc.TaskAttempts SET
  ProcessEndedAt = SYSUTCDATETIME(), ExitCode = @exitCode, ExitSignal = @exitSignal, UpdatedAt = SYSUTCDATETIME()
WHERE Id = @id;`;
const ATTEMPT_HEARTBEAT = `UPDATE orc.TaskAttempts SET LastHeartbeatAt = SYSUTCDATETIME(), UpdatedAt = SYSUTCDATETIME()
OUTPUT inserted.Id
WHERE Id IN (SELECT CAST([value] AS UNIQUEIDENTIFIER) FROM OPENJSON(@ids))
  AND Status = 'active' AND WorkerId = @workerId;`;
const ATTEMPT_SET_WORKSPACE = `UPDATE orc.TaskAttempts SET
  WorkspaceId = @workspaceId, BranchName = @branchName, BaseSha = @baseSha, UpdatedAt = SYSUTCDATETIME()
WHERE Id = @id;`;
const ATTEMPT_SET_REVIEW = `UPDATE orc.TaskAttempts SET
  HeadSha = @headSha, FilesChanged = @filesChanged, Additions = @additions, Deletions = @deletions,
  CommitsJson = @commits, MergeCheckJson = @mergeCheck, UpdatedAt = SYSUTCDATETIME()
WHERE Id = @id;`;
const ATTEMPT_STALE = `SELECT TOP (@limit) * FROM orc.TaskAttempts
WHERE Status = 'active'
  AND (LastHeartbeatAt < DATEADD(MILLISECOND, -@staleMs, SYSUTCDATETIME())
       OR (LastHeartbeatAt IS NULL AND StartedAt < DATEADD(MILLISECOND, -@staleMs, SYSUTCDATETIME())))
ORDER BY LastHeartbeatAt, Id;`;
const ATTEMPT_ACTIVE_BY_WORKER = "SELECT * FROM orc.TaskAttempts WHERE Status = 'active' AND WorkerId = @workerId ORDER BY StartedAt, Id;";

export function createAttemptRepository(ctx: RepoContext): AttemptRepository {
  return {
    async findById(id) {
      if (!isGuid(id)) return null;
      const row = first((await run(ctx, ATTEMPT_BY_ID, [['id', T.guid, id]])).rows);
      return row ? mapAttempt(row) : null;
    },
    async listByTask(taskId) {
      return (await run(ctx, ATTEMPT_BY_TASK, [['taskId', T.guid, taskId]])).rows.map(mapAttempt);
    },
    async setProcess(id, p) {
      const { rowsAffected } = await run(ctx, ATTEMPT_SET_PROCESS, [
        ['id', T.guid, id],
        ['pid', T.int, p.pid],
        ['pgid', T.int, p.pgid],
        ['workerId', T.nvarchar(128), p.workerId],
      ]);
      if (rowsAffected === 0) throw new ConflictError('Attempt is not active on this worker');
    },
    async setProcessExit(id, p) {
      await run(ctx, ATTEMPT_SET_PROCESS_EXIT, [
        ['id', T.guid, id],
        ['exitCode', T.int, p.exitCode],
        ['exitSignal', T.varchar(16), p.exitSignal],
      ]);
    },
    async heartbeat(ids, workerId) {
      if (ids.length === 0) return [];
      const { rows } = await run(ctx, ATTEMPT_HEARTBEAT, [
        ['ids', T.nvarcharMax, idsJson(ids, 'ids')],
        ['workerId', T.nvarchar(128), workerId],
      ]);
      return rows.map((r) => guid(r, 'Id'));
    },
    async setWorkspace(id, w) {
      await run(ctx, ATTEMPT_SET_WORKSPACE, [
        ['id', T.guid, id],
        ['workspaceId', T.guid, w.workspaceId],
        ['branchName', T.nvarchar(200), w.branchName],
        ['baseSha', T.varchar(64), w.baseSha],
      ]);
    },
    async setReview(id, r) {
      await run(ctx, ATTEMPT_SET_REVIEW, [
        ['id', T.guid, id],
        ['headSha', T.varchar(64), r.headSha],
        ['filesChanged', T.int, r.filesChanged],
        ['additions', T.int, r.additions],
        ['deletions', T.int, r.deletions],
        ['commits', T.nvarcharMax, JSON.stringify(r.commits)],
        ['mergeCheck', T.nvarcharMax, r.mergeCheck === null ? null : JSON.stringify(r.mergeCheck)],
      ]);
    },
    async findStaleActive(staleMs, limit) {
      const { rows } = await run(ctx, ATTEMPT_STALE, [
        ['staleMs', T.int, assertInt(staleMs, 'staleMs', 0, 2_000_000_000)],
        ['limit', T.int, assertInt(limit, 'limit', 1, 10_000)],
      ]);
      return rows.map(mapAttempt);
    },
    async findActiveByWorker(workerId) {
      return (await run(ctx, ATTEMPT_ACTIVE_BY_WORKER, [['workerId', T.nvarchar(128), workerId]])).rows.map(mapAttempt);
    },
  };
}
