import { DATA_FENCE_PREFIX } from '@orc/shared';

const TRUNCATION_MARKER = '\n[truncated]';
// C0 controls except \t (0x09), \n (0x0a), \r (0x0d); NUL included.
// eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
const FORBIDDEN_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

export function utf8ByteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Largest prefix of `text` whose UTF-8 encoding fits `maxBytes`, never splitting a code point. */
function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // Step back over continuation bytes (10xxxxxx) so the cut lands on a code point boundary.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function removeFence(text: string): string {
  let out = text;
  while (out.includes(DATA_FENCE_PREFIX)) out = out.split(DATA_FENCE_PREFIX).join('');
  return out;
}

/**
 * Prepares untrusted text (task fields, project description, repository CLAUDE.md) for the prompt:
 * lone surrogates replaced, NUL and C0 controls except \t \n \r removed, \r\n normalized to \n,
 * every `<<<ORC:` fence prefix removed (repeatedly, so removal cannot assemble a new one), then
 * truncated so the result including the `\n[truncated]` marker is at most `maxBytes` UTF-8 bytes.
 */
export function sanitizeUntrustedText(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
  const cleaned = removeFence(
    (typeof text === 'string' ? text : '')
      .toWellFormed()
      .replace(FORBIDDEN_CONTROLS, '')
      .replace(/\r\n/g, '\n'),
  );
  if (utf8ByteLength(cleaned) <= limit) return { text: cleaned, truncated: false };
  const markerBytes = utf8ByteLength(TRUNCATION_MARKER);
  if (limit < markerBytes) return { text: truncateUtf8(cleaned, limit), truncated: true };
  return { text: truncateUtf8(cleaned, limit - markerBytes) + TRUNCATION_MARKER, truncated: true };
}
