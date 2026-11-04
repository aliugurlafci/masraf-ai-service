// Connection settings for the MSSQL test container (contract §18.2). Behaviour tests connect as orc_api /
// orc_worker; orc_migrator is used only by helpers (setup, cleanup, catalogue fixtures); sa only by global setup.
import { createLogger } from '@orc/logger';
import type { Logger } from '@orc/logger';
import type { DatabaseConfig } from '@orc/database';
import { assertTestInfraEnv, loadTestEnv } from '../../setup/test-env';

export type TestLogin = 'orc_api' | 'orc_worker' | 'orc_migrator' | 'orc_backup';

const PASSWORD_KEYS: Readonly<Record<TestLogin, string>> = {
  orc_api: 'DB_API_PASSWORD',
  orc_worker: 'DB_WORKER_PASSWORD',
  orc_migrator: 'DB_MIGRATOR_PASSWORD',
  orc_backup: 'DB_BACKUP_PASSWORD',
};

let cached: Record<string, string> | undefined;

/** The guarded test environment (throws unless it points at the loopback test containers). */
export function testEnv(): Readonly<Record<string, string>> {
  if (!cached) {
    const env = loadTestEnv();
    assertTestInfraEnv(env);
    cached = env;
  }
  return cached;
}

function envValue(key: string): string {
  const value = testEnv()[key];
  if (value === undefined || value === '') throw new Error(`Test environment is missing ${key}`);
  return value;
}

/** DatabaseConfig for `login` against orchestrator_test (appName 'orc-test' => the DB-name guard enforces _test). */
export function testDbConfig(login: TestLogin, overrides: Partial<DatabaseConfig> = {}): DatabaseConfig {
  return {
    host: envValue('DB_HOST'),
    port: Number(envValue('DB_PORT')),
    database: envValue('DB_NAME'),
    user: login,
    password: envValue(PASSWORD_KEYS[login]),
    encrypt: envValue('DB_ENCRYPT') === 'true',
    trustServerCertificate: envValue('DB_TRUST_SERVER_CERTIFICATE') === 'true',
    caCert: null,
    poolMin: 0,
    poolMax: 5,
    connectTimeoutMs: 15_000,
    requestTimeoutMs: 30_000,
    appName: 'orc-test',
    ...overrides,
  };
}

/** sa settings (global setup and cleanup of server-level state only). */
export function saConfig(database = 'master'): DatabaseConfig {
  return { ...testDbConfig('orc_migrator'), user: 'sa', password: envValue('MSSQL_SA_PASSWORD'), database };
}

export function silentLogger(): Logger {
  return createLogger({ service: 'test', level: 'silent', version: 'test', env: 'test' });
}
