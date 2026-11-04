// Browser-safe primitives (contract §2.1). No node:* imports, no Buffer, no process.

export type Uuid = string;
export type BigId = string;
export type IsoDateTime = string;

/** Lower-case GUID 8-4-4-4-12. Not RFC-version-checked: SQL NEWSEQUENTIALID ids are not RFC 9562 compliant. */
export const GUID_REGEX: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Clock {
  now(): Date;
  nowMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now(),
};

export interface IdGenerator {
  uuid(): Uuid;
  token(bytes?: number): string;
}

const MAX_RANDOM_BYTES = 65_536;

export const cryptoIdGenerator: IdGenerator = {
  uuid: () => globalThis.crypto.randomUUID().toLowerCase(),
  token: (bytes = 32) => {
    if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_RANDOM_BYTES) {
      throw new RangeError(`token(bytes): bytes must be an integer in 1..${MAX_RANDOM_BYTES}`);
    }
    const buf = new Uint8Array(bytes);
    globalThis.crypto.getRandomValues(buf);
    return bytesToBase64Url(buf);
  },
};

/** Hyphen-less lower-case prefix of a GUID (`length` hex chars). */
export function shortKey(id: Uuid, length: 8 | 12 | 32): string {
  const normalized = id.trim().toLowerCase();
  if (!GUID_REGEX.test(normalized)) {
    throw new TypeError('shortKey: id is not a GUID');
  }
  if (length !== 8 && length !== 12 && length !== 32) {
    throw new RangeError('shortKey: length must be 8, 12 or 32');
  }
  return normalized.replaceAll('-', '').slice(0, length);
}

export function toIso(d: Date): IsoDateTime {
  return d.toISOString();
}

// ---- internal helpers (not part of the public index) --------------------------

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_LOOKUP: ReadonlyMap<string, number> = new Map([...B64URL].map((c, i) => [c, i]));

export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out +=
      B64URL.charAt((n >> 18) & 63) +
      B64URL.charAt((n >> 12) & 63) +
      B64URL.charAt((n >> 6) & 63) +
      B64URL.charAt(n & 63);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16;
    out += B64URL.charAt((n >> 18) & 63) + B64URL.charAt((n >> 12) & 63);
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out +=
      B64URL.charAt((n >> 18) & 63) + B64URL.charAt((n >> 12) & 63) + B64URL.charAt((n >> 6) & 63);
  }
  return out;
}

/** Strict unpadded base64url decoder; returns null on any invalid input. */
export function base64UrlToBytes(s: string): Uint8Array | null {
  if (s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (const ch of s) {
    const v = B64URL_LOOKUP.get(ch);
    if (v === undefined) return null;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  // Non-canonical trailing bits must be zero.
  if ((buffer & ((1 << bits) - 1)) !== 0) return null;
  return out.subarray(0, o);
}

/** UTF-8 byte length without allocating (lone surrogates count as U+FFFD = 3 bytes). */
export function utf8Length(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Truncate to at most `max` UTF-16 units including `suffix`, never splitting a surrogate pair. */
export function truncateText(text: string, max: number, suffix = '...[truncated]'): string {
  if (text.length <= max) return text;
  let cut = Math.max(0, max - suffix.length);
  const prev = text.charCodeAt(cut - 1);
  if (cut > 0 && prev >= 0xd800 && prev <= 0xdbff) cut -= 1;
  return text.slice(0, cut) + suffix;
}
