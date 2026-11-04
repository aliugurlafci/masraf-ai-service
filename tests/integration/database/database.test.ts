// createDatabase: TLS connection with the app logins, ping, schemaVersion (readiness), unavailable server.
import { afterAll, describe, expect, it } from 'vitest';
import { EXPECTED_SCHEMA_VERSION } from '@orc/database';
import { openDb, resetDb } from '../../helpers/database/db';

describe('createDatabase', () => {
  afterAll(resetDb);

  it.each(['orc_api', 'orc_worker'] as const)('%s connects (encrypt=true), pings and reports the schema version', async (login) => {
    const db = await openDb(login);
    try {
      await db.ping();
      expect(await db.schemaVersion()).toBeGreaterThanOrEqual(EXPECTED_SCHEMA_VERSION);
      // sys.dm_exec_connections needs VIEW SERVER STATE, which the app logins (correctly) lack.
      const result = await db.pool.request().query<{ Login: string }>('SELECT SUSER_SNAME() AS Login;');
      expect(result.recordset[0]?.Login).toBe(login);
    } finally {
      await db.close();
    }
  });

  it('maps an unreachable server to db_unavailable', async () => {
    await expect(openDb('orc_api', { port: 1, connectTimeoutMs: 1000 })).rejects.toMatchObject({ code: 'db_unavailable' });
  });

  it('maps a wrong password to db_unavailable without leaking it', async () => {
    const err = await openDb('orc_api', { password: 'Definitely-Wrong-Password-1' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'db_unavailable' });
    expect(String((err as Error).message)).not.toContain('Definitely-Wrong-Password-1');
  });
});
