// Integration "world" for @orc/git-manager: temp PROJECTS_ROOT / WORKSPACES_ROOT / hooks dir,
// a real source repository and a manager factory with an in-memory recorder and lock.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProcessRegistry } from '@orc/shared/node';
import {
  createGitManager,
  type GitManager,
  type GitManagerConfig,
  type GitOpContext,
} from '@orc/git-manager';
import {
  baseConfig,
  createSourceRepo,
  gitT,
  IS_WIN32,
  makeTempDir,
  memoryLock,
  memoryRecorder,
  removeTempDir,
  silentLogger,
} from './fixtures';

export interface World {
  root: string;
  pr: string;
  ws: string;
  hooks: string;
  home: string;
  /** Marker directory: hooks/filters planted by tests write here when (wrongly) executed. */
  markers: string;
  projectId: string;
  ctx: GitOpContext;
  recorder: ReturnType<typeof memoryRecorder>;
  lock: ReturnType<typeof memoryLock>;
  manager(overrides?: Partial<GitManagerConfig>, registry?: ProcessRegistry): GitManager;
  git(cwd: string, args: readonly string[], allowFail?: boolean): ReturnType<typeof gitT>;
  repo(name: string, files: Record<string, string | Buffer>): { dir: string; sha: string };
  dispose(): void;
}

export const TASK_1 = '7d0c6c1e-1f2a-4b3c-8d4e-5f6a7b8c9d01';
export const TASK_2 = '7d0c6c1e-1f2a-4b3c-8d4e-5f6a7b8c9d02';
export const ATTEMPT_1 = 'a1a1a1a1-0000-4000-8000-000000000001';

export function createWorld(projectId = '5e1f0a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b'): World {
  const root = makeTempDir('orc-gm-int-');
  const pr = path.join(root, 'projects');
  const ws = path.join(root, 'workspaces');
  const hooks = path.join(root, 'empty-hooks');
  const home = path.join(root, 'home');
  const markers = path.join(root, 'markers');
  for (const d of [pr, ws, hooks, home, markers]) mkdirSync(d, { recursive: true });
  const recorder = memoryRecorder();
  const lock = memoryLock();
  const ctx: GitOpContext = { projectId, taskId: null, attemptId: null, correlationId: 'it-corr' };
  return {
    root,
    pr,
    ws,
    hooks,
    home,
    markers,
    projectId,
    ctx,
    recorder,
    lock,
    manager(overrides = {}, registry) {
      return createGitManager(
        baseConfig({ projectsRoot: pr, workspacesRoot: ws, hooksDir: hooks }, overrides),
        {
          logger: silentLogger(),
          recorder,
          lock,
          workerId: 'it-worker',
          ...(registry ? { registry } : {}),
        },
      );
    },
    git(cwd, args, allowFail = false) {
      return gitT(cwd, args, { home, allowFail });
    },
    repo(name, files) {
      const dir = path.join(pr, name);
      return { dir, sha: createSourceRepo(dir, files, home) };
    },
    dispose() {
      removeTempDir(root);
    },
  };
}

/** Directory link that needs no privilege: junction on Windows, symlink elsewhere. */
export function linkDir(target: string, link: string): void {
  symlinkSync(target, link, IS_WIN32 ? 'junction' : 'dir');
}

/** A hook script that records its own execution in `markers/<name>`. */
export function hookScript(markers: string, name: string): string {
  const marker = path.join(markers, name).replaceAll('\\', '/');
  return `#!/bin/sh\necho ran > "${marker}"\n`;
}

export const HOOK_NAMES = [
  'pre-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'post-checkout',
  'post-merge',
  'post-rewrite',
  'reference-transaction',
  'post-index-change',
  'pre-auto-gc',
  'fsmonitor-watchman',
  'pre-push',
  'push-to-checkout',
] as const;

/** Writes every hook in HOOK_NAMES into `dir`, each with its own marker `<tag>-<hook>`. */
export function plantHooks(dir: string, markers: string, tag: string): void {
  mkdirSync(dir, { recursive: true });
  for (const h of HOOK_NAMES) {
    writeFileSync(path.join(dir, h), hookScript(markers, `${tag}-${h}`), { mode: 0o755 });
  }
}
