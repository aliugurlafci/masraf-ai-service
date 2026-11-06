import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

/**
 * Network rules of the service. By default it listens on 127.0.0.1 only. With AG_ERISIMI=yerel it
 * listens on every IPv4 interface so phones on the same Wi-Fi can reach it, and still answers only
 * to private-network addresses (192.168.x, 10.x, 172.16–31.x) and to the machine itself.
 */

const octets = (address: string): number[] | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (m === null) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
};

/** 127.0.0.0/8 and the private ranges of RFC 1918. */
export function isPrivateIPv4(address: string): boolean {
  const o = octets(address);
  if (o === null) return false;
  const [a = -1, b = -1] = o;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Whether a client address (as Node reports it) may use the service: the machine itself or the local network. */
export function isLocalNetworkAddress(remote: string | undefined): boolean {
  if (remote === undefined) return false;
  const address = remote.toLowerCase();
  if (address === '::1') return true;
  // An IPv4 client on a dual-stack socket shows up as ::ffff:a.b.c.d.
  return isPrivateIPv4(address.startsWith('::ffff:') ? address.slice(7) : address);
}

/** This machine's IPv4 addresses on private networks (Wi-Fi, Ethernet, virtual switches). */
export function lanAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  const out = new Set<string>();
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal && isPrivateIPv4(info.address)) out.add(info.address);
    }
  }
  return [...out];
}

/**
 * Host names the service answers to on the local network: the machine's private addresses, read again
 * at most every `refreshMs` so a new address from DHCP works without a restart, plus fixed extra names.
 */
export function lanHostList(extra: readonly string[], refreshMs = 30_000, read: () => string[] = lanAddresses, now = Date.now): () => readonly string[] {
  let cached: readonly string[] = [];
  let readAt = -Infinity;
  return () => {
    if (now() - readAt > refreshMs) {
      cached = [...read(), ...extra.map((h) => h.toLowerCase())];
      readAt = now();
    }
    return cached;
  };
}
