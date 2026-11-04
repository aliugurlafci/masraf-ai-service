// §4.4 migration runner against orchestrator_test (as orc_migrator on dedicated max-1 pools).
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import sql from 'mssql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EXPECTED_SCHEMA_VERSION,
  MigrationChecksumError,
  buildPoolConfig,
  defaultMigrationsDir,
  loadMigrations,
  migrationChecksum,
  runMigrations,
} from '@orc/database';
import type { MigrationFile } from '@orc/database';
import { runOrcDb } from '../../../packages/database/src/cli/run';
import { query, resetDb } from '../../helpers/database/db';
import { silentLogger, testDbConfig, testEnv } from '../../helpers/database/env';

const logger = silentLogger();

class Capture extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
    this.text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    cb();
  }
}

async function migratorPool(): Promise<sql.ConnectionPool> {
  const pool = new sql.ConnectionPool(buildPoolConfig(testDbConfig('orc_migrator'), { poolMax: 1, poolMin: 0 }));
  await pool.connect();
  return pool;
}

function extraMigration(version: number, name: string, text: string): MigrationFile {
  return {
    version,
    name,
    file: `${String(version).padStart(4, '0')}_${name}.sql`,
    sql: text,
    checksum: migrationChecksum(text),
  };
}

async function appliedVersions(pool: sql.ConnectionPool): Promise<{ Version: number; Checksum: string; AppliedBy: string }[]> {
  return query(pool, 'SELECT Version, Checksum, AppliedBy FROM orc.SchemaMigrations ORDER BY Version;');
}

describe('migration runner', () => {
  let shipped: MigrationFile[];
  let pool: sql.ConnectionPool;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    shipped = await loadMigrations(defaultMigrationsDir());
    pool = await migratorPool();
  });

  afterAll(async () => {
    await query(
      pool,
      `IF OBJECT_ID(N'orc.MigrationProbe', N'U') IS NOT NULL DROP TABLE orc.MigrationProbe;
       DELETE FROM orc.SchemaMigrations WHERE Version > @max;`,
      [['max', sql.Int, EXPECTED_SCHEMA_VERSION]],
    );
    await pool.close();
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await resetDb();
  });

  it('global setup applied every shipped migration with matching checksums as orc_migrator', async () => {
    const rows = await appliedVersions(pool);
    expect(rows.map((r) => r.Version)).toEqual(shipped.map((f) => f.version));
    expect(rows.map((r) => r.Checksum)).toEqual(shipped.map((f) => f.checksum));
    expect(new Set(rows.map((r) => r.AppliedBy))).toEqual(new Set(['orc_migrator']));
  });

  it('is idempotent: a second run applies nothing', async () => {
    const report = await runMigrations(pool, shipped, { logger });
    expect(report.applied).toEqual([]);
    expect(report.skipped).toEqual(shipped.map((f) => f.version));
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('detects a checksum mismatch and applies nothing', async () => {
    const tampered = shipped.map((f) =>
      f.version === 2 ? { ...f, sql: `${f.sql}\n-- edited`, checksum: migrationChecksum(`${f.sql}\n-- edited`) } : f,
    );
    const pending = extraMigration(3, 'never_applied', 'CREATE TABLE orc.MigrationProbe (Id INT NOT NULL);');
    await expect(runMigrations(pool, [...tampered, pending], { logger })).rejects.toBeInstanceOf(MigrationChecksumError);
    expect((await appliedVersions(pool)).map((r) => r.Version)).toEqual([1, 2]);
    const [probe] = await query<{ Id: number | null }>(pool, "SELECT OBJECT_ID(N'orc.MigrationProbe', N'U') AS Id;");
    expect(probe?.Id).toBeNull();
  });

  it('refuses an applied version without a file', async () => {
    await expect(runMigrations(pool, shipped.slice(0, 1), { logger })).rejects.toBeInstanceOf(MigrationChecksumError);
  });

  it('orc-db migrate exits with code 2 on a checksum mismatch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orc-test-migrations-'));
    tempDirs.push(dir);
    await cp(defaultMigrationsDir(), dir, { recursive: true });
    const file = join(dir, '0001_core_schema.sql');
    await writeFile(file, `${await readFile(file, 'utf8')}\n-- tampered\n`);
    const stderr = new Capture();
    const code = await runOrcDb(['migrate'], {
      env: testEnv(),
      stdin: Readable.from([]),
      stdout: new Capture(),
      stderr,
      overrides: { migrationsDir: dir, logger },
    });
    expect(code).toBe(2);
    expect(stderr.text).toContain('migration_checksum_mismatch');
  });

  it('rolls back a failing migration file completely', async () => {
    const broken = extraMigration(
      3,
      'broken',
      'CREATE TABLE orc.MigrationProbe (Id INT NOT NULL);\nGO\nINSERT INTO orc.NoSuchTable (X) VALUES (1);\n',
    );
    await expect(runMigrations(pool, [...shipped, broken], { logger })).rejects.toMatchObject({ code: 'internal_error' });
    expect((await appliedVersions(pool)).map((r) => r.Version)).toEqual([1, 2]);
    const [probe] = await query<{ Id: number | null }>(pool, "SELECT OBJECT_ID(N'orc.MigrationProbe', N'U') AS Id;");
    expect(probe?.Id).toBeNull();
  });

  it('serializes concurrent migrators with the transaction-owned applock', async () => {
    // The file sleeps while holding the lock; a non-exclusive runner would fail with "object already exists".
    const slow = extraMigration(
      3,
      'concurrency_probe',
      "CREATE TABLE orc.MigrationProbe (Id INT NOT NULL);\nGO\nWAITFOR DELAY '00:00:01.500';\nINSERT INTO orc.MigrationProbe (Id) VALUES (1);\n",
    );
    const other = await migratorPool();
    try {
      const [a, b] = await Promise.all([
        runMigrations(pool, [...shipped, slow], { logger }),
        runMigrations(other, [...shipped, slow], { logger }),
      ]);
      const appliedBy = [a, b].filter((r) => r.applied.includes(3));
      expect(appliedBy).toHaveLength(1);
      expect([a, b].filter((r) => r.skipped.includes(3))).toHaveLength(1);
      const rows = await query<{ N: number }>(pool, 'SELECT COUNT(*) AS N FROM orc.MigrationProbe;');
      expect(rows[0]?.N).toBe(1);
      expect((await appliedVersions(pool)).map((r) => r.Version)).toEqual([1, 2, 3]);
    } finally {
      await other.close();
      await query(pool, 'DROP TABLE orc.MigrationProbe; DELETE FROM orc.SchemaMigrations WHERE Version = 3;');
    }
  });
});
