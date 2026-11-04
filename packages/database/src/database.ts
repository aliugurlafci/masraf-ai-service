// Connection pool factory, transaction helper with deadlock retry, ping and schema version (contract §2.5).
import { OrcError } from '@orc/shared';
import type { Logger } from '@orc/logger';
import { serializeError } from '@orc/logger';
import type { SecretRegistry } from '@orc/security';
import { isDeadlockError, mapSqlError, sqlErrorInfo } from './errors.js';
import { assertDatabaseGuard, buildPoolConfig, validateDatabaseConfig } from './pool-config.js';
import { createRepositories } from './repositories/index.js';
import { DEFAULT_TX_MAX_RETRIES, withRetry } from './retry.js';
import { poolExecutor, sql, txExecutor } from './sql.js';
import type { RepoDeps, Row, TxRunner } from './sql.js';
import type { Database, DatabaseConfig, TxIsolationLevel, TxOptions } from './types.js';

/** Highest migration number shipped in packages/database/migrations; readiness requires schemaVersion() >= this. */
export const EXPECTED_SCHEMA_VERSION = 2;

const PING_TIMEOUT_MS = 2000;
const INVALID_OBJECT_NAME = 208;

const ISOLATION: Readonly<Record<TxIsolationLevel, number>> = {
  READ_COMMITTED: sql.ISOLATION_LEVEL.READ_COMMITTED,
  REPEATABLE_READ: sql.ISOLATION_LEVEL.REPEATABLE_READ,
  SERIALIZABLE: sql.ISOLATION_LEVEL.SERIALIZABLE,
};

async function rollbackQuietly(tx: sql.Transaction, logger: Logger, name: string): Promise<void> {
  try {
    await tx.rollback();
  } catch (err) {
    // Already rolled back by the server (deadlock victim, XACT_ABORT) or the connection is gone.
    logger.debug({ tx: name, err: serializeError(err) }, 'transaction rollback skipped');
  }
}

/**
 * Runs `fn` on one sql.Transaction: BEGIN..COMMIT; on 1205/1222 rolls back and re-runs `fn`
 * (50ms*2^n + jitter 0-50ms, cap 2s, maxRetries default 3). Every other error rolls back and is rethrown
 * (mssql driver errors mapped with mapSqlError, everything else unchanged).
 */
export function runInTransaction<R>(
  pool: sql.ConnectionPool,
  logger: Logger,
  opts: TxOptions,
  fn: (tx: sql.Transaction) => Promise<R>,
): Promise<R> {
  const isolation = ISOLATION[opts.isolationLevel ?? 'READ_COMMITTED'];
  return withRetry(
    async () => {
      const tx = new sql.Transaction(pool);
      try {
        await tx.begin(isolation);
      } catch (err) {
        throw mapSqlError(err);
      }
      let result: R;
      try {
        result = await fn(tx);
      } catch (err) {
        await rollbackQuietly(tx, logger, opts.name);
        // Driver errors are mapped; application errors thrown by fn propagate unchanged.
        throw err instanceof sql.MSSQLError ? mapSqlError(err) : err;
      }
      try {
        await tx.commit();
      } catch (err) {
        await rollbackQuietly(tx, logger, opts.name);
        throw mapSqlError(err);
      }
      return result;
    },
    {
      maxRetries: opts.maxRetries ?? DEFAULT_TX_MAX_RETRIES,
      isRetryable: isDeadlockError,
      onRetry: ({ retry, delayMs, error }) =>
        logger.warn({ tx: opts.name, retry, delayMs, err: serializeError(error) }, 'transaction deadlock, retrying'),
    },
  );
}

export interface CreateDatabaseDeps {
  logger: Logger;
  secrets?: SecretRegistry;
}

export interface CreateDatabaseOptions {
  /** NODE_ENV used by the DB-name guard; defaults to process.env.NODE_ENV. */
  nodeEnv?: string;
}

export async function createDatabase(
  config: DatabaseConfig,
  deps: CreateDatabaseDeps,
  options: CreateDatabaseOptions = {},
): Promise<Database> {
  const valid = validateDatabaseConfig(config);
  assertDatabaseGuard(valid, options.nodeEnv ?? process.env['NODE_ENV']);
  deps.secrets?.add(valid.password);
  const logger = deps.logger;
  const pool = new sql.ConnectionPool(buildPoolConfig(valid));
  pool.on('error', (err: unknown) => {
    logger.error({ err: serializeError(err) }, 'database pool error');
  });
  try {
    await pool.connect();
  } catch (err) {
    const mapped = mapSqlError(err);
    throw mapped.code === 'db_unavailable'
      ? mapped
      : new OrcError('db_unavailable', 'Database connection failed', { cause: err });
  }

  const repoDeps: RepoDeps = { logger, secrets: deps.secrets };
  const runTx: TxRunner = (name, fn) => runInTransaction(pool, logger, { name }, fn);
  const repos = createRepositories({ ...repoDeps, exec: poolExecutor(pool, runTx) });

  return {
    pool,
    repos,
    transaction(fn, opts) {
      return runInTransaction(pool, logger, opts, (tx) =>
        fn({ tx, repos: createRepositories({ ...repoDeps, exec: txExecutor(tx) }) }),
      );
    },
    async ping() {
      const req = new sql.Request(pool);
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          req.cancel();
          reject(new OrcError('db_unavailable', `Database ping timed out after ${PING_TIMEOUT_MS} ms`));
        }, PING_TIMEOUT_MS);
      });
      try {
        await Promise.race([req.query('SELECT 1 AS Ok;'), timeout]);
      } catch (err) {
        const mapped = mapSqlError(err);
        throw mapped.code === 'db_unavailable' ? mapped : new OrcError('db_unavailable', 'Database ping failed', { cause: err });
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    async schemaVersion() {
      // No OBJECT_ID() probe: VIEW DEFINITION is denied to the app roles, which hides catalog metadata.
      try {
        const result = await new sql.Request(pool).query<Row>(
          'SELECT ISNULL(MAX(Version), 0) AS V FROM orc.SchemaMigrations;',
        );
        const v = result.recordset[0]?.['V'];
        return typeof v === 'number' ? v : 0;
      } catch (err) {
        if (sqlErrorInfo(err).number === INVALID_OBJECT_NAME) return 0;
        throw mapSqlError(err);
      }
    },
    async close() {
      await pool.close();
    },
  };
}
