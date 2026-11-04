import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXPECTED_SCHEMA_VERSION, defaultMigrationsDir, loadMigrations, migrationChecksum, splitBatches } from '@orc/database';

const dirs: string[] = [];
async function tempDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orc-test-migrations-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('splitBatches', () => {
  it('splits on GO lines (case-insensitive, optional trailing comment)', () => {
    const text = 'CREATE TABLE a (x INT);\nGO\ncreate table b (y int);\n  go  -- second\nSELECT 1;\n';
    expect(splitBatches(text)).toEqual(['CREATE TABLE a (x INT);', 'create table b (y int);', 'SELECT 1;']);
  });

  it('does not split on GO inside identifiers or statements', () => {
    expect(splitBatches('SELECT 1 AS GOAL;\nGOTO x;\n')).toHaveLength(1);
  });

  it('handles CRLF and drops empty or comment-only batches', () => {
    expect(splitBatches('-- header\r\nGO\r\n\r\nSELECT 1;\r\nGO\r\nGO\r\n')).toEqual(['SELECT 1;']);
  });
});

describe('migrationChecksum', () => {
  it('is sha256 hex of the text with CRLF normalized to LF', () => {
    expect(migrationChecksum('a\r\nb\n')).toBe(migrationChecksum('a\nb\n'));
    expect(migrationChecksum(Buffer.from('a\r\nb'))).toMatch(/^[0-9a-f]{64}$/);
    expect(migrationChecksum('a')).not.toBe(migrationChecksum('b'));
  });
});

describe('loadMigrations', () => {
  it('loads contiguous NNNN_name.sql files in order', async () => {
    const dir = await tempDir({ '0002_b.sql': 'SELECT 2;', '0001_a.sql': 'SELECT 1;\r\n', 'README.txt': 'ignored' });
    const files = await loadMigrations(dir);
    expect(files.map((f) => [f.version, f.name, f.file])).toEqual([
      [1, 'a', '0001_a.sql'],
      [2, 'b', '0002_b.sql'],
    ]);
    expect(files[0]?.sql).toBe('SELECT 1;\n');
    expect(files[0]?.checksum).toBe(migrationChecksum('SELECT 1;\n'));
  });

  it.each([
    ['a gap', { '0001_a.sql': 'x', '0003_c.sql': 'x' }, /missing 0002/],
    ['a duplicate version', { '0001_a.sql': 'x', '0001_b.sql': 'x' }, /Duplicate migration version 1/],
    ['an invalid name', { '0001_A-B.sql': 'x' }, /Invalid migration file name/],
    ['not starting at 0001', { '0002_b.sql': 'x' }, /missing 0001/],
  ])('rejects %s', async (_label, files, message) => {
    const dir = await tempDir(files);
    await expect(loadMigrations(dir)).rejects.toThrow(message);
  });

  it('ships 0001 and 0002 and EXPECTED_SCHEMA_VERSION matches the highest', async () => {
    const files = await loadMigrations(defaultMigrationsDir());
    expect(files.map((f) => f.file)).toEqual(['0001_core_schema.sql', '0002_roles_and_grants.sql']);
    expect(EXPECTED_SCHEMA_VERSION).toBe(files[files.length - 1]?.version);
    for (const f of files) expect(splitBatches(f.sql).length).toBeGreaterThan(1);
  });

  it('0002 grants objects only (no schema-wide grants, no EXECUTE) and denies AuditLogs changes', async () => {
    const [, grants] = await loadMigrations(defaultMigrationsDir());
    const text = grants?.sql ?? '';
    expect(text).not.toMatch(/^\s*GRANT[^\n]*ON\s+SCHEMA::/im);
    expect(text).not.toMatch(/^\s*GRANT\s+EXECUTE/im);
    expect(text).toMatch(/DENY UPDATE, DELETE ON orc\.AuditLogs TO orc_api_role, orc_worker_role;/);
    expect(text).toMatch(/DENY ALTER, REFERENCES, TAKE OWNERSHIP, VIEW DEFINITION ON SCHEMA::orc TO orc_api_role, orc_worker_role;/);
  });
});
