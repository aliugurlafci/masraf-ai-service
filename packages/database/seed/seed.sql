-- seed.sql: idempotent catalogue seed (contract section 4.4). Run by `orc-db seed` as orc_migrator.
-- MERGE on Teams.Name and Agents.Name; never deletes rows. Admin-tunable agent settings (model, tools,
-- instructions, active flag) are only set on insert. @DefaultModel is bound by the CLI (CLAUDE_DEFAULT_MODEL).
-- One batch, no GO separators (the CLI sends it as a single parameterized batch inside one transaction).
SET XACT_ABORT ON;

DECLARE @Teams TABLE (
  Name NVARCHAR(100) NOT NULL PRIMARY KEY,
  Description NVARCHAR(2000) NOT NULL,
  OwnedPathsJson NVARCHAR(MAX) NOT NULL,
  ManagerName NVARCHAR(100) NOT NULL
);
INSERT INTO @Teams (Name, Description, OwnedPathsJson, ManagerName) VALUES
  (N'Program Management', N'Requirements analysis, cross-team coordination, dependency and token budget control, quality gates and final acceptance.', N'[]', N'General Project Manager'),
  (N'Architecture', N'System architecture, service boundaries, task state machine, data flows, ADRs, failure recovery and deployment topology.', N'["docs/architecture","docs/adr","packages/shared"]', N'Solution Architecture Manager'),
  (N'Backend and API', N'Express API, Zod validation, project/task/agent/session APIs, SSE, authentication, authorization, rate limiting, idempotency and Problem Details.', N'["apps/api","packages/task-manager","packages/project-manager"]', N'Backend Manager'),
  (N'Worker and Claude Runner', N'BullMQ workers, Claude Code process management, timeouts, cancellation, graceful shutdown, retries, dead-lettering, heartbeat and recovery.', N'["apps/worker","apps/runner","packages/claude-runner","packages/orchestrator","packages/sandbox"]', N'Worker Platform Manager'),
  (N'MSSQL and Data', N'SQL Server connectivity, migrations, transactions, repositories, pooling, deadlock retry, optimistic concurrency, audit, retention and backup.', N'["packages/database"]', N'Database Manager'),
  (N'Git and Workspace', N'Repository validation, task branches, worktrees, diffs, commit information, conflict detection, quotas and workspace path safety.', N'["packages/git-manager"]', N'Source Control Manager'),
  (N'MCP and Code Intelligence', N'codebase-memory-mcp connectivity, repository indexing, index state, impact analysis and indexing error reporting.', N'["packages/mcp-manager"]', N'Code Intelligence Manager'),
  (N'Web UI', N'React and Vite application: dashboard, projects, task creation, live Claude output, diffs, test results, index status and task actions.', N'["apps/web"]', N'Frontend Manager'),
  (N'Security', N'Threat model, RBAC, prompt limits, injection and path traversal prevention, workspace isolation, secrets, masking, egress and audit.', N'["packages/security","docs/security","tests/security"]', N'Security Manager'),
  (N'Test and Quality', N'Unit, integration, API, security and end-to-end tests, test infrastructure and test reports; standard tests never run the real Claude CLI.', N'["tests/*","vitest.config.ts","tests/e2e","tests/api","tests/claude-live"]', N'QA Manager'),
  (N'DevOps and Operations', N'Dockerfiles, Compose, local MSSQL and Redis, health and readiness checks, resource limits, logging, backup/restore and runbooks.', N'["docker/","docker-compose*.yml","scripts/","docs/operations","apps/egress-proxy","packages/logger"]', N'Platform Manager');

MERGE orc.Teams WITH (HOLDLOCK) AS target
USING @Teams AS src
ON target.Name = src.Name
WHEN MATCHED AND (ISNULL(target.Description, N'') <> src.Description OR target.OwnedPathsJson <> src.OwnedPathsJson) THEN
  UPDATE SET Description = src.Description, OwnedPathsJson = src.OwnedPathsJson, UpdatedAt = SYSUTCDATETIME()
WHEN NOT MATCHED BY TARGET THEN
  INSERT (Name, Description, OwnedPathsJson) VALUES (src.Name, src.Description, src.OwnedPathsJson);

DECLARE @Agents TABLE (
  Name NVARCHAR(100) NOT NULL PRIMARY KEY,
  TeamName NVARCHAR(100) NOT NULL,
  Title NVARCHAR(100) NOT NULL,
  Description NVARCHAR(2000) NOT NULL,
  IsRoot BIT NOT NULL
);
INSERT INTO @Agents (Name, TeamName, Title, Description, IsRoot)
SELECT t.ManagerName, t.Name,
  CASE WHEN t.Name = N'Program Management' THEN N'General Project Manager' ELSE N'Team Manager' END,
  t.Description,
  CASE WHEN t.Name = N'Program Management' THEN 1 ELSE 0 END
FROM @Teams AS t;

-- The General Project Manager (root of the hierarchy).
MERGE orc.Agents WITH (HOLDLOCK) AS target
USING (
  SELECT a.Name, tm.Id AS TeamId, a.Title, a.Description
  FROM @Agents AS a INNER JOIN orc.Teams AS tm ON tm.Name = a.TeamName
  WHERE a.IsRoot = 1
) AS src
ON target.Name = src.Name
WHEN MATCHED AND (target.TeamId <> src.TeamId OR target.IsManager <> 1 OR target.ParentAgentId IS NOT NULL) THEN
  UPDATE SET TeamId = src.TeamId, IsManager = 1, ParentAgentId = NULL, UpdatedAt = SYSUTCDATETIME()
WHEN NOT MATCHED BY TARGET THEN
  INSERT (TeamId, ParentAgentId, Name, Title, Description, IsManager, Model, Effort, AllowedToolsJson, DisallowedToolsJson,
          Instructions, MaxTimeoutSeconds, MaxBudgetUsd, IsActive)
  VALUES (src.TeamId, NULL, src.Name, src.Title, src.Description, 1, @DefaultModel, NULL,
          N'["Read","Edit","Write","Glob","Grep"]', N'[]', NULL, 3600, NULL, 1);

DECLARE @GpmId UNIQUEIDENTIFIER = (SELECT Id FROM orc.Agents WHERE Name = N'General Project Manager');
IF @GpmId IS NULL THROW 50010, N'seed: General Project Manager agent missing', 1;

-- The ten team managers report to the General Project Manager.
MERGE orc.Agents WITH (HOLDLOCK) AS target
USING (
  SELECT a.Name, tm.Id AS TeamId, a.Title, a.Description
  FROM @Agents AS a INNER JOIN orc.Teams AS tm ON tm.Name = a.TeamName
  WHERE a.IsRoot = 0
) AS src
ON target.Name = src.Name
WHEN MATCHED AND (target.TeamId <> src.TeamId OR target.IsManager <> 1
                  OR target.ParentAgentId IS NULL OR target.ParentAgentId <> @GpmId) THEN
  UPDATE SET TeamId = src.TeamId, IsManager = 1, ParentAgentId = @GpmId, UpdatedAt = SYSUTCDATETIME()
WHEN NOT MATCHED BY TARGET THEN
  INSERT (TeamId, ParentAgentId, Name, Title, Description, IsManager, Model, Effort, AllowedToolsJson, DisallowedToolsJson,
          Instructions, MaxTimeoutSeconds, MaxBudgetUsd, IsActive)
  VALUES (src.TeamId, @GpmId, src.Name, src.Title, src.Description, 1, @DefaultModel, NULL,
          N'["Read","Edit","Write","Glob","Grep"]', N'[]', NULL, 3600, NULL, 1);

-- Teams.ManagerAgentId points at each team's manager.
UPDATE tm SET ManagerAgentId = ag.Id, UpdatedAt = SYSUTCDATETIME()
FROM orc.Teams AS tm
INNER JOIN @Teams AS s ON s.Name = tm.Name
INNER JOIN orc.Agents AS ag ON ag.Name = s.ManagerName
WHERE tm.ManagerAgentId IS NULL OR tm.ManagerAgentId <> ag.Id;

SELECT
  (SELECT COUNT(*) FROM orc.Teams AS tm INNER JOIN @Teams AS s ON s.Name = tm.Name) AS Teams,
  (SELECT COUNT(*) FROM orc.Agents AS ag INNER JOIN @Agents AS s ON s.Name = ag.Name) AS Agents;
