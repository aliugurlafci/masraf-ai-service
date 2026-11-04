// AuditLogs (append-only; masked JSON) and WorkerNodes (contract §2.5).
import { T, assertInt, keysetParams, pageTake, run } from '../sql.js';
import type { RepoContext } from '../sql.js';
import type { AuditLogRepository, WorkerNodeRepository } from '../types.js';
import { insertAudit } from './common.js';
import { mapAuditLog, mapWorkerNode } from './mappers.js';

const AUDIT_LIST = `SELECT TOP (@take) * FROM orc.AuditLogs
WHERE (@actorUserId IS NULL OR ActorUserId = @actorUserId)
  AND (@action IS NULL OR Action = @action)
  AND (@entityType IS NULL OR EntityType = @entityType)
  AND (@entityId IS NULL OR EntityId = @entityId)
  AND (@from IS NULL OR OccurredAt >= @from)
  AND (@to IS NULL OR OccurredAt < @to)
  AND (@afterCreatedAt IS NULL OR OccurredAt < @afterCreatedAt OR (OccurredAt = @afterCreatedAt AND Id < @afterId))
ORDER BY OccurredAt DESC, Id DESC
OPTION (RECOMPILE);`;

export function createAuditLogRepository(ctx: RepoContext): AuditLogRepository {
  return {
    insert(a) {
      return insertAudit(ctx, a);
    },
    async list(q) {
      const { rows } = await run(ctx, AUDIT_LIST, [
        ['take', T.int, pageTake(q.limit)],
        ['actorUserId', T.guid, q.actorUserId ?? null],
        ['action', T.varchar(64), q.action ?? null],
        ['entityType', T.varchar(24), q.entityType ?? null],
        ['entityId', T.nvarchar(64), q.entityId ?? null],
        ['from', T.dt, q.from ?? null],
        ['to', T.dt, q.to ?? null],
        ...keysetParams(q.after, 'bigint'),
      ]);
      return rows.map(mapAuditLog);
    },
  };
}

const WORKER_UPSERT = `MERGE orc.WorkerNodes WITH (HOLDLOCK) AS target
USING (SELECT @id AS Id) AS src
ON target.Id = src.Id
WHEN MATCHED THEN UPDATE SET
  Hostname = @hostname, Pid = @pid, AppVersion = @appVersion, CliVersion = @cliVersion, McpVersion = @mcpVersion,
  Concurrency = @concurrency, ActiveJobs = @activeJobs, Status = @status, DiskFreeBytes = @diskFreeBytes,
  StartedAt = @startedAt, LastHeartbeatAt = SYSUTCDATETIME(),
  StoppedAt = CASE WHEN @status = 'offline' THEN COALESCE(target.StoppedAt, SYSUTCDATETIME()) ELSE NULL END,
  UpdatedAt = SYSUTCDATETIME()
WHEN NOT MATCHED THEN INSERT
  (Id, Hostname, Pid, AppVersion, CliVersion, McpVersion, Concurrency, ActiveJobs, Status, DiskFreeBytes, StartedAt, StoppedAt)
  VALUES (@id, @hostname, @pid, @appVersion, @cliVersion, @mcpVersion, @concurrency, @activeJobs, @status, @diskFreeBytes,
          @startedAt, CASE WHEN @status = 'offline' THEN SYSUTCDATETIME() ELSE NULL END);`;
const WORKER_SET_STATUS = `UPDATE orc.WorkerNodes SET
  Status = @status,
  StoppedAt = CASE WHEN @status = 'offline' THEN COALESCE(StoppedAt, SYSUTCDATETIME()) ELSE NULL END,
  UpdatedAt = SYSUTCDATETIME()
WHERE Id = @id;`;
const WORKER_LIST = 'SELECT * FROM orc.WorkerNodes ORDER BY Id;';
const WORKER_MARK_STALE = `UPDATE orc.WorkerNodes SET
  Status = 'offline', StoppedAt = COALESCE(StoppedAt, SYSUTCDATETIME()), UpdatedAt = SYSUTCDATETIME()
WHERE Status <> 'offline' AND LastHeartbeatAt < DATEADD(MILLISECOND, -@staleMs, SYSUTCDATETIME());`;
const WORKER_DELETE_OFFLINE = "DELETE FROM orc.WorkerNodes WHERE Status = 'offline' AND LastHeartbeatAt < @before;";

export function createWorkerNodeRepository(ctx: RepoContext): WorkerNodeRepository {
  return {
    async upsertHeartbeat(h) {
      await run(ctx, WORKER_UPSERT, [
        ['id', T.nvarchar(128), h.id],
        ['hostname', T.nvarchar(255), h.hostname],
        ['pid', T.int, h.pid],
        ['appVersion', T.varchar(32), h.appVersion],
        ['cliVersion', T.varchar(32), h.cliVersion],
        ['mcpVersion', T.varchar(32), h.mcpVersion],
        ['concurrency', T.int, h.concurrency],
        ['activeJobs', T.int, h.activeJobs],
        ['status', T.varchar(10), h.status],
        ['diskFreeBytes', T.bigint, h.diskFreeBytes],
        ['startedAt', T.dt, h.startedAt],
      ]);
    },
    async setStatus(id, status) {
      await run(ctx, WORKER_SET_STATUS, [
        ['id', T.nvarchar(128), id],
        ['status', T.varchar(10), status],
      ]);
    },
    async list() {
      return (await run(ctx, WORKER_LIST)).rows.map(mapWorkerNode);
    },
    async markStaleOffline(staleMs) {
      const { rowsAffected } = await run(ctx, WORKER_MARK_STALE, [
        ['staleMs', T.int, assertInt(staleMs, 'staleMs', 0, 2_000_000_000)],
      ]);
      return rowsAffected;
    },
    async deleteOfflineOlderThan(before) {
      return (await run(ctx, WORKER_DELETE_OFFLINE, [['before', T.dt, before]])).rowsAffected;
    },
  };
}
