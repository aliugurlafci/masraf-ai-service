-- 0002_roles_and_grants: database roles and the object-level GRANT matrix of contract section 4.3.
-- No schema-wide grants, no EXECUTE grants. Logins and database users are created by `orc-db bootstrap`.
--
-- Deviation from contract section 4.3: `DENY CONTROL ON SCHEMA::orc` is NOT issued. A DENY of CONTROL also
-- denies every permission CONTROL implies (SELECT, INSERT, UPDATE, DELETE on all objects of the schema),
-- which would revoke the whole matrix below (verified on SQL Server 2022: error 229). ALTER, REFERENCES,
-- TAKE OWNERSHIP and VIEW DEFINITION remain denied; DDL is impossible because neither role holds any DDL
-- permission (CREATE TABLE requires database-level CREATE TABLE plus ALTER on the schema, which is denied).

IF DATABASE_PRINCIPAL_ID(N'orc_api_role') IS NULL CREATE ROLE orc_api_role AUTHORIZATION dbo;
GO
IF DATABASE_PRINCIPAL_ID(N'orc_worker_role') IS NULL CREATE ROLE orc_worker_role AUTHORIZATION dbo;
GO

-- ---- orc_api_role --------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON orc.Users TO orc_api_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON orc.AuthSessions TO orc_api_role;
GRANT SELECT, INSERT, UPDATE ON orc.ApiTokens TO orc_api_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON orc.IdempotencyKeys TO orc_api_role;
GRANT SELECT, INSERT, UPDATE ON orc.Projects TO orc_api_role;
GRANT SELECT, INSERT, UPDATE ON orc.Agents TO orc_api_role;
GRANT SELECT, INSERT, UPDATE ON orc.Teams TO orc_api_role;
GRANT SELECT, INSERT, UPDATE ON orc.Tasks TO orc_api_role;
GRANT SELECT, INSERT, UPDATE ON orc.TaskAttempts TO orc_api_role;
GRANT SELECT ON orc.TaskLogs TO orc_api_role;
GRANT SELECT, INSERT ON orc.TaskEvents TO orc_api_role;
GRANT SELECT ON orc.ClaudeSessions TO orc_api_role;
GRANT SELECT ON orc.Workspaces TO orc_api_role;
GRANT SELECT ON orc.ChangedFiles TO orc_api_role;
GRANT SELECT ON orc.AttemptPatches TO orc_api_role;
GRANT SELECT ON orc.TestRuns TO orc_api_role;
GRANT SELECT ON orc.TestResults TO orc_api_role;
GRANT SELECT ON orc.GitOperations TO orc_api_role;
GRANT SELECT, INSERT, UPDATE ON orc.McpIndexOperations TO orc_api_role;
GRANT SELECT, INSERT ON orc.AuditLogs TO orc_api_role;
GRANT SELECT ON orc.WorkerNodes TO orc_api_role;
GRANT SELECT ON orc.SchemaMigrations TO orc_api_role;
GO

-- ---- orc_worker_role -----------------------------------------------------------------------------
GRANT SELECT ON orc.Projects TO orc_worker_role;
GRANT UPDATE (Status, StatusDetail, DefaultBranch, HeadSha, LastSyncedAt, LastIndexedAt, LastIndexOperationId, UpdatedAt) ON orc.Projects TO orc_worker_role;
GRANT SELECT ON orc.Agents TO orc_worker_role;
GRANT SELECT ON orc.Teams TO orc_worker_role;
GRANT SELECT ON orc.Tasks TO orc_worker_role;
GRANT UPDATE (Status, StatusReason, StatusDetail, CurrentAttemptId, AttemptCount, AutoRecoveryCount, QueuedAt, StartedAt, FinishedAt, UpdatedAt) ON orc.Tasks TO orc_worker_role;
GRANT SELECT, INSERT, UPDATE ON orc.TaskAttempts TO orc_worker_role;
GRANT SELECT, INSERT, DELETE ON orc.TaskLogs TO orc_worker_role;
GRANT SELECT, INSERT ON orc.TaskEvents TO orc_worker_role;
GRANT SELECT, INSERT, UPDATE ON orc.ClaudeSessions TO orc_worker_role;
GRANT SELECT, INSERT, UPDATE ON orc.Workspaces TO orc_worker_role;
GRANT SELECT, INSERT, DELETE ON orc.ChangedFiles TO orc_worker_role;
GRANT UPDATE (Patch, PatchPurgedAt) ON orc.ChangedFiles TO orc_worker_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON orc.AttemptPatches TO orc_worker_role;
GRANT SELECT, INSERT, UPDATE ON orc.TestRuns TO orc_worker_role;
GRANT SELECT, INSERT ON orc.TestResults TO orc_worker_role;
GRANT SELECT, INSERT, DELETE ON orc.GitOperations TO orc_worker_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON orc.McpIndexOperations TO orc_worker_role;
GRANT INSERT ON orc.AuditLogs TO orc_worker_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON orc.WorkerNodes TO orc_worker_role;
GRANT SELECT ON orc.SchemaMigrations TO orc_worker_role;
GO

-- ---- explicit denials ----------------------------------------------------------------------------
DENY UPDATE, DELETE ON orc.AuditLogs TO orc_api_role, orc_worker_role;
DENY ALTER, REFERENCES, TAKE OWNERSHIP, VIEW DEFINITION ON SCHEMA::orc TO orc_api_role, orc_worker_role;
GO

-- ---- memberships (bootstrap creates the users; it also adds memberships when it runs after this file) ----
IF DATABASE_PRINCIPAL_ID(N'orc_api') IS NOT NULL AND IS_ROLEMEMBER(N'orc_api_role', N'orc_api') = 0
  ALTER ROLE orc_api_role ADD MEMBER orc_api;
GO
IF DATABASE_PRINCIPAL_ID(N'orc_worker') IS NOT NULL AND IS_ROLEMEMBER(N'orc_worker_role', N'orc_worker') = 0
  ALTER ROLE orc_worker_role ADD MEMBER orc_worker;
GO
