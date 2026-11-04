// Minimal in-memory RedisLike for lock unit tests: SET key value PX ms NX and the two lock scripts.
import type { RedisLike } from '@orc/git-manager';

export interface MemoryRedis extends RedisLike {
  store: Map<string, { value: string; expiresAt: number }>;
  now: () => number;
  calls: { cmd: string; args: (string | number)[] }[];
}

export function createMemoryRedis(now: () => number = Date.now): MemoryRedis {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const calls: { cmd: string; args: (string | number)[] }[] = [];
  const live = (key: string): { value: string; expiresAt: number } | undefined => {
    const e = store.get(key);
    if (e && e.expiresAt <= now()) {
      store.delete(key);
      return undefined;
    }
    return e;
  };
  return {
    store,
    now,
    calls,
    set(...args) {
      calls.push({ cmd: 'set', args });
      const [key, value, px, ms, nx] = args;
      if (px !== 'PX' || nx !== 'NX' || typeof ms !== 'number') {
        return Promise.reject(new Error(`unsupported SET form: ${args.join(' ')}`));
      }
      if (live(String(key))) return Promise.resolve(null);
      store.set(String(key), { value: String(value), expiresAt: now() + ms });
      return Promise.resolve('OK');
    },
    eval(script, numKeys, ...args) {
      calls.push({ cmd: 'eval', args: [script, numKeys, ...args] });
      const key = String(args[0]);
      const token = String(args[1]);
      const e = live(key);
      if (!e || e.value !== token) return Promise.resolve(0);
      if (script.includes("'pexpire'")) {
        e.expiresAt = now() + Number(args[2]);
        return Promise.resolve(1);
      }
      if (script.includes("'del'")) {
        store.delete(key);
        return Promise.resolve(1);
      }
      return Promise.reject(new Error('unsupported script'));
    },
  };
}
