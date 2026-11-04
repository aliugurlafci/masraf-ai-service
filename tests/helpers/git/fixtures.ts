// Shared fixtures for @orc/git-manager tests: temp dirs, isolated test-side git, recorder, lock.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { GitOperation, Uuid } from '@orc/shared';
import { createLogger, type Logger } from '@orc/logger';
import type {
  GitManagerConfig,
  GitOperationRecorder,
  MirrorLock,
} from '@orc/git-manager';

export const IS_WIN32 = process.platform === 'win32';
export const HOST_PLATFORM: 'posix' | 'win32' = IS_WIN32 ? 'win32' : 'posix';

/** Real (long-name) temp directory; 8.3 short names on Windows would defeat path comparisons. */
export function makeTempDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
}

/** Removes a temp tree even when it contains read-only files (git objects on Windows). */
export function removeTempDir(dir: string): void {
  const walk = (p: string): void => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    try {
      chmodSync(p, st.isDirectory() ? 0o777 : 0o666);
    } catch {
      // best effort
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) walk(path.join(p, name));
    }
  };
  walk(dir);
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Environment for test-side git commands: no global/system config, no prompts. */
export function testGitEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toUpperCase().startsWith('GIT_')) continue;
    env[k] = v;
  }
  return {
    ...env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: IS_WIN32 ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    LANG: 'C',
  };
}

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Test-side git with identity and isolated config. Throws on failure unless `allowFail`. */
export function gitT(
  cwd: string,
  args: readonly string[],
  o: { home: string; input?: string | Buffer; allowFail?: boolean; env?: NodeJS.ProcessEnv },
): GitResult {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args],
    {
      cwd,
      env: o.env ?? testGitEnv(o.home),
      shell: false,
      windowsHide: true,
      input: o.input,
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  const res = {
    status: r.status,
    stdout: r.stdout?.toString('utf8') ?? '',
    stderr: r.stderr?.toString('utf8') ?? '',
  };
  if (!o.allowFail && res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${String(res.status)}): ${res.stderr}`);
  }
  return res;
}

export function writeFileP(file: string, content: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Creates a non-bare source repository with an initial commit on `main`. */
export function createSourceRepo(
  dir: string,
  files: Record<string, string | Buffer>,
  home: string,
): string {
  mkdirSync(dir, { recursive: true });
  gitT(dir, ['init', '--quiet', '--initial-branch=main', '.'], { home });
  for (const [rel, content] of Object.entries(files)) writeFileP(path.join(dir, rel), content);
  gitT(dir, ['add', '--all'], { home });
  gitT(dir, ['commit', '--quiet', '-m', 'initial'], { home });
  return gitT(dir, ['rev-parse', 'HEAD'], { home }).stdout.trim();
}

/** sha256 of every file (and the type of every entry) under `root`, including .git. */
export function hashTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      const st = lstatSync(full);
      if (st.isSymbolicLink()) out.set(rel, 'symlink');
      else if (st.isDirectory()) {
        out.set(rel, 'dir');
        walk(full);
      } else out.set(rel, createHash('sha256').update(readFileSync(full)).digest('hex'));
    }
  };
  walk(root);
  return out;
}

export function silentLogger(): Logger {
  return createLogger({
    service: 'test',
    level: 'silent',
    version: 'test',
    env: 'test',
    destination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
}

export type RecordedOp = Omit<GitOperation, 'id' | 'createdAt'>;

export function memoryRecorder(): GitOperationRecorder & { ops: RecordedOp[] } {
  const ops: RecordedOp[] = [];
  return {
    ops,
    record(op) {
      ops.push(op);
      return Promise.resolve();
    },
  };
}

/** In-process MirrorLock (per-project promise chain) that also counts acquisitions. */
export function memoryLock(): MirrorLock & { acquired: Uuid[] } {
  const tails = new Map<string, Promise<unknown>>();
  const acquired: Uuid[] = [];
  return {
    acquired,
    withLock<T>(projectId: Uuid, fn: () => Promise<T>): Promise<T> {
      const prev = tails.get(projectId) ?? Promise.resolve();
      const run = prev.then(
        () => {
          acquired.push(projectId);
          return fn();
        },
        () => {
          acquired.push(projectId);
          return fn();
        },
      );
      tails.set(
        projectId,
        run.catch(() => undefined),
      );
      return run;
    },
  };
}

export function baseConfig(
  roots: { projectsRoot: string; workspacesRoot: string; hooksDir: string },
  overrides: Partial<GitManagerConfig> = {},
): GitManagerConfig {
  return {
    gitBin: 'git',
    projectsRoot: roots.projectsRoot,
    workspacesRoot: roots.workspacesRoot,
    hooksDir: roots.hooksDir,
    opTimeoutMs: 60_000,
    fetchTimeoutMs: 120_000,
    killGraceMs: 1000,
    authorName: 'Orc Orchestrator',
    authorEmail: 'orc@localhost',
    changedFilePatchMaxBytes: 262_144,
    patchExportMaxBytes: 52_428_800,
    diffMaxFiles: 5000,
    commitsMax: 500,
    workspaceMaxBytes: 2_147_483_648,
    minFreeBytes: 0,
    sizeScanMaxEntries: 500_000,
    stderrTailChars: 4000,
    platform: HOST_PLATFORM,
    ...overrides,
  };
}
