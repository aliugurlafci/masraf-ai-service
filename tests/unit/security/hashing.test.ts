import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCRYPT_PARAMS,
  dummyPasswordVerify,
  generateCsrfToken,
  generatePat,
  generateSessionToken,
  hashPassword,
  sha256,
  timingSafeEqualStr,
  validatePasswordPolicy,
  verifyPassword,
} from '@orc/security';
import type { ScryptParams } from '@orc/security';

// Contract §15.4: tests may lower N to 16384; the format embeds the parameters.
const FAST: ScryptParams = { N: 16384, r: 8, p: 1, keyLen: 64, saltLen: 16 };
const PASSWORD = 'correct horse battery staple';

describe('password hashing (scrypt)', () => {
  it('uses the contract defaults', () => {
    expect(DEFAULT_SCRYPT_PARAMS).toEqual({ N: 131072, r: 8, p: 1, keyLen: 64, saltLen: 16 });
  });

  it('round-trips with the documented format and per-hash salt', async () => {
    const a = await hashPassword(PASSWORD, FAST);
    const b = await hashPassword(PASSWORD, FAST);
    expect(a).toMatch(/^scrypt\$1\$N=16384,r=8,p=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
    expect(a).not.toBe(b);
    await expect(verifyPassword(PASSWORD, a, FAST)).resolves.toEqual({
      ok: true,
      needsRehash: false,
    });
    await expect(verifyPassword(PASSWORD, b, FAST)).resolves.toEqual({
      ok: true,
      needsRehash: false,
    });
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword(PASSWORD, FAST);
    await expect(verifyPassword('correct horse battery stapl', stored, FAST)).resolves.toEqual({
      ok: false,
      needsRehash: false,
    });
    await expect(verifyPassword(`${PASSWORD} `, stored, FAST)).resolves.toEqual({
      ok: false,
      needsRehash: false,
    });
    await expect(verifyPassword('', stored, FAST)).resolves.toEqual({
      ok: false,
      needsRehash: false,
    });
  });

  it('flags needsRehash only for a successful match with outdated parameters', async () => {
    const stored = await hashPassword(PASSWORD, FAST);
    const current: ScryptParams = { ...FAST, N: 32768 };
    await expect(verifyPassword(PASSWORD, stored, current)).resolves.toEqual({
      ok: true,
      needsRehash: true,
    });
    await expect(verifyPassword('wrong password!!', stored, current)).resolves.toEqual({
      ok: false,
      needsRehash: false,
    });
  });

  it('works with the default (production) parameters', async () => {
    const stored = await hashPassword(PASSWORD);
    expect(stored.startsWith('scrypt$1$N=131072,r=8,p=1$')).toBe(true);
    await expect(verifyPassword(PASSWORD, stored)).resolves.toEqual({
      ok: true,
      needsRehash: false,
    });
  });

  it('normalizes Unicode so NFC and NFD inputs verify identically', async () => {
    const nfc = 'pässwörd-länger';
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc);
    const stored = await hashPassword(nfc, FAST);
    await expect(verifyPassword(nfd, stored, FAST)).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ['empty', ''],
    ['garbage', 'not-a-hash'],
    ['bcrypt', '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234'],
    ['wrong version', `scrypt$2$N=16384,r=8,p=1$${'A'.repeat(22)}$${'A'.repeat(86)}`],
    ['N not power of two', `scrypt$1$N=16385,r=8,p=1$${'A'.repeat(22)}$${'A'.repeat(86)}`],
    ['N too large (DoS)', `scrypt$1$N=4194304,r=8,p=1$${'A'.repeat(22)}$${'A'.repeat(86)}`],
    ['short salt', `scrypt$1$N=16384,r=8,p=1$AAAA$${'A'.repeat(86)}`],
    ['short hash', `scrypt$1$N=16384,r=8,p=1$${'A'.repeat(22)}$AAAA`],
  ])(
    'treats a malformed stored hash (%s) as a mismatch without throwing',
    async (_name, stored) => {
      await expect(verifyPassword(PASSWORD, stored, FAST)).resolves.toEqual({
        ok: false,
        needsRehash: false,
      });
    },
  );

  it('rejects oversized password input without throwing', async () => {
    const stored = await hashPassword(PASSWORD, FAST);
    await expect(verifyPassword('x'.repeat(5000), stored, FAST)).resolves.toEqual({
      ok: false,
      needsRehash: false,
    });
  });

  it('refuses invalid scrypt parameters when hashing', async () => {
    await expect(hashPassword(PASSWORD, { ...FAST, N: 1000 })).rejects.toMatchObject({
      code: 'config_invalid',
    });
    await expect(hashPassword(PASSWORD, { ...FAST, r: 0 })).rejects.toMatchObject({
      code: 'config_invalid',
    });
  });

  it('runs more hashes than the concurrency limit without deadlock', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => hashPassword(`password-number-${i}`, FAST)),
    );
    expect(new Set(results).size).toBe(6);
  });

  it('provides a constant-cost dummy verification', async () => {
    await expect(dummyPasswordVerify()).resolves.toBeUndefined();
  });
});

describe('validatePasswordPolicy', () => {
  it('accepts 12..256 characters not equal to the username', () => {
    expect(() => validatePasswordPolicy('a'.repeat(12), 'admin')).not.toThrow();
    expect(() => validatePasswordPolicy('a'.repeat(256), 'admin')).not.toThrow();
    // 12 code points, 24 UTF-16 units.
    expect(() => validatePasswordPolicy('\u{1F512}'.repeat(12), 'admin')).not.toThrow();
  });

  it.each([
    ['too short', 'a'.repeat(11), 'admin'],
    ['too long', 'a'.repeat(257), 'admin'],
    ['equals username', 'administrator', 'administrator'],
    ['equals username ignoring case', 'AdministratorX', 'administratorx'],
  ])('rejects %s', (_name, password, username) => {
    expect(() => validatePasswordPolicy(password, username)).toThrow(
      expect.objectContaining({ code: 'validation_failed' }),
    );
  });
});

describe('tokens', () => {
  it('sha256 matches the standard test vector', () => {
    expect(sha256('abc').toString('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256(new Uint8Array([97, 98, 99])).equals(sha256('abc'))).toBe(true);
  });

  it('generates 32-byte base64url session tokens with their SHA-256', () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a.token, 'base64url')).toHaveLength(32);
    expect(a.hash.equals(createHash('sha256').update(a.token).digest())).toBe(true);
    expect(a.token).not.toBe(b.token);
  });

  it('generates CSRF tokens', () => {
    const t = generateCsrfToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t).not.toBe(generateCsrfToken());
  });

  it('generates PATs with prefix and full-token hash', () => {
    const pat = generatePat();
    expect(pat.token).toMatch(/^orc_pat_[A-Za-z0-9_-]{43}$/);
    expect(pat.prefix).toBe(pat.token.slice(8, 16));
    expect(pat.hash.equals(sha256(pat.token))).toBe(true);
    expect(generatePat().token).not.toBe(pat.token);
  });

  it('timingSafeEqualStr compares any lengths safely', () => {
    expect(timingSafeEqualStr('same-value', 'same-value')).toBe(true);
    expect(timingSafeEqualStr('same-value', 'same-valuE')).toBe(false);
    expect(timingSafeEqualStr('short', 'a much longer value')).toBe(false);
    expect(timingSafeEqualStr('', '')).toBe(true);
    expect(timingSafeEqualStr('', 'x')).toBe(false);
  });
});
