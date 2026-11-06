import sql from 'mssql';
import type { DbConfig } from '../config.ts';

export type Db = sql.ConnectionPool;
/** A pool or an open transaction: anything a query can run on. */
export type Executor = sql.ConnectionPool | sql.Transaction;

export interface Param {
  readonly type: sql.ISqlType | (() => sql.ISqlType);
  readonly value: unknown;
}
export type Params = Readonly<Record<string, Param>>;

/** Typed parameters. Every query is parameterised; values are never spliced into SQL text. */
export const p = {
  int: (value: number | null): Param => ({ type: sql.Int, value }),
  bigint: (value: number | null): Param => ({ type: sql.BigInt, value }),
  bit: (value: boolean | null): Param => ({ type: sql.Bit, value }),
  str: (value: string | null, length = 4000): Param => ({ type: sql.NVarChar(length), value }),
  text: (value: string | null): Param => ({ type: sql.NVarChar(sql.MAX), value }),
  ascii: (value: string | null, length = 200): Param => ({ type: sql.VarChar(length), value }),
  money: (value: number | null): Param => ({ type: sql.Decimal(18, 2), value }),
  rate: (value: number | null): Param => ({ type: sql.Decimal(18, 6), value }),
  float: (value: number | null): Param => ({ type: sql.Float, value }),
  time: (value: Date | null): Param => ({ type: sql.DateTime2(3), value }),
  /** A calendar date as YYYY-MM-DD. */
  date: (value: string | null): Param => ({ type: sql.Date, value: value === null ? null : new Date(`${value}T00:00:00Z`) }),
  bytes: (value: Buffer | null): Param => ({ type: sql.VarBinary(sql.MAX), value }),
} as const;

function request(ex: Executor, params: Params): sql.Request {
  const req = ex.request();
  for (const [name, { type, value }] of Object.entries(params)) req.input(name, type, value);
  return req;
}

/** Deadlock victims are retried this many times in all. */
const DEADLOCK_ATTEMPTS = 4;

const isDeadlock = (err: unknown): boolean => sqlErrorNumber(err) === SQL_ERROR.deadlock;

/**
 * Runs `run` again when SQL Server picked it as a deadlock victim. The victim's work is rolled back
 * whole, so running it again is safe; a short random pause lets the winner finish first.
 */
async function retryDeadlock<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= DEADLOCK_ATTEMPTS || !isDeadlock(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40 * attempt));
    }
  }
}

/**
 * A statement on the pool is its own transaction and is retried after a deadlock. Inside a
 * transaction the deadlock ends the whole transaction, so `transaction()` retries it instead.
 */
const run = <T>(ex: Executor, statement: () => Promise<T>): Promise<T> => (ex instanceof sql.Transaction ? statement() : retryDeadlock(statement));

export async function query<T>(ex: Executor, text: string, params: Params = {}): Promise<T[]> {
  const result = await run(ex, () => request(ex, params).query<T>(text));
  return result.recordset ?? [];
}

export async function queryOne<T>(ex: Executor, text: string, params: Params = {}): Promise<T | null> {
  return (await query<T>(ex, text, params))[0] ?? null;
}

/** Runs a statement and returns the number of rows it changed. */
export async function execute(ex: Executor, text: string, params: Params = {}): Promise<number> {
  const result = await run(ex, () => request(ex, params).query(text));
  return result.rowsAffected.reduce((a, b) => a + b, 0);
}

/**
 * Runs `fn` in a transaction; commits when it returns, rolls back when it throws. A deadlock victim
 * runs again from the start, so `fn` must only work through `tx` (it does everywhere in src/).
 */
export function transaction<T>(db: Db, fn: (tx: sql.Transaction) => Promise<T>): Promise<T> {
  return retryDeadlock(() => transactionOnce(db, fn));
}

async function transactionOnce<T>(db: Db, fn: (tx: sql.Transaction) => Promise<T>): Promise<T> {
  const tx = new sql.Transaction(db);
  await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
  let result: T;
  try {
    result = await fn(tx);
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      // SQL Server may already have rolled back (deadlock victim, XACT_ABORT); keep the original error.
    }
    throw err;
  }
  await tx.commit();
  return result;
}

/** SQL Server error numbers we turn into user-facing answers. */
export const SQL_ERROR = {
  uniqueIndex: 2601,
  uniqueConstraint: 2627,
  foreignKey: 547,
  deadlock: 1205,
} as const;

export function sqlErrorNumber(err: unknown): number | null {
  const n = (err as { number?: unknown } | null)?.number;
  return typeof n === 'number' ? n : null;
}

export const isUniqueViolation = (err: unknown): boolean => {
  const n = sqlErrorNumber(err);
  return n === SQL_ERROR.uniqueIndex || n === SQL_ERROR.uniqueConstraint;
};

export function poolConfig(config: DbConfig, database: string): sql.config {
  return {
    server: config.host,
    port: config.port,
    database,
    user: config.user,
    password: config.password,
    pool: { max: config.poolMax, min: 0, idleTimeoutMillis: 30_000 },
    connectionTimeout: 15_000,
    requestTimeout: 30_000,
    options: {
      encrypt: config.encrypt,
      trustServerCertificate: config.trustServerCertificate,
      useUTC: true,
      appName: 'masraf-ai-service',
    },
  };
}

/** YYYY-MM-DD of a DATE column (the driver returns it as UTC midnight). */
export function dateOnly(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

export function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}
