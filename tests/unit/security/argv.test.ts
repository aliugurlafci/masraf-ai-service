import { describe, expect, it } from 'vitest';
import {
  assertSafeArgv,
  isCommitSha,
  isSafeRefName,
  UnsafeArgumentError,
  validateTestCommand,
} from '@orc/security';

describe('assertSafeArgv', () => {
  it('accepts ordinary argv', () => {
    expect(() =>
      assertSafeArgv(['-p', '--output-format', 'stream-json', 'Bash(npm test:*)', 'ünïcødé']),
    ).not.toThrow();
    expect(() => assertSafeArgv([])).not.toThrow();
  });

  it.each([
    ['NUL byte', ['ok', 'a\0b']],
    ['element over 32 KiB', ['x'.repeat(32 * 1024 + 1)]],
    ['multi-byte element over 32 KiB', ['é'.repeat(16 * 1024 + 1)]],
    ['total over 64 KiB', ['a'.repeat(30_000), 'b'.repeat(30_000), 'c'.repeat(10_000)]],
    ['non-string element', ['ok', 42 as unknown as string]],
  ])('rejects %s', (_name, argv) => {
    expect(() => assertSafeArgv(argv)).toThrow(UnsafeArgumentError);
  });

  it('never echoes argument values in the error', () => {
    try {
      assertSafeArgv(['secret-value\0']);
      expect.unreachable();
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('secret-value');
      expect(err).toMatchObject({ code: 'unsafe_argument' });
    }
  });
});

describe('isSafeRefName', () => {
  it.each([
    'main',
    'master',
    'develop',
    'feature/x-1',
    'release/1.2.3',
    'orc/task-1234abcd-a1',
    'a_b',
    'HEAD',
  ])('accepts %j', (ref) => {
    expect(isSafeRefName(ref)).toBe(true);
  });

  it.each([
    '',
    '-main',
    '--upload-pack=evil',
    'a..b',
    'a//b',
    'a@{1}',
    'a@b',
    'a/',
    '/a',
    'a.lock',
    'a/b.lock/c',
    'a.',
    'a/.hidden',
    '.hidden',
    'a b',
    'a~1',
    'a^',
    'a:b',
    'a?',
    'a*',
    'a[',
    'a\\b',
    'a\0b',
    'x'.repeat(201),
  ])('rejects %j', (ref) => {
    expect(isSafeRefName(ref)).toBe(false);
  });
});

describe('isCommitSha', () => {
  it.each(['abc1234', '3f2c1a9b8e7d6c5b4a39281706f5e4d3c2b1a090', 'a'.repeat(64)])(
    'accepts %j',
    (sha) => {
      expect(isCommitSha(sha)).toBe(true);
    },
  );

  it.each(['abc123', 'ABC1234', 'g123456', 'a'.repeat(65), 'abc1234 ', '-abc1234'])(
    'rejects %j',
    (sha) => {
      expect(isCommitSha(sha)).toBe(false);
    },
  );
});

describe('validateTestCommand', () => {
  it('accepts shell-free argv and returns a frozen copy', () => {
    const input = ['npm', 'test', '--', '--reporter=junit'];
    const out = validateTestCommand(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
    expect(Object.isFrozen(out)).toBe(true);
    expect(validateTestCommand(['./node_modules/.bin/vitest', 'run'])).toEqual([
      './node_modules/.bin/vitest',
      'run',
    ]);
  });

  it.each([
    ['empty', []],
    ['too many elements', Array.from({ length: 33 }, () => 'x')],
    ['shell string executable', ['npm test && curl evil']],
    ['executable with metacharacters', ['npm;rm']],
    ['executable with space', ['sh -c', 'x']],
    ['empty element', ['npm', '']],
    ['NUL element', ['npm', 'te\0st']],
    ['element over 1024 chars', ['npm', 'x'.repeat(1025)]],
  ])('rejects %s', (_name, argv) => {
    expect(() => validateTestCommand(argv)).toThrow(
      expect.objectContaining({ code: 'validation_failed' }),
    );
  });
});
