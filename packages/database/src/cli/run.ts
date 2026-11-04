// `orc-db` command implementation (contract §4.2-§4.4, §16.5). Importable so the integration global setup
// runs exactly the same code as the bundled CLI. Passwords are never accepted from argv.
import { OrcError, isOrcError } from '@orc/shared';
import { loadDbCliConfig } from '@orc/shared/node';
import type { DbCliConfig, Env } from '@orc/shared/node';
import { createLogger, serializeError } from '@orc/logger';
import type { Logger } from '@orc/logger';
import { createSecretRegistry, maskText } from '@orc/security';
import type { ScryptParams, SecretRegistry } from '@orc/security';
import { backupDatabase } from '../admin/backup.js';
import { BOOTSTRAP_LOGINS, bootstrapDatabase } from '../admin/bootstrap.js';
import type { BootstrapLogin } from '../admin/bootstrap.js';
import { createAdminUser } from '../admin/create-admin.js';
import { purgeAuditLogs } from '../admin/purge-audit.js';
import { assertSeedModel, readSeedFile, runSeed } from '../admin/seed.js';
import { createDatabase } from '../database.js';
import { MigrationChecksumError } from '../errors.js';
import { loadMigrations, runMigrations } from '../migrations.js';
import { defaultMigrationsDir, defaultSeedFile } from '../paths.js';
import { assertDatabaseGuard, buildPoolConfig, validateDatabaseConfig } from '../pool-config.js';
import { sql } from '../sql.js';
import type { Database } from '../types.js';
import { readSecret } from './secret-input.js';
import type { SecretInputStream } from './secret-input.js';

export const ORC_DB_COMMANDS = ['bootstrap', 'migrate', 'seed', 'create-admin', 'backup', 'purge-audit'] as const;
export type OrcDbCommand = (typeof ORC_DB_COMMANDS)[number];

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_CHECKSUM_MISMATCH = 2;

export const USAGE = `Usage: orc-db <command> [options]

Commands:
  bootstrap                       Create the database, logins (orc_migrator, orc_api, orc_worker, orc_backup),
                                  users and role memberships. Connects as sa (MSSQL_SA_PASSWORD[_FILE]).
  migrate                         Apply pending numbered migrations as orc_migrator (exit 2 on checksum mismatch).
  seed                            Idempotently MERGE the teams and agents catalogue (CLAUDE_DEFAULT_MODEL).
  create-admin --username <u> [--display-name <d>]
                                  Create an admin user. The password is read from ORC_ADMIN_PASSWORD[_FILE]
                                  or from stdin (no echo); it is never accepted as an argument.
  backup                          Full backup of DB_NAME into BACKUP_DIR on the SQL Server host.
  purge-audit --before <ISO date> [--dry-run]
                                  Delete AuditLogs older than the date (must be at least 365 days ago).

Connection settings come from the environment (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD[_FILE], ...).
`;

interface OptionSpec {
  readonly takesValue: boolean;
}

const COMMAND_OPTIONS: Readonly<Record<OrcDbCommand, Readonly<Record<string, OptionSpec>>>> = {
  bootstrap: {},
  migrate: {},
  seed: {},
  'create-admin': { username: { takesValue: true }, 'display-name': { takesValue: true } },
  backup: {},
  'purge-audit': { before: { takesValue: true }, 'dry-run': { takesValue: false } },
};

export type ParsedArgs =
  | { kind: 'help' }
  | { kind: 'command'; command: OrcDbCommand; options: Readonly<Record<string, string | true>> };

function usageError(message: string): OrcError {
  return new OrcError('validation_failed', message, { details: { usage: true } });
}

/** Parses `<command> [--opt value | --opt=value | --flag]`. Any password-like option is refused. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') return { kind: 'help' };
  if (!(ORC_DB_COMMANDS as readonly string[]).includes(command)) throw usageError(`Unknown command: ${command}`);
  const cmd = command as OrcDbCommand;
  const spec = COMMAND_OPTIONS[cmd];
  const options: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? '';
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (!arg.startsWith('--')) throw usageError(`Unexpected argument for ${cmd}`);
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq >= 0 ? eq : undefined);
    if (/pass|pwd|secret/i.test(name)) {
      throw usageError('Passwords are never accepted on the command line; use the *_PASSWORD_FILE variables or stdin');
    }
    const opt = spec[name];
    if (!opt) throw usageError(`Unknown option --${name} for ${cmd}`);
    if (name in options) throw usageError(`Option --${name} given twice`);
    if (!opt.takesValue) {
      if (eq >= 0) throw usageError(`Option --${name} takes no value`);
      options[name] = true;
      continue;
    }
    let value: string | undefined;
    if (eq >= 0) value = arg.slice(eq + 1);
    else {
      value = rest[i + 1];
      i += 1;
    }
    if (value === undefined || value === '' || value.startsWith('--')) throw usageError(`Option --${name} needs a value`);
    options[name] = value;
  }
  return { kind: 'command', command: cmd, options };
}

export interface CliIo {
  env: Env;
  stdin: SecretInputStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** Overrides used by tests (e.g. a cheaper scrypt cost or a fixed migrations directory). */
  overrides?: { migrationsDir?: string; seedFile?: string; scrypt?: ScryptParams; logger?: Logger };
}

function requireValue(value: string | null | undefined, key: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new OrcError('config_invalid', `${key} is required for this command`);
  return value;
}

function registerSecrets(cfg: DbCliConfig, secrets: SecretRegistry): void {
  for (const value of [
    cfg.db.password,
    cfg.mssqlSaPassword,
    cfg.dbMigratorPassword,
    cfg.dbApiPassword,
    cfg.dbWorkerPassword,
    cfg.dbBackupPassword,
    cfg.orcAdminPassword,
  ]) {
    secrets.add(value);
  }
}

async function withDatabase<R>(cfg: DbCliConfig, logger: Logger, secrets: SecretRegistry, fn: (db: Database) => Promise<R>): Promise<R> {
  const db = await createDatabase(cfg.db, { logger, secrets }, { nodeEnv: cfg.nodeEnv });
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

async function withDedicatedPool<R>(cfg: DbCliConfig, fn: (pool: sql.ConnectionPool) => Promise<R>): Promise<R> {
  const config = validateDatabaseConfig(cfg.db);
  assertDatabaseGuard(config, cfg.nodeEnv);
  const pool = new sql.ConnectionPool(buildPoolConfig(config, { poolMax: 1, poolMin: 0 }));
  try {
    await pool.connect();
  } catch (err) {
    throw new OrcError('db_unavailable', 'Database connection failed', { cause: err });
  }
  try {
    return await fn(pool);
  } finally {
    await pool.close();
  }
}

async function execute(
  parsed: Extract<ParsedArgs, { kind: 'command' }>,
  cfg: DbCliConfig,
  io: CliIo,
  logger: Logger,
  secrets: SecretRegistry,
): Promise<Record<string, unknown>> {
  const { command, options } = parsed;
  switch (command) {
    case 'bootstrap': {
      assertDatabaseGuard(cfg.db, cfg.nodeEnv);
      const passwords: Record<BootstrapLogin, string> = {
        orc_migrator: requireValue(cfg.dbMigratorPassword, 'DB_MIGRATOR_PASSWORD'),
        orc_api: requireValue(cfg.dbApiPassword, 'DB_API_PASSWORD'),
        orc_worker: requireValue(cfg.dbWorkerPassword, 'DB_WORKER_PASSWORD'),
        orc_backup: requireValue(cfg.dbBackupPassword, 'DB_BACKUP_PASSWORD'),
      };
      const report = await bootstrapDatabase({
        server: cfg.db,
        saPassword: requireValue(cfg.mssqlSaPassword, 'MSSQL_SA_PASSWORD'),
        database: cfg.db.database,
        passwords,
        logger,
      });
      return { database: report.database, logins: [...BOOTSTRAP_LOGINS] };
    }
    case 'migrate': {
      const files = await loadMigrations(io.overrides?.migrationsDir ?? defaultMigrationsDir());
      const report = await withDedicatedPool(cfg, (pool) => runMigrations(pool, files, { logger }));
      return { applied: report.applied, skipped: report.skipped, durationMs: report.durationMs };
    }
    case 'seed': {
      const model = assertSeedModel(cfg.claudeDefaultModel);
      const sqlText = await readSeedFile(io.overrides?.seedFile ?? defaultSeedFile());
      const report = await withDedicatedPool(cfg, (pool) => runSeed(pool, { sqlText, defaultModel: model }, { logger }));
      return { teams: report.teams, agents: report.agents };
    }
    case 'create-admin': {
      const username = options['username'];
      if (typeof username !== 'string') throw usageError('create-admin requires --username <u>');
      const displayName = options['display-name'];
      const password =
        cfg.orcAdminPassword ?? (await readSecret(io.stdin, io.stderr, `Password for ${username}`));
      secrets.add(password);
      const user = await withDatabase(cfg, logger, secrets, (db) =>
        createAdminUser(db, {
          username,
          displayName: typeof displayName === 'string' ? displayName : null,
          password,
          scrypt: io.overrides?.scrypt,
        }),
      );
      return { userId: user.id, username: user.username, role: user.role };
    }
    case 'backup': {
      assertDatabaseGuard(cfg.db, cfg.nodeEnv);
      const report = await backupDatabase({ config: cfg.db, backupDir: cfg.backupDir, logger });
      return { database: report.database, path: report.path, durationMs: report.durationMs };
    }
    case 'purge-audit': {
      const before = options['before'];
      if (typeof before !== 'string') throw usageError('purge-audit requires --before <ISO date>');
      const report = await withDatabase(cfg, logger, secrets, (db) =>
        purgeAuditLogs(db, { before, dryRun: options['dry-run'] === true, logger }),
      );
      return { before: report.before, dryRun: report.dryRun, deleted: report.deleted };
    }
  }
}

function describeError(err: unknown, secrets: SecretRegistry): string {
  if (isOrcError(err)) {
    const issues =
      'issues' in err && Array.isArray(err.issues)
        ? (err.issues as readonly { path: string; message: string }[]).map((i) => ` ${i.path}: ${i.message}`).join(';')
        : '';
    return maskText(`${err.code}: ${err.message}${issues ? ` (${issues.trim()})` : ''}`, secrets);
  }
  return maskText(err instanceof Error ? err.message : String(err), secrets);
}

/** Runs one orc-db command. Resolves with the process exit code (0 ok, 1 failure, 2 migration checksum mismatch). */
export async function runOrcDb(argv: readonly string[], io: CliIo): Promise<number> {
  const secrets = createSecretRegistry();
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    io.stderr.write(`orc-db: ${describeError(err, secrets)}\n\n${USAGE}`);
    return EXIT_FAILURE;
  }
  if (parsed.kind === 'help') {
    io.stdout.write(USAGE);
    return EXIT_OK;
  }

  let logger: Logger | undefined = io.overrides?.logger;
  try {
    const cfg = loadDbCliConfig(io.env);
    registerSecrets(cfg, secrets);
    logger ??= createLogger({
      service: 'db-cli',
      level: cfg.logLevel,
      pretty: cfg.logPretty,
      version: cfg.appVersion,
      env: cfg.nodeEnv,
      destination: io.stderr,
      secrets,
    });
    const result = await execute(parsed, cfg, io, logger, secrets);
    io.stdout.write(`${JSON.stringify({ command: parsed.command, ok: true, ...result })}\n`);
    return EXIT_OK;
  } catch (err) {
    logger?.debug({ err: serializeError(err) }, 'orc-db command failed');
    io.stderr.write(`orc-db ${parsed.command}: ${describeError(err, secrets)}\n`);
    return err instanceof MigrationChecksumError ? EXIT_CHECKSUM_MISMATCH : EXIT_FAILURE;
  }
}
