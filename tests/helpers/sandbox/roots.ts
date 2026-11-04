// Temporary WORKSPACES_ROOT / CLAUDE_HOME_ROOT / CBM_CACHE_DIR trees for sandbox tests.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SandboxRoots {
  base: string;
  ws: string;
  claudeHome: string;
  cbm: string;
  roots: string[];
  /** Attempt lease paths: worktree, .meta, claude home, cbm cache. */
  attemptPaths(task: string): { worktree: string; meta: string; home: string; cache: string };
  cleanup(): void;
}

const PROJECT = 'p1';

export function makeRoots(prefix = 'orc-sandbox-'): SandboxRoots {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  const ws = join(base, 'workspaces');
  const claudeHome = join(base, 'claude');
  const cbm = join(base, 'cbm-cache');
  for (const d of [ws, claudeHome, cbm]) mkdirSync(d, { recursive: true });
  mkdirSync(join(ws, '.repos', 'p1.git'), { recursive: true });
  return {
    base,
    ws,
    claudeHome,
    cbm,
    roots: [ws, claudeHome, cbm],
    attemptPaths(task) {
      const worktree = join(ws, PROJECT, task, 'a1');
      const meta = join(ws, PROJECT, task, 'a1.meta');
      const home = join(claudeHome, 'w', `ws-${task}`);
      const cache = join(cbm, 'w', `ws-${task}`);
      for (const d of [worktree, meta, home, cache]) mkdirSync(d, { recursive: true });
      mkdirSync(join(worktree, 'src'), { recursive: true });
      writeFileSync(join(worktree, 'src', 'index.ts'), 'export const x = 1;\n');
      writeFileSync(join(worktree, 'README.md'), '# test\n');
      writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere\n');
      return { worktree, meta, home, cache };
    },
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}
