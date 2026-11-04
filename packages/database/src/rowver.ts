// ROWVERSION <-> ETag helpers (contract §2.5, T-m3).
import { OrcError, PreconditionFailedError } from '@orc/shared';

const ROWVER_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/** 8-byte ROWVERSION buffer -> base64url string. */
export function rowVerFromBuffer(buf: Buffer): string {
  if (buf.length !== 8) throw new OrcError('internal_error', 'ROWVERSION must be 8 bytes');
  return buf.toString('base64url');
}

/** base64url rowVer -> 8-byte Buffer for `sql.Binary(8)`; malformed => PreconditionFailedError. */
export function rowVerToBuffer(rowVer: string): Buffer {
  if (!ROWVER_PATTERN.test(rowVer)) throw new PreconditionFailedError('Malformed row version');
  const buf = Buffer.from(rowVer, 'base64url');
  if (buf.length !== 8) throw new PreconditionFailedError('Malformed row version');
  return buf;
}

/** `"${rowVer}"` (rowVer already base64url). */
export function rowVerToEtag(rowVer: string): string {
  return `"${rowVer}"`;
}

/** Strips quotes / W/ prefix; throws 'precondition_failed' when malformed. */
export function etagToRowVer(etag: string): string {
  let value = etag.trim();
  if (value.startsWith('W/')) value = value.slice(2);
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  if (!ROWVER_PATTERN.test(value) || Buffer.from(value, 'base64url').length !== 8) {
    throw new PreconditionFailedError('Malformed ETag');
  }
  return value;
}
