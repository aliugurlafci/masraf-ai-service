// Low-level SQL helpers: mssql import, executors, parameter types, row accessors (internal).
import sql from 'mssql';
import { GUID_REGEX, OrcError } from '@orc/shared';
import type { Logger } from '@orc/logger';
import { serializeError } from '@orc/logger';
import type { SecretRegistry } from '@orc/security';
import { isCheckViolation, mapSqlError } from './errors.js';
import { rowVerFromBuffer } from './rowver.js';

export { sql };

export type SqlType = sql.ISqlType | (() => sql.ISqlType);
export type Param = readonly [name: string, type: SqlType, value: unknown];
export type Row = Readonly<Record<string, unknown>>;

const binaryFactory = sql.Binary as unknown as (length: number) => sql.ISqlType;

/** Parameter type shorthands. BIGINT ids are bound as sql.BigInt from validated decimal strings (T-m3). */
export const T = {
  guid: sql.UniqueIdentifier,
  bigint: sql.BigInt,
  int: sql.Int,
  tinyint: sql.TinyInt,
  bit: sql.Bit,
  dt: sql.DateTime2(3),
  money: sql.Decimal(10, 4),
  cost: sql.Decimal(12, 6),
  nvarchar: (length: number): sql.ISqlType => sql.NVarChar(length),
  nvarcharMax: sql.NVarChar(sql.MAX),
  varchar: (length: number): sql.ISqlType => sql.VarChar(length),
  binary: (length: number): sql.ISqlType => binaryFactory(length),
  varbinaryMax: sql.VarBinary(sql.MAX),
} as const;

/** Runs statements either on the pool (autocommit) or on a pinned transaction. */
export interface Executor {
  readonly inTransaction: boolean;
  request(): sql.Request;
  /** Runs fn atomically: reuses the ambient transaction or opens one (with deadlock retry) on the pool. */
  atomic<R>(name: string, fn: (exec: Executor) => Promise<R>): Promise<R>;
}

export interface RepoDeps {
  logger: Logger;
  secrets: SecretRegistry | undefined;
}

export interface RepoContext extends RepoDeps {
  exec: Executor;
}

export type TxRunner = <R>(name: string, fn: (tx: sql.Transaction) => Promise<R>) => Promise<R>;

export function txExecutor(tx: sql.Transaction): Executor {
  const exec: Executor = {
    inTransaction: true,
    request: () => new sql.Request(tx),
    atomic: (_name, fn) => fn(exec),
  };
  return exec;
}

export function poolExecutor(pool: sql.ConnectionPool, runTx: TxRunner): Executor {
  return {
    inTransaction: false,
    request: () => new sql.Request(pool),
    atomic: (name, fn) => runTx(name, (tx) => fn(txExecutor(tx))),
  };
}

export interface QueryResult {
  rows: Row[];
  recordsets: Row[][];
  rowsAffected: number;
  rowsAffectedPerStatement: number[];
}

/** Maps a driver error to OrcError; CHECK violations (validation gaps) are logged at error. */
export function toOrcError(deps: RepoDeps, err: unknown): OrcError {
  const mapped = mapSqlError(err);
  if (isCheckViolation(mapped)) {
    deps.logger.error(
      { err: serializeError(err), constraint: mapped.details?.['constraint'] ?? null },
      'database CHECK constraint violated (input validation gap)',
    );
  }
  return mapped;
}

/** Executes one parameterized batch. The SQL text is always a constant; values are only bound as inputs. */
export async function run(ctx: RepoContext, text: string, params: readonly Param[] = []): Promise<QueryResult> {
  const req = ctx.exec.request();
  for (const [name, type, value] of params) req.input(name, type, value);
  try {
    const result = await req.query<Row>(text);
    const recordsets = (result.recordsets as unknown as Row[][] | undefined) ?? [];
    const perStatement = result.rowsAffected;
    return {
      rows: recordsets[0] ?? [],
      recordsets,
      rowsAffected: perStatement.reduce((a, b) => a + b, 0),
      rowsAffectedPerStatement: perStatement,
    };
  } catch (err) {
    throw toOrcError(ctx, err);
  }
}

// ---- input validation -------------------------------------------------------------------------

const BIG_ID_PATTERN = /^[0-9]{1,19}$/;

export function assertGuid(value: string, field: string): string {
  if (!GUID_REGEX.test(value.toLowerCase())) {
    throw new OrcError('validation_failed', `${field} must be a GUID`, { details: { field } });
  }
  return value.toLowerCase();
}

export function isGuid(value: string): boolean {
  return GUID_REGEX.test(value.toLowerCase());
}

export function assertBigId(value: string, field: string): string {
  if (!BIG_ID_PATTERN.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) {
    throw new OrcError('validation_failed', `${field} must be a BIGINT id`, { details: { field } });
  }
  return value;
}

export function assertInt(value: number, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new OrcError('validation_failed', `${field} must be an integer in ${min}..${max}`, {
      details: { field },
    });
  }
  return value;
}

/** Clamps a page size to 1..max (repos fetch limit + 1 rows). */
export function pageTake(limit: number, max = 1000): number {
  return assertInt(limit, 'limit', 1, max) + 1;
}

/** Truncates to at most `maxChars` UTF-16 code units without splitting a surrogate pair. */
export function truncateChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let end = maxChars;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/** Truncates to at most `maxBytes` UTF-8 bytes on a code point boundary. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let bytes = 0;
  const parts: string[] = [];
  for (const ch of value) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    parts.push(ch);
  }
  return parts.join('');
}

// ---- row accessors ------------------------------------------------------------------------------

function bad(column: string, expected: string): never {
  throw new OrcError('internal_error', `Unexpected SQL value in column ${column} (expected ${expected})`);
}

function isNil(v: unknown): v is null | undefined {
  return v === null || v === undefined;
}

export function str(r: Row, c: string): string {
  const v = r[c];
  return typeof v === 'string' ? v : bad(c, 'string');
}
export function nstr(r: Row, c: string): string | null {
  const v = r[c];
  if (isNil(v)) return null;
  return typeof v === 'string' ? v : bad(c, 'string');
}
export function int(r: Row, c: string): number {
  const v = r[c];
  return typeof v === 'number' && Number.isInteger(v) ? v : bad(c, 'integer');
}
export function nint(r: Row, c: string): number | null {
  return isNil(r[c]) ? null : int(r, c);
}
export function num(r: Row, c: string): number {
  const v = r[c];
  return typeof v === 'number' && Number.isFinite(v) ? v : bad(c, 'number');
}
export function nnum(r: Row, c: string): number | null {
  return isNil(r[c]) ? null : num(r, c);
}
export function bool(r: Row, c: string): boolean {
  const v = r[c];
  return typeof v === 'boolean' ? v : bad(c, 'boolean');
}
export function nbool(r: Row, c: string): boolean | null {
  return isNil(r[c]) ? null : bool(r, c);
}
export function date(r: Row, c: string): Date {
  const v = r[c];
  return v instanceof Date && !Number.isNaN(v.getTime()) ? v : bad(c, 'date');
}
export function ndate(r: Row, c: string): Date | null {
  return isNil(r[c]) ? null : date(r, c);
}
export function iso(r: Row, c: string): string {
  return date(r, c).toISOString();
}
export function niso(r: Row, c: string): string | null {
  return isNil(r[c]) ? null : iso(r, c);
}
export function guid(r: Row, c: string): string {
  return str(r, c).toLowerCase();
}
export function nguid(r: Row, c: string): string | null {
  return isNil(r[c]) ? null : guid(r, c);
}
/** BIGINT id: tedious returns BIGINT as a decimal string. */
export function bigId(r: Row, c: string): string {
  const v = r[c];
  if (typeof v === 'string' && BIG_ID_PATTERN.test(v)) return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v);
  if (typeof v === 'bigint') return v.toString();
  return bad(c, 'BIGINT');
}
/** BIGINT counter: checked Number() (> MAX_SAFE_INTEGER => internal_error). */
export function bigNum(r: Row, c: string): number {
  const v = r[c];
  let n: number;
  if (typeof v === 'string' && /^-?[0-9]{1,20}$/.test(v)) n = Number(v);
  else if (typeof v === 'number') n = v;
  else if (typeof v === 'bigint') n = Number(v);
  else return bad(c, 'BIGINT');
  if (!Number.isSafeInteger(n)) throw new OrcError('internal_error', `BIGINT value in ${c} exceeds MAX_SAFE_INTEGER`);
  return n;
}
export function nbigNum(r: Row, c: string): number | null {
  return isNil(r[c]) ? null : bigNum(r, c);
}
export function buf(r: Row, c: string): Buffer {
  const v = r[c];
  return Buffer.isBuffer(v) ? v : bad(c, 'binary');
}
export function nbuf(r: Row, c: string): Buffer | null {
  return isNil(r[c]) ? null : buf(r, c);
}
export function rowVer(r: Row, c = 'RowVer'): string {
  return rowVerFromBuffer(buf(r, c));
}
/** Parses a JSON column; malformed JSON => internal_error. */
export function json(r: Row, c: string): unknown {
  const text = nstr(r, c);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return bad(c, 'JSON');
  }
}

/** Parses a JSON column with a schema-like parser (Zod `parse`). */
export function jsonAs<V>(r: Row, c: string, parse: (value: unknown) => V): V | null {
  const value = json(r, c);
  if (value === null) return null;
  try {
    return parse(value);
  } catch {
    return bad(c, 'JSON matching its schema');
  }
}

/** Binds a JS value as JSON text (NULL for null/undefined). */
export function toJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

export function first(rows: readonly Row[]): Row | null {
  return rows[0] ?? null;
}

/** A string column restricted to a constant list (CHECK-constrained in SQL). */
export function oneOf<V extends string>(values: readonly V[], r: Row, c: string): V {
  const v = str(r, c);
  return (values as readonly string[]).includes(v) ? (v as V) : bad(c, values.join('|'));
}

export function noneOf<V extends string>(values: readonly V[], r: Row, c: string): V | null {
  return isNil(r[c]) ? null : oneOf(values, r, c);
}

/** Builds `@set_<field>` / `@<field>` parameter pairs for `CASE WHEN @set_x = 1 THEN @x ELSE Col END` patches. */
export function patchParams<P extends object>(
  patch: P,
  spec: readonly (readonly [field: keyof P & string, type: SqlType, map?: (value: unknown) => unknown])[],
): Param[] {
  const params: Param[] = [];
  const source = patch as Record<string, unknown>;
  for (const [field, type, map] of spec) {
    const present = Object.prototype.hasOwnProperty.call(source, field) && source[field] !== undefined;
    const value = present ? (map ? map(source[field]) : source[field]) : null;
    params.push([`set_${field}`, T.bit, present], [field, type, value ?? null]);
  }
  return params;
}

/** Keyset parameters `@afterCreatedAt` / `@afterId` for descending (CreatedAt, Id) lists. */
export function keysetParams(after: { createdAt: string; id: string } | undefined, idKind: 'guid' | 'bigint'): Param[] {
  if (!after) {
    return [
      ['afterCreatedAt', T.dt, null],
      ['afterId', idKind === 'guid' ? T.guid : T.bigint, null],
    ];
  }
  const at = new Date(after.createdAt);
  if (Number.isNaN(at.getTime())) {
    throw new OrcError('invalid_cursor', 'Malformed cursor timestamp');
  }
  const id = idKind === 'guid' ? (isGuid(after.id) ? after.id.toLowerCase() : null) : /^[0-9]{1,19}$/.test(after.id) ? after.id : null;
  if (id === null) throw new OrcError('invalid_cursor', 'Malformed cursor id');
  return [
    ['afterCreatedAt', T.dt, at],
    ['afterId', idKind === 'guid' ? T.guid : T.bigint, id],
  ];
}
