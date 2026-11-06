import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));

const KEY_LENGTH = 64;
/** scrypt cost (N = 2^15, r = 8, p = 1): about 32 MB and some tens of milliseconds per hash. */
const COST = { N: 32_768, r: 8, p: 1 } as const;
const MAX_MEM = 128 * COST.N * COST.r * 2;

/** "scrypt$N$r$p$salt$hash", salt and hash in base64. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFC'), salt, KEY_LENGTH, { ...COST, maxmem: MAX_MEM });
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (N === undefined || r === undefined || p === undefined || ![N, r, p].every(Number.isSafeInteger)) return false;
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (salt.length === 0 || expected.length === 0) return false;
  const key = await scrypt(password.normalize('NFC'), salt, expected.length, { N, r, p, maxmem: 128 * N * r * 2 });
  return timingSafeEqual(key, expected);
}

let dummy: Promise<string> | null = null;

/** Spends the time of a real check, so an unknown e-mail answers as slowly as a wrong password. */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummy);
}

/** Turkish message when the password is too weak, otherwise null. */
export function passwordProblem(password: string, minLength: number): string | null {
  if (password.length < minLength) return `Şifre en az ${minLength} karakter olmalıdır.`;
  if (password.length > 128) return 'Şifre en fazla 128 karakter olabilir.';
  if (!/\p{L}/u.test(password) || !/\d/.test(password)) return 'Şifre en az bir harf ve bir rakam içermelidir.';
  return null;
}
