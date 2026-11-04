// Contract §4.2 (F15, T-m11): the bootstrap batches are constant; only bound inputs vary.
import { describe, expect, it } from 'vitest';
import { SQL_LOGIN_PASSWORD_REGEX } from '@orc/shared/node';
import {
  BOOTSTRAP_LOGINS,
  assertBootstrapPassword,
  configureDatabaseStatement,
  createDatabaseStatement,
  loginStatement,
  roleMemberStatement,
  userStatement,
} from '../../../packages/database/src/admin/bootstrap';

const GOOD = 'Abcdefgh1234!xyz';
const OTHER = 'Zyxw_9876.Vuts/Rq';

describe('bootstrap SQL', () => {
  it('uses the contract password alphabet', () => {
    expect(SQL_LOGIN_PASSWORD_REGEX.test(GOOD)).toBe(true);
    expect(SQL_LOGIN_PASSWORD_REGEX.test(OTHER)).toBe(true);
  });

  it('produces identical batch text for every password, login and database', () => {
    const a = loginStatement('orc_api', GOOD, 'orchestrator');
    const b = loginStatement('orc_worker', OTHER, 'orchestrator_test');
    expect(a.sql).toBe(b.sql);
    expect(a.sql).not.toContain(GOOD);
    expect(b.sql).not.toContain(OTHER);
    expect(a.inputs).toEqual([
      ['login', 'orc_api'],
      ['pwd', GOOD],
      ['db', 'orchestrator'],
    ]);
    expect(createDatabaseStatement('a').sql).toBe(createDatabaseStatement('orchestrator_test').sql);
    expect(configureDatabaseStatement('a').sql).toBe(configureDatabaseStatement('b').sql);
    expect(userStatement('orc_api').sql).toBe(userStatement('orc_backup').sql);
  });

  it('builds dynamic text only in T-SQL with QUOTENAME/REPLACE and a NULL guard', () => {
    const { sql } = loginStatement('orc_migrator', GOOD, 'orchestrator');
    expect(sql).toContain('QUOTENAME(@login)');
    expect(sql).toContain("REPLACE(@pwd, N'''', N'''''')");
    expect(sql).toContain('QUOTENAME(@db)');
    expect(sql).toContain('IF @sql IS NULL THROW');
    expect(sql).toContain('CHECK_POLICY = ON, CHECK_EXPIRATION = OFF');
    expect(sql).toContain('EXEC sys.sp_executesql @sql');
    for (const s of [createDatabaseStatement('x').sql, userStatement('orc_api').sql, roleMemberStatement('db_owner', 'orc_migrator').sql]) {
      expect(s).toContain('IF @sql IS NULL THROW');
    }
    expect(configureDatabaseStatement('x').sql).toContain('READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE');
  });

  it.each([
    ['a single quote', "Abcdefgh1234'xyz"],
    ['a closing bracket', 'Abcdefgh1234]xyz'],
    ['an injection attempt', "x'; DROP LOGIN sa; --aaaaaaaaaa"],
    ['a backslash', 'Abcdefgh1234\\xyz'],
    ['a dollar sign', 'Abcdefgh1234$xyz'],
    ['whitespace', 'Abcdefgh 1234xyz'],
    ['15 characters', 'Abcdefgh1234!xy'],
    ['129 characters', `A1!${'a'.repeat(126)}`],
  ])('rejects a password with %s', (_label, pwd) => {
    expect(() => loginStatement('orc_api', pwd, 'orchestrator')).toThrow(
      expect.objectContaining({ code: 'validation_failed' }) as Error,
    );
  });

  it('rejects null/undefined passwords (NULL-producing input)', () => {
    expect(() => assertBootstrapPassword(null as unknown as string, 'pwd')).toThrow();
    expect(() => assertBootstrapPassword(undefined as unknown as string, 'pwd')).toThrow();
  });

  it.each([
    ['a closing bracket', 'orc]x'],
    ['a quote', "orc'x"],
    ['an injection attempt', "orc'; DROP LOGIN sa; --"],
    ['129 characters (QUOTENAME would return NULL)', `a${'b'.repeat(128)}`],
    ['an empty name', ''],
    ['a leading digit', '1orc'],
  ])('rejects a database name with %s', (_label, db) => {
    expect(() => createDatabaseStatement(db)).toThrow(expect.objectContaining({ code: 'validation_failed' }) as Error);
    expect(() => loginStatement('orc_api', GOOD, db)).toThrow();
  });

  it('accepts a 128-character database name', () => {
    expect(() => createDatabaseStatement(`a${'b'.repeat(127)}`)).not.toThrow();
  });

  it('only allows the four orc logins and the bootstrap roles', () => {
    expect([...BOOTSTRAP_LOGINS]).toEqual(['orc_migrator', 'orc_api', 'orc_worker', 'orc_backup']);
    expect(() => loginStatement('sa', GOOD, 'orchestrator')).toThrow();
    expect(() => loginStatement('orc_api]; DROP LOGIN sa; --', GOOD, 'orchestrator')).toThrow();
    expect(() => userStatement('dbo')).toThrow();
    expect(() => roleMemberStatement('sysadmin', 'orc_api')).toThrow();
    expect(() => roleMemberStatement('db_owner', 'sa')).toThrow();
    expect(roleMemberStatement('orc_api_role', 'orc_api').inputs).toEqual([
      ['role', 'orc_api_role'],
      ['member', 'orc_api'],
    ]);
  });
});
