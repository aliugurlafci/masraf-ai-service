// Proxy-Authorization check (contract §16.4): `Basic base64("orc:" + EGRESS_AUTH_TOKEN)`,
// compared in constant time. Only processes that received the proxy URL with credentials
// (Claude, §10.3) can open a tunnel.
import { createHash, timingSafeEqual } from 'node:crypto';

export const PROXY_AUTH_USER = 'orc';
export const PROXY_AUTH_REALM = 'orc';

/** Longest header value accepted; a 256-char token encodes to well under this. */
const MAX_HEADER_LENGTH = 1024;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Returns a predicate over the raw `Proxy-Authorization` header value. With a null token
 * (development only; `EGRESS_AUTH_TOKEN` is required in production) every request passes.
 */
export function createProxyAuthenticator(token: string | null): (header: unknown) => boolean {
  if (token === null) return () => true;
  const expectedDigest = digest(`${PROXY_AUTH_USER}:${token}`);
  return (header: unknown): boolean => {
    if (typeof header !== 'string' || header.length > MAX_HEADER_LENGTH) return false;
    const match = /^basic[ \t]+([A-Za-z0-9+/]+={0,2})[ \t]*$/i.exec(header);
    const encoded = match?.[1];
    if (encoded === undefined) return false;
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    // Both sides are hashed first so the comparison is constant-time regardless of length.
    return timingSafeEqual(digest(decoded), expectedDigest);
  };
}

/** Header value a client sends for `token` (used by tests and operator probes). */
export function proxyAuthorizationHeader(token: string): string {
  return `Basic ${Buffer.from(`${PROXY_AUTH_USER}:${token}`, 'utf8').toString('base64')}`;
}
