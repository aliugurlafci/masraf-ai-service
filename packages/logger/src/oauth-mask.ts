import { maskText } from '@orc/security';
import type { SecretRegistry } from '@orc/security';

const CENSOR = '[REDACTED]';
const OAUTH_PREFIX = 'sk-ant-oat';
/** Base64 alphabets (standard and url-safe) accepted after an encoded prefix, plus padding. */
const B64_RUN = '[A-Za-z0-9+/_-]*={0,2}';

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * The base64 characters that depend only on the bytes of `prefix` when it starts at byte offset 0, 1 or 2 of
 * a larger payload (the neighbouring bytes are unknown, so characters touching them are dropped).
 */
function alignedBase64Prefixes(prefix: string): string[] {
  const out: string[] = [];
  for (const lead of [0, 1, 2]) {
    const bytes = Buffer.concat([Buffer.alloc(lead), Buffer.from(prefix, 'utf8')]);
    const complete = Math.floor((bytes.length * 8) / 6);
    const skip = Math.ceil((lead * 8) / 6);
    const std = bytes.toString('base64').slice(skip, complete);
    const url = std.replaceAll('+', '-').replaceAll('/', '_');
    out.push(std);
    if (url !== std) out.push(url);
  }
  return out;
}

/**
 * ADR-0036 item 8. Masks OAuth token values and any base64 / base64url encoding of them, whatever the byte
 * offset inside a larger encoded payload (three alignments of the `sk-ant-oat` prefix, 12 to 13 encoded
 * characters = at least 72 bits, then the rest of the base64 run). Needs no secret registry.
 */
const OAUTH_TOKEN_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`${escapeRegex(OAUTH_PREFIX)}\d{2}-[A-Za-z0-9_-]+`, 'g'),
  ...alignedBase64Prefixes(OAUTH_PREFIX).map((p) => new RegExp(`${escapeRegex(p)}${B64_RUN}`, 'g')),
];

export function maskOAuthTokens(text: string): string {
  let out = text;
  for (const pattern of OAUTH_TOKEN_PATTERNS) out = out.replace(pattern, CENSOR);
  return out;
}

/** Registry-aware masking (@orc/security) followed by the registry-free OAuth patterns. */
export function maskSecretText(text: string, registry: SecretRegistry | undefined): string {
  return maskOAuthTokens(maskText(text, registry));
}
