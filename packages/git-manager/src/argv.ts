// Exact git argv per operation (contract §11.3, §11.4). Pure functions; paths are absolute and
// already produced by resolveWithin, refs/shas already validated by the caller.
import type { HostPlatform } from '@orc/shared/node';
import { UnsafeArgumentError } from '@orc/security';

/** Git on Windows accepts '/' everywhere; '/'-separated spellings keep safe.directory comparisons exact. */
export function toGitPath(p: string, platform: HostPlatform): string {
  return platform === 'win32' ? p.replaceAll('\\', '/') : p;
}

/** Fully qualified only: '/...' (POSIX); 'C:\...', 'C:/...' or UNC (win32). Never '*', '~...' or '%(prefix)'. */
function isQualifiedPath(p: string, platform: HostPlatform): boolean {
  return platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(p) : p.startsWith('/');
}

/**
 * Global config text of the per-call `GIT_CONFIG_GLOBAL` file for git processes that the local
 * transport starts itself (`git-upload-pack` of `mirror_fetch`; ADR-0033). The transport clears
 * git's `local_repo_env` (incl. `GIT_CONFIG_PARAMETERS`/`GIT_CONFIG_COUNT`) before it starts
 * upload-pack, so `-c safe.directory=` never reaches it, while `GIT_CONFIG_GLOBAL` is inherited.
 * Content: only `safe.directory` entries, one per exact absolute path (deduplicated like the
 * argv prefix), as quoted values with `\` and `"` escaped. Control characters and relative
 * paths are rejected, so no other key, section or wildcard can ever be produced.
 */
export function safeDirectoryConfig(dirs: readonly string[], platform: HostPlatform): string {
  if (dirs.length === 0) {
    throw new UnsafeArgumentError('Transport config needs at least one safe directory', {
      details: { reason: 'transport_config_empty' },
    });
  }
  const lines = ['# @orc/git-manager per-call transport config (ADR-0033); removed after the call', '[safe]'];
  const seen = new Set<string>();
  for (const dir of dirs) {
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is rejected
    if (!isQualifiedPath(dir, platform) || /[\u0000-\u001f\u007f]/.test(dir)) {
      throw new UnsafeArgumentError('Transport safe.directory must be an absolute path without control characters', {
        details: { reason: 'transport_config_path' },
      });
    }
    const value = toGitPath(dir, platform);
    const key = platform === 'win32' ? value.toLowerCase() : value;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`\tdirectory = "${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`);
  }
  return `${lines.join('\n')}\n`;
}

export interface IsolationOptions {
  hooksDir: string;
  /** Exact absolute path of each repository touched. */
  safeDirectories: readonly string[];
  /** mirror_fetch only: `-c protocol.file.allow=always`. */
  fetch?: boolean;
  platform: HostPlatform;
}

/** `GIT_CONFIG_GLOBAL` of every git spawn without a transport config (§11.3). */
export const NULL_GLOBAL_CONFIG = '/dev/null';

/** §11.3 argv prefix, in contract order. */
export function isolationPrefix(o: IsolationOptions): string[] {
  const out = [
    '-c',
    `core.hooksPath=${toGitPath(o.hooksDir, o.platform)}`,
    '-c',
    'core.fsmonitor=false',
    '-c',
    'credential.helper=',
    '-c',
    'protocol.allow=never',
    '-c',
    'gc.auto=0',
    '-c',
    'maintenance.auto=false',
    '-c',
    'advice.detachedHead=false',
  ];
  const seen = new Set<string>();
  for (const dir of o.safeDirectories) {
    const value = toGitPath(dir, o.platform);
    const key = o.platform === 'win32' ? value.toLowerCase() : value;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push('-c', `safe.directory=${value}`);
  }
  if (o.fetch) out.push('-c', 'protocol.file.allow=always');
  if (o.platform === 'win32') out.push('-c', 'core.longpaths=true');
  return out;
}

/** Builders for the argv after the prefix. `p` converts a path to git's spelling. */
export function gitArgv(platform: HostPlatform) {
  const p = (path: string): string => toGitPath(path, platform);
  const gd = (dir: string): string => `--git-dir=${p(dir)}`;
  /** Worktree ops: `--git-dir=<A> --work-tree=<W>` (never `-C <W>` / the worktree's .git file). */
  const wt = (admin: string, worktree: string): string[] => [gd(admin), `--work-tree=${p(worktree)}`];
  return {
    version: (): string[] => ['--version'],
    validateSourceDiscover: (src: string): string[] => [
      '-C',
      p(src),
      'rev-parse',
      '--is-bare-repository',
      '--absolute-git-dir',
    ],
    validateSourceHead: (gitDir: string): string[] => [
      gd(gitDir),
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ],
    validateSourceBranch: (gitDir: string, branch: string): string[] => [
      gd(gitDir),
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `refs/heads/${branch}^{commit}`,
    ],
    mirrorInit: (mirror: string): string[] => ['init', '--bare', '--quiet', p(mirror)],
    mirrorConfig: (mirror: string, key: string, value: string): string[] => [
      gd(mirror),
      'config',
      key,
      value,
    ],
    mirrorConfigGet: (mirror: string, key: string): string[] => [gd(mirror), 'config', '--get', key],
    mirrorFetch: (mirror: string): string[] => [
      gd(mirror),
      'fetch',
      '--prune',
      '--no-tags',
      '--no-write-fetch-head',
      '--quiet',
      'origin',
    ],
    listBranches: (mirror: string): string[] => [
      gd(mirror),
      'for-each-ref',
      '--format=%(refname:lstrip=3)%00%(objectname)',
      'refs/remotes/origin/',
    ],
    resolveRemoteBranch: (mirror: string, ref: string): string[] => [
      gd(mirror),
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `refs/remotes/origin/${ref}^{commit}`,
    ],
    resolveSha: (mirror: string, sha: string): string[] => [
      gd(mirror),
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${sha}^{commit}`,
    ],
    /** Existence check of a local branch in the mirror (§11.2 key-length retry). */
    localBranchExists: (mirror: string, branch: string): string[] => [
      gd(mirror),
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `refs/heads/${branch}`,
    ],
    worktreeAddAttempt: (
      mirror: string,
      lockLabel: string,
      branch: string,
      worktree: string,
      startSha: string,
    ): string[] => [
      gd(mirror),
      'worktree',
      'add',
      '--lock',
      '--reason',
      `orc-attempt-${lockLabel}`,
      '-b',
      branch,
      p(worktree),
      startSha,
    ],
    worktreeAddBase: (mirror: string, worktree: string, sha: string): string[] => [
      gd(mirror),
      'worktree',
      'add',
      '--detach',
      '--force',
      p(worktree),
      sha,
    ],
    worktreeUnlock: (mirror: string, worktree: string): string[] => [
      gd(mirror),
      'worktree',
      'unlock',
      p(worktree),
    ],
    worktreeRemove: (mirror: string, worktree: string): string[] => [
      gd(mirror),
      'worktree',
      'remove',
      '--force',
      '--force',
      p(worktree),
    ],
    worktreePrune: (mirror: string): string[] => [gd(mirror), 'worktree', 'prune', '--expire=now'],
    worktreeList: (mirror: string): string[] => [gd(mirror), 'worktree', 'list', '--porcelain', '-z'],
    add: (admin: string, worktree: string): string[] => [
      ...wt(admin, worktree),
      'add',
      '--all',
      '--',
      '.',
    ],
    diffCachedQuiet: (admin: string, worktree: string): string[] => [
      ...wt(admin, worktree),
      'diff',
      '--cached',
      '--quiet',
      '--no-ext-diff',
    ],
    commit: (admin: string, worktree: string, name: string, email: string): string[] => [
      ...wt(admin, worktree),
      '-c',
      `user.name=${name}`,
      '-c',
      `user.email=${email}`,
      '-c',
      'commit.gpgSign=false',
      'commit',
      '--no-verify',
      '--no-gpg-sign',
      '--quiet',
      '--file=-',
    ],
    revParseHead: (admin: string, worktree: string): string[] => [
      ...wt(admin, worktree),
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ],
    log: (admin: string, worktree: string, max: number, base: string): string[] => [
      ...wt(admin, worktree),
      'log',
      '--no-color',
      `--max-count=${max}`,
      '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e',
      `${base}..HEAD`,
    ],
    diffNameStatus: (admin: string, worktree: string, base: string): string[] => [
      ...wt(admin, worktree),
      'diff',
      '--name-status',
      '-M',
      '-z',
      '--no-ext-diff',
      '--no-textconv',
      base,
      'HEAD',
    ],
    diffNumstat: (admin: string, worktree: string, base: string): string[] => [
      ...wt(admin, worktree),
      'diff',
      '--numstat',
      '-M',
      '-z',
      '--no-ext-diff',
      '--no-textconv',
      base,
      'HEAD',
    ],
    diffPatch: (admin: string, worktree: string, base: string): string[] => [
      ...wt(admin, worktree),
      'diff',
      '-M',
      '--patch',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--full-index',
      base,
      'HEAD',
    ],
    formatPatch: (admin: string, worktree: string, base: string): string[] => [
      ...wt(admin, worktree),
      'format-patch',
      '--stdout',
      '--binary',
      '--full-index',
      '--no-color',
      '--no-signature',
      `${base}..HEAD`,
    ],
    mergeTree: (mirror: string, baseSha: string, headSha: string): string[] => [
      gd(mirror),
      'merge-tree',
      '--write-tree',
      '--name-only',
      '--no-messages',
      '-z',
      baseSha,
      headSha,
    ],
    mergeBaseIsAncestor: (mirror: string, baseSha: string, headSha: string): string[] => [
      gd(mirror),
      'merge-base',
      '--is-ancestor',
      baseSha,
      headSha,
    ],
    branchDelete: (mirror: string, branch: string): string[] => [
      gd(mirror),
      'branch',
      '-D',
      '--end-of-options',
      branch,
    ],
    gc: (mirror: string): string[] => [gd(mirror), 'gc', '--quiet', '--prune=2.weeks.ago'],
  };
}

export type GitArgv = ReturnType<typeof gitArgv>;
