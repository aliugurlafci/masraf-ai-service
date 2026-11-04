// `orc-db bootstrap` (contract §4.2, F15/T-m11): database, logins, users and role memberships, run as `sa`.
//
// Documented exception to "parameterized SQL only": CREATE DATABASE and CREATE/ALTER LOGIN ... WITH PASSWORD
// cannot take parameters. Every statement below is ONE constant batch in which only T-SQL builds the dynamic
// text from bound sql.NVarChar inputs (QUOTENAME / REPLACE); JavaScript never concatenates SQL and the batch
// text never contains a secret. Inputs are validated before connecting.
import { OrcError } from '@orc/shared';
import { SQL_LOGIN_PASSWORD_REGEX } from '@orc/shared/node';
import type { Logger } from '@orc/logger';
import { mapSqlError } from '../errors.js';
import { DB_NAME_PATTERN, buildPoolConfig, validateDatabaseConfig } from '../pool-config.js';
import { sql } from '../sql.js';
import type { DatabaseConfig } from '../types.js';

export const BOOTSTRAP_LOGINS = ['orc_migrator', 'orc_api', 'orc_worker', 'orc_backup'] as const;
export type BootstrapLogin = (typeof BOOTSTRAP_LOGINS)[number];

/** Database role memberships per login (orc_* roles are created by migration 0002 and are skipped until then). */
export const BOOTSTRAP_ROLE_MEMBERSHIPS: readonly (readonly [role: string, member: BootstrapLogin])[] = [
  ['db_owner', 'orc_migrator'],
  ['db_backupoperator', 'orc_backup'],
  ['orc_api_role', 'orc_api'],
  ['orc_worker_role', 'orc_worker'],
];
const ALLOWED_ROLES: ReadonlySet<string> = new Set(BOOTSTRAP_ROLE_MEMBERSHIPS.map(([role]) => role));

export interface BootstrapStatement {
  readonly sql: string;
  readonly inputs: readonly (readonly [name: string, value: string])[];
}

const NULL_GUARD = "IF @sql IS NULL THROW 50001, N'bootstrap statement is NULL', 1;";

const CREATE_DATABASE_SQL = `IF DB_ID(@db) IS NULL
BEGIN
  DECLARE @sql NVARCHAR(MAX) = N'CREATE DATABASE ' + QUOTENAME(@db) + N';';
  ${NULL_GUARD}
  EXEC sys.sp_executesql @sql;
END;`;

const CONFIGURE_DATABASE_SQL = `DECLARE @sql NVARCHAR(MAX);
IF EXISTS (SELECT 1 FROM sys.databases WHERE name = @db AND is_read_committed_snapshot_on = 0)
BEGIN
  SET @sql = N'ALTER DATABASE ' + QUOTENAME(@db) + N' SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE;';
  ${NULL_GUARD}
  EXEC sys.sp_executesql @sql;
END;
IF EXISTS (SELECT 1 FROM sys.databases WHERE name = @db AND snapshot_isolation_state <> 0)
BEGIN
  SET @sql = N'ALTER DATABASE ' + QUOTENAME(@db) + N' SET ALLOW_SNAPSHOT_ISOLATION OFF;';
  ${NULL_GUARD}
  EXEC sys.sp_executesql @sql;
END;`;

const LOGIN_SQL = `DECLARE @sql NVARCHAR(MAX) =
  CASE WHEN SUSER_ID(@login) IS NULL THEN N'CREATE LOGIN ' ELSE N'ALTER LOGIN ' END
  + QUOTENAME(@login) + N' WITH PASSWORD = N''' + REPLACE(@pwd, N'''', N'''''')
  + N''', CHECK_POLICY = ON, CHECK_EXPIRATION = OFF, DEFAULT_DATABASE = ' + QUOTENAME(@db) + N';';
${NULL_GUARD}
EXEC sys.sp_executesql @sql;`;

const USER_SQL = `DECLARE @sql NVARCHAR(MAX) =
  CASE WHEN DATABASE_PRINCIPAL_ID(@login) IS NULL
    THEN N'CREATE USER ' + QUOTENAME(@login) + N' FOR LOGIN ' + QUOTENAME(@login) + N';'
    ELSE N'ALTER USER ' + QUOTENAME(@login) + N' WITH LOGIN = ' + QUOTENAME(@login) + N';' END;
${NULL_GUARD}
EXEC sys.sp_executesql @sql;`;

const ROLE_MEMBER_SQL = `IF DATABASE_PRINCIPAL_ID(@role) IS NOT NULL AND DATABASE_PRINCIPAL_ID(@member) IS NOT NULL
   AND ISNULL(IS_ROLEMEMBER(@role, @member), 0) = 0
BEGIN
  DECLARE @sql NVARCHAR(MAX) = N'ALTER ROLE ' + QUOTENAME(@role) + N' ADD MEMBER ' + QUOTENAME(@member) + N';';
  ${NULL_GUARD}
  EXEC sys.sp_executesql @sql;
END;`;

function invalid(message: string): OrcError {
  return new OrcError('validation_failed', message);
}

export function assertBootstrapDbName(db: string): string {
  if (typeof db !== 'string' || !DB_NAME_PATTERN.test(db)) throw invalid('DB_NAME must match ^[A-Za-z][A-Za-z0-9_]{0,127}$');
  return db;
}

export function assertBootstrapLogin(login: string): BootstrapLogin {
  if (!(BOOTSTRAP_LOGINS as readonly string[]).includes(login)) throw invalid('Login name is not one of the orc logins');
  return login as BootstrapLogin;
}

export function assertBootstrapPassword(password: string, field: string): string {
  if (typeof password !== 'string' || !SQL_LOGIN_PASSWORD_REGEX.test(password)) {
    throw invalid(`${field} must match SQL_LOGIN_PASSWORD_REGEX (16..128 chars, no quotes, brackets, backslash, $ or whitespace)`);
  }
  return password;
}

export function createDatabaseStatement(db: string): BootstrapStatement {
  return { sql: CREATE_DATABASE_SQL, inputs: [['db', assertBootstrapDbName(db)]] };
}

export function configureDatabaseStatement(db: string): BootstrapStatement {
  return { sql: CONFIGURE_DATABASE_SQL, inputs: [['db', assertBootstrapDbName(db)]] };
}

export function loginStatement(login: string, password: string, db: string): BootstrapStatement {
  return {
    sql: LOGIN_SQL,
    inputs: [
      ['login', assertBootstrapLogin(login)],
      ['pwd', assertBootstrapPassword(password, `password of ${login}`)],
      ['db', assertBootstrapDbName(db)],
    ],
  };
}

export function userStatement(login: string): BootstrapStatement {
  return { sql: USER_SQL, inputs: [['login', assertBootstrapLogin(login)]] };
}

export function roleMemberStatement(role: string, member: string): BootstrapStatement {
  if (!ALLOWED_ROLES.has(role)) throw invalid('Role is not one of the bootstrap roles');
  return { sql: ROLE_MEMBER_SQL, inputs: [['role', role], ['member', assertBootstrapLogin(member)]] };
}

async function exec(pool: sql.ConnectionPool, statement: BootstrapStatement): Promise<void> {
  const req = new sql.Request(pool);
  for (const [name, value] of statement.inputs) req.input(name, sql.NVarChar(256), value);
  await req.query(statement.sql);
}

export interface BootstrapOptions {
  /** Server connection settings; user/password/database are replaced by `sa` / `saPassword` / master+app DB. */
  server: DatabaseConfig;
  saPassword: string;
  database: string;
  passwords: Readonly<Record<BootstrapLogin, string>>;
  logger: Logger;
}

export interface BootstrapReport {
  database: string;
  logins: BootstrapLogin[];
}

/** Idempotent: creates the DB if missing, sets RCSI, creates or rotates the four logins, maps users, adds roles. */
export async function bootstrapDatabase(opts: BootstrapOptions): Promise<BootstrapReport> {
  const db = assertBootstrapDbName(opts.database);
  const statements = BOOTSTRAP_LOGINS.map((login) => loginStatement(login, opts.passwords[login], db));
  if (typeof opts.saPassword !== 'string' || opts.saPassword.length === 0) throw invalid('MSSQL_SA_PASSWORD is required');

  const asSa = (database: string): DatabaseConfig =>
    validateDatabaseConfig({ ...opts.server, user: 'sa', password: opts.saPassword, database, poolMin: 0, poolMax: 1 });

  const master = new sql.ConnectionPool(buildPoolConfig(asSa('master')));
  try {
    await master.connect();
    await exec(master, createDatabaseStatement(db));
    await exec(master, configureDatabaseStatement(db));
    for (const statement of statements) await exec(master, statement);
  } catch (err) {
    throw mapSqlError(err);
  } finally {
    await master.close();
  }
  opts.logger.info({ database: db }, 'database and logins ready');

  const app = new sql.ConnectionPool(buildPoolConfig(asSa(db)));
  try {
    await app.connect();
    for (const login of BOOTSTRAP_LOGINS) await exec(app, userStatement(login));
    for (const [role, member] of BOOTSTRAP_ROLE_MEMBERSHIPS) await exec(app, roleMemberStatement(role, member));
  } catch (err) {
    throw mapSqlError(err);
  } finally {
    await app.close();
  }
  opts.logger.info({ database: db, logins: BOOTSTRAP_LOGINS }, 'database users and role memberships ready');
  return { database: db, logins: [...BOOTSTRAP_LOGINS] };
}
