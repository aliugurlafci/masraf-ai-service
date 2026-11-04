// Temporary directories for tests with guaranteed cleanup (contract §18.2).
// Pure Node module (no vitest import, no relative imports) so it can also be loaded by
// plain `node` child processes in tests.
import { rmSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEMP_DIR_PREFIX = 'orc-test-';

/** §18.2: retries cover Windows EBUSY/EPERM while handles of exited children close. */
export const REMOVE_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 200,
} as const;

export interface TempDir {
  /** Canonical absolute path (symlinks and Windows 8.3 short names resolved). */
  readonly path: string;
  /** Removes the directory tree. Idempotent; a failed removal can be retried. */
  cleanup(): Promise<void>;
}

// Directories not yet removed; swept synchronously when the process exits so a test that
// forgets (or never reaches) cleanup does not leak them.
const pending = new Set<string>();
let exitHookInstalled = false;

function sweepPending(): void {
  for (const dir of pending) {
    try {
      rmSync(dir, REMOVE_OPTIONS);
    } catch (error) {
      process.stderr.write(
        `[test-helpers] could not remove temp dir ${dir}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  pending.clear();
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', sweepPending);
}

/** Removes a directory tree with the §18.2 retry policy. Missing directories are fine. */
export async function removeDir(dir: string): Promise<void> {
  await rm(dir, REMOVE_OPTIONS);
}

/** Creates `<os.tmpdir()>/<prefix>XXXXXX`. Call `cleanup()` (or rely on the exit sweep). */
export async function createTempDir(prefix: string = TEMP_DIR_PREFIX): Promise<TempDir> {
  if (!/^[\w.-]+$/.test(prefix)) {
    throw new Error(`invalid temp dir prefix ${JSON.stringify(prefix)}`);
  }
  const created = await mkdtemp(join(tmpdir(), prefix));
  pending.add(created);
  installExitHook();
  let path: string;
  try {
    path = await realpath(created);
  } catch (error) {
    await removeDir(created);
    pending.delete(created);
    throw error;
  }
  let removal: Promise<void> | undefined;
  return {
    path,
    cleanup(): Promise<void> {
      removal ??= removeDir(created).then(
        () => {
          pending.delete(created);
        },
        (error: unknown) => {
          removal = undefined;
          throw error;
        },
      );
      return removal;
    },
  };
}

/** Runs `fn` with a fresh temp directory and removes it afterwards, also when `fn` throws. */
export async function withTempDir<T>(
  fn: (dir: string) => T | Promise<T>,
  prefix: string = TEMP_DIR_PREFIX,
): Promise<T> {
  const dir = await createTempDir(prefix);
  try {
    return await fn(dir.path);
  } finally {
    await dir.cleanup();
  }
}

/** Temp directories created by this process and not removed yet (absolute, as created). */
export function pendingTempDirs(): string[] {
  return [...pending];
}
