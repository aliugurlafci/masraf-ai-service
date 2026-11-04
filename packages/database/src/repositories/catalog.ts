// Projects, Agents, Teams (contract §2.5).
import { OrcError } from '@orc/shared';
import { T, first, isGuid, keysetParams, pageTake, patchParams, run } from '../sql.js';
import type { RepoContext } from '../sql.js';
import { rowVerToBuffer } from '../rowver.js';
import type { AgentRepository, ProjectRepository, TeamRepository } from '../types.js';
import { throwCasMiss } from './common.js';
import { mapAgent, mapProject, mapTeam } from './mappers.js';

const jsonOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));
const jsonArray = (v: unknown): string => JSON.stringify(v ?? []);

// ---- projects ---------------------------------------------------------------------------------

const PROJECT_BY_ID = 'SELECT * FROM orc.Projects WHERE Id = @id;';
const PROJECT_EXISTS = 'SELECT 1 AS X FROM orc.Projects WHERE Id = @id;';
const PROJECT_LIST = `SELECT TOP (@take) * FROM orc.Projects
WHERE (@status IS NULL OR Status = @status)
  AND (@afterCreatedAt IS NULL OR CreatedAt < @afterCreatedAt OR (CreatedAt = @afterCreatedAt AND Id < @afterId))
ORDER BY CreatedAt DESC, Id DESC
OPTION (RECOMPILE);`;
const PROJECT_INSERT = `INSERT INTO orc.Projects
  (Name, Description, RepoPath, DefaultBranch, Status, TestCommandJson, TestTimeoutSeconds, JUnitReportPath,
   RequireIndex, AutoIndex, IndexMode, DefaultAgentId, DefaultTimeoutSeconds, WorkspaceMaxBytes, CreatedByUserId)
OUTPUT inserted.*
VALUES
  (@name, @description, @repoPath, @defaultBranch, 'validating', @testCommand, @testTimeoutSeconds, @junitReportPath,
   @requireIndex, @autoIndex, @indexMode, @defaultAgentId, @defaultTimeoutSeconds, @workspaceMaxBytes, @createdByUserId);`;
const PROJECT_UPDATE = `UPDATE orc.Projects SET
  Name = CASE WHEN @set_name = 1 THEN @name ELSE Name END,
  Description = CASE WHEN @set_description = 1 THEN @description ELSE Description END,
  DefaultBranch = CASE WHEN @set_defaultBranch = 1 THEN @defaultBranch ELSE DefaultBranch END,
  TestCommandJson = CASE WHEN @set_testCommand = 1 THEN @testCommand ELSE TestCommandJson END,
  TestTimeoutSeconds = CASE WHEN @set_testTimeoutSeconds = 1 THEN @testTimeoutSeconds ELSE TestTimeoutSeconds END,
  JUnitReportPath = CASE WHEN @set_junitReportPath = 1 THEN @junitReportPath ELSE JUnitReportPath END,
  RequireIndex = CASE WHEN @set_requireIndex = 1 THEN @requireIndex ELSE RequireIndex END,
  AutoIndex = CASE WHEN @set_autoIndex = 1 THEN @autoIndex ELSE AutoIndex END,
  IndexMode = CASE WHEN @set_indexMode = 1 THEN @indexMode ELSE IndexMode END,
  DefaultAgentId = CASE WHEN @set_defaultAgentId = 1 THEN @defaultAgentId ELSE DefaultAgentId END,
  DefaultTimeoutSeconds = CASE WHEN @set_defaultTimeoutSeconds = 1 THEN @defaultTimeoutSeconds ELSE DefaultTimeoutSeconds END,
  WorkspaceMaxBytes = CASE WHEN @set_workspaceMaxBytes = 1 THEN @workspaceMaxBytes ELSE WorkspaceMaxBytes END,
  Status = CASE
    WHEN @set_archived = 1 AND @archived = 1 THEN 'archived'
    WHEN @set_archived = 1 AND @archived = 0 AND Status = 'archived' THEN 'validating'
    ELSE Status END,
  StatusDetail = CASE
    WHEN @set_archived = 1 AND @archived = 0 AND Status = 'archived' THEN NULL
    ELSE StatusDetail END,
  ArchivedAt = CASE
    WHEN @set_archived = 1 AND @archived = 1 THEN COALESCE(ArchivedAt, SYSUTCDATETIME())
    WHEN @set_archived = 1 AND @archived = 0 THEN NULL
    ELSE ArchivedAt END,
  UpdatedAt = SYSUTCDATETIME()
OUTPUT inserted.*
WHERE Id = @id AND RowVer = @rowVer;`;
const PROJECT_SYNC_STATE = `UPDATE orc.Projects SET
  Status = @status,
  StatusDetail = @statusDetail,
  DefaultBranch = CASE WHEN @set_defaultBranch = 1 THEN @defaultBranch ELSE DefaultBranch END,
  HeadSha = CASE WHEN @set_headSha = 1 THEN @headSha ELSE HeadSha END,
  LastSyncedAt = CASE WHEN @synced = 1 THEN SYSUTCDATETIME() ELSE LastSyncedAt END,
  UpdatedAt = SYSUTCDATETIME()
WHERE Id = @id AND Status <> 'archived';`;
const PROJECT_INDEX_STATE = `UPDATE orc.Projects SET
  LastIndexOperationId = @lastIndexOperationId,
  LastIndexedAt = CASE WHEN @indexedAt = 1 THEN SYSUTCDATETIME() ELSE LastIndexedAt END,
  UpdatedAt = SYSUTCDATETIME()
WHERE Id = @id;`;

export function createProjectRepository(ctx: RepoContext): ProjectRepository {
  return {
    async findById(id) {
      if (!isGuid(id)) return null;
      const row = first((await run(ctx, PROJECT_BY_ID, [['id', T.guid, id]])).rows);
      return row ? mapProject(row) : null;
    },
    async list(o) {
      const { rows } = await run(ctx, PROJECT_LIST, [
        ['take', T.int, pageTake(o.limit)],
        ['status', T.varchar(16), o.status ?? null],
        ...keysetParams(o.after, 'guid'),
      ]);
      return rows.map(mapProject);
    },
    async insert(p) {
      const { rows } = await run(ctx, PROJECT_INSERT, [
        ['name', T.nvarchar(100), p.name],
        ['description', T.nvarchar(2000), p.description],
        ['repoPath', T.nvarchar(255), p.repoPath],
        ['defaultBranch', T.nvarchar(200), p.defaultBranch],
        ['testCommand', T.nvarcharMax, jsonOrNull(p.testCommand)],
        ['testTimeoutSeconds', T.int, p.testTimeoutSeconds],
        ['junitReportPath', T.nvarchar(400), p.junitReportPath],
        ['requireIndex', T.bit, p.requireIndex],
        ['autoIndex', T.bit, p.autoIndex],
        ['indexMode', T.varchar(16), p.indexMode],
        ['defaultAgentId', T.guid, p.defaultAgentId],
        ['defaultTimeoutSeconds', T.int, p.defaultTimeoutSeconds],
        ['workspaceMaxBytes', T.bigint, p.workspaceMaxBytes],
        ['createdByUserId', T.guid, p.createdByUserId],
      ]);
      const row = first(rows);
      if (!row) throw new OrcError('internal_error', 'Projects insert returned no row');
      return mapProject(row);
    },
    async update(id, expectedRowVer, patch) {
      const { rows } = await run(ctx, PROJECT_UPDATE, [
        ['id', T.guid, id],
        ['rowVer', T.binary(8), rowVerToBuffer(expectedRowVer)],
        ...patchParams(patch, [
          ['name', T.nvarchar(100)],
          ['description', T.nvarchar(2000)],
          ['defaultBranch', T.nvarchar(200)],
          ['testCommand', T.nvarcharMax, jsonOrNull],
          ['testTimeoutSeconds', T.int],
          ['junitReportPath', T.nvarchar(400)],
          ['requireIndex', T.bit],
          ['autoIndex', T.bit],
          ['indexMode', T.varchar(16)],
          ['defaultAgentId', T.guid],
          ['defaultTimeoutSeconds', T.int],
          ['workspaceMaxBytes', T.bigint],
          ['archived', T.bit],
        ]),
      ]);
      const row = first(rows);
      if (row) return mapProject(row);
      return throwCasMiss(ctx, PROJECT_EXISTS, id, 'Project');
    },
    async updateSyncState(id, s) {
      if (s.status === 'archived') {
        throw new OrcError('validation_failed', 'Sync state cannot archive a project');
      }
      await run(ctx, PROJECT_SYNC_STATE, [
        ['id', T.guid, id],
        ['status', T.varchar(16), s.status],
        ['statusDetail', T.nvarchar(2000), s.statusDetail],
        ['synced', T.bit, s.synced],
        ...patchParams(s, [
          ['defaultBranch', T.nvarchar(200)],
          ['headSha', T.varchar(64)],
        ]),
      ]);
    },
    async updateIndexState(id, s) {
      await run(ctx, PROJECT_INDEX_STATE, [
        ['id', T.guid, id],
        ['lastIndexOperationId', T.guid, s.lastIndexOperationId],
        ['indexedAt', T.bit, s.indexedAt],
      ]);
    },
  };
}

// ---- agents -------------------------------------------------------------------------------------

const AGENT_BY_ID = 'SELECT * FROM orc.Agents WHERE Id = @id;';
const AGENT_EXISTS = 'SELECT 1 AS X FROM orc.Agents WHERE Id = @id;';
const AGENT_LIST = `SELECT * FROM orc.Agents
WHERE (@teamId IS NULL OR TeamId = @teamId) AND (@activeOnly = 0 OR IsActive = 1)
ORDER BY Name, Id
OPTION (RECOMPILE);`;
const AGENT_INSERT = `INSERT INTO orc.Agents
  (TeamId, ParentAgentId, Name, Title, Description, IsManager, Model, Effort, AllowedToolsJson, DisallowedToolsJson,
   Instructions, MaxTimeoutSeconds, MaxBudgetUsd, IsActive)
OUTPUT inserted.*
VALUES
  (@teamId, @parentAgentId, @name, @title, @description, @isManager, @model, @effort, @allowedTools, @disallowedTools,
   @instructions, @maxTimeoutSeconds, @maxBudgetUsd, @isActive);`;
const AGENT_UPDATE = `UPDATE orc.Agents SET
  TeamId = CASE WHEN @set_teamId = 1 THEN @teamId ELSE TeamId END,
  ParentAgentId = CASE WHEN @set_parentAgentId = 1 THEN @parentAgentId ELSE ParentAgentId END,
  Name = CASE WHEN @set_name = 1 THEN @name ELSE Name END,
  Title = CASE WHEN @set_title = 1 THEN @title ELSE Title END,
  Description = CASE WHEN @set_description = 1 THEN @description ELSE Description END,
  IsManager = CASE WHEN @set_isManager = 1 THEN @isManager ELSE IsManager END,
  Model = CASE WHEN @set_model = 1 THEN @model ELSE Model END,
  Effort = CASE WHEN @set_effort = 1 THEN @effort ELSE Effort END,
  AllowedToolsJson = CASE WHEN @set_allowedTools = 1 THEN @allowedTools ELSE AllowedToolsJson END,
  DisallowedToolsJson = CASE WHEN @set_disallowedTools = 1 THEN @disallowedTools ELSE DisallowedToolsJson END,
  Instructions = CASE WHEN @set_instructions = 1 THEN @instructions ELSE Instructions END,
  MaxTimeoutSeconds = CASE WHEN @set_maxTimeoutSeconds = 1 THEN @maxTimeoutSeconds ELSE MaxTimeoutSeconds END,
  MaxBudgetUsd = CASE WHEN @set_maxBudgetUsd = 1 THEN @maxBudgetUsd ELSE MaxBudgetUsd END,
  IsActive = CASE WHEN @set_isActive = 1 THEN @isActive ELSE IsActive END,
  UpdatedAt = SYSUTCDATETIME()
OUTPUT inserted.*
WHERE Id = @id AND RowVer = @rowVer;`;

export function createAgentRepository(ctx: RepoContext): AgentRepository {
  return {
    async findById(id) {
      if (!isGuid(id)) return null;
      const row = first((await run(ctx, AGENT_BY_ID, [['id', T.guid, id]])).rows);
      return row ? mapAgent(row) : null;
    },
    async list(f) {
      const { rows } = await run(ctx, AGENT_LIST, [
        ['teamId', T.guid, f.teamId ?? null],
        ['activeOnly', T.bit, f.activeOnly === true],
      ]);
      return rows.map(mapAgent);
    },
    async insert(a) {
      const { rows } = await run(ctx, AGENT_INSERT, [
        ['teamId', T.guid, a.teamId],
        ['parentAgentId', T.guid, a.parentAgentId],
        ['name', T.nvarchar(100), a.name],
        ['title', T.nvarchar(100), a.title],
        ['description', T.nvarchar(2000), a.description],
        ['isManager', T.bit, a.isManager],
        ['model', T.nvarchar(100), a.model],
        ['effort', T.varchar(8), a.effort],
        ['allowedTools', T.nvarcharMax, jsonArray(a.allowedTools)],
        ['disallowedTools', T.nvarcharMax, jsonArray(a.disallowedTools)],
        ['instructions', T.nvarchar(4000), a.instructions],
        ['maxTimeoutSeconds', T.int, a.maxTimeoutSeconds],
        ['maxBudgetUsd', T.money, a.maxBudgetUsd],
        ['isActive', T.bit, a.isActive],
      ]);
      const row = first(rows);
      if (!row) throw new OrcError('internal_error', 'Agents insert returned no row');
      return mapAgent(row);
    },
    async update(id, expectedRowVer, patch) {
      const { rows } = await run(ctx, AGENT_UPDATE, [
        ['id', T.guid, id],
        ['rowVer', T.binary(8), rowVerToBuffer(expectedRowVer)],
        ...patchParams(patch, [
          ['teamId', T.guid],
          ['parentAgentId', T.guid],
          ['name', T.nvarchar(100)],
          ['title', T.nvarchar(100)],
          ['description', T.nvarchar(2000)],
          ['isManager', T.bit],
          ['model', T.nvarchar(100)],
          ['effort', T.varchar(8)],
          ['allowedTools', T.nvarcharMax, jsonArray],
          ['disallowedTools', T.nvarcharMax, jsonArray],
          ['instructions', T.nvarchar(4000)],
          ['maxTimeoutSeconds', T.int],
          ['maxBudgetUsd', T.money],
          ['isActive', T.bit],
        ]),
      ]);
      const row = first(rows);
      if (row) return mapAgent(row);
      return throwCasMiss(ctx, AGENT_EXISTS, id, 'Agent');
    },
  };
}

// ---- teams --------------------------------------------------------------------------------------

const TEAM_BY_ID = 'SELECT * FROM orc.Teams WHERE Id = @id;';
const TEAM_EXISTS = 'SELECT 1 AS X FROM orc.Teams WHERE Id = @id;';
const TEAM_LIST = 'SELECT * FROM orc.Teams ORDER BY Name, Id;';
const TEAM_INSERT = `INSERT INTO orc.Teams (Name, Description, ManagerAgentId, OwnedPathsJson)
OUTPUT inserted.*
VALUES (@name, @description, @managerAgentId, @ownedPaths);`;
const TEAM_UPDATE = `UPDATE orc.Teams SET
  Name = CASE WHEN @set_name = 1 THEN @name ELSE Name END,
  Description = CASE WHEN @set_description = 1 THEN @description ELSE Description END,
  ManagerAgentId = CASE WHEN @set_managerAgentId = 1 THEN @managerAgentId ELSE ManagerAgentId END,
  OwnedPathsJson = CASE WHEN @set_ownedPaths = 1 THEN @ownedPaths ELSE OwnedPathsJson END,
  UpdatedAt = SYSUTCDATETIME()
OUTPUT inserted.*
WHERE Id = @id AND RowVer = @rowVer;`;

export function createTeamRepository(ctx: RepoContext): TeamRepository {
  return {
    async findById(id) {
      if (!isGuid(id)) return null;
      const row = first((await run(ctx, TEAM_BY_ID, [['id', T.guid, id]])).rows);
      return row ? mapTeam(row) : null;
    },
    async list() {
      return (await run(ctx, TEAM_LIST)).rows.map(mapTeam);
    },
    async insert(t) {
      const { rows } = await run(ctx, TEAM_INSERT, [
        ['name', T.nvarchar(100), t.name],
        ['description', T.nvarchar(2000), t.description],
        ['managerAgentId', T.guid, t.managerAgentId],
        ['ownedPaths', T.nvarcharMax, jsonArray(t.ownedPaths)],
      ]);
      const row = first(rows);
      if (!row) throw new OrcError('internal_error', 'Teams insert returned no row');
      return mapTeam(row);
    },
    async update(id, expectedRowVer, patch) {
      const { rows } = await run(ctx, TEAM_UPDATE, [
        ['id', T.guid, id],
        ['rowVer', T.binary(8), rowVerToBuffer(expectedRowVer)],
        ...patchParams(patch, [
          ['name', T.nvarchar(100)],
          ['description', T.nvarchar(2000)],
          ['managerAgentId', T.guid],
          ['ownedPaths', T.nvarcharMax, jsonArray],
        ]),
      ]);
      const row = first(rows);
      if (row) return mapTeam(row);
      return throwCasMiss(ctx, TEAM_EXISTS, id, 'Team');
    },
  };
}
