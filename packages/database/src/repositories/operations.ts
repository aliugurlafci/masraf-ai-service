// GitOperations and McpIndexOperations (contract §2.5, F3 visibility, §6.5 retention).
import { OrcError, TASK_SCOPED_MCP_OPERATION_KINDS, isOrcError } from '@orc/shared';
import { T, assertInt, first, keysetParams, pageTake, run, truncateChars } from '../sql.js';
import type { Param, RepoContext } from '../sql.js';
import type { GitOperationRepository, McpIndexOperationRepository, McpViewer } from '../types.js';
import { maskedText } from './common.js';
import { mapGitOperation, mapMcpOperation } from './mappers.js';

// ---- git operations -----------------------------------------------------------------------------

const GIT_INSERT = `INSERT INTO orc.GitOperations
  (ProjectId, TaskId, AttemptId, WorkerId, Operation, ArgsJson, Cwd, ExitCode, Signal, Success, TimedOut, DurationMs,
   StderrTail, CorrelationId, StartedAt)
VALUES
  (@projectId, @taskId, @attemptId, @workerId, @operation, @args, @cwd, @exitCode, @signal, @success, @timedOut, @durationMs,
   @stderrTail, @correlationId, @startedAt);`;
const GIT_BY_ATTEMPT = `SELECT TOP (@limit) * FROM orc.GitOperations WHERE AttemptId = @attemptId ORDER BY Id ASC;`;
const GIT_DELETE_OLDER = 'DELETE TOP (@batch) FROM orc.GitOperations WHERE CreatedAt < @before;';

export function createGitOperationRepository(ctx: RepoContext): GitOperationRepository {
  return {
    async insert(o) {
      const startedAt = new Date(o.startedAt);
      if (Number.isNaN(startedAt.getTime())) throw new OrcError('validation_failed', 'startedAt must be an ISO timestamp');
      await run(ctx, GIT_INSERT, [
        ['projectId', T.guid, o.projectId],
        ['taskId', T.guid, o.taskId],
        ['attemptId', T.guid, o.attemptId],
        ['workerId', T.nvarchar(128), o.workerId],
        ['operation', T.varchar(24), o.operation],
        ['args', T.nvarcharMax, JSON.stringify(o.args)],
        ['cwd', T.nvarchar(400), o.cwd === null ? null : truncateChars(o.cwd, 400)],
        ['exitCode', T.int, o.exitCode],
        ['signal', T.varchar(16), o.signal],
        ['success', T.bit, o.success],
        ['timedOut', T.bit, o.timedOut],
        ['durationMs', T.int, Math.max(0, Math.min(Math.round(o.durationMs), 2_147_483_647))],
        ['stderrTail', T.nvarchar(4000), maskedText(ctx, o.stderrTail, 4000)],
        ['correlationId', T.varchar(128), o.correlationId === null ? null : truncateChars(o.correlationId, 128)],
        ['startedAt', T.dt, startedAt],
      ]);
    },
    async listByAttempt(attemptId, limit) {
      const { rows } = await run(ctx, GIT_BY_ATTEMPT, [
        ['attemptId', T.guid, attemptId],
        ['limit', T.int, assertInt(limit, 'limit', 1, 10_000)],
      ]);
      return rows.map(mapGitOperation);
    },
    async deleteOlderThan(before, batchSize) {
      const { rowsAffected } = await run(ctx, GIT_DELETE_OLDER, [
        ['before', T.dt, before],
        ['batch', T.int, assertInt(batchSize, 'batchSize', 1, 100_000)],
      ]);
      return rowsAffected;
    },
  };
}

// ---- MCP index operations -----------------------------------------------------------------------

const ACTIVE_PROJECT_INDEX_CONSTRAINT = 'UX_McpIndexOperations_ActiveProjectIndex';
const TASK_SCOPED_KINDS_JSON = JSON.stringify(TASK_SCOPED_MCP_OPERATION_KINDS);

const MCP_INSERT = `INSERT INTO orc.McpIndexOperations
  (ProjectId, TaskId, AttemptId, WorkspaceId, Kind, IndexName, Mode, Status, RequestedByUserId, WorkerId, StartedAt)
OUTPUT inserted.*
VALUES
  (@projectId, @taskId, @attemptId, @workspaceId, @kind, @indexName, @mode, @status, @requestedByUserId, @workerId,
   CASE WHEN @status = 'running' THEN SYSUTCDATETIME() ELSE NULL END);`;
const MCP_MARK_RUNNING = `UPDATE orc.McpIndexOperations SET
  Status = 'running', WorkerId = @workerId, StartedAt = SYSUTCDATETIME(), UpdatedAt = SYSUTCDATETIME()
WHERE Id = @id AND Status = 'queued';`;
const MCP_FINISH = `UPDATE orc.McpIndexOperations SET
  Status = @status, NodeCount = @nodeCount, EdgeCount = @edgeCount, ResultJson = @result, ErrorCode = @errorCode,
  ErrorMessage = @errorMessage, DurationMs = @durationMs, EndedAt = SYSUTCDATETIME(), UpdatedAt = SYSUTCDATETIME()
WHERE Id = @id;`;
const MCP_BY_ID = 'SELECT * FROM orc.McpIndexOperations WHERE Id = @id;';
const MCP_ACTIVE_PROJECT = `SELECT TOP (1) * FROM orc.McpIndexOperations
WHERE ProjectId = @projectId AND Kind = 'project_index' AND Status IN ('queued', 'running')
ORDER BY CreatedAt DESC, Id DESC;`;
const MCP_LATEST = `SELECT TOP (1) * FROM orc.McpIndexOperations
WHERE ProjectId = @projectId AND Kind = @kind
  AND (@status IS NULL OR Status = @status)
  AND (@attemptId IS NULL OR AttemptId = @attemptId)
ORDER BY CreatedAt DESC, Id DESC
OPTION (RECOMPILE);`;
const MCP_LIST_BY_PROJECT = `SELECT TOP (@take) m.* FROM orc.McpIndexOperations AS m
WHERE m.ProjectId = @projectId
  AND (@canReadAny = 1
       OR m.Kind NOT IN (SELECT [value] FROM OPENJSON(@taskScopedKinds))
       OR EXISTS (SELECT 1 FROM orc.Tasks AS t WHERE t.Id = m.TaskId AND t.CreatedByUserId = @userId))
  AND (@afterCreatedAt IS NULL OR m.CreatedAt < @afterCreatedAt OR (m.CreatedAt = @afterCreatedAt AND m.Id < @afterId))
ORDER BY m.CreatedAt DESC, m.Id DESC
OPTION (RECOMPILE);`;
const MCP_RECENT = `SELECT TOP (@limit) m.* FROM orc.McpIndexOperations AS m
WHERE (@canReadAny = 1
       OR m.Kind NOT IN (SELECT [value] FROM OPENJSON(@taskScopedKinds))
       OR EXISTS (SELECT 1 FROM orc.Tasks AS t WHERE t.Id = m.TaskId AND t.CreatedByUserId = @userId))
ORDER BY m.CreatedAt DESC, m.Id DESC
OPTION (RECOMPILE);`;
const MCP_FAIL_STALE = `UPDATE orc.McpIndexOperations SET
  Status = 'failed', ErrorCode = 'mcp_timeout', ErrorMessage = N'Operation made no progress within the stale threshold',
  EndedAt = SYSUTCDATETIME(),
  DurationMs = CASE WHEN StartedAt IS NULL THEN DurationMs ELSE DATEDIFF_BIG(MILLISECOND, StartedAt, SYSUTCDATETIME()) END,
  UpdatedAt = SYSUTCDATETIME()
WHERE Status = 'running' AND UpdatedAt < DATEADD(MILLISECOND, -@staleMs, SYSUTCDATETIME());`;
const MCP_DELETE_OLDER = `DELETE TOP (@batch) FROM orc.McpIndexOperations
WHERE CreatedAt < @before
  AND Status NOT IN ('queued', 'running')
  AND Id NOT IN (
    SELECT x.Id FROM (
      SELECT Id, ROW_NUMBER() OVER (PARTITION BY ProjectId ORDER BY CreatedAt DESC, Id DESC) AS Rn
      FROM orc.McpIndexOperations
      WHERE Kind = 'project_index' AND Status = 'succeeded'
    ) AS x
    WHERE x.Rn = 1);`;

function viewerParams(viewer: McpViewer): Param[] {
  return [
    ['canReadAny', T.bit, viewer.canReadAny],
    ['userId', T.guid, viewer.userId],
    ['taskScopedKinds', T.nvarchar(400), TASK_SCOPED_KINDS_JSON],
  ];
}

/** JSON text for ResultJson; scalars are wrapped as {"value": x} so ISJSON(ResultJson) = 1 holds. */
function resultJson(result: unknown): string | null {
  if (result === undefined || result === null) return null;
  return JSON.stringify(typeof result === 'object' ? result : { value: result });
}

export function createMcpIndexOperationRepository(ctx: RepoContext): McpIndexOperationRepository {
  return {
    async insert(o) {
      try {
        const { rows } = await run(ctx, MCP_INSERT, [
          ['projectId', T.guid, o.projectId],
          ['taskId', T.guid, o.taskId],
          ['attemptId', T.guid, o.attemptId],
          ['workspaceId', T.guid, o.workspaceId],
          ['kind', T.varchar(16), o.kind],
          ['indexName', T.nvarchar(128), o.indexName],
          ['mode', T.varchar(16), o.mode],
          ['status', T.varchar(10), o.status],
          ['requestedByUserId', T.guid, o.requestedByUserId],
          ['workerId', T.nvarchar(128), o.workerId],
        ]);
        const row = first(rows);
        if (!row) throw new OrcError('internal_error', 'McpIndexOperations insert returned no row');
        return mapMcpOperation(row);
      } catch (err) {
        if (isOrcError(err) && err.code === 'unique_violation' && err.details?.['constraint'] === ACTIVE_PROJECT_INDEX_CONSTRAINT) {
          throw new OrcError('index_in_progress', 'A project index operation is already queued or running', { cause: err });
        }
        throw err;
      }
    },
    async markRunning(id, workerId) {
      const { rowsAffected } = await run(ctx, MCP_MARK_RUNNING, [
        ['id', T.guid, id],
        ['workerId', T.nvarchar(128), workerId],
      ]);
      return rowsAffected > 0;
    },
    async finish(id, r) {
      await run(ctx, MCP_FINISH, [
        ['id', T.guid, id],
        ['status', T.varchar(10), r.status],
        ['nodeCount', T.bigint, r.nodeCount],
        ['edgeCount', T.bigint, r.edgeCount],
        ['result', T.nvarcharMax, resultJson(r.result)],
        ['errorCode', T.varchar(40), r.errorCode === null ? null : truncateChars(r.errorCode, 40)],
        ['errorMessage', T.nvarchar(2000), maskedText(ctx, r.errorMessage, 2000)],
        ['durationMs', T.bigint, Math.max(0, Math.round(r.durationMs))],
      ]);
    },
    async findById(id) {
      const row = first((await run(ctx, MCP_BY_ID, [['id', T.guid, id]])).rows);
      return row ? mapMcpOperation(row) : null;
    },
    async findActiveProjectOp(projectId) {
      const row = first((await run(ctx, MCP_ACTIVE_PROJECT, [['projectId', T.guid, projectId]])).rows);
      return row ? mapMcpOperation(row) : null;
    },
    async findLatest(q) {
      const row = first(
        (
          await run(ctx, MCP_LATEST, [
            ['projectId', T.guid, q.projectId],
            ['kind', T.varchar(16), q.kind],
            ['status', T.varchar(10), q.status ?? null],
            ['attemptId', T.guid, q.attemptId ?? null],
          ])
        ).rows,
      );
      return row ? mapMcpOperation(row) : null;
    },
    async listByProject(q) {
      const { rows } = await run(ctx, MCP_LIST_BY_PROJECT, [
        ['take', T.int, pageTake(q.limit)],
        ['projectId', T.guid, q.projectId],
        ...viewerParams(q.viewer),
        ...keysetParams(q.after, 'guid'),
      ]);
      return rows.map(mapMcpOperation);
    },
    async findRecent(q) {
      const { rows } = await run(ctx, MCP_RECENT, [
        ['limit', T.int, assertInt(q.limit, 'limit', 1, 10_000)],
        ...viewerParams(q.viewer),
      ]);
      return rows.map(mapMcpOperation);
    },
    async failStaleRunning(staleMs) {
      const { rowsAffected } = await run(ctx, MCP_FAIL_STALE, [
        ['staleMs', T.int, assertInt(staleMs, 'staleMs', 0, 2_000_000_000)],
      ]);
      return rowsAffected;
    },
    async deleteOlderThan(before, batchSize) {
      const { rowsAffected } = await run(ctx, MCP_DELETE_OLDER, [
        ['before', T.dt, before],
        ['batch', T.int, assertInt(batchSize, 'batchSize', 1, 100_000)],
      ]);
      return rowsAffected;
    },
  };
}
