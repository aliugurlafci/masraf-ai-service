import { describe, expect, it } from 'vitest';
import { createLoginLimiter } from '../../src/auth/login-limiter.ts';
import { hashPassword, passwordProblem, verifyPassword } from '../../src/auth/password.ts';

describe('passwords', () => {
  it('hashes with a random salt and verifies', async () => {
    const a = await hashPassword('Gizli1234');
    const b = await hashPassword('Gizli1234');
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('Gizli1234');
    expect(await verifyPassword('Gizli1234', a)).toBe(true);
    expect(await verifyPassword('gizli1234', a)).toBe(false);
  });

  it('treats composed and decomposed Turkish letters alike', async () => {
    const hash = await hashPassword('Şifre1234');
    expect(await verifyPassword('Şifre1234', hash)).toBe(true);
  });

  it.each(['', 'düz', 'scrypt$1$2$3$$', 'bcrypt$a$b$c$d$e'])('rejects a malformed stored value %j', async (stored) => {
    expect(await verifyPassword('x', stored)).toBe(false);
  });

  it('explains weak passwords', () => {
    expect(passwordProblem('Ab1', 8)).toBe('Şifre en az 8 karakter olmalıdır.');
    expect(passwordProblem('sadeceharf', 8)).toBe('Şifre en az bir harf ve bir rakam içermelidir.');
    expect(passwordProblem('12345678', 8)).toBe('Şifre en az bir harf ve bir rakam içermelidir.');
    expect(passwordProblem('Uygun1234', 8)).toBeNull();
  });
});

describe('login limiter', () => {
  it('locks an address after the limit and unlocks when the time runs out', () => {
    let now = 0;
    const limiter = createLoginLimiter(3, 60_000, () => now);
    limiter.failed('a@x');
    limiter.failed('a@x');
    expect(limiter.lockedFor('a@x')).toBe(0);
    limiter.failed('a@x');
    expect(limiter.lockedFor('a@x')).toBe(60_000);
    expect(limiter.lockedFor('b@x')).toBe(0);
    now = 60_001;
    expect(limiter.lockedFor('a@x')).toBe(0);
    limiter.failed('a@x');
    expect(limiter.lockedFor('a@x')).toBe(0); // counting starts again
  });

  it('forgets failures after a successful login', () => {
    const limiter = createLoginLimiter(2, 60_000, () => 0);
    limiter.failed('a@x');
    limiter.succeeded('a@x');
    limiter.failed('a@x');
    expect(limiter.lockedFor('a@x')).toBe(0);
  });
});
