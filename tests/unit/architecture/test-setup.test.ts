// Unit tests for the integration-style test infrastructure setup (contract §18.2) that need no infrastructure:
// the test environment defaults and guard, their agreement with docker-compose.test.yml and
// tests/.env.test.example, and the per-process sharing of the global setup. Nothing connects anywhere.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sharedRun, sharedRunUsers } from '../../setup/shared-run';
import {
  TEST_ENV_FILE,
  assertTestInfraEnv,
  loadTestEnv,
  parseEnvFile,
  testEnvDefaults,
} from '../../setup/test-env';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ENV_EXAMPLE = join(ROOT, 'tests/.env.test.example');
const COMPOSE_TEST = join(ROOT, 'docker-compose.test.yml');

/** `${NAME:-default}` defaults of docker-compose.test.yml. */
function composeDefaults(): Map<string, string> {
  const text = readFileSync(COMPOSE_TEST, 'utf8');
  return new Map([...text.matchAll(/\$\{([A-Z0-9_]+):-([^}]*)\}/g)].map((m) => [m[1] ?? '', m[2] ?? '']));
}

describe('test environment (tests/setup/test-env.ts)', () => {
  it('defaults pass the infrastructure guard without any tests/.env.test', () => {
    const env = testEnvDefaults({});
    expect(() => assertTestInfraEnv(env)).not.toThrow();
    expect(env).toMatchObject({
      NODE_ENV: 'test',
      DB_HOST: '127.0.0.1',
      DB_PORT: '14331',
      DB_NAME: 'orchestrator_test',
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: '16380',
    });
  });

  it('loadTestEnv works whether or not tests/.env.test exists and always passes the guard', () => {
    const env = loadTestEnv({});
    expect(() => assertTestInfraEnv(env)).not.toThrow();
    if (!existsSync(TEST_ENV_FILE)) expect(env).toEqual(testEnvDefaults({}));
  });

  it('default passwords follow docker-compose.test.yml and its ORC_TEST_* overrides', () => {
    const compose = composeDefaults();
    const env = testEnvDefaults({});
    expect(env.MSSQL_SA_PASSWORD).toBe(compose.get('ORC_TEST_SA_PASSWORD'));
    expect(env.REDIS_PASSWORD).toBe(compose.get('ORC_TEST_REDIS_PASSWORD'));
    const overridden = testEnvDefaults({ ORC_TEST_SA_PASSWORD: 'sa-x', ORC_TEST_REDIS_PASSWORD: 'redis-x' });
    expect(overridden.MSSQL_SA_PASSWORD).toBe('sa-x');
    expect(overridden.REDIS_PASSWORD).toBe('redis-x');
  });

  it.each([
    ['NODE_ENV', 'production', /NODE_ENV must be "test"/],
    ['DB_NAME', 'orchestrator', /DB_NAME must be "orchestrator_test"/],
    ['DB_PORT', '1433', /DB_PORT must be 14331/],
    ['REDIS_PORT', '6379', /REDIS_PORT must be 16380/],
    ['DB_HOST', 'db.example.com', /DB_HOST must be a loopback address/],
    ['REDIS_HOST', '10.0.0.5', /REDIS_HOST must be a loopback address/],
  ])('the guard refuses %s=%s before connecting', (key, value, message) => {
    expect(() => assertTestInfraEnv({ ...testEnvDefaults({}), [key]: value })).toThrow(message);
  });

  it('parses dotenv lines, comments, export prefixes and quotes', () => {
    expect(
      parseEnvFile('# c\n\nA=1\r\nexport B = two\nC="q u"\nD=\'s\'\nE=\nnot a line\n'),
    ).toEqual({ A: '1', B: 'two', C: 'q u', D: 's', E: '' });
  });

  it.skipIf(!existsSync(ENV_EXAMPLE))(
    'tests/.env.test.example documents exactly the test-only defaults',
    () => {
      expect(parseEnvFile(readFileSync(ENV_EXAMPLE, 'utf8'))).toEqual(testEnvDefaults({}));
    },
  );
});

describe('sharedRun (one global-infra preparation per vitest process)', () => {
  it('prepares once for concurrent projects and releases after the last one', async () => {
    const key = `unit-shared-${process.pid}-a`;
    let prepared = 0;
    let released = 0;
    const prepare = async (): Promise<() => Promise<void>> => {
      prepared += 1;
      await Promise.resolve();
      return () => {
        released += 1;
        return Promise.resolve();
      };
    };
    const [first, second] = await Promise.all([sharedRun(key, prepare), sharedRun(key, prepare)]);
    const third = await sharedRun(key, prepare);
    expect(prepared).toBe(1);
    expect(sharedRunUsers(key)).toBe(3);
    await first();
    await first();
    await third();
    expect(released).toBe(0);
    await second();
    expect(released).toBe(1);
    expect(sharedRunUsers(key)).toBe(0);

    const again = await sharedRun(key, prepare);
    expect(prepared).toBe(2);
    await again();
    expect(released).toBe(2);
  });

  it('does not cache a failed preparation', async () => {
    const key = `unit-shared-${process.pid}-b`;
    let attempts = 0;
    const failing = (): Promise<() => Promise<void>> => {
      attempts += 1;
      return Promise.reject(new Error('infra down'));
    };
    const results = await Promise.allSettled([sharedRun(key, failing), sharedRun(key, failing)]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(attempts).toBe(1);
    expect(sharedRunUsers(key)).toBe(0);
    await expect(sharedRun(key, failing)).rejects.toThrow('infra down');
    expect(attempts).toBe(2);
  });
});
