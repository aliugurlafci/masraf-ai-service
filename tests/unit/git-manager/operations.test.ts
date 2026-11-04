// Exact argv / env / cwd / recording per operation through the public API with a fake spawn.
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '@orc/shared';
import { ConfigError } from '@orc/shared/node';
import { GIT_ENV_ALLOWLIST, WINDOWS_BASE_ENV } from '@orc/security';
import {
  createGitManager,
  GitError,
  GitRefNotFoundError,
  GitTimeoutError,
  type GitManager,
  type GitManagerConfig,
  type WorktreeInfo,
} from '@orc/git-manager';
import { createFakeSpawn, type FakeSpawn } from '../../helpers/git/fake-spawn';
import {
  baseConfig,
  HOST_PLATFORM,
  memoryLock,
  memoryRecorder,
  removeTempDir,
  silentLogger,
} from '../../helpers/git/fixtures';
import {
  ATTEMPT,
  P,
  SHA_BASE,
  SHA_HEAD,
  T,
  T2,
  scriptedGit,
  subcommand,
  unitLayout,
  type ScriptOptions,
  type UnitLayout,
} from '../../helpers/git/unit-layout';

const CTX = { projectId: P, taskId: T, attemptId: ATTEMPT, correlationId: 'corr-1' };

function prefixFor(L: UnitLayout, safe: string[], o: { fetch?: boolean; platform?: string } = {}) {
  const platform = o.platform ?? HOST_PLATFORM;
  const g = (p: string): string => (platform === 'win32' ? p.replaceAll('\\', '/') : p);
  return [
    '-c',
    `core.hooksPath=${g(L.hooks)}`,
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
    ...safe.flatMap((s) => ['-c', `safe.directory=${g(s)}`]),
    ...(o.fetch ? ['-c', 'protocol.file.allow=always'] : []),
    ...(platform === 'win32' ? ['-c', 'core.longpaths=true'] : []),
  ];
}

describe('git-manager operations (fake spawn)', () => {
  let L: UnitLayout;
  let fake: FakeSpawn;
  let recorder: ReturnType<typeof memoryRecorder>;
  let lock: ReturnType<typeof memoryLock>;
  let gm: GitManager;
  let g: (p: string) => string;

  const build = (script: ScriptOptions = {}, overrides: Partial<GitManagerConfig> = {}): void => {
    fake = createFakeSpawn(scriptedGit(L, script));
    recorder = memoryRecorder();
    lock = memoryLock();
    gm = createGitManager(
      baseConfig({ projectsRoot: L.pr, workspacesRoot: L.ws, hooksDir: L.hooks }, overrides),
      { logger: silentLogger(), recorder, lock, workerId: 'worker-1', spawn: fake.spawn },
    );
  };

  const wt = (): WorktreeInfo => ({
    path: L.W,
    relPath: `${P}/${T}/a1`,
    adminDir: L.A,
    branchName: 'orc/task-11111111-a1',
    baseSha: SHA_BASE,
    startSha: SHA_BASE,
    keyLength: 8,
  });

  const lastGit = () => {
    const all = fake.gitCalls();
    return all[all.length - 1] as (typeof all)[number];
  };

  beforeEach(() => {
    L = unitLayout(HOST_PLATFORM);
    g = (p: string): string => L.gp(p);
    build();
  });

  afterEach(() => {
    removeTempDir(L.root);
  });

  it('rejects invalid configuration with ConfigError', () => {
    expect(() =>
      createGitManager(
        baseConfig(
          { projectsRoot: 'relative/path', workspacesRoot: L.ws, hooksDir: L.hooks },
          { authorName: 'evil\nname' },
        ),
        { logger: silentLogger(), recorder, lock, workerId: 'w', spawn: fake.spawn },
      ),
    ).toThrow(ConfigError);
    expect(() =>
      createGitManager(baseConfig({ projectsRoot: L.pr, workspacesRoot: L.ws, hooksDir: L.hooks }), {
        logger: silentLogger(),
        recorder,
        lock,
        workerId: '../x',
        spawn: fake.spawn,
      }),
    ).toThrow(ConfigError);
  });

  it('version: --version with the full isolation prefix, cwd-independent, not recorded', async () => {
    await expect(gm.version()).resolves.toBe('2.45.1');
    const c = lastGit();
    expect(c.prefix).toEqual(prefixFor(L, []));
    expect(c.rest).toEqual(['--version']);
    expect(recorder.ops).toHaveLength(0);
  });

  it('version: refuses git older than 2.38', async () => {
    build({ override: (sub) => (sub === '--version' ? { stdout: 'git version 2.37.9\n' } : undefined) });
    await expect(gm.version()).rejects.toBeInstanceOf(GitError);
  });

  it('builds the §11.3 environment from the allowlist only', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-should-not-leak');
    vi.stubEnv('GIT_DIR', '/tmp/evil');
    vi.stubEnv('GIT_CONFIG_PARAMETERS', "'core.fsmonitor'='evil'");
    vi.stubEnv('DB_PASSWORD', 'secret-password');
    await gm.version();
    const env = lastGit().call.env;
    const allowed = new Set(
      [...GIT_ENV_ALLOWLIST, ...(HOST_PLATFORM === 'win32' ? WINDOWS_BASE_ENV : [])].map((k) =>
        k.toUpperCase(),
      ),
    );
    for (const key of Object.keys(env)) expect(allowed.has(key.toUpperCase())).toBe(true);
    expect(env).toMatchObject({
      HOME: path.join(L.ws, '.orc', 'git-home'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
      LANG: 'C',
    });
    expect(env).not.toHaveProperty('GIT_DIR');
    expect(env).not.toHaveProperty('GIT_CONFIG_PARAMETERS');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(lastGit().call.options).toMatchObject({ shell: false, windowsHide: true });
  });

  it('adds core.longpaths=true only on win32 and keeps the contract prefix order', async () => {
    for (const platform of ['posix', 'win32'] as const) {
      build({}, { platform });
      await gm.version();
      expect(lastGit().prefix).toEqual(prefixFor(L, [], { platform }));
    }
  });

  it('syncMirror: validate_source, mirror_config, mirror_fetch, list_branches with exact argv', async () => {
    const info = await gm.syncMirror(P, 'repo', CTX);
    expect(info.mirrorPath).toBe(L.M);
    expect(info.branches).toEqual([
      { name: 'main', sha: SHA_BASE },
      { name: 'dev', sha: SHA_HEAD },
    ]);
    expect(lock.acquired).toEqual([P]);
    const calls = fake.gitCalls();
    const rests = calls.map((c) => c.rest);
    expect(rests).toEqual([
      ['-C', g(L.src), 'rev-parse', '--is-bare-repository', '--absolute-git-dir'],
      [`--git-dir=${g(L.srcGitDir)}`, 'symbolic-ref', '--quiet', '--short', 'HEAD'],
      [
        `--git-dir=${g(L.srcGitDir)}`,
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        'refs/heads/main^{commit}',
      ],
      [`--git-dir=${g(L.M)}`, 'config', 'remote.origin.url', g(L.srcGitDir)],
      [`--git-dir=${g(L.M)}`, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
      [`--git-dir=${g(L.M)}`, 'config', 'core.hooksPath', g(L.hooks)],
      [`--git-dir=${g(L.M)}`, 'config', 'core.fsmonitor', 'false'],
      [`--git-dir=${g(L.M)}`, 'config', 'gc.auto', '0'],
      [`--git-dir=${g(L.M)}`, 'fetch', '--prune', '--no-tags', '--no-write-fetch-head', '--quiet', 'origin'],
      [
        `--git-dir=${g(L.M)}`,
        'for-each-ref',
        '--format=%(refname:lstrip=3)%00%(objectname)',
        'refs/remotes/origin/',
      ],
    ]);
    expect(calls[0]?.prefix).toEqual(prefixFor(L, [L.src]));
    expect(calls[1]?.prefix).toEqual(prefixFor(L, [L.src, L.srcGitDir]));
    expect(calls[8]?.prefix).toEqual(prefixFor(L, [L.M, L.srcGitDir], { fetch: true }));
    // protocol.file.allow=always appears on the fetch only.
    for (const [i, c] of calls.entries()) {
      expect(c.prefix.includes('protocol.file.allow=always')).toBe(i === 8);
    }
    expect(calls[3]?.call.cwd).toBe(path.join(L.ws, '.repos'));
  });

  it('syncMirror: initialises a missing mirror with init --bare --quiet', async () => {
    removeTempDir(L.M);
    await gm.syncMirror(P, 'repo', CTX);
    const init = fake.gitCalls().find((c) => subcommand(c.rest).sub === 'init');
    expect(init?.rest).toEqual(['init', '--bare', '--quiet', g(L.M)]);
  });

  it('records every op with sanitized args, tokenized cwd and context', async () => {
    await gm.syncMirror(P, 'repo', CTX);
    expect(recorder.ops.map((o) => o.operation)).toEqual([
      'validate_source',
      'validate_source',
      'validate_source',
      'mirror_config',
      'mirror_config',
      'mirror_config',
      'mirror_config',
      'mirror_config',
      'mirror_fetch',
      'list_branches',
    ]);
    const fetchOp = recorder.ops[8];
    expect(fetchOp).toMatchObject({
      projectId: P,
      taskId: T,
      attemptId: ATTEMPT,
      workerId: 'worker-1',
      correlationId: 'corr-1',
      success: true,
      timedOut: false,
      exitCode: 0,
      cwd: '<WORKSPACES_ROOT>/.repos'.replace('/', HOST_PLATFORM === 'win32' ? '\\' : '/'),
    });
    const flat = recorder.ops.flatMap((o) => [...o.args, o.cwd ?? '']).join('\n');
    expect(flat).not.toContain(L.ws);
    expect(flat).not.toContain(g(L.ws));
    expect(flat).not.toContain(L.pr);
    expect(fetchOp?.args).toContain('--git-dir=<WORKSPACES_ROOT>/.repos/' + `${P}.git`);
  });

  it('resolveBase: branch => refs/remotes/origin/<ref>^{commit}; sha => <sha>^{commit}', async () => {
    await expect(gm.resolveBase(P, 'main', CTX)).resolves.toBe(SHA_BASE);
    expect(lastGit().rest).toEqual([
      `--git-dir=${g(L.M)}`,
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      'refs/remotes/origin/main^{commit}',
    ]);
    await expect(gm.resolveBase(P, 'bbbbbbb', CTX)).resolves.toBe(SHA_BASE);
    expect(lastGit().rest.at(-1)).toBe('bbbbbbb^{commit}');
  });

  it('resolveBase: exit 1 => GitRefNotFoundError; unsafe ref is refused without spawning', async () => {
    await expect(gm.resolveBase(P, 'missing', CTX)).rejects.toBeInstanceOf(GitRefNotFoundError);
    const before = fake.calls.length;
    await expect(gm.resolveBase(P, '--upload-pack=evil', CTX)).rejects.toBeInstanceOf(
      GitRefNotFoundError,
    );
    await expect(gm.resolveBase(P, 'a..b', CTX)).rejects.toBeInstanceOf(GitRefNotFoundError);
    expect(fake.calls.length).toBe(before);
    expect(recorder.ops.at(-1)?.success).toBe(false);
  });

  it('createAttemptWorktree: key-length retry, locked worktree add, admin dir from the mirror', async () => {
    build({ existingBranches: ['orc/task-99999999-a2'] });
    const info = await gm.createAttemptWorktree(
      { projectId: P, taskId: T2, attemptNumber: 2, baseSha: SHA_BASE },
      CTX,
    );
    const W2 = path.join(L.ws, P, T2, 'a2');
    expect(info).toMatchObject({
      path: W2,
      relPath: `${P}/${T2}/a2`,
      branchName: 'orc/task-999999998888-a2',
      keyLength: 12,
      baseSha: SHA_BASE,
      startSha: SHA_BASE,
    });
    expect(path.dirname(info.adminDir)).toBe(path.join(L.M, 'worktrees'));
    const rests = fake.gitCalls().map((c) => c.rest);
    expect(rests).toContainEqual([
      `--git-dir=${g(L.M)}`,
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      'refs/heads/orc/task-99999999-a2',
    ]);
    expect(rests).toContainEqual([
      `--git-dir=${g(L.M)}`,
      'worktree',
      'add',
      '--lock',
      '--reason',
      `orc-attempt-${ATTEMPT}`,
      '-b',
      'orc/task-999999998888-a2',
      g(W2),
      SHA_BASE,
    ]);
    expect(rests.at(-1)).toEqual([`--git-dir=${g(L.M)}`, 'worktree', 'list', '--porcelain', '-z']);
  });

  it('createAttemptWorktree: refuses an existing path and invalid input', async () => {
    await expect(
      gm.createAttemptWorktree({ projectId: P, taskId: T, attemptNumber: 1, baseSha: SHA_BASE }, CTX),
    ).rejects.toMatchObject({ code: 'git_failed', details: { reason: 'worktree_exists' } });
    await expect(
      gm.createAttemptWorktree({ projectId: P, taskId: T2, attemptNumber: 1, baseSha: '--evil' }, CTX),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      gm.createAttemptWorktree(
        { projectId: P, taskId: T2, attemptNumber: 1, baseSha: SHA_BASE },
        { ...CTX, projectId: T },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('createAttemptWorktree: a linked task directory is refused before any git spawn', async () => {
    const { mkdirSync, readdirSync, symlinkSync } = await import('node:fs');
    const outside = path.join(L.root, 'outside-task');
    mkdirSync(outside);
    symlinkSync(outside, path.join(L.ws, P, T2), HOST_PLATFORM === 'win32' ? 'junction' : 'dir');
    await expect(
      gm.createAttemptWorktree({ projectId: P, taskId: T2, attemptNumber: 1, baseSha: SHA_BASE }, CTX),
    ).rejects.toMatchObject({ code: 'path_escape' });
    expect(fake.gitCalls()).toHaveLength(0);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('commitAll: worktree ops use --git-dir=<A> --work-tree=<W>, cwd=<W>, message on stdin', async () => {
    const res = await gm.commitAll(wt(), 'orc: change\n\nOrc-Task-Id: x', CTX);
    expect(res).toEqual({ committed: true, headSha: SHA_HEAD });
    const calls = fake.gitCalls();
    const wtArgs = [`--git-dir=${g(L.A)}`, `--work-tree=${g(L.W)}`];
    expect(calls.map((c) => c.rest)).toEqual([
      [...wtArgs, 'add', '--all', '--', '.'],
      [...wtArgs, 'diff', '--cached', '--quiet', '--no-ext-diff'],
      [
        ...wtArgs,
        '-c',
        'user.name=Orc Orchestrator',
        '-c',
        'user.email=orc@localhost',
        '-c',
        'commit.gpgSign=false',
        'commit',
        '--no-verify',
        '--no-gpg-sign',
        '--quiet',
        '--file=-',
      ],
      [...wtArgs, 'rev-parse', '--verify', 'HEAD^{commit}'],
    ]);
    for (const c of calls) {
      expect(c.call.cwd).toBe(L.W);
      expect(c.rest).not.toContain('-C');
      expect(c.prefix).toEqual(prefixFor(L, [L.W, L.M]));
    }
    expect(calls[2]?.call.stdin).toBe('orc: change\n\nOrc-Task-Id: x\n');
    const staged = recorder.ops.find((o) => o.operation === 'diff_cached_quiet');
    expect(staged).toMatchObject({ exitCode: 1, success: true });
    expect(recorder.ops.find((o) => o.operation === 'commit')?.args.join(' ')).not.toContain(
      'Orc-Task-Id',
    );
  });

  it('commitAll: nothing staged => no commit; an unknown adminDir is re-resolved from the mirror', async () => {
    build({ override: (sub, after) => (sub === 'diff' && after.includes('--cached') ? { code: 0 } : undefined) });
    const res = await gm.commitAll({ ...wt(), adminDir: '' }, 'orc: nothing', CTX);
    expect(res).toEqual({ committed: false, headSha: SHA_HEAD });
    expect(fake.gitCalls().some((c) => subcommand(c.rest).sub === 'commit')).toBe(false);
    expect(fake.gitCalls()[0]?.rest[0]).toBe(`--git-dir=${g(L.A)}`);
  });

  it('commitAll: a forged adminDir hint outside the mirror is ignored', async () => {
    await gm.commitAll({ ...wt(), adminDir: path.join(L.root, 'evil', 'worktrees', 'a1') }, 'orc: x', CTX);
    expect(fake.gitCalls()[0]?.rest[0]).toBe(`--git-dir=${g(L.A)}`);
  });

  it('commitAll: rejects a worktree whose path does not match relPath', async () => {
    await expect(gm.commitAll({ ...wt(), path: L.root }, 'orc: x', CTX)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      gm.commitAll({ ...wt(), relPath: `${T}/${T}/a1` }, 'orc: x', CTX),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fake.calls).toHaveLength(0);
  });

  it('collectCommits: exact log argv and %aI => UTC ISO', async () => {
    const rec = (sha: string, subject: string, date: string): string =>
      `${sha}\x1fAlice\x1falice@example.test\x1f${date}\x1f${subject}\x1e\n`;
    build({
      log: rec('e'.repeat(40), 'second', '2026-11-02T12:00:00+03:00') + rec('f'.repeat(40), 'first', '2026-11-01T09:30:00Z'),
    });
    const commits = await gm.collectCommits(wt(), CTX);
    expect(lastGit().rest).toEqual([
      `--git-dir=${g(L.A)}`,
      `--work-tree=${g(L.W)}`,
      'log',
      '--no-color',
      '--max-count=500',
      '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e',
      `${SHA_BASE}..HEAD`,
    ]);
    expect(commits).toEqual([
      { sha: 'e'.repeat(40), authorName: 'Alice', authorEmail: 'alice@example.test', authoredAt: '2026-11-02T09:00:00.000Z', subject: 'second' },
      { sha: 'f'.repeat(40), authorName: 'Alice', authorEmail: 'alice@example.test', authoredAt: '2026-11-01T09:30:00.000Z', subject: 'first' },
    ]);
  });

  describe('collectChanges', () => {
    const patchFor = (name: string, body: string): string =>
      `diff --git a/${name} b/${name}\nindex 1..2 100644\n--- a/${name}\n+++ b/${name}\n${body}`;

    it('uses exact diff argv and maps status, rename score, binary, type change', async () => {
      const nameStatus = ['A', 'new.txt', 'M', 'mod.txt', 'D', 'gone.txt', 'R087', 'old.txt', 'renamed.txt', 'T', 'link', 'M', 'img.bin', ''].join('\0');
      const numstat = ['3\t0\tnew.txt', '1\t1\tmod.txt', '0\t2\tgone.txt', '2\t1\t', 'old.txt', 'renamed.txt', '1\t1\tlink', '-\t-\timg.bin', ''].join('\0');
      const patch =
        patchFor('new.txt', '+a\n+b\n+c\n') +
        patchFor('mod.txt', '-x\n+y\n') +
        patchFor('gone.txt', '-1\n-2\n') +
        'diff --git a/old.txt b/renamed.txt\nsimilarity index 87%\nrename from old.txt\nrename to renamed.txt\n' +
        'diff --git a/link b/link\ndeleted file mode 100644\n' +
        'diff --git a/link b/link\nnew file mode 120000\n' +
        'diff --git a/img.bin b/img.bin\nBinary files a/img.bin and b/img.bin differ\n';
      build({ nameStatus, numstat, patch });
      const res = await gm.collectChanges(wt(), CTX);
      const rests = fake.gitCalls().map((c) => c.rest.slice(2));
      expect(rests).toEqual([
        ['diff', '--name-status', '-M', '-z', '--no-ext-diff', '--no-textconv', SHA_BASE, 'HEAD'],
        ['diff', '--numstat', '-M', '-z', '--no-ext-diff', '--no-textconv', SHA_BASE, 'HEAD'],
        ['diff', '-M', '--patch', '--no-color', '--no-ext-diff', '--no-textconv', '--full-index', SHA_BASE, 'HEAD'],
      ]);
      expect(res.filesChanged).toBe(6);
      expect(res.truncatedFileList).toBe(false);
      expect(res.additions).toBe(7);
      expect(res.deletions).toBe(5);
      const byPath = new Map(res.files.map((f) => [f.path, f]));
      expect(byPath.get('new.txt')).toMatchObject({ changeType: 'A', oldPath: null, additions: 3, deletions: 0, isBinary: false, patchTruncated: false });
      expect(byPath.get('renamed.txt')).toMatchObject({ changeType: 'R', oldPath: 'old.txt', similarity: 87, additions: 2, deletions: 1 });
      expect(byPath.get('renamed.txt')?.patch).toContain('rename to renamed.txt');
      expect(byPath.get('link')?.changeType).toBe('T');
      expect(byPath.get('link')?.patch).toBe('diff --git a/link b/link\ndeleted file mode 100644\ndiff --git a/link b/link\nnew file mode 120000\n');
      expect(byPath.get('img.bin')).toMatchObject({ changeType: 'M', isBinary: true, additions: null, deletions: null });
      expect(byPath.get('img.bin')?.patch).toContain('Binary files a/img.bin and b/img.bin differ');
      for (const f of res.files) expect(f.patchBytes).toBe(Buffer.byteLength(f.patch ?? '', 'utf8'));
    });

    it('caps per-file patches (UTF-8 safe) and truncates the file list at DIFF_MAX_FILES', async () => {
      const big = patchFor('ü.txt', `+${'é'.repeat(200)}\n`);
      build(
        {
          nameStatus: ['M', 'ü.txt', 'A', 'b.txt', 'A', 'c.txt', ''].join('\0'),
          numstat: ['1\t0\tü.txt', '1\t0\tb.txt', '1\t0\tc.txt', ''].join('\0'),
          patch: big + patchFor('b.txt', '+b\n') + patchFor('c.txt', '+c\n'),
        },
        { changedFilePatchMaxBytes: 101, diffMaxFiles: 2 },
      );
      const res = await gm.collectChanges(wt(), CTX);
      expect(res.filesChanged).toBe(3);
      expect(res.truncatedFileList).toBe(true);
      expect(res.files.map((f) => f.path)).toEqual(['ü.txt', 'b.txt']);
      const first = res.files[0];
      expect(first?.patchTruncated).toBe(true);
      expect(first?.patchBytes).toBe(Buffer.byteLength(big, 'utf8'));
      expect(Buffer.byteLength(first?.patch ?? '', 'utf8')).toBeLessThanOrEqual(101);
      expect(first?.patch).not.toContain('�');
      expect(res.files[1]?.patchTruncated).toBe(false);
    });
  });

  it('exportPatch: format-patch argv, gzip level 6 content, sha256, tooLarge cap', async () => {
    const content = 'From x\nSubject: [PATCH] y\n\n---\n a | 1 +\n';
    build({ formatPatch: content });
    const ok = await gm.exportPatch(wt(), CTX);
    expect(lastGit().rest.slice(2)).toEqual([
      'format-patch',
      '--stdout',
      '--binary',
      '--full-index',
      '--no-color',
      '--no-signature',
      `${SHA_BASE}..HEAD`,
    ]);
    expect(ok.tooLarge).toBe(false);
    expect(ok.byteLength).toBe(Buffer.byteLength(content));
    expect(gunzipSync(ok.gzip as Buffer).toString('utf8')).toBe(content);
    expect(ok.sha256).toHaveLength(32);

    build({ formatPatch: content }, { patchExportMaxBytes: 10 });
    const big = await gm.exportPatch(wt(), CTX);
    expect(big).toMatchObject({ gzip: null, tooLarge: true });
  });

  it('mergeCheck: fetch under the lock, merge-tree/merge-base argv, conflicts deduplicated', async () => {
    const res = await gm.mergeCheck({ projectId: P, baseBranch: 'main', headSha: SHA_HEAD }, CTX);
    expect(res).toMatchObject({
      status: 'conflicts',
      baseBranch: 'main',
      latestBaseSha: SHA_BASE,
      headSha: SHA_HEAD,
      conflicts: ['a.txt', 'b.txt'],
      isFastForward: false,
      error: null,
    });
    expect(lock.acquired).toEqual([P]);
    const rests = fake.gitCalls().map((c) => c.rest);
    expect(rests).toContainEqual([`--git-dir=${g(L.M)}`, 'config', '--get', 'remote.origin.url']);
    expect(rests).toContainEqual([
      `--git-dir=${g(L.M)}`,
      'merge-tree',
      '--write-tree',
      '--name-only',
      '--no-messages',
      '-z',
      SHA_BASE,
      SHA_HEAD,
    ]);
    expect(rests.at(-1)).toEqual([`--git-dir=${g(L.M)}`, 'merge-base', '--is-ancestor', SHA_BASE, SHA_HEAD]);
  });

  it('mergeCheck: any error => status error, never throws', async () => {
    build({ override: (sub) => (sub === 'merge-tree' ? { code: 128, stderr: 'fatal: boom' } : undefined) });
    const res = await gm.mergeCheck({ projectId: P, baseBranch: 'main', headSha: SHA_HEAD }, CTX);
    expect(res).toMatchObject({ status: 'error', latestBaseSha: SHA_BASE, conflicts: [] });
    expect(res.error).toMatch(/merge_tree/);
    const bad = await gm.mergeCheck({ projectId: P, baseBranch: '-x', headSha: SHA_HEAD }, CTX);
    expect(bad.status).toBe('error');
  });

  it('removeWorktree: unlock, remove --force --force, fs fallback, prune', async () => {
    await gm.removeWorktree({ projectId: P, relPath: `${P}/${T}/a1` }, CTX);
    expect(fake.gitCalls().map((c) => c.rest)).toEqual([
      [`--git-dir=${g(L.M)}`, 'worktree', 'unlock', g(L.W)],
      [`--git-dir=${g(L.M)}`, 'worktree', 'remove', '--force', '--force', g(L.W)],
      [`--git-dir=${g(L.M)}`, 'worktree', 'prune', '--expire=now'],
    ]);
    const { existsSync } = await import('node:fs');
    expect(existsSync(L.W)).toBe(false);
    await expect(
      gm.removeWorktree({ projectId: P, relPath: `${P}/${T}/a1/../../x` }, CTX),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(gm.removeWorktree({ projectId: P, relPath: '.repos' }, CTX)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('deleteBranch: branch -D --end-of-options; "not found" is success; only orc/task-* allowed', async () => {
    await gm.deleteBranch({ projectId: P, branchName: 'orc/task-11111111-a1' }, CTX);
    expect(lastGit().rest).toEqual([
      `--git-dir=${g(L.M)}`,
      'branch',
      '-D',
      '--end-of-options',
      'orc/task-11111111-a1',
    ]);
    expect(recorder.ops.at(-1)).toMatchObject({ operation: 'branch_delete', success: true, exitCode: 1 });
    await expect(gm.deleteBranch({ projectId: P, branchName: 'main' }, CTX)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('refreshBaseSnapshot: removes the previous base, then worktree add --detach --force under the lock', async () => {
    const base = path.join(L.ws, P, '_base');
    const res = await gm.refreshBaseSnapshot(P, SHA_BASE.slice(0, 12), CTX);
    expect(res).toEqual({ path: base, sha: SHA_BASE });
    expect(lock.acquired).toEqual([P]);
    expect(fake.gitCalls().map((c) => c.rest)).toEqual([
      [`--git-dir=${g(L.M)}`, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${SHA_BASE.slice(0, 12)}^{commit}`],
      [`--git-dir=${g(L.M)}`, 'worktree', 'remove', '--force', '--force', g(base)],
      [`--git-dir=${g(L.M)}`, 'worktree', 'prune', '--expire=now'],
      [`--git-dir=${g(L.M)}`, 'worktree', 'add', '--detach', '--force', g(base), SHA_BASE],
    ]);
    await expect(gm.refreshBaseSnapshot(P, 'main', CTX)).rejects.toBeInstanceOf(ValidationError);
  });

  it('assertCapacity / measureSize: typed errors and root-bounded paths', async () => {
    await expect(gm.freeBytes()).resolves.toBeGreaterThan(0);
    await expect(gm.assertCapacity()).resolves.toBeUndefined();
    build({}, { minFreeBytes: Number.MAX_SAFE_INTEGER });
    await expect(gm.assertCapacity()).rejects.toMatchObject({ code: 'insufficient_disk_space' });
    await expect(
      gm.createAttemptWorktree({ projectId: P, taskId: T2, attemptNumber: 1, baseSha: SHA_BASE }, CTX),
    ).rejects.toMatchObject({ code: 'insufficient_disk_space' });
    expect(fake.gitCalls()).toHaveLength(0);
    const size = await gm.measureSize(L.W);
    expect(size).toMatchObject({ truncated: false });
    await expect(gm.measureSize(path.join(L.ws, P, 'missing', 'a1'))).resolves.toEqual({
      bytes: 0,
      entries: 0,
      truncated: false,
    });
    await expect(gm.measureSize(L.root)).rejects.toMatchObject({ code: 'path_escape' });
    await expect(gm.measureSize('relative/path')).rejects.toBeInstanceOf(ValidationError);
  });

  it('commitAll: over WORKSPACE_MAX_BYTES => WorkspaceQuotaError before any git spawn', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(L.W, 'blob.bin'), Buffer.alloc(4096, 1));
    writeFileSync(path.join(L.W, 'second.txt'), 'x');
    build({}, { workspaceMaxBytes: 1024 });
    await expect(gm.commitAll(wt(), 'orc: x', CTX)).rejects.toMatchObject({ code: 'workspace_quota_exceeded' });
    build({}, { sizeScanMaxEntries: 1 });
    await expect(gm.commitAll(wt(), 'orc: x', CTX)).rejects.toMatchObject({ code: 'workspace_quota_exceeded' });
    expect(fake.gitCalls().some((c) => subcommand(c.rest).sub === 'add')).toBe(false);
  });

  it('gcMirror: gc --quiet --prune=2.weeks.ago under the mirror lock', async () => {
    await gm.gcMirror(P, CTX);
    expect(lastGit().rest).toEqual([`--git-dir=${g(L.M)}`, 'gc', '--quiet', '--prune=2.weeks.ago']);
    expect(lock.acquired).toEqual([P]);
  });

  it('isWorktreeUsable: true for a registered worktree on its branch, false otherwise', async () => {
    const rel = `${P}/${T}/a1`;
    await expect(gm.isWorktreeUsable({ projectId: P, relPath: rel, branchName: 'orc/task-11111111-a1' }, CTX)).resolves.toBe(true);
    await expect(gm.isWorktreeUsable({ projectId: P, relPath: rel, branchName: 'orc/task-11111111-a2' }, CTX)).resolves.toBe(false);
    await expect(gm.isWorktreeUsable({ projectId: P, relPath: `${P}/${T2}/a1`, branchName: 'orc/task-99999999-a1' }, CTX)).resolves.toBe(false);
  });

  it('maps a timeout to GitTimeoutError and records timedOut', async () => {
    build(
      { override: (sub) => (sub === 'for-each-ref' ? { code: 0, delayMs: 400 } : undefined) },
      { opTimeoutMs: 100, killGraceMs: 10 },
    );
    await expect(gm.syncMirror(P, 'repo', CTX)).rejects.toBeInstanceOf(GitTimeoutError);
    expect(recorder.ops.at(-1)).toMatchObject({ operation: 'list_branches', timedOut: true, success: false });
  });

  it('maps a spawn failure to GitError(spawn_failed)', async () => {
    build({ override: () => ({ spawnError: true }) });
    await expect(gm.resolveBase(P, 'main', CTX)).rejects.toMatchObject({
      code: 'git_failed',
      details: { reason: 'spawn_failed' },
    });
  });

  it('an aborted signal stops before spawning', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(gm.resolveBase(P, 'main', { ...CTX, signal: ac.signal })).rejects.toMatchObject({
      code: 'git_failed',
      details: { aborted: true },
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('masks secrets in the recorded stderr tail and keeps only the last stderrTailChars', async () => {
    build(
      {
        override: (sub) =>
          sub === 'gc'
            ? { code: 1, stderr: `${'x'.repeat(100)} token sk-ant-api03-${'A'.repeat(40)} end` }
            : undefined,
      },
      { stderrTailChars: 80 },
    );
    await expect(gm.gcMirror(P, CTX)).rejects.toBeInstanceOf(GitError);
    const tail = recorder.ops.at(-1)?.stderrTail ?? '';
    expect(tail.length).toBeLessThanOrEqual(80);
    expect(tail).not.toContain('A'.repeat(40));
  });
});
