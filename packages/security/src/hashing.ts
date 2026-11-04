import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { OrcError } from '@orc/shared';
import { validationFailed } from './errors.js';

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keyLen: 64;
  saltLen: 16;
}

/** N=131072 (2^17), r=8, p=1, 64-byte key, 16-byte salt. */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = Object.freeze({
  N: 131072,
  r: 8,
  p: 1,
  keyLen: 64,
  saltLen: 16,
});

const BASE_MAXMEM = 256 * 1024 * 1024;
/**
 * Upper bound for parsed/accepted cost parameters (bounds CPU/memory a stored hash can demand):
 * N <= 2^17 and N*r <= 2^20, i.e. at most 128 MiB (128*N*r bytes) per scrypt computation.
 */
const LIMITS = { minLogN: 10, maxLogN: 17, maxR: 32, maxP: 16, maxNr: 2 ** 20 } as const;
/** Default concurrency: 2 x 128 MiB fits the API memory budget (contract §15.4, §19). */
export const DEFAULT_PASSWORD_HASH_CONCURRENCY = 2;
const MAX_PASSWORD_HASH_CONCURRENCY = 16;
let maxConcurrentHashes = DEFAULT_PASSWORD_HASH_CONCURRENCY;
/** Verification input cap: longer inputs are rejected after a constant-cost dummy computation. */
const MAX_VERIFY_PASSWORD_CHARS = 1024;
const HASH_PREFIX = 'scrypt';
const HASH_VERSION = '1';
const B64URL = /^[A-Za-z0-9_-]+$/;

// ---- concurrency limiter: at most `maxConcurrentHashes` scrypt computations per process -------
let activeHashes = 0;
const hashWaiters: (() => void)[] = [];

/**
 * Sets the per-process scrypt concurrency (PASSWORD_HASH_CONCURRENCY, 1..16; default 2). Sizing rule:
 * 128 * N * r * n must stay below the container memory limit minus 256 MiB. Waiters queued before a
 * decrease keep their place; the new limit applies to subsequent acquisitions.
 */
export function setPasswordHashConcurrency(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > MAX_PASSWORD_HASH_CONCURRENCY) {
    throw new OrcError('config_invalid', 'Invalid password hash concurrency', { details: { n } });
  }
  maxConcurrentHashes = n;
  while (activeHashes < maxConcurrentHashes && hashWaiters.length > 0) {
    activeHashes += 1;
    hashWaiters.shift()?.();
  }
}

async function acquireHashSlot(): Promise<void> {
  if (activeHashes < maxConcurrentHashes) {
    activeHashes += 1;
    return;
  }
  await new Promise<void>((resolve) => hashWaiters.push(resolve));
}

function releaseHashSlot(): void {
  if (activeHashes > maxConcurrentHashes) {
    activeHashes -= 1;
    return;
  }
  const next = hashWaiters.shift();
  if (next) next();
  else activeHashes -= 1;
}

function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;
}

function paramsValid(params: { N: number; r: number; p: number }): boolean {
  return (
    isPowerOfTwo(params.N) &&
    params.N >= 2 ** LIMITS.minLogN &&
    params.N <= 2 ** LIMITS.maxLogN &&
    Number.isInteger(params.r) &&
    params.r >= 1 &&
    params.r <= LIMITS.maxR &&
    Number.isInteger(params.p) &&
    params.p >= 1 &&
    params.p <= LIMITS.maxP &&
    params.N * params.r <= LIMITS.maxNr
  );
}

function assertParams(params: ScryptParams): void {
  if (!paramsValid(params) || params.keyLen !== 64 || params.saltLen !== 16) {
    throw new OrcError('config_invalid', 'Invalid scrypt parameters', {
      details: { N: params.N, r: params.r, p: params.p },
    });
  }
}

/** 256 MiB per the contract; LIMITS keep 128 * r * (N + p + 2) well below it. */
function maxmemFor(N: number, r: number, p: number): number {
  return Math.max(BASE_MAXMEM, 128 * r * (N + p + 2) + 1024 * 1024);
}

async function deriveKey(
  password: string,
  salt: Buffer,
  N: number,
  r: number,
  p: number,
  keyLen: number,
): Promise<Buffer> {
  await acquireHashSlot();
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        password.normalize('NFKC'),
        salt,
        keyLen,
        { N, r, p, maxmem: maxmemFor(N, r, p) },
        (err, key) => {
          if (err) reject(err);
          else resolve(key);
        },
      );
    });
  } finally {
    releaseHashSlot();
  }
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parseStoredHash(stored: string): ParsedHash | null {
  if (typeof stored !== 'string' || stored.length > 512) return null;
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[0] !== HASH_PREFIX || parts[1] !== HASH_VERSION) return null;
  const [, , paramText = '', saltText = '', hashText = ''] = parts;
  const match = /^N=(\d{1,8}),r=(\d{1,3}),p=(\d{1,3})$/.exec(paramText);
  if (!match || !B64URL.test(saltText) || !B64URL.test(hashText)) return null;
  const N = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  if (!paramsValid({ N, r, p })) return null;
  const salt = Buffer.from(saltText, 'base64url');
  const hash = Buffer.from(hashText, 'base64url');
  if (salt.length !== 16 || hash.length !== 64) return null;
  return { N, r, p, salt, hash };
}

/** Format: `scrypt$1$N=<N>,r=<r>,p=<p>$<saltB64url>$<hashB64url>` (password NFKC-normalized). */
export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  if (typeof password !== 'string') throw validationFailed('password', 'Password must be a string');
  assertParams(params);
  const salt = randomBytes(params.saltLen);
  const key = await deriveKey(password, salt, params.N, params.r, params.p, params.keyLen);
  return `${HASH_PREFIX}$${HASH_VERSION}$N=${params.N},r=${params.r},p=${params.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

const DUMMY_SALT = randomBytes(16);
const DUMMY_HASH = randomBytes(64);

/** Constant-cost path (unknown user, malformed hash): one scrypt with the default parameters. */
export async function dummyPasswordVerify(): Promise<void> {
  const { N, r, p, keyLen } = DEFAULT_SCRYPT_PARAMS;
  const key = await deriveKey(randomBytes(24).toString('base64url'), DUMMY_SALT, N, r, p, keyLen);
  timingSafeEqual(key, DUMMY_HASH);
}

/**
 * Timing-safe verification against a stored hash. `needsRehash` is true only for a successful match
 * whose stored parameters differ from `current`. Malformed hashes never throw: they cost one dummy
 * computation and yield `{ ok: false }`.
 */
export async function verifyPassword(
  password: string,
  stored: string,
  current: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<{ ok: boolean; needsRehash: boolean }> {
  const parsed = parseStoredHash(stored);
  if (!parsed || typeof password !== 'string' || password.length > MAX_VERIFY_PASSWORD_CHARS) {
    await dummyPasswordVerify();
    return { ok: false, needsRehash: false };
  }
  const key = await deriveKey(
    password,
    parsed.salt,
    parsed.N,
    parsed.r,
    parsed.p,
    parsed.hash.length,
  );
  const ok = key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
  const needsRehash =
    ok && (parsed.N !== current.N || parsed.r !== current.r || parsed.p !== current.p);
  return { ok, needsRehash };
}

/** 12..256 characters (Unicode code points) and not equal to the username (case-insensitive). */
export function validatePasswordPolicy(password: string, username: string): void {
  if (typeof password !== 'string') throw validationFailed('password', 'Password must be a string');
  const length = [...password].length;
  if (length < 12 || length > 256) {
    throw validationFailed('password', 'Password must be 12..256 characters long');
  }
  if (typeof username === 'string' && password.toLowerCase() === username.toLowerCase()) {
    throw validationFailed('password', 'Password must not equal the username');
  }
}

export function sha256(input: string | Uint8Array): Buffer {
  return createHash('sha256').update(input).digest();
}

/** 32 random bytes as base64url (43 chars) plus its SHA-256 (the only form ever stored). */
export function generateSessionToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

export function generateCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/** `orc_pat_` + 43 base64url chars; prefix = first 8 chars after `orc_pat_`; hash = SHA-256 of the full token. */
export function generatePat(): { token: `orc_pat_${string}`; prefix: string; hash: Buffer } {
  const secret = randomBytes(32).toString('base64url');
  const token: `orc_pat_${string}` = `orc_pat_${secret}`;
  return { token, prefix: secret.slice(0, 8), hash: sha256(token) };
}

/** Constant-time string equality for inputs of any length (compares SHA-256 digests). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return timingSafeEqual(sha256(a), sha256(b));
}
