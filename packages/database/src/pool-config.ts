// DatabaseConfig validation, DB-name guard and mssql pool configuration (§2.5, §16.1, ADR-0026).
import type sql from 'mssql';
import { z } from 'zod';
import { NODE_ENVS, ValidationError } from '@orc/shared';
import type { NodeEnv } from '@orc/shared';
import { assertDbNameForEnv } from '@orc/shared/node';
import type { DatabaseConfig } from './types.js';

export const DB_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

const DatabaseConfigSchema = z
  .object({
    host: z.string().trim().min(1).max(255),
    port: z.int().min(1).max(65535),
    database: z.string().regex(DB_NAME_PATTERN, 'Expected a plain SQL identifier'),
    user: z.string().min(1).max(128),
    password: z.string().min(1),
    encrypt: z.boolean(),
    trustServerCertificate: z.boolean(),
    caCert: z
      .string()
      .refine((v) => v.includes('-----BEGIN CERTIFICATE-----'), 'Expected a PEM certificate')
      .nullable(),
    poolMin: z.int().min(0).max(1000),
    poolMax: z.int().min(1).max(1000),
    connectTimeoutMs: z.int().min(100),
    requestTimeoutMs: z.int().min(100),
    appName: z.enum(['orc-api', 'orc-worker', 'orc-db-cli', 'orc-test']),
  })
  .refine((c) => c.poolMin <= c.poolMax, { message: 'poolMin must not exceed poolMax', path: ['poolMin'] });

/** Validates a DatabaseConfig (shape, ranges, TLS consistency). Throws ValidationError (source 'env'). */
export function validateDatabaseConfig(config: DatabaseConfig): DatabaseConfig {
  const parsed = DatabaseConfigSchema.safeParse(config);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error, 'env');
  return parsed.data;
}

function parseNodeEnv(value: string | undefined): NodeEnv {
  if (value === undefined || value.trim() === '') return 'development';
  const v = value.trim();
  if ((NODE_ENVS as readonly string[]).includes(v)) return v as NodeEnv;
  // Unknown NODE_ENV values are rejected by assertDbNameForEnv with DbNameGuardError.
  return v as NodeEnv;
}

/**
 * DB-name guard (§2.2, §18.2): the app name 'orc-test' always means test; otherwise NODE_ENV decides
 * (default development). test => name MUST end with "_test"; production|development => MUST NOT.
 * Throws DbNameGuardError before any connection is attempted.
 */
export function assertDatabaseGuard(config: Pick<DatabaseConfig, 'database' | 'appName'>, nodeEnv?: string): void {
  const env: NodeEnv = config.appName === 'orc-test' ? 'test' : parseNodeEnv(nodeEnv);
  assertDbNameForEnv(env, config.database);
}

/** Maps DatabaseConfig to the mssql/tedious pool configuration (TLS verified against a private CA when given). */
export function buildPoolConfig(config: DatabaseConfig, overrides?: { poolMax?: number; poolMin?: number }): sql.config {
  const options: NonNullable<sql.config['options']> = {
    encrypt: config.encrypt,
    trustServerCertificate: config.trustServerCertificate,
    appName: config.appName,
    useUTC: true,
    enableArithAbort: true,
  };
  if (config.caCert !== null) {
    options.cryptoCredentialsDetails = { ca: config.caCert, minVersion: 'TLSv1.2' };
  }
  const poolMax = overrides?.poolMax ?? config.poolMax;
  const poolMin = Math.min(overrides?.poolMin ?? config.poolMin, poolMax);
  return {
    server: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeout: config.connectTimeoutMs,
    requestTimeout: config.requestTimeoutMs,
    options,
    pool: { min: poolMin, max: poolMax, idleTimeoutMillis: 30_000 },
  };
}
