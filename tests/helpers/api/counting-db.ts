// A Database view counting every repository call as `<repo>.<method>` (e.g. `apiTokens.findActiveByHash`): lets API
// tests prove which requests reach the database (credential lookups, audit inserts) without changing behaviour.
import type { Database } from '@orc/database';

type Fn = (...args: unknown[]) => unknown;

export type CallCounts = Map<string, number>;

export function callsOf(counts: CallCounts, name: string): number {
  return counts.get(name) ?? 0;
}

function bindIfFunction(value: unknown, target: object): unknown {
  return typeof value === 'function' ? (value as Fn).bind(target) : value;
}

export function withCallCounts(db: Database, counts: CallCounts): Database {
  const wrapped = new Map<PropertyKey, unknown>();
  const repoView = (name: string, repo: object): object =>
    new Proxy(repo, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop);
        if (typeof value !== 'function' || typeof prop !== 'string') return bindIfFunction(value, target);
        const fn = value as Fn;
        const key = `${name}.${prop}`;
        return (...args: unknown[]): unknown => {
          counts.set(key, callsOf(counts, key) + 1);
          return fn.apply(target, args);
        };
      },
    });
  const repos = new Proxy(db.repos, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== 'object' || value === null || typeof prop !== 'string') return bindIfFunction(value, target);
      let view = wrapped.get(prop);
      if (view === undefined) {
        view = repoView(prop, value);
        wrapped.set(prop, view);
      }
      return view;
    },
  });
  return new Proxy(db, {
    get: (target, prop) => (prop === 'repos' ? repos : bindIfFunction(Reflect.get(target, prop), target)),
  });
}
