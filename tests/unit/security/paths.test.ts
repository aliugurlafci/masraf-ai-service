import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  normalizeRepoRelativePath,
  normalizeWorktreeRelativePath,
  PathEscapeError,
  realpathWithin,
  resolveWithin,
} from '@orc/security';

const IS_WIN32 = process.platform === 'win32';

function escapeReason(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PathEscapeError);
    expect((err as PathEscapeError).code).toBe('path_escape');
    return (err as PathEscapeError).details?.reason;
  }
  throw new Error('expected PathEscapeError');
}

let base = '';
let root = '';
let outside = '';

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'orc-sec-paths-')));
  root = path.join(base, 'root');
  outside = path.join(base, 'outside');
  await mkdir(path.join(root, 'inside', 'nested'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(root, 'inside', 'file.txt'), 'ok');
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  // Directory junctions need no privilege on Windows; the type argument is ignored on POSIX.
  await symlink(outside, path.join(root, 'escape-link'), 'junction');
  await symlink(path.join(root, 'inside'), path.join(root, 'inner-link'), 'junction');
});

afterAll(async () => {
  if (base) await rm(base, { recursive: true, force: true });
});

describe('resolveWithin', () => {
  it('resolves segments inside the root', () => {
    expect(resolveWithin(root)).toBe(root);
    expect(resolveWithin(root, 'a', 'b/c')).toBe(path.join(root, 'a', 'b', 'c'));
    expect(resolveWithin(root, 'a/../b')).toBe(path.join(root, 'b'));
    expect(resolveWithin(root, './x/./y')).toBe(path.join(root, 'x', 'y'));
    expect(resolveWithin(`${root}${path.sep}`, 'a')).toBe(path.join(root, 'a'));
  });

  it.each([
    ['..'],
    ['../etc/passwd'],
    ['a/../../b'],
    ['./../x'],
    ['inside/../../outside/secret.txt'],
    ['../root-evil/file'],
  ])('rejects lexical traversal %j', (segment) => {
    expect(escapeReason(() => resolveWithin(root, segment))).toBe('outside_root');
  });

  it('rejects traversal spread across several segments', () => {
    expect(escapeReason(() => resolveWithin(root, 'a', '..', '..', 'x'))).toBe('outside_root');
  });

  it.each([
    ['/etc/passwd'],
    ['//server/share/x'],
    ['\\\\server\\share\\x'],
    ['\\\\?\\C:\\Windows'],
    ['\\\\.\\pipe\\evil'],
    ['\\Windows\\System32'],
    ['C:\\Windows\\System32'],
    ['C:/Windows'],
    ['c:relative-to-drive-cwd'],
  ])('rejects absolute, drive and UNC segment %j on every platform', (segment) => {
    expect(escapeReason(() => resolveWithin(root, segment))).toBe('absolute_segment');
  });

  it('rejects Windows-style traversal on every platform', () => {
    expect(() => resolveWithin(root, '..\\..\\Windows\\win.ini')).toThrow(PathEscapeError);
    expect(() => resolveWithin(root, 'a\\..\\..\\b')).toThrow(PathEscapeError);
  });

  it('rejects NUL bytes in segments and root', () => {
    expect(escapeReason(() => resolveWithin(root, 'a\0b'))).toBe('nul_byte');
    expect(escapeReason(() => resolveWithin(root, 'ok', '../\0'))).toBe('nul_byte');
    expect(escapeReason(() => resolveWithin(`${root}\0`, 'a'))).toBe('nul_byte');
  });

  it('rejects relative or empty roots', () => {
    expect(escapeReason(() => resolveWithin('relative/root', 'a'))).toBe('invalid_root');
    expect(escapeReason(() => resolveWithin('', 'a'))).toBe('invalid_root');
  });

  it('does not URL-decode: encoded traversal stays a literal name inside the root', () => {
    expect(resolveWithin(root, '%2e%2e/%2e%2e/etc/passwd')).toBe(
      path.join(root, '%2e%2e', '%2e%2e', 'etc', 'passwd'),
    );
    expect(resolveWithin(root, '..%2f..%2fetc')).toBe(path.join(root, '..%2f..%2fetc'));
    expect(resolveWithin(root, '%252e%252e')).toBe(path.join(root, '%252e%252e'));
  });

  it('rejects non-string segments passed from untyped callers', () => {
    const segments = [42] as unknown as string[];
    expect(escapeReason(() => resolveWithin(root, ...segments))).toBe('invalid_segment');
  });

  it.runIf(IS_WIN32)(
    'win32: compares case-insensitively and rejects alternate data streams',
    () => {
      expect(resolveWithin(root.toUpperCase(), 'a').toLowerCase()).toBe(
        path.join(root, 'a').toLowerCase(),
      );
      const rootName = path.basename(root).toUpperCase();
      expect(resolveWithin(root, `..\\${rootName}\\a`).toLowerCase()).toBe(
        path.join(root, 'a').toLowerCase(),
      );
      expect(escapeReason(() => resolveWithin(root, 'file.txt:stream'))).toBe('invalid_segment');
    },
  );

  it.runIf(!IS_WIN32)('posix: is case-sensitive', () => {
    const upper = path.join(path.dirname(root), path.basename(root).toUpperCase());
    expect(escapeReason(() => resolveWithin(root, '..', path.basename(upper), 'a'))).toBe(
      'outside_root',
    );
  });
});

describe('realpathWithin', () => {
  it('returns the real path of an existing file inside the root', async () => {
    await expect(realpathWithin(root, 'inside/file.txt')).resolves.toBe(
      await realpath(path.join(root, 'inside', 'file.txt')),
    );
  });

  it('allows links that stay inside the root', async () => {
    await expect(realpathWithin(root, 'inner-link', 'file.txt')).resolves.toBe(
      await realpath(path.join(root, 'inside', 'file.txt')),
    );
  });

  it('rejects a symlink/junction escaping the root even though the lexical path is inside', async () => {
    expect(resolveWithin(root, 'escape-link', 'secret.txt')).toBe(
      path.join(root, 'escape-link', 'secret.txt'),
    );
    const err: unknown = await realpathWithin(root, 'escape-link', 'secret.txt').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PathEscapeError);
    expect((err as PathEscapeError).details?.reason).toBe('symlink_escape');
    await expect(realpathWithin(root, 'escape-link')).rejects.toBeInstanceOf(PathEscapeError);
  });

  it('still applies lexical checks before touching the filesystem', async () => {
    await expect(realpathWithin(root, '../outside/secret.txt')).rejects.toBeInstanceOf(
      PathEscapeError,
    );
  });

  it('propagates ENOENT for a missing target', async () => {
    await expect(realpathWithin(root, 'inside/missing.txt')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('normalizeRepoRelativePath', () => {
  it.each([
    ['repo', 'repo'],
    ['group/repo', 'group/repo'],
    ['group/my-repo_2.0/', 'group/my-repo_2.0'],
    ['A1/b.c', 'A1/b.c'],
  ])('accepts %j', (input, expected) => {
    expect(normalizeRepoRelativePath(input)).toBe(expected);
  });

  it.each([
    [''],
    ['/abs/repo'],
    ['../repo'],
    ['a/../b'],
    ['a..b'],
    ['a//b'],
    ['.hidden'],
    ['-repo'],
    ['a\\b'],
    ['C:/repo'],
    ['%2e%2e/repo'],
    ['repo name'],
    ['con'],
    ['group/NUL.txt'],
    ['trailing.'],
    ['a\0b'],
    ['x'.repeat(256)],
    [`${'a'.repeat(101)}`],
  ])('rejects %j with validation_failed', (input) => {
    expect(() => normalizeRepoRelativePath(input)).toThrow(
      expect.objectContaining({ code: 'validation_failed' }),
    );
  });
});

describe('normalizeWorktreeRelativePath', () => {
  it.each([
    ['reports/junit.xml', 'reports/junit.xml'],
    ['./reports//junit.xml', 'reports/junit.xml'],
    ['reports\\junit.xml', 'reports/junit.xml'],
    ['a/./b/c.xml', 'a/b/c.xml'],
  ])('normalizes %j', (input, expected) => {
    expect(normalizeWorktreeRelativePath(input)).toBe(expected);
  });

  it.each([
    [''],
    ['.'],
    ['/etc/passwd'],
    ['\\\\server\\share\\x.xml'],
    ['C:\\x.xml'],
    ['c:x.xml'],
    ['../x.xml'],
    ['a/../../x.xml'],
    ['a\\..\\x.xml'],
    ['a\0.xml'],
    ['a\n.xml'],
    ['file.xml:stream'],
    ['a'.repeat(401)],
  ])('rejects %j with validation_failed', (input) => {
    expect(() => normalizeWorktreeRelativePath(input)).toThrow(
      expect.objectContaining({ code: 'validation_failed' }),
    );
  });
});
