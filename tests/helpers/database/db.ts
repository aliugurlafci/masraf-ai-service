// Database handles and cleanup for integration tests (contract §18.2). resetDb() runs as orc_migrator and
// removes every non-seed row in FK order, then verifies that only the seeded baseline is left.
import sql from 'mssql';
import { buildPoolConfig, createDatabase } from '@orc/database';
import type { Database, DatabaseConfig } from '@orc/database';
import { createSecretRegistry } from '@orc/security';
import { silentLogger, testDbConfig } from './env';
import type { TestLogin } from './env';

/** The 11 teams and 11 manager agents of packages/database/seed/seed.sql (CLAUDE.md organisation). */
export const SEED_TEAMS = [
  ['Program Management', 'General Project Manager'],
  ['Architecture', 'Solution Architecture Manager'],
  ['Backend and API', 'Backend Manager'],
  ['Worker and Claude Runner', 'Worker Platform Manager'],
  ['MSSQL and Data', 'Database Manager'],
  ['Git and Workspace', 'Source Control Manager'],
  ['MCP and Code Intelligence', 'Code Intelligence Manager'],
  ['Web UI', 'Frontend Manager'],
  ['Security', 'Security Manager'],
  ['Test and Quality', 'QA Manager'],
  ['DevOps and Operations', 'Platform Manager'],
] as const;
export const SEED_TEAM_NAMES: readonly string[] = SEED_TEAMS.map(([team]) => team);
export const SEED_AGENT_NAMES: readonly string[] = SEED_TEAMS.map(([, agent]) => agent);

/** Opens an @orc/database handle as `login` (never sa). Close it in afterAll. */
export function openDb(login: TestLogin, overrides: Partial<DatabaseConfig> = {}): Promise<Database> {
  return createDatabase(testDbConfig(login, overrides), { logger: silentLogger(), secrets: createSecretRegistry() }, { nodeEnv: 'test' });
}

/** A raw mssql pool as `login` (for grant probes and helper SQL). */
export async function openPool(login: TestLogin, max = 2): Promise<sql.ConnectionPool> {
  const pool = new sql.ConnectionPool(buildPoolConfig(testDbConfig(login), { poolMax: max, poolMin: 0 }));
  await pool.connect();
  return pool;
}

export type SqlInput = readonly [name: string, type: sql.ISqlType | (() => sql.ISqlType), value: unknown];

/** Runs one constant, parameterized statement and returns the first recordset. */
export async function query<R = Record<string, unknown>>(
  pool: sql.ConnectionPool | sql.Transaction,
  text: string,
  inputs: readonly SqlInput[] = [],
): Promise<R[]> {
  const req = new sql.Request(pool as sql.ConnectionPool);
  for (const [name, type, value] of inputs) req.input(name, type, value);
  const result = await req.query<R>(text);
  return result.recordset ?? [];
}

const RESET_SQL = `SET XACT_ABORT ON;
BEGIN TRAN;
DELETE FROM orc.TestResults;
DELETE FROM orc.TestRuns;
DELETE FROM orc.ChangedFiles;
DELETE FROM orc.AttemptPatches;
DELETE FROM orc.ClaudeSessions;
DELETE FROM orc.TaskLogs;
DELETE FROM orc.TaskEvents;
DELETE FROM orc.GitOperations;
DELETE FROM orc.McpIndexOperations;
UPDATE orc.Tasks SET CurrentAttemptId = NULL WHERE CurrentAttemptId IS NOT NULL;
UPDATE orc.Workspaces SET CreatedByAttemptId = NULL WHERE CreatedByAttemptId IS NOT NULL;
UPDATE orc.TaskAttempts SET PreviousAttemptId = NULL, WorkspaceId = NULL
  WHERE PreviousAttemptId IS NOT NULL OR WorkspaceId IS NOT NULL;
DELETE FROM orc.TaskAttempts;
DELETE FROM orc.Workspaces;
DELETE FROM orc.Tasks;
DELETE FROM orc.Projects;
DELETE FROM orc.IdempotencyKeys;
DELETE FROM orc.AuthSessions;
DELETE FROM orc.ApiTokens;
DELETE FROM orc.AuditLogs;
DELETE FROM orc.WorkerNodes;
DELETE FROM orc.Users;
UPDATE orc.Teams SET ManagerAgentId = NULL
  WHERE ManagerAgentId IS NOT NULL AND Name NOT IN (SELECT [value] FROM OPENJSON(@seedTeams));
UPDATE orc.Agents SET ParentAgentId = NULL
  WHERE ParentAgentId IS NOT NULL AND Name NOT IN (SELECT [value] FROM OPENJSON(@seedAgents));
DELETE FROM orc.Agents WHERE Name NOT IN (SELECT [value] FROM OPENJSON(@seedAgents));
DELETE FROM orc.Teams WHERE Name NOT IN (SELECT [value] FROM OPENJSON(@seedTeams));
COMMIT;`;

export const BASELINE_COUNT_SQL = `SELECT
  (SELECT COUNT(*) FROM orc.Users) + (SELECT COUNT(*) FROM orc.AuthSessions) + (SELECT COUNT(*) FROM orc.ApiTokens)
  + (SELECT COUNT(*) FROM orc.IdempotencyKeys) + (SELECT COUNT(*) FROM orc.Projects) + (SELECT COUNT(*) FROM orc.Tasks)
  + (SELECT COUNT(*) FROM orc.TaskAttempts) + (SELECT COUNT(*) FROM orc.TaskLogs) + (SELECT COUNT(*) FROM orc.TaskEvents)
  + (SELECT COUNT(*) FROM orc.ClaudeSessions) + (SELECT COUNT(*) FROM orc.Workspaces) + (SELECT COUNT(*) FROM orc.ChangedFiles)
  + (SELECT COUNT(*) FROM orc.AttemptPatches) + (SELECT COUNT(*) FROM orc.TestRuns) + (SELECT COUNT(*) FROM orc.TestResults)
  + (SELECT COUNT(*) FROM orc.GitOperations) + (SELECT COUNT(*) FROM orc.McpIndexOperations) + (SELECT COUNT(*) FROM orc.AuditLogs)
  + (SELECT COUNT(*) FROM orc.WorkerNodes) AS NonSeedRows,
  (SELECT COUNT(*) FROM orc.Teams) AS Teams,
  (SELECT COUNT(*) FROM orc.Agents) AS Agents;`;

export interface BaselineCounts {
  NonSeedRows: number;
  Teams: number;
  Agents: number;
}

export async function baselineCounts(pool: sql.ConnectionPool): Promise<BaselineCounts> {
  const [row] = await query<BaselineCounts>(pool, BASELINE_COUNT_SQL);
  if (!row) throw new Error('baseline count query returned no row');
  return row;
}

/**
 * Deletes every non-seed row (as orc_migrator) and asserts the seeded baseline: no rows outside Teams/Agents,
 * exactly the seeded teams and agents. Call in afterAll of every DB test file.
 */
export async function resetDb(): Promise<void> {
  const pool = await openPool('orc_migrator', 1);
  try {
    await query(pool, RESET_SQL, [
      ['seedTeams', sql.NVarChar(sql.MAX), JSON.stringify(SEED_TEAM_NAMES)],
      ['seedAgents', sql.NVarChar(sql.MAX), JSON.stringify(SEED_AGENT_NAMES)],
    ]);
    const counts = await baselineCounts(pool);
    if (counts.NonSeedRows !== 0 || counts.Teams !== SEED_TEAMS.length || counts.Agents !== SEED_TEAMS.length) {
      throw new Error(`resetDb left rows beyond the seeded baseline: ${JSON.stringify(counts)}`);
    }
  } finally {
    await pool.close();
  }
}
