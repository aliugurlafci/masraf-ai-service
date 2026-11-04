// ADR-0019 / §2.10: the API-side services never touch repositories or processes on disk. Project registration only
// stores the relative path and enqueues `sync-project`; the worker validates and mirrors. This guards the sources.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FORBIDDEN =
  /\bfrom\s+['"](?:node:)?(?:fs|fs\/promises|child_process|worker_threads)['"]|\brequire\(\s*['"](?:node:)?(?:fs|child_process)['"]|\bimport\(\s*['"](?:node:)?(?:fs|fs\/promises|child_process)['"]/;

function sourcesOf(pkg: string): string[] {
  const dir = fileURLToPath(new URL(`../../../packages/${pkg}/src`, import.meta.url));
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(dir, f));
}

describe('ADR-0019: service packages have no filesystem or process access', () => {
  for (const pkg of ['project-manager', 'task-manager']) {
    it(`${pkg} imports neither fs nor child_process`, () => {
      const files = sourcesOf(pkg);
      expect(files.length).toBeGreaterThan(0);
      const offenders = files.filter((f) => FORBIDDEN.test(readFileSync(f, 'utf8')));
      expect(offenders).toEqual([]);
    });
  }
});
