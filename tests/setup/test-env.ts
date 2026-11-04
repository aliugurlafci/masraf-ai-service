// Test environment for the integration-style projects (contract §18.2). Values come from tests/.env.test only
// (never .env); keys missing there fall back to the TEST-ONLY defaults of docker-compose.test.yml, whose
// passwords may be overridden with ORC_TEST_SA_PASSWORD / ORC_TEST_REDIS_PASSWORD exactly like the compose file.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TEST_ENV_FILE = fileURLToPath(new URL('../.env.test', import.meta.url));

export const TEST_DB_NAME = 'orchestrator_test';
export const TEST_DB_PORT = '14331';
export const TEST_REDIS_PORT = '16380';
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * TEST-ONLY credentials for the loopback-bound throwaway containers of docker-compose.test.yml. Documented key by
 * key in tests/.env.test.example (kept identical by tests/unit/architecture/test-setup.test.ts).
 */
export function testEnvDefaults(
  processEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const migrator = 'OrcTest_Migrator_2026!';
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DB_HOST: '127.0.0.1',
    DB_PORT: TEST_DB_PORT,
    DB_NAME: TEST_DB_NAME,
    DB_USER: 'orc_migrator',
    DB_PASSWORD: migrator,
    DB_ENCRYPT: 'true',
    DB_TRUST_SERVER_CERTIFICATE: 'true',
    MSSQL_SA_PASSWORD: processEnv['ORC_TEST_SA_PASSWORD'] ?? 'OrcTestOnly_Sa_2026!',
    DB_MIGRATOR_PASSWORD: migrator,
    DB_API_PASSWORD: 'OrcTest_Api_Login_2026!',
    DB_WORKER_PASSWORD: 'OrcTest_Worker_Login_2026!',
    DB_BACKUP_PASSWORD: 'OrcTest_Backup_Login_2026!',
    CLAUDE_DEFAULT_MODEL: 'sonnet',
    PASSWORD_SCRYPT_N: '16384',
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: TEST_REDIS_PORT,
    REDIS_PASSWORD: processEnv['ORC_TEST_REDIS_PASSWORD'] ?? 'orc-test-only-redis-pw',
  };
}

/** Minimal dotenv parser: KEY=VALUE lines, `#` comments, optional single or double quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m?.[1]) continue;
    let value = m[2] ?? '';
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

/** The effective test environment (tests/.env.test over the compose defaults). */
export function loadTestEnv(processEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const fromFile = existsSync(TEST_ENV_FILE)
    ? parseEnvFile(readFileSync(TEST_ENV_FILE, 'utf8'))
    : {};
  return { ...testEnvDefaults(processEnv), ...fromFile };
}

/**
 * Global-setup guard (§18.2): refuse BEFORE connecting unless NODE_ENV=test, DB_NAME=orchestrator_test,
 * DB_PORT=14331, REDIS_PORT=16380 and both hosts are loopback addresses.
 */
export function assertTestInfraEnv(env: Readonly<Record<string, string | undefined>>): void {
  const problems: string[] = [];
  if (env['NODE_ENV'] !== 'test') problems.push('NODE_ENV must be "test"');
  if (env['DB_NAME'] !== TEST_DB_NAME) problems.push(`DB_NAME must be "${TEST_DB_NAME}"`);
  if (env['DB_PORT'] !== TEST_DB_PORT) problems.push(`DB_PORT must be ${TEST_DB_PORT}`);
  if (env['REDIS_PORT'] !== TEST_REDIS_PORT) problems.push(`REDIS_PORT must be ${TEST_REDIS_PORT}`);
  if (!LOOPBACK_HOSTS.has(env['DB_HOST'] ?? ''))
    problems.push('DB_HOST must be a loopback address');
  if (!LOOPBACK_HOSTS.has(env['REDIS_HOST'] ?? ''))
    problems.push('REDIS_HOST must be a loopback address');
  if (problems.length > 0) {
    throw new Error(`Refusing to touch test infrastructure: ${problems.join('; ')}`);
  }
}
