// Process-wide sharing of one globalSetup run between Vitest projects. Vitest initialises the globalSetup of every
// selected project up front in the main process and tears them all down at the end of the run, loading the file
// once per project. global-infra.ts holds an exclusive applock until teardown, so a second project initialising it
// in the same process would wait on its own process' lock. sharedRun() prepares once per process, hands every
// project the same result and releases only when the last project tears down.

export type Release = () => Promise<void>;

interface SharedEntry {
  users: number;
  ready: Promise<Release>;
}

type Registry = Map<string, SharedEntry>;

const REGISTRY_KEY = Symbol.for('orc.tests.sharedRun');

function registry(): Registry {
  const holder = globalThis as { [REGISTRY_KEY]?: Registry };
  holder[REGISTRY_KEY] ??= new Map<string, SharedEntry>();
  return holder[REGISTRY_KEY];
}

/** Number of projects currently holding the shared run `key` (0 when none). */
export function sharedRunUsers(key: string): number {
  return registry().get(key)?.users ?? 0;
}

/**
 * Runs `prepare` once per process for `key` while at least one holder exists. Every caller gets its own
 * idempotent release; the underlying release runs when the last holder releases. A failed prepare is not
 * cached: every waiting caller sees the error and the next caller prepares afresh.
 */
export async function sharedRun(key: string, prepare: () => Promise<Release>): Promise<Release> {
  const runs = registry();
  let entry = runs.get(key);
  if (!entry) {
    entry = { users: 0, ready: prepare() };
    runs.set(key, entry);
  }
  const current = entry;
  current.users += 1;
  let release: Release;
  try {
    release = await current.ready;
  } catch (err) {
    current.users -= 1;
    if (runs.get(key) === current) runs.delete(key);
    throw err;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    current.users -= 1;
    if (current.users > 0) return;
    if (runs.get(key) === current) runs.delete(key);
    await release();
  };
}
