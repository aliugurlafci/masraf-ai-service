// Row counts of orchestrator_test for the test leak guard (B-005). Report only: nothing here (and nothing in the
// guard, also with ORC_TEST_REAP=1) ever deletes a row; global-infra.ts recreates the database on the next run.
// The connection is refused BEFORE connecting unless the environment targets the loopback test containers
// (assertTestInfraEnv) and the database is orchestrator_test (name ends with _test). One constant statement.
import sql from 'mssql';
import { buildPoolConfig } from '@orc/database';
import { z } from 'zod';
import { TEST_DB_NAME, assertTestInfraEnv, loadTestEnv } from './test-env';

/** Every table of the orc schema, migration history included (leak-detection.test.ts compares it with sys.tables). */
export const COUNTED_TABLES = [
  'Agents',
  'ApiTokens',
  'AttemptPatches',
  'AuditLogs',
  'AuthSessions',
  'ChangedFiles',
  'ClaudeSessions',
  'GitOperations',
  'IdempotencyKeys',
  'McpIndexOperations',
  'Projects',
  'SchemaMigrations',
  'TaskAttempts',
  'TaskEvents',
  'TaskLogs',
  'Tasks',
  'Teams',
  'TestResults',
  'TestRuns',
  'Users',
  'WorkerNodes',
  'Workspaces',
] as const;

export type CountedTable = (typeof COUNTED_TABLES)[number];

const COUNT_SQL = `SELECT N'Agents' AS TableName, COUNT(*) AS TableRows FROM orc.Agents
UNION ALL SELECT N'ApiTokens', COUNT(*) FROM orc.ApiTokens
UNION ALL SELECT N'AttemptPatches', COUNT(*) FROM orc.AttemptPatches
UNION ALL SELECT N'AuditLogs', COUNT(*) FROM orc.AuditLogs
UNION ALL SELECT N'AuthSessions', COUNT(*) FROM orc.AuthSessions
UNION ALL SELECT N'ChangedFiles', COUNT(*) FROM orc.ChangedFiles
UNION ALL SELECT N'ClaudeSessions', COUNT(*) FROM orc.ClaudeSessions
UNION ALL SELECT N'GitOperations', COUNT(*) FROM orc.GitOperations
UNION ALL SELECT N'IdempotencyKeys', COUNT(*) FROM orc.IdempotencyKeys
UNION ALL SELECT N'McpIndexOperations', COUNT(*) FROM orc.McpIndexOperations
UNION ALL SELECT N'Projects', COUNT(*) FROM orc.Projects
UNION ALL SELECT N'SchemaMigrations', COUNT(*) FROM orc.SchemaMigrations
UNION ALL SELECT N'TaskAttempts', COUNT(*) FROM orc.TaskAttempts
UNION ALL SELECT N'TaskEvents', COUNT(*) FROM orc.TaskEvents
UNION ALL SELECT N'TaskLogs', COUNT(*) FROM orc.TaskLogs
UNION ALL SELECT N'Tasks', COUNT(*) FROM orc.Tasks
UNION ALL SELECT N'Teams', COUNT(*) FROM orc.Teams
UNION ALL SELECT N'TestResults', COUNT(*) FROM orc.TestResults
UNION ALL SELECT N'TestRuns', COUNT(*) FROM orc.TestRuns
UNION ALL SELECT N'Users', COUNT(*) FROM orc.Users
UNION ALL SELECT N'WorkerNodes', COUNT(*) FROM orc.WorkerNodes
UNION ALL SELECT N'Workspaces', COUNT(*) FROM orc.Workspaces;`;

const CountRowsSchema = z
  .array(z.object({ TableName: z.enum(COUNTED_TABLES), TableRows: z.number().int().nonnegative() }))
  .length(COUNTED_TABLES.length);

export interface DbTableCount {
  readonly table: CountedTable;
  readonly rows: number;
}

export type DbScan =
  | { readonly ok: true; readonly counts: readonly DbTableCount[] }
  | { readonly ok: false; readonly reason: string };

type TestEnv = Readonly<Record<string, string | undefined>>;

/** Refuses anything but the loopback test containers and a database whose name ends with `_test`. */
export function assertCountableDatabase(env: TestEnv): string {
  assertTestInfraEnv(env);
  const database = env['DB_NAME'] ?? '';
  if (database !== TEST_DB_NAME || !database.endsWith('_test')) {
    throw new Error('refusing to inspect a database whose name does not end with _test');
  }
  return database;
}

/** Row count of every orc table as orc_migrator. Never throws: failures come back as { ok: false }. */
export async function countTestDbRows(env: TestEnv = loadTestEnv()): Promise<DbScan> {
  try {
    const database = assertCountableDatabase(env);
    const pool = new sql.ConnectionPool(
      buildPoolConfig(
        {
          host: env['DB_HOST'] ?? '',
          port: Number(env['DB_PORT']),
          database,
          user: 'orc_migrator',
          password: env['DB_MIGRATOR_PASSWORD'] ?? '',
          encrypt: env['DB_ENCRYPT'] === 'true',
          trustServerCertificate: env['DB_TRUST_SERVER_CERTIFICATE'] === 'true',
          caCert: null,
          poolMin: 0,
          poolMax: 1,
          connectTimeoutMs: 15_000,
          requestTimeoutMs: 30_000,
          appName: 'orc-test',
        },
        { poolMax: 1, poolMin: 0 },
      ),
    );
    await pool.connect();
    try {
      const result = await new sql.Request(pool).query<unknown>(COUNT_SQL);
      const rows = CountRowsSchema.parse(result.recordset);
      return { ok: true, counts: rows.map((r) => ({ table: r.TableName, rows: r.TableRows })) };
    } finally {
      await pool.close();
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
