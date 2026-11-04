// A Database view whose `repos.tasks.findVisible` waits a configurable time first: lets API tests hold a request inside
// SSE admission (e.g. to disconnect the client before the event stream opens).
import type { Database } from '@orc/database';

type Fn = (...args: unknown[]) => unknown;

function bindIfFunction(value: unknown, target: object): unknown {
  return typeof value === 'function' ? (value as Fn).bind(target) : value;
}

export function withDelayedFindVisible(db: Database, delayMs: () => number): Database {
  const realTasks = db.repos.tasks;
  const tasks = new Proxy(realTasks, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop !== 'findVisible' || typeof value !== 'function') return bindIfFunction(value, target);
      const findVisible = value as Fn;
      return async (...args: unknown[]): Promise<unknown> => {
        const ms = delayMs();
        if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
        return findVisible.apply(target, args);
      };
    },
  });
  const repos = new Proxy(db.repos, {
    get: (target, prop) => (prop === 'tasks' ? tasks : bindIfFunction(Reflect.get(target, prop), target)),
  });
  return new Proxy(db, {
    get: (target, prop) => (prop === 'repos' ? repos : bindIfFunction(Reflect.get(target, prop), target)),
  });
}
