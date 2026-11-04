import { describe, expect, it } from 'vitest';
import { OrcError } from '@orc/shared';
import { MigrationChecksumError, MigrationLockError, isDeadlockError, mapSqlError } from '@orc/database';
import { isCheckViolation, sqlErrorInfo } from '../../../packages/database/src/errors';

/** Shape of an mssql RequestError wrapping a tedious error. */
function requestError(number: number, message: string): Error {
  const err = new Error(message) as Error & { number: number; code: string; originalError: unknown };
  err.number = number;
  err.code = 'EREQUEST';
  err.originalError = { info: { number, message } };
  return err;
}

function driverError(code: string): Error {
  const err = new Error(`driver ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

describe('mapSqlError', () => {
  it.each([
    [2627, "Violation of UNIQUE KEY constraint 'UQ_Users_Username'. Cannot insert duplicate key.", 'unique_violation'],
    [2601, "Cannot insert duplicate key row in object 'orc.TaskLogs' with unique index 'UX_TaskLogs_AttemptSeq'.", 'unique_violation'],
    [547, 'The INSERT statement conflicted with the FOREIGN KEY constraint "FK_Tasks_Projects".', 'conflict'],
    [547, 'The DELETE statement conflicted with the REFERENCE constraint "FK_Agents_Teams".', 'conflict'],
    [547, 'The INSERT statement conflicted with the CHECK constraint "CK_Users_Role".', 'internal_error'],
    [2628, 'String or binary data would be truncated in table', 'validation_failed'],
    [8152, 'String or binary data would be truncated.', 'validation_failed'],
    [8114, 'Error converting data type nvarchar to bigint.', 'validation_failed'],
    [8115, 'Arithmetic overflow error converting expression to data type int.', 'validation_failed'],
    [220, 'Arithmetic overflow error for data type tinyint', 'validation_failed'],
    [1205, 'Transaction was deadlocked on lock resources with another process', 'db_deadlock'],
    [1222, 'Lock request time out period exceeded.', 'db_deadlock'],
    [229, 'The SELECT permission was denied on the object', 'internal_error'],
  ] as const)('maps SQL error %i to %s', (number, message, code) => {
    const mapped = mapSqlError(requestError(number, message));
    expect(mapped).toBeInstanceOf(OrcError);
    expect(mapped.code).toBe(code);
    expect(mapped.cause).toBeInstanceOf(Error);
  });

  it('extracts the constraint name for unique and reference violations', () => {
    expect(mapSqlError(requestError(2627, "Violation of UNIQUE KEY constraint 'UQ_Users_Username'.")).details?.['constraint']).toBe(
      'UQ_Users_Username',
    );
    expect(
      mapSqlError(requestError(547, 'conflicted with the FOREIGN KEY constraint "FK_Tasks_Projects"')).details?.['constraint'],
    ).toBe('FK_Tasks_Projects');
  });

  it('flags CHECK violations as a validation gap', () => {
    const mapped = mapSqlError(requestError(547, 'conflicted with the CHECK constraint "CK_Users_Role"'));
    expect(isCheckViolation(mapped)).toBe(true);
    expect(isCheckViolation(mapSqlError(requestError(547, 'FOREIGN KEY constraint "FK_X"')))).toBe(false);
  });

  it.each(['ELOGIN', 'ESOCKET', 'ETIMEOUT', 'ECONNCLOSED'])('maps driver code %s to db_unavailable', (code) => {
    expect(mapSqlError(driverError(code)).code).toBe('db_unavailable');
  });

  it('reads the number from originalError when the wrapper has none', () => {
    const err = Object.assign(new Error('wrapped'), { originalError: { number: 1205 } });
    expect(sqlErrorInfo(err).number).toBe(1205);
    expect(mapSqlError(err).code).toBe('db_deadlock');
  });

  it('passes OrcErrors through unchanged and wraps unknown values', () => {
    const orc = new OrcError('not_found', 'x');
    expect(mapSqlError(orc)).toBe(orc);
    expect(mapSqlError('boom').code).toBe('internal_error');
    expect(mapSqlError(null).code).toBe('internal_error');
  });
});

describe('isDeadlockError', () => {
  it('accepts 1205 and 1222 (raw or already mapped) only', () => {
    expect(isDeadlockError(requestError(1205, 'deadlock'))).toBe(true);
    expect(isDeadlockError(requestError(1222, 'lock timeout'))).toBe(true);
    expect(isDeadlockError(new OrcError('db_deadlock', 'x'))).toBe(true);
    expect(isDeadlockError(requestError(2627, 'dup'))).toBe(false);
    expect(isDeadlockError(new OrcError('conflict', 'x'))).toBe(false);
    expect(isDeadlockError(new Error('plain'))).toBe(false);
    expect(isDeadlockError(undefined)).toBe(false);
  });
});

describe('migration errors', () => {
  it('carry their contract codes', () => {
    expect(new MigrationChecksumError('x').code).toBe('migration_checksum_mismatch');
    expect(new MigrationLockError('x').code).toBe('migration_lock_timeout');
  });
});
