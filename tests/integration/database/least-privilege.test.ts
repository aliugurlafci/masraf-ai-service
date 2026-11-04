// §4.2/§4.3: logins, role memberships and the object-level GRANT matrix, probed with the real logins (never sa).
import sql from 'mssql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPool, query, resetDb } from '../../helpers/database/db';

// 229/230 object, 262 statement, 3701/3704 drop ("does not exist or you do not have permission"), 1088 truncate.
const PERMISSION_DENIED = new Set([229, 230, 262, 300, 1088, 2760, 3701, 3704, 15151, 15247]);

async function sqlErrorNumber(promise: Promise<unknown>): Promise<number | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    const n = (err as { number?: unknown }).number;
    return typeof n === 'number' ? n : -1;
  }
}

async function expectDenied(pool: sql.ConnectionPool, text: string): Promise<void> {
  const n = await sqlErrorNumber(query(pool, text));
  expect(n === null ? `allowed: ${text}` : PERMISSION_DENIED.has(n) ? 'denied' : `error ${n}: ${text}`).toBe('denied');
}

async function expectAllowed(pool: sql.ConnectionPool, text: string): Promise<void> {
  // Probes run inside a rolled-back transaction so they leave no rows behind.
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx).query(text);
  } finally {
    await tx.rollback();
  }
}

describe('least privilege', () => {
  let api: sql.ConnectionPool;
  let worker: sql.ConnectionPool;
  let backup: sql.ConnectionPool;
  let migrator: sql.ConnectionPool;

  beforeAll(async () => {
    [api, worker, backup, migrator] = await Promise.all([
      openPool('orc_api'),
      openPool('orc_worker'),
      openPool('orc_backup'),
      openPool('orc_migrator'),
    ]);
  });

  afterAll(async () => {
    await Promise.all([api.close(), worker.close(), backup.close(), migrator.close()]);
    await resetDb();
  });

  it('connections use the dedicated logins without elevated roles', async () => {
    for (const [pool, login, role, isOwner] of [
      [api, 'orc_api', 'orc_api_role', 0],
      [worker, 'orc_worker', 'orc_worker_role', 0],
      [migrator, 'orc_migrator', 'db_owner', 1],
    ] as const) {
      const [row] = await query<{ Login: string; Sys: number; Owner: number; InRole: number }>(
        pool,
        `SELECT SUSER_SNAME() AS Login, IS_SRVROLEMEMBER('sysadmin') AS Sys, IS_ROLEMEMBER('db_owner') AS Owner,
                IS_ROLEMEMBER(@role) AS InRole;`,
        [['role', sql.NVarChar(128), role]],
      );
      expect(row).toEqual({ Login: login, Sys: 0, Owner: isOwner, InRole: 1 });
    }
    const [b] = await query<{ Login: string; BackupOp: number; Sys: number }>(
      backup,
      "SELECT SUSER_SNAME() AS Login, IS_ROLEMEMBER('db_backupoperator') AS BackupOp, IS_SRVROLEMEMBER('sysadmin') AS Sys;",
    );
    expect(b).toEqual({ Login: 'orc_backup', BackupOp: 1, Sys: 0 });
  });

  it('bootstrap enabled READ_COMMITTED_SNAPSHOT', async () => {
    const [row] = await query<{ Rcsi: boolean }>(
      migrator,
      'SELECT is_read_committed_snapshot_on AS Rcsi FROM sys.databases WHERE name = DB_NAME();',
    );
    expect(row?.Rcsi).toBe(true);
  });

  it.each([
    ['CREATE TABLE', 'CREATE TABLE orc.Evil (Id INT);'],
    ['CREATE TABLE in dbo', 'CREATE TABLE dbo.Evil (Id INT);'],
    ['ALTER TABLE', 'ALTER TABLE orc.Tasks ADD Evil INT NULL;'],
    ['DROP TABLE', 'DROP TABLE orc.TaskLogs;'],
    ['TRUNCATE', 'TRUNCATE TABLE orc.TaskLogs;'],
    ['CREATE VIEW', "EXEC(N'CREATE VIEW orc.EvilView AS SELECT 1 AS X');"],
    ['UPDATE AuditLogs', "UPDATE orc.AuditLogs SET Action = 'x.y' WHERE Id = -1;"],
    ['DELETE AuditLogs', 'DELETE FROM orc.AuditLogs WHERE Id = -1;'],
  ])('orc_api and orc_worker cannot %s', async (_label, text) => {
    await expectDenied(api, text);
    await expectDenied(worker, text);
  });

  it.each([
    ['Users', 'SELECT TOP (1) * FROM orc.Users;'],
    ['AuthSessions', 'SELECT TOP (1) * FROM orc.AuthSessions;'],
    ['ApiTokens', 'SELECT TOP (1) * FROM orc.ApiTokens;'],
    ['IdempotencyKeys', 'SELECT TOP (1) * FROM orc.IdempotencyKeys;'],
    ['AuditLogs', 'SELECT TOP (1) * FROM orc.AuditLogs;'],
  ])('orc_worker cannot read orc.%s', async (_table, text) => {
    await expectDenied(worker, text);
  });

  it('orc_worker may update only the granted Tasks/Projects columns', async () => {
    await expectAllowed(worker, "UPDATE orc.Tasks SET Status = Status, StatusReason = NULL, UpdatedAt = SYSUTCDATETIME() WHERE Id = NEWID();");
    await expectDenied(worker, "UPDATE orc.Tasks SET Prompt = N'x' WHERE Id = NEWID();");
    await expectDenied(worker, 'UPDATE orc.Tasks SET CancelRequestedAt = NULL WHERE Id = NEWID();');
    await expectAllowed(worker, "UPDATE orc.Projects SET Status = Status, HeadSha = NULL WHERE Id = NEWID();");
    await expectDenied(worker, "UPDATE orc.Projects SET RepoPath = N'x' WHERE Id = NEWID();");
    await expectDenied(worker, 'INSERT INTO orc.Tasks (ProjectId) VALUES (NEWID());');
    await expectDenied(worker, 'DELETE FROM orc.Tasks WHERE Id = NEWID();');
    await expectDenied(worker, "UPDATE orc.Agents SET Model = N'x' WHERE Id = NEWID();");
    await expectAllowed(worker, "UPDATE orc.ChangedFiles SET Patch = NULL, PatchPurgedAt = SYSUTCDATETIME() WHERE Id = -1;");
    await expectDenied(worker, "UPDATE orc.ChangedFiles SET Path = N'x' WHERE Id = -1;");
  });

  it('orc_api is read-only on worker-owned tables', async () => {
    await expectDenied(api, 'DELETE FROM orc.TaskLogs WHERE Id = -1;');
    await expectDenied(api, 'UPDATE orc.ClaudeSessions SET Status = Status WHERE AttemptId = NEWID();');
    await expectDenied(api, "DELETE FROM orc.WorkerNodes WHERE Id = N'x';");
    await expectDenied(api, 'UPDATE orc.Workspaces SET Status = Status WHERE Id = NEWID();');
    await expectDenied(api, 'DELETE FROM orc.Users WHERE Id = NEWID();');
    await expectAllowed(api, 'DELETE FROM orc.AuthSessions WHERE Id = NEWID();');
    await expectAllowed(api, "UPDATE orc.Tasks SET CancelRequestedAt = NULL WHERE Id = NEWID();");
  });

  it('neither app role can change SchemaMigrations or see object definitions', async () => {
    for (const pool of [api, worker]) {
      await expectDenied(pool, 'DELETE FROM orc.SchemaMigrations WHERE Version = -1;');
      const [row] = await query<{ Def: string | null }>(pool, "SELECT OBJECT_DEFINITION(OBJECT_ID(N'orc.Tasks')) AS Def;");
      expect(row?.Def ?? null).toBeNull();
      const [v] = await query<{ V: number }>(pool, 'SELECT MAX(Version) AS V FROM orc.SchemaMigrations;');
      expect(v?.V).toBe(2);
    }
  });

  it('orc_backup cannot read application data', async () => {
    await expectDenied(backup, 'SELECT TOP (1) * FROM orc.Tasks;');
    await expectDenied(backup, 'SELECT TOP (1) * FROM orc.Users;');
  });
});
