// Workspaces, ChangedFiles, AttemptPatches (contract §2.5, §6.5 patch retention F12).
import { CHANGE_TYPES, OrcError } from '@orc/shared';
import { T, assertBigId, assertGuid, assertInt, bigNum, bool, buf, first, iso, run } from '../sql.js';
import type { RepoContext } from '../sql.js';
import type {
  AttemptPatchRepository,
  ChangedFileRepository,
  NewChangedFile,
  WorkspaceRepository,
} from '../types.js';
import { maskedText } from './common.js';
import { mapChangedFile, mapWorkspace } from './mappers.js';

// ---- workspaces ---------------------------------------------------------------------------------

const WS_INSERT = `INSERT INTO orc.Workspaces
  (ProjectId, TaskId, Kind, CreatedByAttemptId, Path, BranchName, BaseSha, Status, WorkerId, QuotaBytes)
OUTPUT inserted.*
VALUES (@projectId, @taskId, @kind, @createdByAttemptId, @path, @branchName, @baseSha, 'creating', @workerId, @quotaBytes);`;
const WS_BY_ID = 'SELECT * FROM orc.Workspaces WHERE Id = @id;';
const WS_BASE = "SELECT TOP (1) * FROM orc.Workspaces WHERE ProjectId = @projectId AND Kind = 'base' AND Status <> 'removed';";
const WS_SET_STATUS = `UPDATE orc.Workspaces SET
  Status = @status,
  HeadSha = CASE WHEN @set_headSha = 1 THEN @headSha ELSE HeadSha END,
  RetainUntil = CASE WHEN @set_retainUntil = 1 THEN @retainUntil ELSE RetainUntil END,
  ErrorDetail = CASE WHEN @set_errorDetail = 1 THEN @errorDetail ELSE ErrorDetail END,
  RemovedAt = CASE WHEN @status = 'removed' THEN COALESCE(RemovedAt, SYSUTCDATETIME()) ELSE RemovedAt END,
  UpdatedAt = SYSUTCDATETIME()
WHERE Id = @id;`;
const WS_RECORD_SIZE = `UPDATE orc.Workspaces SET SizeBytes = @sizeBytes, SizeCheckedAt = SYSUTCDATETIME(), UpdatedAt = SYSUTCDATETIME()
WHERE Id = @id;`;
const WS_FOR_CLEANUP = `SELECT TOP (@limit) w.* FROM orc.Workspaces AS w
WHERE w.Kind = 'attempt' AND w.Status IN ('ready', 'retained', 'error') AND w.RetainUntil < SYSUTCDATETIME()
  AND NOT EXISTS (
    SELECT 1 FROM orc.TaskAttempts AS a WHERE a.WorkspaceId = w.Id AND a.Status IN ('queued', 'active'))
ORDER BY w.RetainUntil, w.Id;`;
const WS_BRANCHES_FOR_DELETION = `SELECT TOP (@limit) w.* FROM orc.Workspaces AS w
INNER JOIN orc.Tasks AS t ON t.Id = w.TaskId
WHERE w.Kind = 'attempt' AND w.Status = 'removed' AND w.BranchDeletedAt IS NULL AND w.BranchName IS NOT NULL
  AND t.Status IN ('completed', 'failed', 'timed_out', 'cancelled', 'blocked')
  AND t.FinishedAt < DATEADD(DAY, -@retentionDays, SYSUTCDATETIME())
ORDER BY t.FinishedAt, w.Id;`;
const WS_MARK_BRANCH_DELETED = `UPDATE orc.Workspaces SET BranchDeletedAt = SYSUTCDATETIME(), UpdatedAt = SYSUTCDATETIME()
WHERE Id = @id AND BranchDeletedAt IS NULL;`;

export function createWorkspaceRepository(ctx: RepoContext): WorkspaceRepository {
  return {
    async insert(w) {
      const { rows } = await run(ctx, WS_INSERT, [
        ['projectId', T.guid, w.projectId],
        ['taskId', T.guid, w.taskId],
        ['kind', T.varchar(8), w.kind],
        ['createdByAttemptId', T.guid, w.createdByAttemptId],
        ['path', T.nvarchar(400), w.path],
        ['branchName', T.nvarchar(200), w.branchName],
        ['baseSha', T.varchar(64), w.baseSha],
        ['workerId', T.nvarchar(128), w.workerId],
        ['quotaBytes', T.bigint, w.quotaBytes],
      ]);
      const row = first(rows);
      if (!row) throw new OrcError('internal_error', 'Workspaces insert returned no row');
      return mapWorkspace(row);
    },
    async findById(id) {
      const row = first((await run(ctx, WS_BY_ID, [['id', T.guid, id]])).rows);
      return row ? mapWorkspace(row) : null;
    },
    async findBase(projectId) {
      const row = first((await run(ctx, WS_BASE, [['projectId', T.guid, projectId]])).rows);
      return row ? mapWorkspace(row) : null;
    },
    async setStatus(id, status, patch) {
      const p = patch ?? {};
      const has = (k: keyof typeof p): boolean => Object.prototype.hasOwnProperty.call(p, k) && p[k] !== undefined;
      await run(ctx, WS_SET_STATUS, [
        ['id', T.guid, id],
        ['status', T.varchar(10), status],
        ['set_headSha', T.bit, has('headSha')],
        ['headSha', T.varchar(64), p.headSha ?? null],
        ['set_retainUntil', T.bit, has('retainUntil')],
        ['retainUntil', T.dt, p.retainUntil ?? null],
        ['set_errorDetail', T.bit, has('errorDetail')],
        ['errorDetail', T.nvarchar(2000), maskedText(ctx, p.errorDetail, 2000)],
      ]);
    },
    async recordSize(id, sizeBytes) {
      await run(ctx, WS_RECORD_SIZE, [
        ['id', T.guid, id],
        ['sizeBytes', T.bigint, sizeBytes],
      ]);
    },
    async findForCleanup(limit) {
      const { rows } = await run(ctx, WS_FOR_CLEANUP, [['limit', T.int, assertInt(limit, 'limit', 1, 10_000)]]);
      return rows.map(mapWorkspace);
    },
    async findBranchesForDeletion(retentionDays, limit) {
      const { rows } = await run(ctx, WS_BRANCHES_FOR_DELETION, [
        ['retentionDays', T.int, assertInt(retentionDays, 'retentionDays', 0, 36_500)],
        ['limit', T.int, assertInt(limit, 'limit', 1, 10_000)],
      ]);
      return rows.map(mapWorkspace);
    },
    async markBranchDeleted(id) {
      await run(ctx, WS_MARK_BRANCH_DELETED, [['id', T.guid, id]]);
    },
  };
}

// ---- changed files --------------------------------------------------------------------------------

export const CHANGED_FILE_ROWS_PER_STATEMENT = 100;

const CF_DELETE = 'DELETE FROM orc.ChangedFiles WHERE AttemptId = @attemptId;';
const CF_INSERT_BATCH = `INSERT INTO orc.ChangedFiles
  (AttemptId, TaskId, Path, OldPath, ChangeType, Similarity, Additions, Deletions, IsBinary, Patch, PatchBytes, PatchTruncated)
SELECT @attemptId, @taskId, j.Path, j.OldPath, j.ChangeType, j.Similarity, j.Additions, j.Deletions, j.IsBinary,
  j.Patch, j.PatchBytes, j.PatchTruncated
FROM OPENJSON(@rows) WITH (
  Ord INT '$.o',
  Path NVARCHAR(MAX) '$.p',
  OldPath NVARCHAR(MAX) '$.op',
  ChangeType VARCHAR(MAX) '$.ct',
  Similarity INT '$.si',
  Additions INT '$.ad',
  Deletions INT '$.de',
  IsBinary BIT '$.bi',
  Patch NVARCHAR(MAX) '$.pa',
  PatchBytes INT '$.pb',
  PatchTruncated BIT '$.pt'
) AS j
ORDER BY j.Ord;`;
const CF_LIST = `SELECT TOP (@limit) Id, AttemptId, TaskId, Path, OldPath, ChangeType, Similarity, Additions, Deletions,
  IsBinary, PatchBytes, PatchTruncated, PatchPurgedAt, CreatedAt
FROM orc.ChangedFiles
WHERE AttemptId = @attemptId AND (@afterId IS NULL OR Id > @afterId)
ORDER BY Id ASC
OPTION (RECOMPILE);`;
const CF_LIST_WITH_PATCH = `SELECT TOP (@limit) * FROM orc.ChangedFiles
WHERE AttemptId = @attemptId AND (@afterId IS NULL OR Id > @afterId)
ORDER BY Id ASC
OPTION (RECOMPILE);`;
const CF_PURGE = `UPDATE TOP (@batch) cf SET Patch = NULL, PatchPurgedAt = SYSUTCDATETIME()
FROM orc.ChangedFiles AS cf
INNER JOIN orc.Tasks AS t ON t.Id = cf.TaskId
WHERE cf.PatchPurgedAt IS NULL AND cf.Patch IS NOT NULL
  AND t.Status IN ('completed', 'failed', 'timed_out', 'cancelled', 'blocked')
  AND t.FinishedAt < @before;`;

function changedFileJson(f: NewChangedFile, ord: number): Record<string, unknown> {
  if (!(CHANGE_TYPES as readonly string[]).includes(f.changeType)) {
    throw new OrcError('validation_failed', `Invalid change type for ${f.path}`);
  }
  return {
    o: ord,
    p: f.path,
    op: f.oldPath,
    ct: f.changeType,
    si: f.similarity,
    ad: f.additions,
    de: f.deletions,
    bi: f.isBinary,
    pa: f.patch,
    pb: f.patchBytes,
    pt: f.patchTruncated,
  };
}

export function createChangedFileRepository(ctx: RepoContext): ChangedFileRepository {
  return {
    async replaceForAttempt(attemptId, taskId, files) {
      assertGuid(attemptId, 'attemptId');
      assertGuid(taskId, 'taskId');
      const payload = files.map(changedFileJson);
      await ctx.exec.atomic('changedFiles.replaceForAttempt', async (exec) => {
        const c: RepoContext = { ...ctx, exec };
        await run(c, CF_DELETE, [['attemptId', T.guid, attemptId]]);
        for (let start = 0; start < payload.length; start += CHANGED_FILE_ROWS_PER_STATEMENT) {
          const chunk = payload.slice(start, start + CHANGED_FILE_ROWS_PER_STATEMENT);
          await run(c, CF_INSERT_BATCH, [
            ['attemptId', T.guid, attemptId],
            ['taskId', T.guid, taskId],
            ['rows', T.nvarcharMax, JSON.stringify(chunk)],
          ]);
        }
      });
    },
    async listByAttempt(q) {
      const { rows } = await run(ctx, q.includePatch ? CF_LIST_WITH_PATCH : CF_LIST, [
        ['limit', T.int, assertInt(q.limit, 'limit', 1, 10_000)],
        ['attemptId', T.guid, q.attemptId],
        ['afterId', T.bigint, q.afterId === undefined ? null : assertBigId(q.afterId, 'afterId')],
      ]);
      return rows.map((r) => {
        const file = mapChangedFile(r);
        if (!q.includePatch) return file;
        const patch = r['Patch'];
        return { ...file, patch: typeof patch === 'string' ? patch : null };
      });
    },
    async purgePatchesOlderThan(before, batchSize) {
      const { rowsAffected } = await run(ctx, CF_PURGE, [
        ['before', T.dt, before],
        ['batch', T.int, assertInt(batchSize, 'batchSize', 1, 100_000)],
      ]);
      return rowsAffected;
    },
  };
}

// ---- attempt patches --------------------------------------------------------------------------------

const PATCH_UPSERT = `MERGE orc.AttemptPatches WITH (HOLDLOCK) AS target
USING (SELECT @attemptId AS AttemptId) AS src
ON target.AttemptId = src.AttemptId
WHEN MATCHED THEN UPDATE SET
  ByteLength = @byteLength, Sha256 = @sha256, ContentGzip = @content, TooLarge = @tooLarge, PurgedAt = NULL
WHEN NOT MATCHED THEN INSERT (AttemptId, ByteLength, Sha256, ContentGzip, TooLarge)
  VALUES (@attemptId, @byteLength, @sha256, @content, @tooLarge);`;
const PATCH_META = `SELECT ByteLength, Sha256, TooLarge, PurgedAt, CreatedAt FROM orc.AttemptPatches WHERE AttemptId = @attemptId;`;
const PATCH_CONTENT = `SELECT ContentGzip FROM orc.AttemptPatches
WHERE AttemptId = @attemptId AND TooLarge = 0 AND PurgedAt IS NULL;`;
const PATCH_PURGE = `UPDATE TOP (@batch) p SET ContentGzip = NULL, PurgedAt = SYSUTCDATETIME()
FROM orc.AttemptPatches AS p
INNER JOIN orc.TaskAttempts AS a ON a.Id = p.AttemptId
INNER JOIN orc.Tasks AS t ON t.Id = a.TaskId
WHERE p.PurgedAt IS NULL
  AND t.Status IN ('completed', 'failed', 'timed_out', 'cancelled', 'blocked')
  AND t.FinishedAt < @before;`;

export function createAttemptPatchRepository(ctx: RepoContext): AttemptPatchRepository {
  return {
    async upsert(p) {
      if (p.sha256.length !== 32) throw new OrcError('validation_failed', 'sha256 must be 32 bytes');
      if (p.tooLarge !== (p.content === null)) {
        throw new OrcError('validation_failed', 'content must be null exactly when tooLarge is true');
      }
      await run(ctx, PATCH_UPSERT, [
        ['attemptId', T.guid, p.attemptId],
        ['byteLength', T.bigint, p.byteLength],
        ['sha256', T.binary(32), p.sha256],
        ['content', T.varbinaryMax, p.content],
        ['tooLarge', T.bit, p.tooLarge],
      ]);
    },
    async getMeta(attemptId) {
      const row = first((await run(ctx, PATCH_META, [['attemptId', T.guid, attemptId]])).rows);
      if (!row) return null;
      return {
        byteLength: bigNum(row, 'ByteLength'),
        sha256: buf(row, 'Sha256').toString('hex'),
        tooLarge: bool(row, 'TooLarge'),
        purged: row['PurgedAt'] !== null && row['PurgedAt'] !== undefined,
        createdAt: iso(row, 'CreatedAt'),
      };
    },
    async getContent(attemptId) {
      const row = first((await run(ctx, PATCH_CONTENT, [['attemptId', T.guid, attemptId]])).rows);
      if (!row) return null;
      const content = row['ContentGzip'];
      return Buffer.isBuffer(content) ? content : null;
    },
    async purgeOlderThan(before, batchSize) {
      const { rowsAffected } = await run(ctx, PATCH_PURGE, [
        ['before', T.dt, before],
        ['batch', T.int, assertInt(batchSize, 'batchSize', 1, 100_000)],
      ]);
      return rowsAffected;
    },
  };
}
