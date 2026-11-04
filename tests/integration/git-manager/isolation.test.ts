// Isolation guarantees of @orc/git-manager against real git (contract §11.1, §11.3, §11.6, §11.7):
// planted hooks never run, a redirected worktree `.git` is never trusted, link escapes are refused,
// quotas raise typed errors and every temp directory is removed afterwards.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  InsufficientDiskSpaceError,
  WorkspaceQuotaError,
  type GitManager,
  type GitOpContext,
  type WorktreeInfo,
} from '@orc/git-manager';
import { gitT, hashTree, IS_WIN32, writeFileP } from '../../helpers/git/fixtures';
import { createWorld, HOOK_NAMES, linkDir, plantHooks, type World } from '../../helpers/git/world';

const TASK_A = '3c9d2e10-5a6b-4c7d-8e9f-0a1b2c3d4e01';
const TASK_B = '3c9d2e10-5a6b-4c7d-8e9f-0a1b2c3d4e02';
const TASK_C = '3c9d2e10-5a6b-4c7d-8e9f-0a1b2c3d4e03';
const TASK_D = '3c9d2e10-5a6b-4c7d-8e9f-0a1b2c3d4e04';
const TASK_E = '3c9d2e10-5a6b-4c7d-8e9f-0a1b2c3d4e05';
const TASK_F = '3c9d2e10-5a6b-4c7d-8e9f-0a1b2c3d4e06';

/** '/'-separated spelling usable inside sh commands on every host. */
const sh = (p: string): string => p.replaceAll('\\', '/');

/** Test-side git that can never run planted hooks itself (fixture setup only). */
function fixtureGit(w: World, cwd: string, args: readonly string[]): void {
  gitT(cwd, ['-c', `core.hooksPath=${sh(w.hooks)}`, '-c', 'core.fsmonitor=false', ...args], {
    home: w.home,
  });
}

function markers(w: World): string[] {
  return readdirSync(w.markers).sort();
}

function clearMarkers(w: World): void {
  for (const m of readdirSync(w.markers)) rmSync(path.join(w.markers, m), { force: true });
}

describe('git-manager isolation (real git)', () => {
  const worlds: World[] = [];
  const track = (w: World): World => {
    worlds.push(w);
    return w;
  };

  afterAll(() => {
    for (const w of worlds) {
      w.dispose();
      expect(existsSync(w.root)).toBe(false);
    }
  });

  describe('planted hooks never execute', () => {
    let w: World;
    let gm: GitManager;
    let ctx: GitOpContext;

    beforeAll(() => {
      w = track(createWorld('6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c01'));
      ctx = { ...w.ctx, taskId: TASK_A };
      gm = w.manager();
    });

    it('positive control: the planted hook scripts do run under a plain git', () => {
      const scratch = path.join(w.root, 'hook-control');
      mkdirSync(scratch);
      gitT(scratch, ['init', '--quiet', '--initial-branch=main', '.'], { home: w.home });
      plantHooks(path.join(scratch, '.git', 'hooks'), w.markers, 'control');
      writeFileSync(path.join(scratch, 'f.txt'), 'x\n');
      gitT(scratch, ['add', '--all'], { home: w.home });
      gitT(scratch, ['commit', '--quiet', '-m', 'control'], { home: w.home });
      expect(markers(w)).toEqual(
        expect.arrayContaining(['control-pre-commit', 'control-commit-msg', 'control-post-commit']),
      );
      clearMarkers(w);
    });

    it('runs the whole attempt lifecycle without executing any hook', async () => {
      const repo = w.repo('acme/hooked', { 'a.txt': 'one\n', 'b.txt': 'two\n' });
      const src = repo.dir;
      // The source repository carries hooks in .git/hooks, a hooksPath and an fsmonitor of its own.
      plantHooks(path.join(src, '.git', 'hooks'), w.markers, 'src');
      plantHooks(path.join(src, 'planted-hooks'), w.markers, 'srcpath');
      fixtureGit(w, src, ['config', 'core.hooksPath', sh(path.join(src, 'planted-hooks'))]);
      fixtureGit(w, src, ['config', 'core.fsmonitor', `echo ran > '${sh(path.join(w.markers, 'src-fsmonitor'))}'`]);

      await gm.syncMirror(w.projectId, 'acme/hooked', ctx);
      const mirror = path.join(w.ws, '.repos', `${w.projectId}.git`);
      // Default hooks location of the mirror and of every worktree ($GIT_COMMON_DIR/hooks).
      plantHooks(path.join(mirror, 'hooks'), w.markers, 'mirror');

      // Upstream moves: the next fetch updates refs (reference-transaction would fire).
      writeFileSync(path.join(src, 'a.txt'), 'one\nupstream\n');
      fixtureGit(w, src, ['commit', '--quiet', '-am', 'upstream']);
      const before = hashTree(src);

      await gm.syncMirror(w.projectId, 'acme/hooked', ctx);
      const baseSha = await gm.resolveBase(w.projectId, 'main', ctx);
      await gm.refreshBaseSnapshot(w.projectId, baseSha, ctx);
      const wt = await gm.createAttemptWorktree(
        { projectId: w.projectId, taskId: TASK_A, attemptNumber: 1, baseSha },
        ctx,
      );
      // Hooks planted inside the worktree and in its admin dir.
      plantHooks(path.join(wt.path, '.githooks'), w.markers, 'wt');
      plantHooks(path.join(wt.path, 'hooks'), w.markers, 'wthooks');
      plantHooks(path.join(wt.adminDir, 'hooks'), w.markers, 'admin');

      writeFileSync(path.join(wt.path, 'b.txt'), 'two\nchanged\n');
      const res = await gm.commitAll(wt, 'orc: hooked change', ctx);
      expect(res.committed).toBe(true);
      await gm.collectCommits(wt, ctx);
      await gm.collectChanges(wt, ctx);
      await gm.exportPatch(wt, ctx);
      const mc = await gm.mergeCheck({ projectId: w.projectId, baseBranch: 'main', headSha: res.headSha }, ctx);
      expect(mc.status).toBe('clean');
      await gm.removeWorktree({ projectId: w.projectId, relPath: wt.relPath }, ctx);
      await gm.deleteBranch({ projectId: w.projectId, branchName: wt.branchName }, ctx);
      await gm.removeWorktree({ projectId: w.projectId, relPath: `${w.projectId}/_base` }, ctx);
      await gm.gcMirror(w.projectId, ctx);

      expect(markers(w)).toEqual([]);
      expect(hashTree(src)).toEqual(before);
      expect(existsSync(wt.path)).toBe(false);
      // Every hook name of the planted set was available to git the whole time.
      expect(readdirSync(path.join(mirror, 'hooks'))).toEqual(expect.arrayContaining([...HOOK_NAMES]));
    });
  });

  describe('a redirected worktree .git is never trusted', () => {
    let w: World;
    let gm: GitManager;
    let ctx: GitOpContext;
    let wt: WorktreeInfo;
    let mirror: string;
    let evil: string;

    beforeAll(async () => {
      w = track(createWorld('6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c02'));
      ctx = { ...w.ctx, taskId: TASK_B };
      gm = w.manager();
      const repo = w.repo('acme/redirect', { 'code.txt': 'original\n' });
      await gm.syncMirror(w.projectId, 'acme/redirect', ctx);
      mirror = path.join(w.ws, '.repos', `${w.projectId}.git`);
      wt = await gm.createAttemptWorktree(
        { projectId: w.projectId, taskId: TASK_B, attemptNumber: 1, baseSha: repo.sha },
        ctx,
      );
      // An attacker-controlled git dir outside every root, with filters, fsmonitor, textconv,
      // external diff, pager and hooks that would all write markers when executed.
      evil = path.join(w.root, 'evil.git');
      gitT(w.root, ['init', '--quiet', '--bare', evil], { home: w.home });
      const m = (name: string): string => `echo ran > '${sh(path.join(w.markers, name))}'`;
      const settings: [string, string][] = [
        ['filter.evil.clean', `${m('evil-clean')}; cat`],
        ['filter.evil.smudge', `${m('evil-smudge')}; cat`],
        ['filter.evil.process', m('evil-process')],
        ['filter.evil.required', 'true'],
        ['diff.evil.textconv', `${m('evil-textconv')}; cat`],
        ['diff.evil.command', m('evil-diffcmd')],
        ['diff.external', m('evil-external')],
        ['core.fsmonitor', m('evil-fsmonitor')],
        ['core.pager', m('evil-pager')],
        ['core.hooksPath', sh(path.join(evil, 'hooks'))],
        ['core.bare', 'false'],
      ];
      for (const [k, v] of settings) gitT(evil, ['config', k, v], { home: w.home });
      plantHooks(path.join(evil, 'hooks'), w.markers, 'evil');
    });

    it('commits into the mirror branch through the worker-owned admin dir only', async () => {
      // (win32 marks the .git file hidden, which a plain overwrite refuses: replace it instead)
      rmSync(path.join(wt.path, '.git'), { force: true });
      writeFileSync(path.join(wt.path, '.git'), `gitdir: ${sh(evil)}\n`);
      writeFileSync(path.join(wt.path, '.gitattributes'), '* filter=evil diff=evil merge=evil\n');
      writeFileSync(path.join(wt.path, 'code.txt'), 'changed by the sandbox\n');
      const evilBefore = hashTree(evil);

      const res = await gm.commitAll(wt, 'orc: redirected', ctx);
      expect(res.committed).toBe(true);
      expect(gitT(mirror, ['rev-parse', `refs/heads/${wt.branchName}`], { home: w.home }).stdout.trim()).toBe(
        res.headSha,
      );
      // Raw content (no clean filter) landed in the mirror.
      expect(gitT(mirror, ['show', `${res.headSha}:code.txt`], { home: w.home }).stdout).toBe(
        'changed by the sandbox\n',
      );
      const changes = await gm.collectChanges(wt, ctx);
      const code = changes.files.find((f) => f.path === 'code.txt');
      expect(code?.patch).toContain('+changed by the sandbox');
      expect(changes.files.some((f) => f.path === '.git')).toBe(false);
      await gm.exportPatch(wt, ctx);
      await expect(
        gm.isWorktreeUsable({ projectId: w.projectId, relPath: wt.relPath, branchName: wt.branchName }, ctx),
      ).resolves.toBe(true);

      expect(hashTree(evil)).toEqual(evilBefore);
      expect(markers(w)).toEqual([]);
    });

    it('ignores a .git directory planted in place of the .git file', async () => {
      rmSync(path.join(wt.path, '.git'), { force: true });
      mkdirSync(path.join(wt.path, '.git'));
      writeFileSync(
        path.join(wt.path, '.git', 'config'),
        `[core]\n\tfsmonitor = echo ran > '${sh(path.join(w.markers, 'dir-fsmonitor'))}'\n\thooksPath = ${sh(path.join(wt.path, '.git', 'hooks'))}\n`,
      );
      writeFileSync(path.join(wt.path, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      plantHooks(path.join(wt.path, '.git', 'hooks'), w.markers, 'dotgitdir');
      writeFileSync(path.join(wt.path, 'code.txt'), 'second change\n');

      const res = await gm.commitAll(wt, 'orc: second', ctx);
      expect(res.committed).toBe(true);
      expect(gitT(mirror, ['rev-parse', `refs/heads/${wt.branchName}`], { home: w.home }).stdout.trim()).toBe(
        res.headSha,
      );
      expect((await gm.collectCommits(wt, ctx)).map((c) => c.subject)).toEqual(['orc: second', 'orc: redirected']);
      expect(markers(w)).toEqual([]);

      const evilBefore = hashTree(evil);
      await gm.removeWorktree({ projectId: w.projectId, relPath: wt.relPath }, ctx);
      expect(existsSync(wt.path)).toBe(false);
      const admins = path.join(mirror, 'worktrees');
      expect(existsSync(admins) ? readdirSync(admins) : []).toEqual([]);
      expect(hashTree(evil)).toEqual(evilBefore);
      expect(markers(w)).toEqual([]);
    });

    it('positive control: git discovery through the redirected .git would run the attacker config', () => {
      const scratch = path.join(w.root, 'redirect-control');
      mkdirSync(scratch);
      writeFileSync(path.join(scratch, '.git'), `gitdir: ${sh(evil)}\n`);
      writeFileSync(path.join(scratch, '.gitattributes'), '* filter=evil\n');
      writeFileSync(path.join(scratch, 'x.txt'), 'x\n');
      gitT(scratch, ['add', '--all'], { home: w.home, allowFail: true });
      expect(markers(w).length).toBeGreaterThan(0);
      clearMarkers(w);
    });
  });

  describe('link escapes are refused', () => {
    let w: World;
    let gm: GitManager;
    let ctx: GitOpContext;
    let outside: string;
    let baseSha: string;

    beforeAll(async () => {
      w = track(createWorld('6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c03'));
      ctx = { ...w.ctx, taskId: TASK_C };
      gm = w.manager();
      outside = path.join(w.root, 'outside');
      mkdirSync(outside);
      const repo = w.repo('acme/legit', { 'f.txt': 'f\n' });
      baseSha = repo.sha;
      await gm.syncMirror(w.projectId, 'acme/legit', ctx);
    });

    it('a repoPath that links outside PROJECTS_ROOT is rejected', async () => {
      const foreign = path.join(outside, 'foreign-repo');
      mkdirSync(foreign);
      gitT(foreign, ['init', '--quiet', '--initial-branch=main', '.'], { home: w.home });
      writeFileSync(path.join(foreign, 'secret.txt'), 'secret\n');
      gitT(foreign, ['add', '--all'], { home: w.home });
      gitT(foreign, ['commit', '--quiet', '-m', 'secret'], { home: w.home });
      linkDir(foreign, path.join(w.pr, 'acme', 'escape'));
      const before = hashTree(foreign);

      await expect(gm.validateSource('acme/escape', ctx)).rejects.toMatchObject({ code: 'path_escape' });
      await expect(
        gm.syncMirror('6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8cff', 'acme/escape', {
          ...ctx,
          projectId: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8cff',
        }),
      ).rejects.toMatchObject({ code: 'path_escape' });
      expect(existsSync(path.join(w.ws, '.repos', '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8cff.git'))).toBe(false);
      expect(hashTree(foreign)).toEqual(before);
    });

    it("a source whose '.git' links outside PROJECTS_ROOT is rejected", async () => {
      const foreign = path.join(outside, 'foreign-gitdir');
      mkdirSync(foreign);
      gitT(foreign, ['init', '--quiet', '--initial-branch=main', '.'], { home: w.home });
      writeFileSync(path.join(foreign, 'x.txt'), 'x\n');
      gitT(foreign, ['add', '--all'], { home: w.home });
      gitT(foreign, ['commit', '--quiet', '-m', 'x'], { home: w.home });
      const inner = path.join(w.pr, 'acme', 'dotgit-link');
      mkdirSync(inner);
      linkDir(path.join(foreign, '.git'), path.join(inner, '.git'));

      const err: unknown = await gm.validateSource('acme/dotgit-link', ctx).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).not.toBeNull();
      expect(['path_escape', 'git_repo_invalid']).toContain((err as { code?: string }).code);
    });

    it('removeWorktree never deletes through a linked task directory', async () => {
      const victim = path.join(outside, 'victim-task');
      mkdirSync(path.join(victim, 'a1'), { recursive: true });
      writeFileSync(path.join(victim, 'a1', 'precious.txt'), 'keep me\n');
      mkdirSync(path.join(w.ws, w.projectId), { recursive: true });
      linkDir(victim, path.join(w.ws, w.projectId, TASK_D));

      await expect(
        gm.removeWorktree({ projectId: w.projectId, relPath: `${w.projectId}/${TASK_D}/a1` }, ctx),
      ).rejects.toMatchObject({ code: 'path_escape' });
      expect(readFileSync(path.join(victim, 'a1', 'precious.txt'), 'utf8')).toBe('keep me\n');
      await expect(gm.measureSize(path.join(w.ws, w.projectId, TASK_D, 'a1'))).rejects.toMatchObject({
        code: 'path_escape',
      });
    });

    it('createAttemptWorktree never creates a worktree through a linked task directory', async () => {
      const victim = path.join(outside, 'victim-create');
      mkdirSync(victim);
      if (!IS_WIN32) chmodSync(victim, 0o750);
      const modeBefore = statSync(victim).mode;
      mkdirSync(path.join(w.ws, w.projectId), { recursive: true });
      linkDir(victim, path.join(w.ws, w.projectId, TASK_F));
      const mirror = path.join(w.ws, '.repos', `${w.projectId}.git`);
      const adminsBefore = existsSync(path.join(mirror, 'worktrees'))
        ? readdirSync(path.join(mirror, 'worktrees'))
        : [];

      await expect(
        gm.createAttemptWorktree({ projectId: w.projectId, taskId: TASK_F, attemptNumber: 1, baseSha }, ctx),
      ).rejects.toMatchObject({ code: 'path_escape' });
      expect(readdirSync(victim)).toEqual([]);
      expect(statSync(victim).mode).toBe(modeBefore); // chmod never followed the link
      expect(
        existsSync(path.join(mirror, 'worktrees')) ? readdirSync(path.join(mirror, 'worktrees')) : [],
      ).toEqual(adminsBefore);
      expect(gitT(mirror, ['for-each-ref', '--format=%(refname)', 'refs/heads/'], { home: w.home }).stdout).toBe('');
    });

    it('removeWorktree unlinks a linked attempt directory without touching its target', async () => {
      const victim = path.join(outside, 'victim-attempt');
      mkdirSync(victim);
      writeFileSync(path.join(victim, 'precious.txt'), 'keep me too\n');
      mkdirSync(path.join(w.ws, w.projectId, TASK_E), { recursive: true });
      const link = path.join(w.ws, w.projectId, TASK_E, 'a1');
      linkDir(victim, link);

      await gm.removeWorktree({ projectId: w.projectId, relPath: `${w.projectId}/${TASK_E}/a1` }, ctx);
      expect(existsSync(link)).toBe(false);
      expect(readFileSync(path.join(victim, 'precious.txt'), 'utf8')).toBe('keep me too\n');
    });

    it('measureSize never follows links and refuses paths outside WORKSPACES_ROOT', async () => {
      const big = path.join(outside, 'big');
      mkdirSync(big);
      writeFileSync(path.join(big, 'blob.bin'), Buffer.alloc(256 * 1024, 1));
      const wt = await gm.createAttemptWorktree(
        { projectId: w.projectId, taskId: TASK_C, attemptNumber: 1, baseSha },
        ctx,
      );
      const plain = await gm.measureSize(wt.path);
      linkDir(big, path.join(wt.path, 'linked-big'));
      const linked = await gm.measureSize(wt.path);
      expect(linked.bytes).toBeLessThan(plain.bytes + 64 * 1024);
      expect(linked.entries).toBe(plain.entries + 1);
      expect(linked.truncated).toBe(false);
      await expect(gm.measureSize(outside)).rejects.toMatchObject({ code: 'path_escape' });
      await gm.removeWorktree({ projectId: w.projectId, relPath: wt.relPath }, ctx);
      expect(existsSync(path.join(big, 'blob.bin'))).toBe(true);
    });
  });

  describe('quotas', () => {
    let w: World;
    let gm: GitManager;
    let ctx: GitOpContext;
    let baseSha: string;
    let mirror: string;

    beforeAll(async () => {
      w = track(createWorld('6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c04'));
      ctx = { ...w.ctx, taskId: TASK_A };
      gm = w.manager();
      baseSha = w.repo('acme/quota', { 'f.txt': 'f\n' }).sha;
      await gm.syncMirror(w.projectId, 'acme/quota', ctx);
      mirror = path.join(w.ws, '.repos', `${w.projectId}.git`);
    });

    it('freeBytes reports the volume free space', async () => {
      expect(await gm.freeBytes()).toBeGreaterThan(0);
    });

    it('insufficient free space => InsufficientDiskSpaceError before fetch and before worktree add', async () => {
      const full = w.manager({ minFreeBytes: Number.MAX_SAFE_INTEGER });
      await expect(full.assertCapacity()).rejects.toBeInstanceOf(InsufficientDiskSpaceError);
      await expect(full.syncMirror(w.projectId, 'acme/quota', ctx)).rejects.toMatchObject({
        code: 'insufficient_disk_space',
      });
      await expect(
        full.createAttemptWorktree({ projectId: w.projectId, taskId: TASK_B, attemptNumber: 1, baseSha }, ctx),
      ).rejects.toMatchObject({ code: 'insufficient_disk_space' });
      expect(existsSync(path.join(w.ws, w.projectId, TASK_B))).toBe(false);
    });

    it('a workspace over WORKSPACE_MAX_BYTES or the scan entry cap => WorkspaceQuotaError, nothing committed', async () => {
      const wt = await gm.createAttemptWorktree(
        { projectId: w.projectId, taskId: TASK_A, attemptNumber: 1, baseSha },
        ctx,
      );
      writeFileP(path.join(wt.path, 'huge', 'blob.bin'), Buffer.alloc(64 * 1024, 7));
      const small = w.manager({ workspaceMaxBytes: 16 * 1024 });
      await expect(small.commitAll(wt, 'orc: too big', ctx)).rejects.toBeInstanceOf(WorkspaceQuotaError);
      const few = w.manager({ sizeScanMaxEntries: 2 });
      await expect(few.commitAll(wt, 'orc: too many', ctx)).rejects.toMatchObject({
        code: 'workspace_quota_exceeded',
      });
      expect(gitT(mirror, ['rev-parse', `refs/heads/${wt.branchName}`], { home: w.home }).stdout.trim()).toBe(
        baseSha,
      );
      const size = await small.measureSize(wt.path);
      expect(size.bytes).toBeGreaterThan(64 * 1024);
      expect((await few.measureSize(wt.path)).truncated).toBe(true);
      // Within quota the same workspace commits normally.
      await expect(gm.commitAll(wt, 'orc: fits', ctx)).resolves.toMatchObject({ committed: true });
      await gm.removeWorktree({ projectId: w.projectId, relPath: wt.relPath }, ctx);
      await gm.deleteBranch({ projectId: w.projectId, branchName: wt.branchName }, ctx);
    });

    it('a read-only source tree is enough for every mirror operation (POSIX)', async () => {
      if (IS_WIN32) return; // directory write bits are not enforced on win32
      const src = path.join(w.pr, 'acme', 'quota');
      const walk = (p: string, mode: (isDir: boolean) => number): void => {
        for (const d of readdirSync(p, { withFileTypes: true })) {
          const full = path.join(p, d.name);
          if (d.isDirectory()) walk(full, mode);
          chmodSync(full, mode(d.isDirectory()));
        }
      };
      walk(src, (dir) => (dir ? 0o555 : 0o444));
      chmodSync(src, 0o555);
      const before = hashTree(src);
      await gm.syncMirror(w.projectId, 'acme/quota', ctx);
      await expect(gm.validateSource('acme/quota', ctx)).resolves.toMatchObject({ headSha: baseSha });
      expect(hashTree(src)).toEqual(before);
    });
  });
});
