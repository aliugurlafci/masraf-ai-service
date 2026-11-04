import { describe, expect, it } from 'vitest';

// Guards the source-first workspace layout: every library must resolve through
// its package.json "exports" map to TypeScript source without a build step.
const LIBRARY_PACKAGES = [
  '@orc/shared',
  '@orc/logger',
  '@orc/security',
  '@orc/database',
  '@orc/git-manager',
  '@orc/mcp-manager',
  '@orc/claude-runner',
  '@orc/task-manager',
  '@orc/project-manager',
  '@orc/orchestrator',
] as const;

// The first import of a package transforms its whole source graph; on a cold cache with the other unit files
// running in parallel this has exceeded the 5 s default, so each import gets an explicit budget.
const COLD_IMPORT_TIMEOUT_MS = 60_000;

describe('workspace package resolution', { timeout: COLD_IMPORT_TIMEOUT_MS }, () => {
  it.each(LIBRARY_PACKAGES)('resolves %s from source', async (packageName) => {
    const moduleNamespace: unknown = await import(packageName);
    expect(moduleNamespace).toBeTypeOf('object');
  });
});
