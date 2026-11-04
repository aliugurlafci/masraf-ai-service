// Requirements §15 "production and test DB separated" and "MSSQL least privilege" (contract §4.2,
// §18.5, ADR-0030). The full GRANT matrix is the integration gate
// tests/integration/database/least-privilege.test.ts; this file re-checks its existence and coverage
// and probes the essentials with the real service logins.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type sql from 'mssql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDbNameForEnv } from '@orc/shared/node';
import { apiTestConfig } from '../helpers/api/harness';
import { openPool, query } from '../helpers/database/db';
import { testEnv } from '../helpers/database/env';
import { assertTestInfraEnv, loadTestEnv, TEST_DB_NAME } from '../setup/test-env';
import { REPO_ROOT } from '../helpers/security/deployment';

describe('database name guard (config load)', () => {
  it.each([
    ['test', 'orchestrator', false],
    ['test', 'orchestrator_test', true],
    ['test', 'ORCHESTRATOR_TEST', true],
    ['production', 'orchestrator_test', false],
    ['development', 'orc_TEST', false],
    ['production', 'orchestrator', true],
    ['test', ' ', false],
  ] as const)('NODE_ENV=%s DB_NAME=%j => allowed %s', (env, name, ok) => {
    if (ok) expect(() => assertDbNameForEnv(env, name)).not.toThrow();
    else expect(() => assertDbNameForEnv(env, name)).toThrow();
  });

  it('the API config loader refuses a production database name under NODE_ENV=test', () => {
    // A complete, otherwise valid test configuration (the API harness's), only DB_NAME differs.
    expect(() => apiTestConfig('orc-sec-guard', { DB_NAME: TEST_DB_NAME })).not.toThrow();
    expect(() => apiTestConfig('orc-sec-guard', { DB_NAME: 'orchestrator' })).toThrow(/_test/);
    expect(() => apiTestConfig('orc-sec-guard', { DB_NAME: 'orchestrator_prod' })).toThrow(/_test/);
  });

  it('the test infrastructure guard only accepts the loopback test containers', () => {
    const good = loadTestEnv();
    expect(() => assertTestInfraEnv(good)).not.toThrow();
    for (const bad of [
      { DB_NAME: 'orchestrator' },
      { DB_HOST: 'mssql' },
      { DB_HOST: '10.0.0.5' },
      { DB_PORT: '1433' },
      { NODE_ENV: 'production' },
      { REDIS_HOST: 'redis' },
    ]) {
      expect(() => assertTestInfraEnv({ ...good, ...bad }), JSON.stringify(bad)).toThrow();
    }
  });
});

describe('least-privilege logins (live, test server)', () => {
  let api: sql.ConnectionPool;
  let worker: sql.ConnectionPool;

  beforeAll(async () => {
    api = await openPool('orc_api', 1);
    worker = await openPool('orc_worker', 1);
  });

  afterAll(async () => {
    await api?.close();
    await worker?.close();
  });

  it('connects to the _test database only', async () => {
    expect(testEnv()['DB_NAME']).toBe(TEST_DB_NAME);
    const [row] = await query<{ Db: string }>(api, 'SELECT DB_NAME() AS Db;');
    expect(row?.Db).toBe(TEST_DB_NAME);
  });

  it.each([['orc_api'], ['orc_worker']] as const)('%s is neither sysadmin nor db_owner and cannot run DDL', async (login) => {
    const pool = login === 'orc_api' ? api : worker;
    const [row] = await query<{ Sa: number; Owner: number; Ddl: number }>(
      pool,
      `SELECT IS_SRVROLEMEMBER('sysadmin') AS Sa, IS_ROLEMEMBER('db_owner') AS Owner, IS_ROLEMEMBER('db_ddladmin') AS Ddl;`,
    );
    expect(row).toEqual({ Sa: 0, Owner: 0, Ddl: 0 });
    await expect(query(pool, 'CREATE TABLE orc.SecProbe (Id INT);')).rejects.toThrow(/permission|denied/i);
  });

  it('the worker login cannot read users, sessions or tokens', async () => {
    for (const table of ['Users', 'AuthSessions', 'ApiTokens']) {
      await expect(query(worker, `SELECT TOP (1) * FROM orc.${table};`), table).rejects.toThrow(/permission|denied/i);
    }
  });

  it('the full GRANT matrix gate exists and covers the §15 assertions', () => {
    const gate = readFileSync(path.join(REPO_ROOT, 'tests', 'integration', 'database', 'least-privilege.test.ts'), 'utf8');
    for (const needle of ["IS_SRVROLEMEMBER('sysadmin')", 'db_owner', 'AuditLogs', 'orc_worker', 'orc_api']) {
      expect(gate, needle).toContain(needle);
    }
  });
});
