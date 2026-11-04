// SQL error classification and mapping (contract §2.5).
import { OrcError, isOrcError } from '@orc/shared';
import type { OrcErrorOptions } from './internal-types.js';

/** 'migration_checksum_mismatch' (CLI exit code 2). */
export class MigrationChecksumError extends OrcError {
  constructor(message: string, options?: OrcErrorOptions) {
    super('migration_checksum_mismatch', message, options);
  }
}

/** 'migration_lock_timeout' */
export class MigrationLockError extends OrcError {
  constructor(message: string, options?: OrcErrorOptions) {
    super('migration_lock_timeout', message, options);
  }
}

const DEADLOCK_NUMBERS: ReadonlySet<number> = new Set([1205, 1222]);
const UNIQUE_NUMBERS: ReadonlySet<number> = new Set([2627, 2601]);
const TRUNCATION_NUMBERS: ReadonlySet<number> = new Set([2628, 8152]);
const CONVERSION_NUMBERS: ReadonlySet<number> = new Set([8114, 8115, 220]);
/** Transport-level mssql/tedious codes that mean "the database cannot be reached right now". */
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'ELOGIN',
  'ESOCKET',
  'ETIMEOUT',
  'ECONNCLOSED',
  'ENOTOPEN',
  'EINSTLOOKUP',
  'ECONNRESET',
  'ECONNREFUSED',
]);

interface SqlErrorInfo {
  number: number | null;
  code: string | null;
  message: string;
}

function readProp(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function numberOf(value: unknown): number | null {
  const n = readProp(value, 'number');
  return typeof n === 'number' && Number.isInteger(n) ? n : null;
}

/** Extracts the SQL Server error number and driver code from mssql/tedious errors (including wrapped ones). */
export function sqlErrorInfo(err: unknown): SqlErrorInfo {
  const original = readProp(err, 'originalError');
  const info = readProp(original, 'info');
  const number = numberOf(err) ?? numberOf(original) ?? numberOf(info);
  const rawCode = readProp(err, 'code');
  const originalCode = readProp(original, 'code');
  const code =
    typeof rawCode === 'string' ? rawCode : typeof originalCode === 'string' ? originalCode : null;
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown database error';
  return { number, code, message };
}

/** number 1205 (deadlock victim) or 1222 (lock request timeout); also an already mapped 'db_deadlock'. */
export function isDeadlockError(err: unknown): boolean {
  if (isOrcError(err)) return err.code === 'db_deadlock';
  const { number } = sqlErrorInfo(err);
  return number !== null && DEADLOCK_NUMBERS.has(number);
}

const CONSTRAINT_PATTERNS: readonly RegExp[] = [
  /constraint "([^"]+)"/i,
  /constraint '([^']+)'/i,
  /unique index '([^']+)'/i,
];

function constraintName(message: string): string | null {
  for (const pattern of CONSTRAINT_PATTERNS) {
    const m = pattern.exec(message);
    if (m?.[1]) return m[1];
  }
  return null;
}

/**
 * 2627/2601 -> 'unique_violation'; 547 FOREIGN KEY/REFERENCE -> 'conflict'; 547 CHECK -> 'internal_error'
 * (details.kind = 'check_violation'; callers log it at error); 2628/8152, 8114/8115/220 -> 'validation_failed';
 * 1205/1222 -> 'db_deadlock'; ELOGIN/ESOCKET/ETIMEOUT/ECONNCLOSED (and other transport failures) -> 'db_unavailable'.
 * OrcErrors pass through unchanged.
 */
export function mapSqlError(err: unknown): OrcError {
  if (isOrcError(err)) return err;
  const { number, code, message } = sqlErrorInfo(err);
  if (number !== null) {
    if (UNIQUE_NUMBERS.has(number)) {
      return new OrcError('unique_violation', 'Duplicate value', {
        cause: err,
        details: { sqlNumber: number, constraint: constraintName(message) },
      });
    }
    if (number === 547) {
      const constraint = constraintName(message);
      if (/\bCHECK constraint\b/i.test(message)) {
        return new OrcError('internal_error', 'Database CHECK constraint violated', {
          cause: err,
          details: { sqlNumber: number, kind: 'check_violation', constraint },
        });
      }
      return new OrcError('conflict', 'Referenced row does not exist or is still referenced', {
        cause: err,
        details: { sqlNumber: number, kind: 'reference_violation', constraint },
      });
    }
    if (TRUNCATION_NUMBERS.has(number)) {
      return new OrcError('validation_failed', 'Value too long for its column', {
        cause: err,
        details: { sqlNumber: number },
      });
    }
    if (CONVERSION_NUMBERS.has(number)) {
      return new OrcError('validation_failed', 'Value out of range or not convertible', {
        cause: err,
        details: { sqlNumber: number },
      });
    }
    if (DEADLOCK_NUMBERS.has(number)) {
      return new OrcError('db_deadlock', 'Database deadlock or lock timeout', {
        cause: err,
        details: { sqlNumber: number },
      });
    }
  }
  if (code !== null && UNAVAILABLE_CODES.has(code)) {
    return new OrcError('db_unavailable', 'Database unavailable', {
      cause: err,
      details: { driverCode: code },
    });
  }
  return new OrcError('internal_error', 'Database operation failed', {
    cause: err,
    details: { sqlNumber: number, driverCode: code },
  });
}

/** True when a mapped error is a CHECK constraint violation (validation gap; logged at error). */
export function isCheckViolation(err: OrcError): boolean {
  return err.code === 'internal_error' && err.details?.['kind'] === 'check_violation';
}
