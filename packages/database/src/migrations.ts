// Numbered SQL migrations and the transaction-owned-applock runner (contract §2.5, §4.4; ADR-0018, T-M4).
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { OrcError } from '@orc/shared';
import type { Logger } from '@orc/logger';
import { MigrationChecksumError, MigrationLockError, mapSqlError } from './errors.js';
import { sql } from './sql.js';
import type { Row } from './sql.js';
import type { MigrationFile, MigrationReport } from './types.js';

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const GO_LINE = /^\s*GO\s*(--.*)?$/i;
const APPLOCK_RESOURCE = 'orc_migrations';
const APPLOCK_TIMEOUT_MS = 60_000;

/** sha256 hex of the file bytes with CRLF -> LF. */
export function migrationChecksum(bytes: Buffer | string): string {
  const text = typeof bytes === 'string' ? bytes : bytes.toString('utf8');
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** Loads `NNNN_name.sql` files (ascending, starting at 1); gaps or duplicates => error. */
export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: MigrationFile[] = [];
  const seen = new Map<number, string>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.sql')) continue;
    const m = FILE_PATTERN.exec(entry.name);
    if (!m) {
      throw new OrcError('internal_error', `Invalid migration file name: ${entry.name}`);
    }
    const version = Number(m[1]);
    const previous = seen.get(version);
    if (previous !== undefined) {
      throw new OrcError('internal_error', `Duplicate migration version ${version}: ${previous}, ${entry.name}`);
    }
    seen.set(version, entry.name);
    const bytes = await readFile(join(dir, entry.name));
    files.push({
      version,
      name: m[2] ?? '',
      file: entry.name,
      sql: bytes.toString('utf8').replace(/\r\n/g, '\n'),
      checksum: migrationChecksum(bytes),
    });
  }
  files.sort((a, b) => a.version - b.version);
  files.forEach((f, i) => {
    if (f.version !== i + 1) {
      throw new OrcError('internal_error', `Migration versions must be contiguous from 0001; missing ${String(i + 1).padStart(4, '0')}`);
    }
  });
  return files;
}

/** Splits on lines matching /^\s*GO\s*(--.*)?$/i; drops batches that are empty or comments only. */
export function splitBatches(sqlText: string): string[] {
  const batches: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    const text = current.join('\n');
    const meaningful = text
      .split('\n')
      .some((line) => line.trim() !== '' && !line.trim().startsWith('--'));
    if (meaningful) batches.push(text.trim());
    current = [];
  };
  for (const line of sqlText.replace(/\r\n/g, '\n').split('\n')) {
    if (GO_LINE.test(line)) flush();
    else current.push(line);
  }
  flush();
  return batches;
}

const APPLOCK_SQL = `DECLARE @r INT;
EXEC @r = sys.sp_getapplock @Resource = @resource, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = @timeoutMs;
SELECT @r AS Result;`;

const ENSURE_SCHEMA_SQL = `IF SCHEMA_ID(N'orc') IS NULL EXEC(N'CREATE SCHEMA orc AUTHORIZATION dbo');
IF OBJECT_ID(N'orc.SchemaMigrations', N'U') IS NULL
  EXEC(N'CREATE TABLE orc.SchemaMigrations (
    Version INT NOT NULL CONSTRAINT PK_SchemaMigrations PRIMARY KEY,
    Name NVARCHAR(200) NOT NULL,
    Checksum CHAR(64) NOT NULL,
    AppliedAt DATETIME2(3) NOT NULL CONSTRAINT DF_SchemaMigrations_AppliedAt DEFAULT SYSUTCDATETIME(),
    DurationMs INT NOT NULL,
    AppliedBy NVARCHAR(128) NOT NULL CONSTRAINT DF_SchemaMigrations_AppliedBy DEFAULT SUSER_SNAME()
  )');`;

const SELECT_APPLIED_SQL = 'SELECT Version, Name, Checksum FROM orc.SchemaMigrations ORDER BY Version;';
const SELECT_ONE_SQL = 'SELECT Checksum FROM orc.SchemaMigrations WITH (UPDLOCK, HOLDLOCK) WHERE Version = @version;';
const INSERT_APPLIED_SQL =
  'INSERT INTO orc.SchemaMigrations (Version, Name, Checksum, DurationMs) VALUES (@version, @name, @checksum, @durationMs);';

async function acquireLock(tx: sql.Transaction): Promise<void> {
  const req = new sql.Request(tx);
  req.input('resource', sql.NVarChar(255), APPLOCK_RESOURCE);
  req.input('timeoutMs', sql.Int, APPLOCK_TIMEOUT_MS);
  const result = await req.query<Row>(APPLOCK_SQL);
  const code = result.recordset[0]?.['Result'];
  if (typeof code !== 'number' || code < 0) {
    throw new MigrationLockError(`sp_getapplock(${APPLOCK_RESOURCE}) failed with result ${String(code)}`);
  }
}

async function rollbackQuietly(tx: sql.Transaction): Promise<void> {
  try {
    await tx.rollback();
  } catch {
    // The server may already have rolled back (e.g. XACT_ABORT); nothing left to undo.
  }
}

async function inLockedTransaction<R>(pool: sql.ConnectionPool, fn: (tx: sql.Transaction) => Promise<R>): Promise<R> {
  const tx = new sql.Transaction(pool);
  await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
  try {
    await acquireLock(tx);
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (err) {
    await rollbackQuietly(tx);
    throw err;
  }
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

function toApplied(r: Row): AppliedRow {
  const version = r['Version'];
  const name = r['Name'];
  const checksum = r['Checksum'];
  if (typeof version !== 'number' || typeof name !== 'string' || typeof checksum !== 'string') {
    throw new OrcError('internal_error', 'Unexpected orc.SchemaMigrations row');
  }
  return { version, name, checksum: checksum.trim() };
}

/**
 * §4.4: pre-batch (lock, create schema + SchemaMigrations) committed; verify checksums of applied versions;
 * apply each pending file on ONE transaction that owns the applock (re-checking the version under the lock).
 * The pool should be dedicated (`max: 1`) and connected as orc_migrator.
 */
export async function runMigrations(
  pool: sql.ConnectionPool,
  files: readonly MigrationFile[],
  deps: { logger: Logger },
): Promise<MigrationReport> {
  const started = Date.now();
  const log = deps.logger;
  const sorted = [...files].sort((a, b) => a.version - b.version);
  try {
    await inLockedTransaction(pool, async (tx) => {
      await new sql.Request(tx).batch(ENSURE_SCHEMA_SQL);
    });

    const appliedRows = (await new sql.Request(pool).query<Row>(SELECT_APPLIED_SQL)).recordset.map(toApplied);
    const byVersion = new Map(sorted.map((f) => [f.version, f]));
    for (const row of appliedRows) {
      const file = byVersion.get(row.version);
      if (!file) {
        throw new MigrationChecksumError(`Applied migration ${row.version} (${row.name}) has no migration file`, {
          details: { version: row.version },
        });
      }
      if (file.checksum !== row.checksum) {
        throw new MigrationChecksumError(`Checksum mismatch for applied migration ${file.file}`, {
          details: { version: row.version, expected: row.checksum, actual: file.checksum },
        });
      }
    }

    const appliedVersions = new Set(appliedRows.map((r) => r.version));
    const report: MigrationReport = { applied: [], skipped: [...appliedVersions].sort((a, b) => a - b), durationMs: 0 };

    for (const file of sorted) {
      if (appliedVersions.has(file.version)) continue;
      const batches = splitBatches(file.sql);
      const fileStarted = Date.now();
      const outcome = await inLockedTransaction(pool, async (tx) => {
        const check = new sql.Request(tx);
        check.input('version', sql.Int, file.version);
        const existing = (await check.query<Row>(SELECT_ONE_SQL)).recordset[0];
        if (existing) {
          const checksum = typeof existing['Checksum'] === 'string' ? existing['Checksum'].trim() : '';
          if (checksum !== file.checksum) {
            throw new MigrationChecksumError(`Checksum mismatch for concurrently applied migration ${file.file}`, {
              details: { version: file.version },
            });
          }
          return 'skipped' as const;
        }
        for (const batch of batches) {
          await new sql.Request(tx).batch(batch);
        }
        const ins = new sql.Request(tx);
        ins.input('version', sql.Int, file.version);
        ins.input('name', sql.NVarChar(200), file.name);
        ins.input('checksum', sql.Char(64), file.checksum);
        ins.input('durationMs', sql.Int, Math.min(Date.now() - fileStarted, 2_147_483_647));
        await ins.query(INSERT_APPLIED_SQL);
        return 'applied' as const;
      });
      if (outcome === 'applied') {
        report.applied.push(file.version);
        log.info({ version: file.version, file: file.file, durationMs: Date.now() - fileStarted }, 'migration applied');
      } else {
        report.skipped.push(file.version);
        log.info({ version: file.version, file: file.file }, 'migration already applied by another migrator');
      }
    }
    report.skipped.sort((a, b) => a - b);
    report.durationMs = Date.now() - started;
    return report;
  } catch (err) {
    if (err instanceof MigrationChecksumError || err instanceof MigrationLockError) throw err;
    if (err instanceof OrcError) throw err;
    const mapped = mapSqlError(err);
    log.error({ code: mapped.code, message: err instanceof Error ? err.message : String(err) }, 'migration failed');
    throw new OrcError(mapped.code === 'db_unavailable' ? 'db_unavailable' : 'internal_error', `Migration failed: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
}
