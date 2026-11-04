// Egress policy primitives (contract §16.4, ADR-0013): CONNECT target parsing, host/port
// allow-lists and the "resolved address must be public" rule used against DNS rebinding.
import { isIP } from 'node:net';

export type TargetHostType = 'name' | 'ipv4' | 'ipv6';

export interface ConnectTarget {
  /** Lower-case host name without a trailing dot, or a bare IP literal (IPv6 without brackets). */
  readonly host: string;
  readonly port: number;
  readonly hostType: TargetHostType;
}

const MAX_TARGET_LENGTH = 270;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isValidHostName(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const labels = host.split('.');
  if (!labels.every((label) => LABEL.test(label))) return false;
  // A purely numeric last label is never a DNS name; it is an IP literal in a legacy notation
  // (e.g. "2130706433" or "127.1") that getaddrinfo would happily accept.
  const last = labels[labels.length - 1] ?? '';
  return !/^[0-9]+$/.test(last) && !/^0x[0-9a-f]*$/.test(last);
}

/**
 * Parses the authority-form request target of a CONNECT request (`host:port`, `[v6]:port`).
 * Returns null for anything else (userinfo, paths, zone ids, out-of-range ports, odd notations).
 */
export function parseConnectTarget(target: string | undefined): ConnectTarget | null {
  if (target === undefined || target.length === 0 || target.length > MAX_TARGET_LENGTH) {
    return null;
  }
  let rawHost: string;
  let portText: string;
  if (target.startsWith('[')) {
    const end = target.indexOf(']');
    if (end < 0 || target[end + 1] !== ':') return null;
    rawHost = target.slice(1, end);
    portText = target.slice(end + 2);
    if (isIP(rawHost) !== 6) return null;
  } else {
    const colon = target.lastIndexOf(':');
    if (colon <= 0) return null;
    rawHost = target.slice(0, colon);
    portText = target.slice(colon + 1);
    if (rawHost.includes(':')) return null;
  }
  if (!/^[0-9]{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  if (port < 1 || port > 65_535) return null;

  let host = rawHost.toLowerCase();
  if (host.endsWith('.') && isIP(host) === 0) host = host.slice(0, -1);
  const version = isIP(host);
  if (version === 4) return { host, port, hostType: 'ipv4' };
  if (version === 6) {
    // isIP accepts "fe80::1%eth0"; zone ids never leave the host, so they are refused.
    return host.includes('%') ? null : { host, port, hostType: 'ipv6' };
  }
  return isValidHostName(host) ? { host, port, hostType: 'name' } : null;
}

/**
 * Builds a matcher for `EGRESS_ALLOWED_HOSTS`: exact entries match only themselves, `*.domain`
 * matches any sub-domain of `domain` (at any depth) but not `domain` itself.
 */
export function createHostMatcher(patterns: readonly string[]): (host: string) => boolean {
  const exact = new Set<string>();
  const suffixes: string[] = [];
  for (const raw of patterns) {
    const pattern = raw.trim().toLowerCase();
    if (pattern.length === 0) continue;
    if (pattern.startsWith('*.')) suffixes.push(pattern.slice(1));
    else exact.add(pattern);
  }
  return (host: string): boolean => {
    const h = host.toLowerCase();
    if (exact.has(h)) return true;
    return suffixes.some((suffix) => h.length > suffix.length && h.endsWith(suffix));
  };
}

// ---- address classification ------------------------------------------------------------

/** [network, prefix length] pairs of IPv4 ranges that are not globally reachable unicast. */
const NON_PUBLIC_IPV4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // shared address space (CGNAT)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata endpoints)
  ['172.16.0.0', 12], // private (Docker bridge networks)
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.31.196.0', 24], // AS112-v4
  ['192.52.193.0', 24], // AMT
  ['192.88.99.0', 24], // deprecated 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['192.175.48.0', 24], // direct delegation AS112
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + limited broadcast
];

function ipv4ToInt(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

const NON_PUBLIC_IPV4_RANGES: readonly (readonly [number, number])[] = NON_PUBLIC_IPV4.map(
  ([network, prefix]) => {
    const base = ipv4ToInt(network);
    if (base === null) throw new Error(`invalid built-in range ${network}`);
    const size = 2 ** (32 - prefix);
    return [base, base + size - 1] as const;
  },
);

function isPublicIPv4Int(value: number): boolean {
  return !NON_PUBLIC_IPV4_RANGES.some(([first, last]) => value >= first && value <= last);
}

/** Parses an IPv6 literal (optionally with a trailing dotted IPv4) into 16 bytes. */
export function parseIPv6(text: string): Uint8Array | null {
  if (isIP(text) !== 6 || text.includes('%')) return null;
  let rest = text;
  const tailWords: number[] = [];
  if (rest.includes('.')) {
    // Trailing dotted IPv4 ("::ffff:1.2.3.4", "64:ff9b::1.2.3.4", "1:2:3:4:5:6:1.2.3.4").
    const lastColon = rest.lastIndexOf(':');
    const v4 = ipv4ToInt(rest.slice(lastColon + 1));
    if (v4 === null) return null;
    tailWords.push(Math.floor(v4 / 65_536), v4 % 65_536);
    rest = rest.slice(0, lastColon + 1);
    if (!rest.endsWith('::')) rest = rest.slice(0, -1);
  }
  const toWords = (part: string): number[] | null => {
    if (part.length === 0) return [];
    const groups = part.split(':');
    if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
    return groups.map((g) => Number.parseInt(g, 16));
  };
  let words: number[] | null;
  const doubleColon = rest.indexOf('::');
  if (doubleColon >= 0) {
    const left = toWords(rest.slice(0, doubleColon));
    const right = toWords(rest.slice(doubleColon + 2));
    if (left === null || right === null) return null;
    const missing = 8 - tailWords.length - left.length - right.length;
    if (missing < 0) return null;
    words = [...left, ...new Array<number>(missing).fill(0), ...right, ...tailWords];
  } else {
    const groups = toWords(rest);
    words = groups === null ? null : [...groups, ...tailWords];
  }
  if (words === null || words.length !== 8) return null;
  const bytes = new Uint8Array(16);
  words.forEach((w, i) => {
    bytes[2 * i] = w >> 8;
    bytes[2 * i + 1] = w & 0xff;
  });
  return bytes;
}

function embeddedIPv4(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) * 16_777_216 +
    (bytes[offset + 1] ?? 0) * 65_536 +
    (bytes[offset + 2] ?? 0) * 256 +
    (bytes[offset + 3] ?? 0)
  );
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((b, i) => bytes[i] === b);
}

const IPV4_MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff] as const;
const NAT64_PREFIX = [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0] as const;

function isPublicIPv6Bytes(bytes: Uint8Array): boolean {
  // IPv4-mapped (::ffff:a.b.c.d) and the NAT64 well-known prefix (64:ff9b::/96) carry an IPv4
  // destination: they are public exactly when the embedded IPv4 address is.
  if (startsWith(bytes, IPV4_MAPPED_PREFIX) || startsWith(bytes, NAT64_PREFIX)) {
    return isPublicIPv4Int(embeddedIPv4(bytes, 12));
  }
  const b0 = bytes[0] ?? 0;
  const b1 = bytes[1] ?? 0;
  const b2 = bytes[2] ?? 0;
  const b3 = bytes[3] ?? 0;
  // Only global unicast (2000::/3) is reachable on the internet; everything else (::, ::1,
  // fc00::/7, fe80::/10, ff00::/8, 100::/64, ...) is refused.
  if ((b0 & 0xe0) !== 0x20) return false;
  if (b0 === 0x20 && b1 === 0x01 && (b2 & 0xfe) === 0x00) return false; // 2001::/23 IETF (Teredo, ...)
  if (b0 === 0x20 && b1 === 0x01 && b2 === 0x0d && b3 === 0xb8) return false; // 2001:db8::/32 doc
  if (b0 === 0x20 && b1 === 0x02) return false; // 2002::/16 6to4
  if (b0 === 0x3f && b1 === 0xff && (b2 & 0xf0) === 0x00) return false; // 3fff::/20 doc
  return true;
}

/** True when `address` (an IPv4 or IPv6 literal) is a globally reachable unicast address. */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const value = ipv4ToInt(address);
    return value !== null && isPublicIPv4Int(value);
  }
  if (version === 6) {
    const bytes = parseIPv6(address);
    return bytes !== null && isPublicIPv6Bytes(bytes);
  }
  return false;
}
