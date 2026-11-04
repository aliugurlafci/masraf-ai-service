import { describe, expect, it } from 'vitest';
import { createLogger } from '@orc/logger';
import {
  assertDatabaseGuard,
  buildPoolConfig,
  createDatabase,
  etagToRowVer,
  rowVerToEtag,
  validateDatabaseConfig,
} from '@orc/database';
import type { DatabaseConfig } from '@orc/database';
import { rowVerFromBuffer, rowVerToBuffer } from '../../../packages/database/src/rowver';
import { assertTestInfraEnv } from '../../setup/test-env';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ==\n-----END CERTIFICATE-----\n';

function config(o: Partial<DatabaseConfig> = {}): DatabaseConfig {
  return {
    host: '127.0.0.1',
    port: 1,
    database: 'orchestrator',
    user: 'orc_api',
    password: 'a-password-value-123',
    encrypt: true,
    trustServerCertificate: false,
    caCert: null,
    poolMin: 0,
    poolMax: 10,
    connectTimeoutMs: 15000,
    requestTimeoutMs: 30000,
    appName: 'orc-api',
    ...o,
  };
}

const logger = createLogger({ service: 'test', level: 'silent', version: 'test', env: 'test' });

describe('validateDatabaseConfig', () => {
  it('accepts a valid config', () => {
    expect(validateDatabaseConfig(config())).toEqual(config());
  });

  it.each([
    ['empty host', { host: '' }],
    ['port 0', { port: 0 }],
    ['database with a bracket', { database: 'orc]; DROP DATABASE x' }],
    ['database starting with a digit', { database: '1orc' }],
    ['database of 129 characters', { database: `a${'b'.repeat(128)}` }],
    ['poolMin > poolMax', { poolMin: 5, poolMax: 2 }],
    ['non-PEM CA', { caCert: 'not a certificate' }],
    ['tiny request timeout', { requestTimeoutMs: 5 }],
  ] as const)('rejects %s', (_label, patch) => {
    expect(() => validateDatabaseConfig(config(patch as Partial<DatabaseConfig>))).toThrow(
      expect.objectContaining({ code: 'validation_failed' }) as Error,
    );
  });
});

describe('DB-name guard', () => {
  it('requires the _test suffix under NODE_ENV=test', () => {
    expect(() => assertDatabaseGuard({ database: 'orchestrator', appName: 'orc-api' }, 'test')).toThrow(
      expect.objectContaining({ code: 'db_name_guard' }) as Error,
    );
    expect(() => assertDatabaseGuard({ database: 'orchestrator_test', appName: 'orc-api' }, 'test')).not.toThrow();
  });

  it('forbids the _test suffix in production and development (default)', () => {
    expect(() => assertDatabaseGuard({ database: 'orchestrator_test', appName: 'orc-api' }, 'production')).toThrow(
      expect.objectContaining({ code: 'db_name_guard' }) as Error,
    );
    expect(() => assertDatabaseGuard({ database: 'orchestrator_test', appName: 'orc-worker' }, undefined)).toThrow(
      expect.objectContaining({ code: 'db_name_guard' }) as Error,
    );
    expect(() => assertDatabaseGuard({ database: 'orchestrator', appName: 'orc-api' }, 'production')).not.toThrow();
  });

  it('treats appName orc-test as test regardless of NODE_ENV', () => {
    expect(() => assertDatabaseGuard({ database: 'orchestrator', appName: 'orc-test' }, 'production')).toThrow(
      expect.objectContaining({ code: 'db_name_guard' }) as Error,
    );
  });

  it('rejects unknown NODE_ENV values', () => {
    expect(() => assertDatabaseGuard({ database: 'orchestrator', appName: 'orc-api' }, 'staging')).toThrow();
  });

  it('createDatabase refuses before connecting (nothing listens on port 1)', async () => {
    await expect(createDatabase(config({ database: 'orchestrator' }), { logger }, { nodeEnv: 'test' })).rejects.toMatchObject({
      code: 'db_name_guard',
    });
    await expect(
      createDatabase(config({ database: 'orchestrator_test' }), { logger }, { nodeEnv: 'production' }),
    ).rejects.toMatchObject({ code: 'db_name_guard' });
  });
});

describe('integration global-setup guard', () => {
  const ok = {
    NODE_ENV: 'test',
    DB_NAME: 'orchestrator_test',
    DB_PORT: '14331',
    REDIS_PORT: '16380',
    DB_HOST: '127.0.0.1',
    REDIS_HOST: '127.0.0.1',
  };
  it('accepts the test container settings', () => {
    expect(() => assertTestInfraEnv(ok)).not.toThrow();
  });
  it.each([
    ['NODE_ENV', 'production'],
    ['DB_NAME', 'orchestrator'],
    ['DB_PORT', '1433'],
    ['REDIS_PORT', '6379'],
    ['DB_HOST', 'db.example.com'],
  ])('refuses %s=%s', (key, value) => {
    expect(() => assertTestInfraEnv({ ...ok, [key]: value })).toThrow(/Refusing/);
  });
});

describe('buildPoolConfig (TLS per §16.1 / ADR-0026)', () => {
  it('maps encryption, certificate trust and pool sizes', () => {
    const c = buildPoolConfig(config({ poolMin: 2, poolMax: 7 }));
    expect(c.server).toBe('127.0.0.1');
    expect(c.options?.encrypt).toBe(true);
    expect(c.options?.trustServerCertificate).toBe(false);
    expect(c.options?.appName).toBe('orc-api');
    expect(c.options?.useUTC).toBe(true);
    expect(c.options?.cryptoCredentialsDetails).toBeUndefined();
    expect(c.pool).toMatchObject({ min: 2, max: 7 });
    expect(c.connectionTimeout).toBe(15000);
    expect(c.requestTimeout).toBe(30000);
  });

  it('pins the private CA when DB_CA_CERT is set', () => {
    const c = buildPoolConfig(config({ caCert: PEM }));
    expect(c.options?.cryptoCredentialsDetails).toEqual({ ca: PEM, minVersion: 'TLSv1.2' });
  });

  it('applies pool overrides (migrator: max 1)', () => {
    const c = buildPoolConfig(config({ poolMin: 3 }), { poolMax: 1 });
    expect(c.pool).toMatchObject({ min: 1, max: 1 });
  });
});

describe('RowVer / ETag', () => {
  const buf = Buffer.from([0, 0, 0, 0, 0, 0, 0x07, 0xd1]);
  const rv = rowVerFromBuffer(buf);

  it('round-trips an 8-byte ROWVERSION via base64url', () => {
    expect(rv).toBe(buf.toString('base64url'));
    expect(rowVerToBuffer(rv).equals(buf)).toBe(true);
    expect(rowVerToEtag(rv)).toBe(`"${rv}"`);
    expect(etagToRowVer(`"${rv}"`)).toBe(rv);
    expect(etagToRowVer(`W/"${rv}"`)).toBe(rv);
    expect(etagToRowVer(rv)).toBe(rv);
  });

  it.each(['', '"abc"', '"!!!!!!!!!!!"', `"${Buffer.alloc(9).toString('base64url')}"`])(
    'rejects malformed ETag %j with precondition_failed',
    (etag) => {
      expect(() => etagToRowVer(etag)).toThrow(expect.objectContaining({ code: 'precondition_failed' }) as Error);
    },
  );

  it('rejects malformed row versions and non-8-byte buffers', () => {
    expect(() => rowVerToBuffer('short')).toThrow(expect.objectContaining({ code: 'precondition_failed' }) as Error);
    expect(() => rowVerFromBuffer(Buffer.alloc(4))).toThrow(expect.objectContaining({ code: 'internal_error' }) as Error);
  });
});
