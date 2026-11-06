export interface LoginLimiter {
  /** Milliseconds until the address may try again; 0 when it is not locked. */
  lockedFor(key: string): number;
  failed(key: string): void;
  succeeded(key: string): void;
}

/**
 * Locks an e-mail address for `lockMs` after `maxAttempts` failed logins in a row. Kept in memory:
 * a restart clears the counters, which is acceptable for a service that only listens on 127.0.0.1.
 */
export function createLoginLimiter(maxAttempts: number, lockMs: number, now: () => number = Date.now): LoginLimiter {
  const entries = new Map<string, { failures: number; lockedUntil: number }>();

  const prune = (): void => {
    if (entries.size < 10_000) return;
    const t = now();
    for (const [key, e] of entries) if (e.lockedUntil < t && e.failures < maxAttempts) entries.delete(key);
  };

  return {
    lockedFor(key) {
      const e = entries.get(key);
      if (e === undefined) return 0;
      const left = e.lockedUntil - now();
      if (left > 0) return left;
      if (e.failures >= maxAttempts) entries.delete(key); // the lock ran out: start counting again
      return 0;
    },
    failed(key) {
      prune();
      const e = entries.get(key) ?? { failures: 0, lockedUntil: 0 };
      e.failures++;
      if (e.failures >= maxAttempts) e.lockedUntil = now() + lockMs;
      entries.set(key, e);
    },
    succeeded(key) {
      entries.delete(key);
    },
  };
}
