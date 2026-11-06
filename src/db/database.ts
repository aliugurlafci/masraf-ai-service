import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sql from 'mssql';
import type { DbConfig } from '../config.ts';
import { execute, poolConfig, query, transaction, type Db } from './sql.ts';

export const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');
const MIGRATION_FILE = /^(\d{3})_[a-z0-9_]+\.sql$/;
const DB_NAME = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;

export class DatabaseError extends Error {
  override readonly name = 'DatabaseError';
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Connects, retrying while SQL Server is still starting (a fresh container needs 10–30 s). */
async function connectWithRetry(config: sql.config, waitMs: number): Promise<Db> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const pool = new sql.ConnectionPool(config);
    try {
      return await pool.connect();
    } catch (err) {
      await pool.close().catch(() => {});
      const code = (err as { code?: string }).code;
      // Wrong password or user: waiting will not help.
      if (code === 'ELOGIN' || Date.now() >= deadline) throw err;
      await sleep(2_000);
    }
  }
}

function describeConnectError(config: DbConfig, err: unknown): DatabaseError {
  const code = (err as { code?: string }).code;
  const where = `${config.host}:${config.port}`;
  if (code === 'ELOGIN') {
    return new DatabaseError(
      `Veritabanına giriş yapılamadı (${where}, kullanıcı ${config.user}). MSSQL_USER ve MSSQL_PASSWORD değerlerini kontrol edin.`,
    );
  }
  return new DatabaseError(
    `Veritabanına bağlanılamadı (${where}). SQL Server'ı "npm run db:up" ile başlatın ve MSSQL_HOST/MSSQL_PORT değerlerini kontrol edin.`,
  );
}

/** Creates the database when it does not exist yet. The name is validated, then quoted. */
async function ensureDatabase(config: DbConfig, database: string): Promise<void> {
  if (!DB_NAME.test(database)) throw new DatabaseError(`Geçersiz veritabanı adı: ${database}`);
  let master: Db;
  try {
    master = await connectWithRetry(poolConfig({ ...config, poolMax: 1 }, 'master'), config.connectWaitMs);
  } catch (err) {
    throw describeConnectError(config, err);
  }
  try {
    await execute(
      master,
      `IF DB_ID(@name) IS NULL
       BEGIN
         DECLARE @sql NVARCHAR(400) = N'CREATE DATABASE ' + QUOTENAME(@name);
         EXEC (@sql);
       END`,
      { name: { type: sql.NVarChar(128), value: database } },
    );
  } finally {
    await master.close();
  }
}

export interface Migration {
  readonly version: number;
  readonly name: string;
  /** Batches split on GO lines, as in SSMS and sqlcmd. */
  readonly batches: readonly string[];
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => MIGRATION_FILE.test(f)).sort();
  const out: Migration[] = [];
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8');
    const batches = text
      .split(/^\s*GO\s*$/im)
      .map((b) => b.trim())
      .filter((b) => b !== '');
    out.push({ version: Number(file.slice(0, 3)), name: file, batches });
  }
  return out;
}

/**
 * Applies the migrations that have not run yet, each in its own transaction. An application lock keeps
 * two servers starting at once from running the same migration twice.
 */
export async function migrate(db: Db, migrations?: readonly Migration[]): Promise<string[]> {
  const all = migrations ?? (await loadMigrations());
  await execute(
    db,
    `IF OBJECT_ID(N'dbo.sema_surumleri', N'U') IS NULL
       CREATE TABLE dbo.sema_surumleri (
         surum INT NOT NULL PRIMARY KEY,
         ad NVARCHAR(200) NOT NULL,
         uygulanma DATETIME2(3) NOT NULL CONSTRAINT df_sema_surumleri_uygulanma DEFAULT SYSUTCDATETIME()
       )`,
  );
  // A database built from migration files that are gone (merged or renamed) would skip a new file
  // that reuses one of their numbers, so it is refused instead of being taken as up to date.
  const files = new Map(all.map((m) => [m.version, m.name]));
  const unknown = (await query<{ surum: number; ad: string }>(db, 'SELECT surum, ad FROM dbo.sema_surumleri ORDER BY surum')).filter(
    (r) => files.get(r.surum) !== r.ad,
  );
  if (unknown.length > 0) {
    throw new DatabaseError(
      `Veritabanı artık bulunmayan şema dosyalarıyla kurulmuş (${unknown.map((r) => r.ad).join(', ')}). ` +
        'Bu veritabanını silin ya da MSSQL_DATABASE ile başka bir ad verin; sunucu şemayı baştan kurar.',
    );
  }
  const applied: string[] = [];
  for (const m of all) {
    const done = await transaction(db, async (tx) => {
      await execute(tx, `EXEC sp_getapplock @Resource = N'masraf_migrate', @LockMode = N'Exclusive', @LockOwner = N'Transaction', @LockTimeout = 60000`);
      const seen = await query(tx, 'SELECT 1 AS x FROM dbo.sema_surumleri WHERE surum = @v', { v: { type: sql.Int, value: m.version } });
      if (seen.length > 0) return false;
      for (const batch of m.batches) await execute(tx, batch);
      await execute(tx, 'INSERT INTO dbo.sema_surumleri (surum, ad) VALUES (@v, @ad)', {
        v: { type: sql.Int, value: m.version },
        ad: { type: sql.NVarChar(200), value: m.name },
      });
      return true;
    });
    if (done) applied.push(m.name);
  }
  return applied;
}

export interface OpenOptions {
  /** Overrides config.database (tests use their own databases). */
  readonly database?: string;
}

/** Makes sure the database exists and is up to date, then returns a connection pool. */
export async function openDatabase(config: DbConfig, opts: OpenOptions = {}): Promise<Db> {
  const database = opts.database ?? config.database;
  await ensureDatabase(config, database);
  let db: Db;
  try {
    db = await connectWithRetry(poolConfig(config, database), config.connectWaitMs);
  } catch (err) {
    throw describeConnectError(config, err);
  }
  try {
    await migrate(db);
  } catch (err) {
    await db.close();
    throw new DatabaseError(`Veritabanı şeması güncellenemedi: ${err instanceof Error ? err.message : String(err)}`);
  }
  return db;
}
