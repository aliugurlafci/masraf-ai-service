// Vitest globalSetup for the infrastructure projects (contract §18.2). Loads tests/.env.test only, refuses to
// run unless it targets the loopback test containers (checked BEFORE any connection), then drops and recreates
// orchestrator_test through the real `orc-db` commands: bootstrap (as sa), migrate and seed (as orc_migrator).
//
// Several vitest processes may run on one dev host against the same test server. A run would otherwise drop
// the database under another run's feet, so every run holds an exclusive, transaction-owned applock in master
// (on its own connection) from before the drop until its teardown; concurrent runs wait for each other. Within one
// run the infrastructure projects share a single preparation and lock (shared-run.ts).
import { Readable, Writable } from 'node:stream';
import sql from 'mssql';
import { buildPoolConfig } from '@orc/database';
import { runOrcDb } from '../../packages/database/src/cli/run';
import { sharedRun } from './shared-run';
import { TEST_DB_NAME, assertTestInfraEnv, loadTestEnv } from './test-env';

const DROP_DATABASE_SQL = `IF DB_ID(@db) IS NOT NULL
BEGIN
  DECLARE @sql NVARCHAR(MAX) = N'ALTER DATABASE ' + QUOTENAME(@db) + N' SET SINGLE_USER WITH ROLLBACK IMMEDIATE; '
    + N'DROP DATABASE ' + QUOTENAME(@db) + N';';
  IF @sql IS NULL THROW 50001, N'drop statement is NULL', 1;
  EXEC sys.sp_executesql @sql;
END;`;

const RUN_LOCK = 'orc_test_integration_run';
const SHARED_RUN_KEY = 'global-infra';
const RUN_LOCK_TIMEOUT_MS = 900_000;
const RUN_LOCK_SQL = `DECLARE @r INT;
EXEC @r = sys.sp_getapplock @Resource = @resource, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = @timeoutMs;
SELECT @r AS R;`;

type TestEnv = Readonly<Record<string, string>>;

class Capture extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
    this.text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    cb();
  }
}

function saPoolConfig(env: TestEnv): sql.config {
  return buildPoolConfig(
    {
      host: env['DB_HOST'] ?? '127.0.0.1',
      port: Number(env['DB_PORT']),
      database: 'master',
      user: 'sa',
      password: env['MSSQL_SA_PASSWORD'] ?? '',
      encrypt: env['DB_ENCRYPT'] === 'true',
      trustServerCertificate: env['DB_TRUST_SERVER_CERTIFICATE'] === 'true',
      caCert: null,
      poolMin: 0,
      poolMax: 1,
      connectTimeoutMs: 15_000,
      requestTimeoutMs: RUN_LOCK_TIMEOUT_MS + 60_000,
      appName: 'orc-test',
    },
    { poolMax: 1, poolMin: 0 },
  );
}

/** Acquires the run lock; the returned function releases it (ROLLBACK of the owning transaction) and closes the pool. */
async function acquireRunLock(env: TestEnv): Promise<() => Promise<void>> {
  const pool = new sql.ConnectionPool(saPoolConfig(env));
  await pool.connect();
  const tx = new sql.Transaction(pool);
  try {
    await tx.begin();
    const req = new sql.Request(tx);
    req.input('resource', sql.NVarChar(255), RUN_LOCK);
    req.input('timeoutMs', sql.Int, RUN_LOCK_TIMEOUT_MS);
    const result = await req.query<{ R: number }>(RUN_LOCK_SQL);
    const code = result.recordset[0]?.R;
    if (typeof code !== 'number' || code < 0) {
      throw new Error(`integration run lock not acquired within ${RUN_LOCK_TIMEOUT_MS} ms (sp_getapplock ${String(code)})`);
    }
  } catch (err) {
    await pool.close();
    throw err;
  }
  return async () => {
    try {
      await tx.rollback();
    } finally {
      await pool.close();
    }
  };
}

async function dropTestDatabase(env: TestEnv): Promise<void> {
  const db = env['DB_NAME'];
  if (db !== TEST_DB_NAME || !db.endsWith('_test')) throw new Error('refusing to drop a non-test database');
  const pool = new sql.ConnectionPool(saPoolConfig(env));
  await pool.connect();
  try {
    const req = new sql.Request(pool);
    req.input('db', sql.NVarChar(128), db);
    await req.query(DROP_DATABASE_SQL);
  } finally {
    await pool.close();
  }
}

async function orcDb(command: string, env: TestEnv): Promise<void> {
  const stdout = new Capture();
  const stderr = new Capture();
  const code = await runOrcDb([command], { env, stdin: Readable.from([]), stdout, stderr });
  if (code !== 0) throw new Error(`orc-db ${command} failed with exit code ${code}: ${stderr.text.trim()}`);
}

async function prepareTestInfra(): Promise<() => Promise<void>> {
  const env = loadTestEnv();
  assertTestInfraEnv(env);
  const release = await acquireRunLock(env);
  try {
    await dropTestDatabase(env);
    await orcDb('bootstrap', env);
    await orcDb('migrate', env);
    await orcDb('seed', env);
  } catch (err) {
    await release();
    throw err;
  }
  return release;
}

/**
 * globalSetup entry. integration/api/security/e2e/claude-live all register this file; the drop/recreate and the
 * applock happen once per vitest process and are released when the last of those projects tears down.
 */
export default function setup(): Promise<() => Promise<void>> {
  return sharedRun(SHARED_RUN_KEY, prepareTestInfra);
}
