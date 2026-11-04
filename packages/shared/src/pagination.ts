// Keyset cursor pagination (contract §9.4).
import { z } from 'zod';
import { OrcError } from './errors';
import { base64UrlToBytes, bytesToBase64Url } from './primitives';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Sort-key values + filter hash. */
export interface KeysetCursor {
  k: readonly (string | number)[];
  f: string;
}

const MAX_CURSOR_LENGTH = 512;

const KeysetCursorSchema = z.strictObject({
  k: z.array(z.union([z.string(), z.number()])).max(8),
  f: z.string().regex(/^[0-9a-f]{8}$/),
});

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function encodeCursor(c: KeysetCursor): string {
  return bytesToBase64Url(encoder.encode(JSON.stringify({ k: c.k, f: c.f })));
}

/** Throws OrcError('invalid_cursor') for anything that is not a cursor produced by encodeCursor. */
export function decodeCursor(s: string): KeysetCursor {
  const invalid = (): OrcError => new OrcError('invalid_cursor');
  if (typeof s !== 'string' || s.length === 0 || s.length > MAX_CURSOR_LENGTH) throw invalid();
  const bytes = base64UrlToBytes(s);
  if (bytes === null) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    throw invalid();
  }
  const result = KeysetCursorSchema.safeParse(parsed);
  if (!result.success) throw invalid();
  return result.data;
}

/** Canonical JSON: object keys sorted recursively, undefined members dropped (as JSON.stringify does). */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value) as string | undefined;
    return s ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && typeof v !== 'function' && typeof v !== 'symbol')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** FNV-1a 32-bit (lower-case hex, 8 chars) of the UTF-8 canonical JSON of `filters`. */
export function filterHash(filters: Record<string, unknown>): string {
  const bytes = encoder.encode(canonicalJson(filters));
  let hash = 0x811c9dc5;
  for (const b of bytes) {
    hash ^= b;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
