import { PassThrough, Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { assertBackupDir, backupFilePath } from '../../../packages/database/src/admin/backup';
import { parsePurgeBefore } from '../../../packages/database/src/admin/purge-audit';
import { assertSeedModel } from '../../../packages/database/src/admin/seed';
import { USAGE, parseArgs, runOrcDb } from '../../../packages/database/src/cli/run';
import { readSecret, readSecretLine } from '../../../packages/database/src/cli/secret-input';

class Capture extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
    this.text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    cb();
  }
}

describe('parseArgs', () => {
  it('parses commands and options', () => {
    expect(parseArgs([])).toEqual({ kind: 'help' });
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['migrate'])).toEqual({ kind: 'command', command: 'migrate', options: {} });
    expect(parseArgs(['create-admin', '--username', 'root', '--display-name=Root User'])).toEqual({
      kind: 'command',
      command: 'create-admin',
      options: { username: 'root', 'display-name': 'Root User' },
    });
    expect(parseArgs(['purge-audit', '--before', '2020-01-01', '--dry-run'])).toEqual({
      kind: 'command',
      command: 'purge-audit',
      options: { before: '2020-01-01', 'dry-run': true },
    });
  });

  it.each([
    [['drop-everything']],
    [['migrate', '--force']],
    [['migrate', 'extra']],
    [['create-admin', '--username']],
    [['create-admin', '--username', 'a', '--username', 'b']],
    [['purge-audit', '--dry-run=yes']],
  ])('rejects %j', (argv) => {
    expect(() => parseArgs(argv)).toThrow(expect.objectContaining({ code: 'validation_failed' }) as Error);
  });

  it.each([['--password', 'x'], ['--password=x'], ['--admin-pwd', 'x'], ['--db-secret=x']])(
    'never accepts passwords from argv (%s)',
    (...args) => {
      expect(() => parseArgs(['create-admin', '--username', 'root', ...args])).toThrow(/never accepted on the command line/);
    },
  );
});

describe('runOrcDb (no database needed)', () => {
  const io = (env: Record<string, string>) => ({ env, stdin: Readable.from([]), stdout: new Capture(), stderr: new Capture() });

  it('prints usage for --help', async () => {
    const x = io({});
    expect(await runOrcDb(['--help'], x)).toBe(0);
    expect(x.stdout.text).toBe(USAGE);
  });

  it('fails with usage on a bad command', async () => {
    const x = io({});
    expect(await runOrcDb(['nope'], x)).toBe(1);
    expect(x.stderr.text).toContain('Unknown command');
  });

  it('reports invalid configuration without echoing secret values', async () => {
    const x = io({ NODE_ENV: 'test', DB_USER: 'orc_migrator', DB_PASSWORD: 'Super$ecretValue1', DB_MIGRATOR_PASSWORD: 'bad pw' });
    expect(await runOrcDb(['migrate'], x)).toBe(1);
    expect(x.stderr.text).toContain('config_invalid');
    expect(x.stderr.text).not.toContain('Super$ecretValue1');
    expect(x.stderr.text).not.toContain('bad pw');
  });

  it('refuses a non-_test database under NODE_ENV=test before connecting', async () => {
    const x = io({ NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_PORT: '1', DB_NAME: 'orchestrator', DB_USER: 'orc_migrator', DB_PASSWORD: 'x'.repeat(20) });
    expect(await runOrcDb(['migrate'], x)).toBe(1);
    expect(x.stderr.text).toContain('db_name_guard');
  });
});

describe('purge-audit --before', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');
  it('accepts dates at least 365 days in the past (UTC for zone-less values)', () => {
    expect(parsePurgeBefore('2025-06-01', now).toISOString()).toBe('2025-06-01T00:00:00.000Z');
    expect(parsePurgeBefore('2024-01-02T03:04:05', now).toISOString()).toBe('2024-01-02T03:04:05.000Z');
    expect(parsePurgeBefore('2024-01-02T03:04:05+02:00', now).toISOString()).toBe('2024-01-02T01:04:05.000Z');
  });
  it.each(['2025-06-02', '2026-05-31', 'yesterday', '2025-13-45', ''])('refuses %j', (v) => {
    expect(() => parsePurgeBefore(v, now)).toThrow(expect.objectContaining({ code: 'validation_failed' }) as Error);
  });
});

describe('backup paths', () => {
  const at = new Date('2026-03-04T05:06:07.890Z');
  it('builds <dir>/<db>_<stamp>.bak', () => {
    expect(backupFilePath('/var/opt/mssql/backups/', 'orchestrator', at)).toBe('/var/opt/mssql/backups/orchestrator_20260304T050607Z.bak');
    expect(backupFilePath('D:\\backups', 'orchestrator', at)).toBe('D:\\backups\\orchestrator_20260304T050607Z.bak');
  });
  it.each(['relative/dir', "/var/o'pt", '/var/../etc', '/var/opt\nx', '/a*b'])('rejects BACKUP_DIR %j', (dir) => {
    expect(() => assertBackupDir(dir)).toThrow(expect.objectContaining({ code: 'config_invalid' }) as Error);
  });
});

describe('seed model', () => {
  it('requires CLAUDE_DEFAULT_MODEL', () => {
    expect(assertSeedModel(' sonnet ')).toBe('sonnet');
    expect(() => assertSeedModel(null)).toThrow(expect.objectContaining({ code: 'config_invalid' }) as Error);
    expect(() => assertSeedModel('x'.repeat(101))).toThrow();
  });
});

describe('secret input', () => {
  it('reads the first line from a pipe', async () => {
    await expect(readSecretLine(Readable.from(['pass', 'word\r\nignored\n']))).resolves.toBe('password');
    await expect(readSecretLine(Readable.from(['no-newline']))).resolves.toBe('no-newline');
  });

  it('reads without echo on a TTY and requires a matching repeat', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, rawModes: [] as boolean[] });
    const raw: boolean[] = [];
    const tty = Object.assign(input, { setRawMode: (m: boolean) => raw.push(m) });
    const prompt = new Capture();
    const pending = readSecret(tty, prompt, 'Password');
    tty.write('s3cretX\u007fY\r');
    await new Promise((r) => setTimeout(r, 10));
    tty.write('s3cretY\r');
    await expect(pending).resolves.toBe('s3cretY');
    expect(prompt.text).not.toContain('s3cret');
    expect(raw).toEqual([true, false, true, false]);
  });

  it('rejects empty input and mismatching repeats', async () => {
    await expect(readSecret(Readable.from(['\n']), new Capture(), 'Password')).rejects.toThrow(/must not be empty/);
    const tty = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
    const pending = readSecret(tty, new Capture(), 'Password');
    tty.write('one\r');
    await new Promise((r) => setTimeout(r, 10));
    tty.write('two\r');
    await expect(pending).rejects.toThrow(/do not match/);
  });
});
