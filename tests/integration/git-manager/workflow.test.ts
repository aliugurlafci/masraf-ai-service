// End-to-end git-manager flow against real temp repositories (contract §11).
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFileProcessRegistry } from '@orc/shared/node';
import { GitRefNotFoundError, type GitManager, type WorktreeInfo } from '@orc/git-manager';
import { gitT, hashTree, writeFileP } from '../../helpers/git/fixtures';
import { ATTEMPT_1, createWorld, TASK_1, TASK_2, type World } from '../../helpers/git/world';

const UNICODE_PATH = 'ünïcødé/文件 名.txt';

describe('git-manager workflow (real git)', () => {
  let w: World;
  let gm: GitManager;
  let src: string;
  let baseSha: string;
  let wt: WorktreeInfo;
  let headSha: string;
  let mirror: string;
  const ctx1 = (): typeof w.ctx => ({ ...w.ctx, taskId: TASK_1, attemptId: ATTEMPT_1 });

  beforeAll(() => {
    w = createWorld();
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i} of a file that will be renamed`).join('\n');
    const repo = w.repo('acme/app', {
      'mod.txt': 'alpha\nbeta\ngamma\n',
      'gone.txt': 'to be deleted\n',
      'old-name.txt': `${lines}\n`,
      'other.txt': 'unrelated\n',
      'big.txt': 'small\n',
    });
    src = repo.dir;
    baseSha = repo.sha;
    w.git(src, ['checkout', '--quiet', '-b', 'feature']);
    writeFileP(path.join(src, 'feature.txt'), 'feature\n');
    w.git(src, ['add', '--all']);
    w.git(src, ['commit', '--quiet', '-m', 'feature']);
    w.git(src, ['checkout', '--quiet', 'main']);
    const registry = createFileProcessRegistry(path.join(w.ws, '.orc', 'run', 'it-worker'));
    gm = w.manager({}, registry);
    mirror = path.join(w.ws, '.repos', `${w.projectId}.git`);
  });

  afterAll(() => {
    w.dispose();
  });

  it('reports a supported git version', async () => {
    const v = await gm.version();
    const [major, minor] = v.split('.').map(Number) as [number, number];
    expect(major > 2 || (major === 2 && minor >= 38)).toBe(true);
  });

  it('ensureRuntimeDirs creates the fixed directories', async () => {
    // Leftover transport config files (ADR-0033) of this worker id are swept; other worker ids' are not.
    const ownConfigDir = path.join(w.ws, '.orc', 'git-config', 'it-worker');
    const otherConfig = path.join(w.ws, '.orc', 'git-config', 'other-worker', 'mirror_fetch-x.gitconfig');
    for (const f of [path.join(ownConfigDir, 'mirror_fetch-stale.gitconfig'), otherConfig]) {
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, '[safe]\n');
    }
    if (process.platform !== 'win32') {
      // POSIX: a writable hooks dir is refused (the fixed dirs are created before that check).
      await expect(gm.ensureRuntimeDirs()).rejects.toMatchObject({ code: 'config_invalid' });
      if (process.getuid?.() !== 0) {
        // The image-owned dir is read-only; root could still write it, so it stays refused for root.
        const { chmodSync } = await import('node:fs');
        chmodSync(w.hooks, 0o555);
        await gm.ensureRuntimeDirs();
      }
    } else {
      await gm.ensureRuntimeDirs();
    }
    for (const rel of ['.orc/git-home', '.orc/git-config/it-worker', '.orc/run/it-worker', '.repos']) {
      expect(existsSync(path.join(w.ws, rel))).toBe(true);
    }
    expect(readdirSync(ownConfigDir)).toEqual([]);
    expect(existsSync(otherConfig)).toBe(true);
    if (process.platform !== 'win32') {
      const { statSync } = await import('node:fs');
      expect(statSync(path.join(w.ws, '.repos')).mode & 0o777).toBe(0o700);
      expect(statSync(ownConfigDir).mode & 0o777).toBe(0o700);
      expect(statSync(path.dirname(ownConfigDir)).mode & 0o777).toBe(0o700);
      expect(statSync(w.ws).mode & 0o777).toBe(0o711);
    }
  });

  it('validateSource inspects the read-only source with plumbing only', async () => {
    const info = await gm.validateSource('acme/app', w.ctx);
    expect(info).toEqual({ absPath: src, isBare: false, defaultBranch: 'main', headSha: baseSha });
    await expect(gm.validateSource('acme/missing', w.ctx)).rejects.toMatchObject({
      code: 'git_repo_invalid',
    });
    await expect(gm.validateSource('../outside', w.ctx)).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('syncMirror builds the bare mirror without modifying the source repository', async () => {
    const before = hashTree(src);
    const info = await gm.syncMirror(w.projectId, 'acme/app', w.ctx);
    expect(hashTree(src)).toEqual(before);
    expect(info.mirrorPath).toBe(mirror);
    expect(info.branches).toEqual(
      expect.arrayContaining([
        { name: 'main', sha: baseSha },
        { name: 'feature', sha: expect.stringMatching(/^[0-9a-f]{40}$/) as unknown as string },
      ]),
    );
    expect(info.branches.some((b) => b.name === 'HEAD')).toBe(false);
    expect(w.git(mirror, ['config', '--get', 'core.hooksPath']).stdout.trim()).toBe(
      w.hooks.replaceAll('\\', '/'),
    );
    expect(w.git(mirror, ['config', '--get', 'core.bare']).stdout.trim()).toBe('true');
    // refs/heads/* of the mirror stay reserved for orc/task-* branches (ADR-0015).
    expect(w.git(mirror, ['for-each-ref', 'refs/heads/']).stdout.trim()).toBe('');
    // second sync is idempotent
    await gm.syncMirror(w.projectId, 'acme/app', w.ctx);
    expect(hashTree(src)).toEqual(before);
    expect(w.lock.acquired.filter((p) => p === w.projectId).length).toBeGreaterThanOrEqual(2);
  });

  it('resolveBase resolves branches via refs/remotes/origin and verifies shas', async () => {
    await expect(gm.resolveBase(w.projectId, 'main', w.ctx)).resolves.toBe(baseSha);
    await expect(gm.resolveBase(w.projectId, baseSha.slice(0, 10), w.ctx)).resolves.toBe(baseSha);
    await expect(gm.resolveBase(w.projectId, 'no-such-branch', w.ctx)).rejects.toBeInstanceOf(
      GitRefNotFoundError,
    );
    await expect(gm.resolveBase(w.projectId, 'f'.repeat(40), w.ctx)).rejects.toBeInstanceOf(
      GitRefNotFoundError,
    );
  });

  it('refreshBaseSnapshot (re)creates the detached _base worktree', async () => {
    const first = await gm.refreshBaseSnapshot(w.projectId, baseSha, w.ctx);
    expect(first).toEqual({ path: path.join(w.ws, w.projectId, '_base'), sha: baseSha });
    expect(readFileSync(path.join(first.path, 'mod.txt'), 'utf8')).toBe('alpha\nbeta\ngamma\n');
    writeFileSync(path.join(first.path, 'stray.txt'), 'x');
    const second = await gm.refreshBaseSnapshot(w.projectId, baseSha.slice(0, 12), w.ctx);
    expect(second.sha).toBe(baseSha);
    expect(existsSync(path.join(second.path, 'stray.txt'))).toBe(false);
  });

  it('createAttemptWorktree adds a locked worktree on orc/task-<key>-a<n>', async () => {
    wt = await gm.createAttemptWorktree(
      { projectId: w.projectId, taskId: TASK_1, attemptNumber: 1, baseSha },
      ctx1(),
    );
    expect(wt).toMatchObject({
      path: path.join(w.ws, w.projectId, TASK_1, 'a1'),
      relPath: `${w.projectId}/${TASK_1}/a1`,
      branchName: 'orc/task-7d0c6c1e-a1',
      keyLength: 8,
      baseSha,
      startSha: baseSha,
    });
    expect(path.dirname(wt.adminDir)).toBe(path.join(mirror, 'worktrees'));
    expect(readFileSync(path.join(wt.path, 'mod.txt'), 'utf8')).toBe('alpha\nbeta\ngamma\n');
    const list = w.git(mirror, ['worktree', 'list', '--porcelain']).stdout;
    expect(list).toContain(`locked orc-attempt-${ATTEMPT_1}`);
    expect(w.git(mirror, ['rev-parse', 'refs/heads/orc/task-7d0c6c1e-a1']).stdout.trim()).toBe(baseSha);
    await expect(
      gm.isWorktreeUsable(
        { projectId: w.projectId, relPath: wt.relPath, branchName: wt.branchName },
        ctx1(),
      ),
    ).resolves.toBe(true);
  });

  it('commitAll commits every change (A/M/D/R, binary, unicode) without hooks', async () => {
    writeFileSync(path.join(wt.path, 'mod.txt'), 'alpha\nBETA\ngamma\n');
    rmSync(path.join(wt.path, 'gone.txt'));
    renameSync(path.join(wt.path, 'old-name.txt'), path.join(wt.path, 'new-name.txt'));
    writeFileSync(path.join(wt.path, 'new.txt'), 'one\ntwo\n');
    writeFileSync(path.join(wt.path, 'img.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 254, 0, 9]));
    writeFileP(path.join(wt.path, UNICODE_PATH), 'merhaba dünya\n');
    writeFileSync(path.join(wt.path, 'big.txt'), `${'x'.repeat(100)}\n`.repeat(200));
    const res = await gm.commitAll(wt, 'orc: implement change\n\nOrc-Task-Id: t', ctx1());
    expect(res.committed).toBe(true);
    expect(res.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(res.headSha).not.toBe(baseSha);
    headSha = res.headSha;
    expect(w.git(mirror, ['rev-parse', `refs/heads/${wt.branchName}`]).stdout.trim()).toBe(headSha);
    const again = await gm.commitAll(wt, 'orc: nothing', ctx1());
    expect(again).toEqual({ committed: false, headSha });
  });

  it('collectCommits returns base..HEAD with UTC timestamps', async () => {
    const commits = await gm.collectCommits(wt, ctx1());
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      sha: headSha,
      authorName: 'Orc Orchestrator',
      authorEmail: 'orc@localhost',
      subject: 'orc: implement change',
    });
    expect(commits[0]?.authoredAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it('collectChanges maps name-status, numstat and per-file patches', async () => {
    const res = await gm.collectChanges(wt, ctx1());
    const byPath = new Map(res.files.map((f) => [f.path, f]));
    expect(res.truncatedFileList).toBe(false);
    expect(res.filesChanged).toBe(7);
    expect(byPath.get('mod.txt')).toMatchObject({ changeType: 'M', additions: 1, deletions: 1, isBinary: false });
    expect(byPath.get('mod.txt')?.patch).toContain('-beta\n+BETA');
    expect(byPath.get('gone.txt')).toMatchObject({ changeType: 'D', deletions: 1 });
    expect(byPath.get('new-name.txt')).toMatchObject({ changeType: 'R', oldPath: 'old-name.txt' });
    expect(byPath.get('new-name.txt')?.similarity).toBeGreaterThanOrEqual(50);
    expect(byPath.get('new.txt')).toMatchObject({ changeType: 'A', additions: 2, deletions: 0 });
    expect(byPath.get('img.bin')).toMatchObject({ changeType: 'A', isBinary: true, additions: null });
    expect(byPath.get('img.bin')?.patch).toMatch(/Binary files .* differ/);
    expect(byPath.get(UNICODE_PATH)).toMatchObject({ changeType: 'A', additions: 1 });
    expect(byPath.get(UNICODE_PATH)?.patch).toContain('+merhaba dünya');
    for (const f of res.files) {
      expect(f.patchTruncated).toBe(false);
      expect(f.patchBytes).toBe(Buffer.byteLength(f.patch ?? '', 'utf8'));
    }
    expect(res.additions).toBe([...byPath.values()].reduce((s, f) => s + (f.additions ?? 0), 0));

    const capped = await w
      .manager({ changedFilePatchMaxBytes: 1024, diffMaxFiles: 3 })
      .collectChanges(wt, ctx1());
    expect(capped.files).toHaveLength(3);
    expect(capped.filesChanged).toBe(7);
    expect(capped.truncatedFileList).toBe(true);
    const big = (await w.manager({ changedFilePatchMaxBytes: 1024 }).collectChanges(wt, ctx1())).files.find(
      (f) => f.path === 'big.txt',
    );
    expect(big?.patchTruncated).toBe(true);
    expect(Buffer.byteLength(big?.patch ?? '', 'utf8')).toBeLessThanOrEqual(1024);
    expect(big?.patchBytes).toBeGreaterThan(1024);
  });

  it('exportPatch produces a format-patch series that applies cleanly on the base', async () => {
    const res = await gm.exportPatch(wt, ctx1());
    expect(res.tooLarge).toBe(false);
    const patch = gunzipSync(res.gzip as Buffer);
    expect(patch.length).toBe(res.byteLength);
    const scratch = path.join(w.root, 'apply-check');
    w.git(w.root, ['clone', '--quiet', '--no-hardlinks', src, scratch]);
    w.git(scratch, ['checkout', '--quiet', '--detach', baseSha]);
    const am = gitT(scratch, ['am', '--quiet', '--keep-cr', '-'], {
      home: w.home,
      input: patch,
      allowFail: true,
    });
    expect(am.status, am.stderr).toBe(0);
    expect(w.git(scratch, ['rev-parse', 'HEAD^{tree}']).stdout.trim()).toBe(
      w.git(mirror, ['rev-parse', `${headSha}^{tree}`]).stdout.trim(),
    );
    const tiny = await w.manager({ patchExportMaxBytes: 100 }).exportPatch(wt, ctx1());
    expect(tiny).toMatchObject({ gzip: null, tooLarge: true });
  });

  it('mergeCheck reports clean / fast-forward while the base has not moved', async () => {
    const before = hashTree(src);
    const res = await gm.mergeCheck({ projectId: w.projectId, baseBranch: 'main', headSha }, ctx1());
    expect(res).toMatchObject({
      status: 'clean',
      latestBaseSha: baseSha,
      headSha,
      conflicts: [],
      isFastForward: true,
      error: null,
    });
    expect(hashTree(src)).toEqual(before);
  });

  it('mergeCheck detects a real conflict and reports none for an unrelated change', async () => {
    // Upstream moves on (an external developer commits to the source repository).
    writeFileSync(path.join(src, 'mod.txt'), 'alpha\nBeta-upstream\ngamma\n');
    w.git(src, ['commit', '--quiet', '-am', 'upstream edit']);
    const upstream = w.git(src, ['rev-parse', 'HEAD']).stdout.trim();

    const conflict = await gm.mergeCheck({ projectId: w.projectId, baseBranch: 'main', headSha }, ctx1());
    expect(conflict).toMatchObject({
      status: 'conflicts',
      latestBaseSha: upstream,
      conflicts: ['mod.txt'],
      isFastForward: false,
      error: null,
    });

    const wt2 = await gm.createAttemptWorktree(
      { projectId: w.projectId, taskId: TASK_2, attemptNumber: 1, baseSha },
      { ...w.ctx, taskId: TASK_2 },
    );
    expect(wt2.branchName).toBe('orc/task-7d0c6c1e-a1'.replace('7d0c6c1e', '7d0c6c1e1f2a'));
    writeFileSync(path.join(wt2.path, 'other.txt'), 'changed elsewhere\n');
    const c2 = await gm.commitAll(wt2, 'orc: other', { ...w.ctx, taskId: TASK_2 });
    const clean = await gm.mergeCheck(
      { projectId: w.projectId, baseBranch: 'main', headSha: c2.headSha },
      { ...w.ctx, taskId: TASK_2 },
    );
    expect(clean).toMatchObject({ status: 'clean', latestBaseSha: upstream, conflicts: [], isFastForward: false });
    await gm.removeWorktree({ projectId: w.projectId, relPath: wt2.relPath }, w.ctx);
    await gm.deleteBranch({ projectId: w.projectId, branchName: wt2.branchName }, w.ctx);

    const missing = await gm.mergeCheck(
      { projectId: w.projectId, baseBranch: 'no-such-branch', headSha },
      ctx1(),
    );
    expect(missing).toMatchObject({ status: 'error', latestBaseSha: null });
  });

  it('removeWorktree + deleteBranch roll back an attempt (idempotent)', async () => {
    await gm.removeWorktree({ projectId: w.projectId, relPath: wt.relPath }, ctx1());
    expect(existsSync(wt.path)).toBe(false);
    expect(w.git(mirror, ['worktree', 'list', '--porcelain']).stdout).not.toContain(TASK_1);
    expect(readdirSync(path.join(mirror, 'worktrees')).length).toBe(1); // only _base
    await expect(
      gm.isWorktreeUsable({ projectId: w.projectId, relPath: wt.relPath, branchName: wt.branchName }, ctx1()),
    ).resolves.toBe(false);
    await gm.deleteBranch({ projectId: w.projectId, branchName: wt.branchName }, ctx1());
    expect(w.git(mirror, ['rev-parse', '--verify', '--quiet', `refs/heads/${wt.branchName}`], true).status).toBe(1);
    await gm.removeWorktree({ projectId: w.projectId, relPath: wt.relPath }, ctx1());
    await gm.deleteBranch({ projectId: w.projectId, branchName: wt.branchName }, ctx1());
    await gm.removeWorktree({ projectId: w.projectId, relPath: `${w.projectId}/_base` }, w.ctx);
    expect(existsSync(path.join(w.ws, w.projectId, '_base'))).toBe(false);
  });

  it('gcMirror runs under the mirror lock', async () => {
    const n = w.lock.acquired.length;
    await gm.gcMirror(w.projectId, w.ctx);
    expect(w.lock.acquired.length).toBe(n + 1);
  });

  it('recorded every git spawn with sanitized args and left no registry entries', async () => {
    const ops = w.recorder.ops;
    expect(ops.length).toBeGreaterThan(30);
    for (const op of ops) {
      expect(op.projectId).toBe(w.projectId);
      expect(op.workerId).toBe('it-worker');
      const text = [...op.args, op.cwd ?? ''].join(' ');
      expect(text).not.toContain(w.ws);
      expect(text).not.toContain(w.ws.replaceAll('\\', '/'));
      expect(text).not.toContain(w.pr.replaceAll('\\', '/'));
      // §11.3: the isolation prefix leads every recorded argv.
      expect(op.args.slice(0, 2)).toEqual(['-c', `core.hooksPath=${w.hooks.replaceAll('\\', '/')}`]);
      expect(op.args).toContain('core.fsmonitor=false');
      expect(op.args).toContain('protocol.allow=never');
    }
    const kinds = new Set(ops.map((o) => o.operation));
    for (const k of [
      'validate_source',
      'mirror_init',
      'mirror_config',
      'mirror_fetch',
      'list_branches',
      'resolve_ref',
      'worktree_add',
      'worktree_list',
      'add',
      'diff_cached_quiet',
      'commit',
      'rev_parse',
      'log',
      'diff_name_status',
      'diff_numstat',
      'diff_patch',
      'format_patch',
      'merge_tree',
      'merge_base',
      'worktree_unlock',
      'worktree_remove',
      'worktree_prune',
      'branch_delete',
      'gc',
    ] as const) {
      expect(kinds.has(k)).toBe(true);
    }
    const registry = createFileProcessRegistry(path.join(w.ws, '.orc', 'run', 'it-worker'));
    await expect(registry.list()).resolves.toEqual([]);
  });
});
