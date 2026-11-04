// `orc-db backup` (contract §16.5): full database backup to BACKUP_DIR on the SQL Server host.
// Runs as the connecting login (orc_backup: db_backupoperator). BACKUP DATABASE takes the database name,
// the disk path and the backup-set name as variables, so the batch is constant and fully parameterized.
import { OrcError } from '@orc/shared';
import type { Logger } from '@orc/logger';
import { mapSqlError } from '../errors.js';
import { DB_NAME_PATTERN, buildPoolConfig, validateDatabaseConfig } from '../pool-config.js';
import { sql } from '../sql.js';
import type { DatabaseConfig } from '../types.js';

/** Backups can take far longer than an ordinary request. */
export const BACKUP_REQUEST_TIMEOUT_MS = 3_600_000;

const BACKUP_SQL = 'BACKUP DATABASE @db TO DISK = @path WITH INIT, CHECKSUM, NAME = @name;';

/** Server-side directory: absolute POSIX or Windows path without quotes, wildcards, control characters or `..`. */
const BACKUP_DIR_PATTERN = /^(?:\/|[A-Za-z]:[\\/])[^"'*?<>|]*$/;

function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function assertBackupDir(dir: string): string {
  const trimmed = dir.trim();
  if (
    !BACKUP_DIR_PATTERN.test(trimmed) ||
    hasControlChars(trimmed) ||
    trimmed.split(/[\\/]/).includes('..') ||
    trimmed.length > 200
  ) {
    throw new OrcError('config_invalid', 'BACKUP_DIR must be an absolute server path (no quotes, control characters or ..)');
  }
  return trimmed.replace(/[\\/]+$/, '') || '/';
}

/** `<dir>/<db>_<yyyyMMddTHHmmssZ>.bak` using the separator style of `dir`. */
export function backupFilePath(dir: string, database: string, at: Date): string {
  const base = assertBackupDir(dir);
  if (!DB_NAME_PATTERN.test(database)) throw new OrcError('config_invalid', 'DB_NAME is not a plain SQL identifier');
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return `${base === '/' ? '' : base}${sep}${database}_${stamp}.bak`;
}

export interface BackupReport {
  database: string;
  path: string;
  durationMs: number;
}

export async function backupDatabase(opts: {
  config: DatabaseConfig;
  backupDir: string;
  logger: Logger;
  now?: Date;
}): Promise<BackupReport> {
  const config = validateDatabaseConfig(opts.config);
  const path = backupFilePath(opts.backupDir, config.database, opts.now ?? new Date());
  const started = Date.now();
  const pool = new sql.ConnectionPool({
    ...buildPoolConfig(config, { poolMax: 1, poolMin: 0 }),
    requestTimeout: Math.max(config.requestTimeoutMs, BACKUP_REQUEST_TIMEOUT_MS),
  });
  try {
    await pool.connect();
    const req = new sql.Request(pool);
    req.input('db', sql.NVarChar(128), config.database);
    req.input('path', sql.NVarChar(260), path);
    req.input('name', sql.NVarChar(128), `${config.database} full backup`);
    await req.query(BACKUP_SQL);
  } catch (err) {
    throw mapSqlError(err);
  } finally {
    await pool.close();
  }
  const durationMs = Date.now() - started;
  opts.logger.info({ database: config.database, path, durationMs }, 'database backup written');
  return { database: config.database, path, durationMs };
}
