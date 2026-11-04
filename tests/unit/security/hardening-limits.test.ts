import { describe, expect, it } from 'vitest';
import {
  assertSafeArgv,
  DEFAULT_PASSWORD_HASH_CONCURRENCY,
  hashPassword,
  setPasswordHashConcurrency,
  UnsafeArgumentError,
  verifyPassword,
} from '@orc/security';

const SALT = 'A'.repeat(22);
const HASH = 'A'.repeat(86);

describe('scrypt memory bounds (contract §15.4)', () => {
  it('defaults to 2 concurrent hashes and validates the setting', () => {
    expect(DEFAULT_PASSWORD_HASH_CONCURRENCY).toBe(2);
    expect(() => setPasswordHashConcurrency(0)).toThrow(
      expect.objectContaining({ code: 'config_invalid' }),
    );
    expect(() => setPasswordHashConcurrency(17)).toThrow();
    expect(() => setPasswordHashConcurrency(1.5)).toThrow();
    setPasswordHashConcurrency(DEFAULT_PASSWORD_HASH_CONCURRENCY);
  });

  it.each([
    ['N above 2^17', `scrypt$1$N=262144,r=8,p=1$${SALT}$${HASH}`],
    ['N*r above 2^20', `scrypt$1$N=131072,r=16,p=1$${SALT}$${HASH}`],
  ])(
    'treats a stored hash with %s as invalid (no 256 MiB+ computation)',
    async (_label, stored) => {
      await expect(verifyPassword('correct horse battery', stored)).resolves.toEqual({
        ok: false,
        needsRehash: false,
      });
    },
  );

  it('rejects hashing parameters above 128 MiB per computation', async () => {
    await expect(
      hashPassword('correct horse battery', { N: 262_144, r: 8, p: 1, keyLen: 64, saltLen: 16 }),
    ).rejects.toMatchObject({ code: 'config_invalid' });
    await expect(
      hashPassword('correct horse battery', { N: 65_536, r: 32, p: 1, keyLen: 64, saltLen: 16 }),
    ).rejects.toMatchObject({ code: 'config_invalid' });
  });

  it('serializes hashing when the concurrency is 1', async () => {
    setPasswordHashConcurrency(1);
    try {
      const params = { N: 16_384, r: 8, p: 1, keyLen: 64, saltLen: 16 } as const;
      const hashes = await Promise.all(
        [1, 2, 3].map((i) => hashPassword(`password-${i}-xx`, params)),
      );
      expect(new Set(hashes).size).toBe(3);
    } finally {
      setPasswordHashConcurrency(DEFAULT_PASSWORD_HASH_CONCURRENCY);
    }
  });
});

describe('assertSafeArgv win32 command-line budget', () => {
  it('accepts a 20 000-character argv on win32 and posix', () => {
    const argv = ['--append-system-prompt', 'x'.repeat(20_000)];
    expect(() => assertSafeArgv(argv, { platform: 'win32' })).not.toThrow();
    expect(() => assertSafeArgv(argv)).not.toThrow();
  });

  it('rejects argv beyond 30 000 characters only on win32', () => {
    const argv = Array.from({ length: 4 }, () => 'y'.repeat(8_000));
    expect(() => assertSafeArgv(argv, { platform: 'posix' })).not.toThrow();
    expect(() => assertSafeArgv(argv, { platform: 'win32' })).toThrow(UnsafeArgumentError);
    let caught: unknown;
    try {
      assertSafeArgv(argv, { platform: 'win32' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsafeArgumentError);
    expect((caught as UnsafeArgumentError).details?.reason).toBe('win32_command_line_too_long');
  });

  it('counts quotes and backslashes that need escaping on win32', () => {
    const argv = ['"'.repeat(15_000), 'a'];
    expect(() => assertSafeArgv(argv, { platform: 'win32' })).toThrow(UnsafeArgumentError);
  });
});
