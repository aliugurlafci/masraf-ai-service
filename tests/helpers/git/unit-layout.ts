// Fake on-disk mirror/worktree layout + scripted git responses for @orc/git-manager unit tests.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { splitPrefix, type FakeCall, type FakeResponse, type Responder } from './fake-spawn';
import { makeTempDir } from './fixtures';

export const P = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const T = '11111111-2222-4333-8444-555555555555';
export const T2 = '99999999-8888-4777-8666-555555555555';
export const ATTEMPT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const SHA_BASE = 'b'.repeat(40);
export const SHA_HEAD = 'c'.repeat(40);

export interface UnitLayout {
  root: string;
  ws: string;
  pr: string;
  hooks: string;
  src: string;
  srcGitDir: string;
  M: string;
  W: string;
  A: string;
  gp(p: string): string;
}

export function unitLayout(platform: 'posix' | 'win32'): UnitLayout {
  const root = makeTempDir('orc-gm-unit-');
  const ws = path.join(root, 'ws');
  const pr = path.join(root, 'projects');
  const hooks = path.join(root, 'hooks');
  const src = path.join(pr, 'repo');
  const srcGitDir = path.join(src, '.git');
  const M = path.join(ws, '.repos', `${P}.git`);
  const W = path.join(ws, P, T, 'a1');
  // Admin id deliberately differs from basename(W): git appends counters on collisions.
  const A = path.join(M, 'worktrees', 'a17');
  const gp = (p: string): string => (platform === 'win32' ? p.replaceAll('\\', '/') : p);
  for (const d of [ws, pr, hooks, srcGitDir, M, W, A]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(M, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(path.join(A, 'gitdir'), `${gp(W)}/.git\n`);
  writeFileSync(path.join(A, 'HEAD'), `${SHA_HEAD}\n`);
  writeFileSync(path.join(W, '.git'), 'gitdir: /somewhere/else\n');
  return { root, ws, pr, hooks, src, srcGitDir, M, W, A, gp };
}

/** The git subcommand and its arguments, skipping global options. */
export function subcommand(rest: readonly string[]): { sub: string; after: string[] } {
  let i = 0;
  while (i < rest.length) {
    const a = rest[i] as string;
    if (a === '-C' || a === '-c') {
      i += 2;
      continue;
    }
    if (a.startsWith('--git-dir=') || a.startsWith('--work-tree=')) {
      i += 1;
      continue;
    }
    break;
  }
  return { sub: rest[i] ?? '', after: rest.slice(i + 1) };
}

export interface ScriptOptions {
  nameStatus?: string;
  numstat?: string;
  patch?: string | Buffer;
  log?: string;
  formatPatch?: string | Buffer;
  /** Branch names (refs/heads/<name>) that already exist in the mirror. */
  existingBranches?: string[];
  override?: (sub: string, after: string[], call: FakeCall) => FakeResponse | undefined;
}

/** Default scripted git behaviour for the unit layout. */
export function scriptedGit(L: UnitLayout, o: ScriptOptions = {}): Responder {
  const extraWorktrees: string[] = [];
  return (call) => {
    const { rest } = splitPrefix(call.args);
    const { sub, after } = subcommand(rest);
    const custom = o.override?.(sub, after, call);
    if (custom) return custom;
    const last = after[after.length - 1] ?? '';
    switch (sub) {
      case '--version':
        return { stdout: 'git version 2.45.1\n' };
      case 'rev-parse':
        if (after.includes('--is-bare-repository')) {
          return { stdout: `false\n${L.gp(L.srcGitDir)}\n` };
        }
        if (last === 'HEAD^{commit}') return { stdout: `${SHA_HEAD}\n` };
        if (last === 'refs/heads/main^{commit}') return { stdout: `${SHA_HEAD}\n` };
        if (last === 'refs/remotes/origin/main^{commit}') return { stdout: `${SHA_BASE}\n` };
        if (last.startsWith('refs/heads/')) {
          const name = last.slice('refs/heads/'.length);
          return (o.existingBranches ?? []).includes(name)
            ? { stdout: `${SHA_BASE}\n` }
            : { code: 1 };
        }
        if (/^[0-9a-f]{7,64}\^\{commit\}$/.test(last)) {
          return last.startsWith('b') ? { stdout: `${SHA_BASE}\n` } : { code: 1 };
        }
        return { code: 1 };
      case 'symbolic-ref':
        return { stdout: 'main\n' };
      case 'init':
      case 'fetch':
      case 'add':
      case 'commit':
      case 'gc':
        return { code: 0 };
      case 'config':
        return after[0] === '--get' ? { stdout: `${L.gp(L.srcGitDir)}\n` } : { code: 0 };
      case 'for-each-ref':
        return { stdout: `HEAD\0${SHA_BASE}\nmain\0${SHA_BASE}\ndev\0${SHA_HEAD}\n` };
      case 'worktree': {
        if (after[0] === 'add') {
          const target = after[after.length - 2] as string;
          const wPath = path.resolve(target);
          mkdirSync(wPath, { recursive: true });
          const admin = path.join(L.M, 'worktrees', `a1${extraWorktrees.length + 2}`);
          mkdirSync(admin, { recursive: true });
          writeFileSync(path.join(admin, 'gitdir'), `${L.gp(wPath)}/.git\n`);
          writeFileSync(path.join(admin, 'HEAD'), `${SHA_BASE}\n`);
          extraWorktrees.push(wPath);
          return { code: 0 };
        }
        if (after[0] === 'list') {
          const entries = [
            `worktree ${L.gp(L.M)}\0bare\0\0`,
            `worktree ${L.gp(L.W)}\0HEAD ${SHA_HEAD}\0branch refs/heads/orc/task-11111111-a1\0locked orc-attempt-x\0\0`,
            ...extraWorktrees.map((w) => `worktree ${L.gp(w)}\0HEAD ${SHA_BASE}\0detached\0\0`),
          ];
          return { stdout: entries.join('') };
        }
        return { code: 0 };
      }
      case 'diff':
        if (after.includes('--cached')) return { code: 1 };
        if (after.includes('--name-status')) return { stdout: o.nameStatus ?? '' };
        if (after.includes('--numstat')) return { stdout: o.numstat ?? '' };
        return { stdout: o.patch ?? '' };
      case 'log':
        return { stdout: o.log ?? '' };
      case 'format-patch':
        return { stdout: o.formatPatch ?? '' };
      case 'merge-tree':
        return { code: 1, stdout: `${'d'.repeat(40)}\0a.txt\0a.txt\0b.txt\0` };
      case 'merge-base':
        return { code: 1 };
      case 'branch':
        return { code: 1, stderr: `error: branch '${last}' not found.\n` };
      default:
        return { code: 129, stderr: `unexpected git call: ${rest.join(' ')}` };
    }
  };
}
