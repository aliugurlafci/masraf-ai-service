// Vitest lifecycle wrappers around the common helpers.
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { createTempDir } from './temp-dir';
import type { TempDir } from './temp-dir';

export interface UseTempDirOptions {
  /** 'each' (default): a fresh directory per test; 'all': one directory per describe/file. */
  readonly scope?: 'each' | 'all';
  readonly prefix?: string;
}

/**
 * Registers hooks that create a temp directory before and remove it after each test (or the
 * whole suite). Returns a getter for the current path; calling it outside a test throws.
 */
export function useTempDir(options: UseTempDirOptions = {}): () => string {
  let current: TempDir | undefined;
  const setup = async (): Promise<void> => {
    current = await createTempDir(options.prefix);
  };
  const teardown = async (): Promise<void> => {
    const dir = current;
    current = undefined;
    await dir?.cleanup();
  };
  if (options.scope === 'all') {
    beforeAll(setup);
    afterAll(teardown);
  } else {
    beforeEach(setup);
    afterEach(teardown);
  }
  return () => {
    if (!current) throw new Error('useTempDir: the directory only exists while a test runs');
    return current.path;
  };
}
