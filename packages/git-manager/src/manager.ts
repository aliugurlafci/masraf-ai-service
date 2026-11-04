// GitManager implementation (contract §2.6, §11). Bare mirror per project (ADR-0015), locked
// per-attempt worktrees, hardened git spawns (§11.3), GitOperations recording (§11.7).
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, readdir, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip as gzipCallback } from 'node:zlib';
import { z } from 'zod';
import {
  GUID_REGEX,
  isOrcError,
  shortKey,
  systemClock,
  toIso,
  type CommitInfo,
  type GitOperationKind,
  type Uuid,
} from '@orc/shared';
import { ConfigError } from '@orc/shared/node';
import {
  isCommitSha,
  isSafeRefName,
  maskText,
  normalizeRepoRelativePath,
  PathEscapeError,
  realpathWithin,
  resolveWithin,
  sha256,
} from '@orc/security';
import { serializeError } from '@orc/logger';
import { gitArgv, toGitPath } from './argv';
import {
  GitError,
  GitRefNotFoundError,
  GitRepoInvalidError,
  InsufficientDiskSpaceError,
  WorkspaceQuotaError,
} from './errors';
import {
  ensureDirMode,
  errnoOf,
  lstatOrNull,
  measureTree,
  removeNoFollow,
  samePath,
} from './fs-utils';
import {
  assertAttemptNumber,
  assertBranchName,
  assertGuid,
  assertSha,
  BRANCH_PREFIX,
  branchNameFor,
  invalid,
  KEY_LENGTHS,
  parseWorktreeRelPath,
  worktreeRelPath,
} from './naming';
import {
  assembleChangedFiles,
  isFullSha,
  parseBranchList,
  parseGitVersion,
  parseLog,
  parseMergeTree,
  parseNameStatusZ,
  parseNumstatZ,
  parseWorktreeList,
  splitPatch,
} from './parse';
import {
  createGitExecutor,
  DIFF_STDOUT_MAX,
  GC_TIMEOUT_MS,
  gitFailed,
  VERSION_TIMEOUT_MS,
  type GitExec,
  type GitExecResult,
} from './runner';
import type {
  CollectedChanges,
  GitManager,
  GitManagerConfig,
  GitManagerDeps,
  GitOpContext,
  MergeCheckResult,
  MirrorInfo,
  SourceRepoInfo,
  WorktreeInfo,
} from './types';

const gzip = promisify(gzipCallback);

const MIN_GIT = { major: 2, minor: 38 } as const;
const MIRROR_REFSPEC = '+refs/heads/*:refs/remotes/origin/*';
const MESSAGE_MAX_BYTES = 64 * 1024;
const ADMIN_ID = /^[A-Za-z0-9._-]{1,255}$/;
const WORKER_ID = /^[A-Za-z0-9._-]{1,128}$/;
const MODE_TRAVERSE = 0o711;
const MODE_PRIVATE = 0o700;

const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.includes('\0') && path.isAbsolute(p), 'must be an absolute path');
const positiveInt = z.number().int().min(1);
const nonNegativeInt = z.number().int().min(0);
const identity = z
  .string()
  .min(1)
  .max(256)
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is rejected
  .refine((s) => !/[\u0000-\u001f\u007f<>]/.test(s), 'must not contain control characters or <>');

const GitManagerConfigSchema = z.object({
  gitBin: z
    .string()
    .min(1)
    .max(4096)
    .refine((s) => !s.includes('\0'), 'must not contain NUL'),
  projectsRoot: absolutePath,
  workspacesRoot: absolutePath,
  hooksDir: absolutePath,
  opTimeoutMs: positiveInt,
  fetchTimeoutMs: positiveInt,
  killGraceMs: nonNegativeInt,
  authorName: identity,
  authorEmail: identity,
  changedFilePatchMaxBytes: positiveInt,
  patchExportMaxBytes: positiveInt.max(1024 * 1024 * 1024),
  diffMaxFiles: positiveInt,
  commitsMax: positiveInt,
  workspaceMaxBytes: positiveInt,
  minFreeBytes: nonNegativeInt,
  sizeScanMaxEntries: positiveInt,
  stderrTailChars: nonNegativeInt,
  platform: z.enum(['posix', 'win32']),
});

function parseConfig(config: GitManagerConfig): GitManagerConfig {
  const parsed = GitManagerConfigSchema.safeParse(config);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new ConfigError(`Invalid git manager configuration: ${keys}`, {
      details: { keys: parsed.error.issues.map((i) => ({ key: i.path.join('.'), issue: i.message })) },
    });
  }
  return {
    ...parsed.data,
    projectsRoot: path.resolve(parsed.data.projectsRoot),
    workspacesRoot: path.resolve(parsed.data.workspacesRoot),
    hooksDir: path.resolve(parsed.data.hooksDir),
  };
}

function assertCtx(ctx: GitOpContext, projectId?: Uuid): void {
  if (typeof ctx !== 'object' || ctx === null) throw invalid('ctx', 'ctx is required');
  assertGuid(ctx.projectId, 'ctx.projectId');
  if (projectId !== undefined && ctx.projectId !== projectId) {
    throw invalid('ctx.projectId', 'ctx.projectId must equal the projectId of the operation');
  }
}

function throwIfAborted(ctx: GitOpContext, operation: GitOperationKind): void {
  if (ctx.signal?.aborted) {
    throw new GitError(`git ${operation} aborted`, {
      details: { operation, exitCode: null, stderrTail: '', aborted: true },
    });
  }
}

function normalizeMessage(message: unknown): string {
  if (typeof message !== 'string') throw invalid('message', 'Commit message must be a string');
  const text = message
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex -- strip control characters except \t and \n
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trimEnd();
  if (text.trim() === '') throw invalid('message', 'Commit message must not be empty');
  if (Buffer.byteLength(text, 'utf8') > MESSAGE_MAX_BYTES) {
    throw invalid('message', `Commit message exceeds ${MESSAGE_MAX_BYTES} bytes`);
  }
  return `${text}\n`;
}

interface WorktreePaths {
  M: string;
  W: string;
  A: string;
}

export function createGitManager(config: GitManagerConfig, deps: GitManagerDeps): GitManager {
  const cfg = parseConfig(config);
  if (typeof deps.workerId !== 'string' || !WORKER_ID.test(deps.workerId) || /^\.\.?$/.test(deps.workerId)) {
    throw new ConfigError('Invalid worker id for the git manager', { details: { keys: ['workerId'] } });
  }
  const platform = cfg.platform;
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger.child({ component: 'git-manager' });
  const ws = cfg.workspacesRoot;
  const pr = cfg.projectsRoot;
  const reposDir = resolveWithin(ws, '.repos');
  const orcDir = resolveWithin(ws, '.orc');
  const gitHome = resolveWithin(ws, '.orc', 'git-home');
  // Per-call transport config files of this worker (ADR-0033); swept by ensureRuntimeDirs.
  const gitConfigRoot = resolveWithin(ws, '.orc', 'git-config');
  const gitConfigDir = resolveWithin(ws, '.orc', 'git-config', deps.workerId);
  const runRoot = resolveWithin(ws, '.orc', 'run');
  const runDir = resolveWithin(ws, '.orc', 'run', deps.workerId);
  const A = gitArgv(platform);
  const gp = (p: string): string => toGitPath(p, platform);

  const git = createGitExecutor({
    gitBin: cfg.gitBin,
    hooksDir: cfg.hooksDir,
    gitHome,
    transportConfigDir: gitConfigDir,
    platform,
    killGraceMs: cfg.killGraceMs,
    stderrTailChars: cfg.stderrTailChars,
    roots: { projectsRoot: pr, workspacesRoot: ws },
    workerId: deps.workerId,
    logger,
    recorder: deps.recorder,
    clock,
    ...(deps.spawn ? { spawn: deps.spawn } : {}),
    ...(deps.registry ? { registry: deps.registry } : {}),
  });

  /** Mirror-level op (cwd = `.repos`). */
  const mirrorOp = (
    ctx: GitOpContext | null,
    op: GitOperationKind,
    args: string[],
    safe: readonly string[],
    extra: Partial<GitExec> = {},
  ): Promise<GitExecResult> =>
    git({ op, args, safeDirectories: safe, cwd: reposDir, timeoutMs: cfg.opTimeoutMs, ...extra }, ctx);

  /** Worktree-level op: `--git-dir=<A> --work-tree=<W>`, cwd = <W> (§11.3). */
  const worktreeOp = (
    ctx: GitOpContext,
    w: WorktreePaths,
    op: GitOperationKind,
    args: string[],
    extra: Partial<GitExec> = {},
  ): Promise<GitExecResult> =>
    git(
      { op, args, safeDirectories: [w.W, w.M], cwd: w.W, timeoutMs: cfg.opTimeoutMs, ...extra },
      ctx,
    );

  const mirrorPath = (projectId: Uuid): string => resolveWithin(ws, '.repos', `${projectId}.git`);

  const mirrorExists = async (M: string): Promise<boolean> =>
    (await lstatOrNull(path.join(M, 'HEAD'))) !== null;

  const requireMirror = async (projectId: Uuid): Promise<string> => {
    const M = mirrorPath(projectId);
    if (!(await mirrorExists(M))) {
      throw new GitError('Project mirror does not exist; sync the project first', {
        details: { operation: 'resolve_ref', exitCode: null, stderrTail: '', reason: 'mirror_missing' },
      });
    }
    return M;
  };

  const freeBytes = async (): Promise<number> => {
    const s = await statfs(ws);
    return Number(s.bavail) * Number(s.bsize);
  };

  const assertCapacity = async (): Promise<void> => {
    const free = await freeBytes();
    if (free < cfg.minFreeBytes) {
      throw new InsufficientDiskSpaceError('Not enough free disk space in the workspaces volume', {
        details: { freeBytes: free, minFreeBytes: cfg.minFreeBytes },
      });
    }
  };

  const measureSize = async (
    absPath: string,
  ): Promise<{ bytes: number; entries: number; truncated: boolean }> => {
    if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) {
      throw invalid('absPath', 'absPath must be an absolute path');
    }
    const rel = path.relative(ws, absPath);
    if (rel === '') return measureTree(ws, cfg.sizeScanMaxEntries);
    const segments = rel.split(path.sep);
    resolveWithin(ws, ...segments); // lexical containment (PathEscapeError)
    const name = segments[segments.length - 1] as string;
    // The walked directory itself is lstat'ed (a link is measured as a link); every parent must
    // resolve inside WORKSPACES_ROOT so a linked parent cannot redirect the walk.
    let parentReal = ws;
    if (segments.length > 1) {
      try {
        parentReal = await realpathWithin(ws, ...segments.slice(0, -1));
      } catch (e) {
        if (errnoOf(e) === 'ENOENT' || errnoOf(e) === 'ENOTDIR') return { bytes: 0, entries: 0, truncated: false };
        throw e;
      }
    }
    return measureTree(resolveWithin(parentReal, name), cfg.sizeScanMaxEntries);
  };

  // ---- source repository ---------------------------------------------------------------------

  const inspectSource = async (
    repoPath: string,
    ctx: GitOpContext,
  ): Promise<{ info: SourceRepoInfo; gitDir: string }> => {
    assertCtx(ctx);
    const rel = normalizeRepoRelativePath(repoPath);
    const segments = rel.split('/');
    let abs: string;
    try {
      abs = await realpathWithin(pr, ...segments);
    } catch (e) {
      if (isOrcError(e)) throw e;
      if (errnoOf(e) === 'ENOENT' || errnoOf(e) === 'ENOTDIR') {
        throw new GitRepoInvalidError('Source repository does not exist', { details: { repoPath: rel } });
      }
      throw e;
    }
    const st = await stat(abs);
    if (!st.isDirectory()) {
      throw new GitRepoInvalidError('Source repository is not a directory', { details: { repoPath: rel } });
    }
    const discover = await git(
      {
        op: 'validate_source',
        args: A.validateSourceDiscover(abs),
        safeDirectories: [abs],
        cwd: abs,
        timeoutMs: cfg.opTimeoutMs,
      },
      ctx,
    );
    if (discover.exitCode !== 0) {
      throw new GitRepoInvalidError('Source path is not a git repository', {
        details: { repoPath: rel, stderrTail: discover.stderrTail },
      });
    }
    const lines = discover.stdout.toString('utf8').split(/\r?\n/);
    const isBare = (lines[0] ?? '').trim() === 'true';
    const reported = (lines[1] ?? '').trim();
    const expected = isBare ? abs : path.join(abs, '.git');
    if (reported === '' || !(await samePath(reported, expected, platform))) {
      throw new GitRepoInvalidError('Source git directory is not the repository itself', {
        details: { repoPath: rel },
      });
    }
    // A '.git' that links outside PROJECTS_ROOT is rejected (symlink escape).
    const gitDir = isBare ? abs : await realpathWithin(pr, ...segments, '.git');
    if (!(await stat(gitDir)).isDirectory()) {
      throw new GitRepoInvalidError('Source git directory is not a directory', { details: { repoPath: rel } });
    }
    const safe = [abs, gitDir];
    const head = await git(
      {
        op: 'validate_source',
        args: A.validateSourceHead(gitDir),
        safeDirectories: safe,
        cwd: abs,
        timeoutMs: cfg.opTimeoutMs,
      },
      ctx,
    );
    const branch = head.stdout.toString('utf8').trim();
    if (head.exitCode !== 0 || branch === '') {
      throw new GitRepoInvalidError('Source HEAD does not point to a branch', {
        details: { repoPath: rel, stderrTail: head.stderrTail },
      });
    }
    if (!isSafeRefName(branch)) {
      throw new GitRepoInvalidError('Source default branch name is not supported', {
        details: { repoPath: rel },
      });
    }
    const tip = await git(
      {
        op: 'validate_source',
        args: A.validateSourceBranch(gitDir, branch),
        safeDirectories: safe,
        cwd: abs,
        timeoutMs: cfg.opTimeoutMs,
      },
      ctx,
    );
    const headSha = tip.stdout.toString('utf8').trim();
    if (tip.exitCode !== 0 || !isFullSha(headSha)) {
      throw new GitRepoInvalidError('Source default branch has no commit', {
        details: { repoPath: rel, stderrTail: tip.stderrTail },
      });
    }
    return { info: { absPath: abs, isBare, defaultBranch: branch, headSha }, gitDir };
  };

  // ---- mirror ----------------------------------------------------------------------------------

  const ensureMirror = async (M: string, srcGitDir: string, ctx: GitOpContext): Promise<void> => {
    await ensureDirMode(reposDir, MODE_PRIVATE, platform);
    if (!(await mirrorExists(M))) {
      const r = await mirrorOp(ctx, 'mirror_init', A.mirrorInit(M), [M]);
      if (r.exitCode !== 0) throw gitFailed('mirror_init', r);
    }
    const settings: [string, string][] = [
      ['remote.origin.url', gp(srcGitDir)],
      ['remote.origin.fetch', MIRROR_REFSPEC],
      ['core.hooksPath', gp(cfg.hooksDir)],
      ['core.fsmonitor', 'false'],
      ['gc.auto', '0'],
    ];
    for (const [key, value] of settings) {
      const r = await mirrorOp(ctx, 'mirror_config', A.mirrorConfig(M, key, value), [M]);
      if (r.exitCode !== 0) throw gitFailed('mirror_config', r);
    }
  };

  const fetchMirror = async (M: string, srcGitDir: string, ctx: GitOpContext): Promise<void> => {
    throwIfAborted(ctx, 'mirror_fetch');
    // upload-pack runs in the source git dir and is started by the local transport without the
    // `-c` config, so safe.directory reaches it only via the per-call global config (ADR-0033).
    const r = await mirrorOp(ctx, 'mirror_fetch', A.mirrorFetch(M), [M, srcGitDir], {
      fetch: true,
      transportSafeDirectories: [srcGitDir],
      timeoutMs: cfg.fetchTimeoutMs,
    });
    if (r.exitCode !== 0) throw gitFailed('mirror_fetch', r);
  };

  const listBranches = async (M: string, ctx: GitOpContext): Promise<{ name: string; sha: string }[]> => {
    const r = await mirrorOp(ctx, 'list_branches', A.listBranches(M), [M]);
    if (r.exitCode !== 0) throw gitFailed('list_branches', r);
    return parseBranchList(r.stdout);
  };

  /** Source git dir recorded in the worker-owned mirror config, re-validated against PROJECTS_ROOT. */
  const mirrorSourceGitDir = async (M: string, ctx: GitOpContext): Promise<string> => {
    const r = await mirrorOp(ctx, 'mirror_config', A.mirrorConfigGet(M, 'remote.origin.url'), [M]);
    const url = r.stdout.toString('utf8').trim();
    if (r.exitCode !== 0 || url === '' || !path.isAbsolute(url)) {
      throw new GitRepoInvalidError('Mirror has no valid source repository configured');
    }
    const rel = path.relative(pr, path.resolve(url));
    if (rel === '') throw new GitRepoInvalidError('Mirror source must not be PROJECTS_ROOT itself');
    const real = await realpathWithin(pr, rel);
    if (!(await stat(real)).isDirectory()) {
      throw new GitRepoInvalidError('Mirror source git directory is missing');
    }
    return real;
  };

  type RefKind = 'any' | 'branch';
  const resolveRef = async (M: string, ref: unknown, kind: RefKind, ctx: GitOpContext): Promise<string> => {
    let args: string[];
    if (kind === 'any' && typeof ref === 'string' && isCommitSha(ref)) args = A.resolveSha(M, ref);
    else if (typeof ref === 'string' && isSafeRefName(ref)) args = A.resolveRemoteBranch(M, ref);
    else {
      throw new GitRefNotFoundError('Ref is not a valid branch name or commit id', {
        details: { reason: 'invalid_ref' },
      });
    }
    const r = await mirrorOp(ctx, 'resolve_ref', args, [M], { success: (c) => c === 0 });
    const sha = r.stdout.toString('utf8').trim();
    if (r.exitCode === 0 && isFullSha(sha)) return sha;
    if (r.exitCode === 1 || (r.exitCode === 0 && sha === '')) {
      throw new GitRefNotFoundError('Ref not found in the project mirror', {
        details: { ref: ref.slice(0, 200) },
      });
    }
    throw gitFailed('resolve_ref', r);
  };

  // ---- worktrees -------------------------------------------------------------------------------

  /**
   * mkdir/chmod of `<WS>/<projectId>[/<taskId>]`. An existing level that is a link (symlink or
   * junction) or not a directory is refused: git would otherwise create the worktree through it
   * outside WORKSPACES_ROOT, and chmod would follow it (§11.7).
   */
  const ensureTaskDirs = async (segments: readonly string[]): Promise<void> => {
    for (let n = 1; n <= segments.length; n++) {
      const dir = resolveWithin(ws, ...segments.slice(0, n));
      const st = await lstatOrNull(dir);
      if (st !== null && (st.isSymbolicLink() || !st.isDirectory())) {
        throw new PathEscapeError('Workspace directory is a link or not a directory', {
          details: { relPath: segments.slice(0, n).join('/') },
        });
      }
      await ensureDirMode(dir, MODE_TRAVERSE, platform);
    }
  };

  /**
   * Admin dir `<M>/worktrees/<id>` of worktree `W`, from the worker-owned mirror only: the id whose
   * `gitdir` file points to `<W>/.git`. The worktree's own `.git` file is never read (§11.3).
   */
  const findAdminDir = async (
    M: string,
    W: string,
    hint: string | null,
    ctx: GitOpContext,
    verifyListed: boolean,
  ): Promise<string> => {
    const worktreesDir = path.join(M, 'worktrees');
    if (verifyListed) {
      const r = await mirrorOp(ctx, 'worktree_list', A.worktreeList(M), [M]);
      if (r.exitCode !== 0) throw gitFailed('worktree_list', r);
      let listed = false;
      for (const e of parseWorktreeList(r.stdout)) {
        if (!e.bare && (await samePath(e.worktree, W, platform))) {
          listed = true;
          break;
        }
      }
      if (!listed) {
        throw new GitError('Worktree is not registered in the project mirror', {
          details: { operation: 'worktree_list', exitCode: 0, stderrTail: '', reason: 'worktree_unregistered' },
        });
      }
    }
    const candidates: string[] = [];
    if (hint) {
      const id = path.basename(hint);
      if (ADMIN_ID.test(id) && (await samePath(hint, path.join(worktreesDir, id), platform))) candidates.push(id);
    }
    const scan = async (ids: readonly string[]): Promise<string | null> => {
      for (const id of ids) {
        if (!ADMIN_ID.test(id)) continue;
        const admin = resolveWithin(worktreesDir, id);
        let target: string;
        try {
          target = (await readFile(path.join(admin, 'gitdir'), 'utf8')).trim();
        } catch {
          continue;
        }
        if (target !== '' && (await samePath(path.dirname(target), W, platform))) return admin;
      }
      return null;
    };
    const fromHint = await scan(candidates);
    if (fromHint) return fromHint;
    let ids: string[] = [];
    try {
      ids = await readdir(worktreesDir);
    } catch (e) {
      if (errnoOf(e) !== 'ENOENT') throw e;
    }
    const found = await scan(ids);
    if (found) return found;
    throw new GitError('Worktree admin directory not found in the project mirror', {
      details: { operation: 'worktree_list', exitCode: null, stderrTail: '', reason: 'worktree_admin_missing' },
    });
  };

  const worktreePaths = async (wt: WorktreeInfo, ctx: GitOpContext): Promise<WorktreePaths> => {
    assertCtx(ctx);
    if (typeof wt !== 'object' || wt === null) throw invalid('wt', 'WorktreeInfo is required');
    const { segments } = parseWorktreeRelPath(wt.relPath, ctx.projectId);
    const W = resolveWithin(ws, ...segments);
    if (typeof wt.path !== 'string' || !(await samePath(wt.path, W, platform))) {
      throw invalid('wt.path', 'Worktree path does not match its relPath');
    }
    assertSha(wt.baseSha, 'wt.baseSha');
    const st = await lstatOrNull(W);
    if (st === null || st.isSymbolicLink() || !st.isDirectory()) {
      throw new GitError('Worktree directory is missing', {
        details: { operation: 'rev_parse', exitCode: null, stderrTail: '', reason: 'worktree_missing' },
      });
    }
    const M = await requireMirror(ctx.projectId);
    const hint = typeof wt.adminDir === 'string' && wt.adminDir !== '' ? wt.adminDir : null;
    const Adir = await findAdminDir(M, W, hint, ctx, false);
    return { M, W, A: Adir };
  };

  /** Deletes `<WS>/<segments>` without following links; the parent must resolve inside WORKSPACES_ROOT. */
  const guardedRemove = async (segments: readonly string[]): Promise<void> => {
    const parent = segments.slice(0, -1);
    const name = segments[segments.length - 1];
    if (name === undefined) return;
    let parentReal: string;
    try {
      parentReal = await realpathWithin(ws, ...parent);
    } catch (e) {
      if (errnoOf(e) === 'ENOENT' || errnoOf(e) === 'ENOTDIR') return;
      throw e;
    }
    await removeNoFollow(resolveWithin(parentReal, name));
  };

  const removeWorktreeAt = async (
    M: string,
    W: string,
    segments: readonly string[],
    ctx: GitOpContext,
    unlock: boolean,
  ): Promise<void> => {
    const hasMirror = await mirrorExists(M);
    if (hasMirror) {
      if (unlock) {
        await mirrorOp(ctx, 'worktree_unlock', A.worktreeUnlock(M, W), [M], {
          success: (c, err) => c === 0 || /not locked|is not a working tree/i.test(err),
        });
      }
      await mirrorOp(ctx, 'worktree_remove', A.worktreeRemove(M, W), [M, W], {
        success: (c, err) => c === 0 || /is not a working tree/i.test(err),
      });
    }
    await guardedRemove(segments);
    if (hasMirror) {
      const r = await mirrorOp(ctx, 'worktree_prune', A.worktreePrune(M), [M]);
      if (r.exitCode !== 0) throw gitFailed('worktree_prune', r);
    }
  };

  const revParseHead = async (ctx: GitOpContext, w: WorktreePaths): Promise<string> => {
    const r = await worktreeOp(ctx, w, 'rev_parse', A.revParseHead(w.A, w.W));
    const sha = r.stdout.toString('utf8').trim();
    if (r.exitCode !== 0 || !isFullSha(sha)) throw gitFailed('rev_parse', r);
    return sha;
  };

  // ---- public API ------------------------------------------------------------------------------

  const manager: GitManager = {
    async version() {
      const r = await git(
        {
          op: 'version',
          args: A.version(),
          safeDirectories: [],
          cwd: process.cwd(),
          timeoutMs: VERSION_TIMEOUT_MS,
        },
        null,
      );
      const v = parseGitVersion(r.stdout.toString('utf8'));
      if (r.exitCode !== 0 || v === null) throw gitFailed('version', r, 'Unable to determine the git version');
      if (v.major < MIN_GIT.major || (v.major === MIN_GIT.major && v.minor < MIN_GIT.minor)) {
        throw new GitError(`git ${v.text} is too old; >= 2.38 is required`, {
          details: { operation: 'version', exitCode: 0, stderrTail: '', reason: 'version_unsupported', version: v.text },
        });
      }
      return v.text;
    },

    async ensureRuntimeDirs() {
      await ensureDirMode(ws, MODE_TRAVERSE, platform).catch(async (e: unknown) => {
        if (errnoOf(e) !== 'EPERM') throw e;
        // Root owned by another uid (volume mount): keep its mode, it must exist.
        await stat(ws);
        logger.warn({ path: '<WORKSPACES_ROOT>' }, 'could not set WORKSPACES_ROOT mode');
      });
      for (const dir of [orcDir, gitHome, gitConfigRoot, runRoot, runDir, reposDir]) {
        await ensureDirMode(dir, MODE_PRIVATE, platform);
      }
      // Transport config files left by a crash of this worker id; no git process of it runs yet.
      await rm(gitConfigDir, { recursive: true, force: true });
      await ensureDirMode(gitConfigDir, MODE_PRIVATE, platform);
      let hooks;
      try {
        hooks = await stat(cfg.hooksDir);
      } catch {
        throw new ConfigError('GIT_HOOKS_DIR does not exist', { details: { keys: ['GIT_HOOKS_DIR'] } });
      }
      if (!hooks.isDirectory()) {
        throw new ConfigError('GIT_HOOKS_DIR is not a directory', { details: { keys: ['GIT_HOOKS_DIR'] } });
      }
      if ((await readdir(cfg.hooksDir)).length > 0) {
        throw new ConfigError('GIT_HOOKS_DIR must be empty', { details: { keys: ['GIT_HOOKS_DIR'] } });
      }
      let writable: boolean;
      if (platform === 'posix') {
        writable = await access(cfg.hooksDir, fsConstants.W_OK).then(
          () => true,
          () => false,
        );
      } else {
        // win32: access(W_OK) ignores directory ACLs; probe by creating a file.
        const probe = path.join(cfg.hooksDir, `.orc-probe-${randomUUID()}`);
        writable = await writeFile(probe, '', { flag: 'wx' }).then(
          () => true,
          () => false,
        );
        if (writable) await rm(probe, { force: true });
      }
      if (writable && platform === 'posix') {
        throw new ConfigError('GIT_HOOKS_DIR must not be writable by the worker', {
          details: { keys: ['GIT_HOOKS_DIR'] },
        });
      }
      if (writable) {
        logger.warn(
          { keys: ['GIT_HOOKS_DIR'] },
          'GIT_HOOKS_DIR is writable on this win32 development host (SANDBOX_MODE=local only)',
        );
      }
    },

    async validateSource(repoPath, ctx) {
      return (await inspectSource(repoPath, ctx)).info;
    },

    async syncMirror(projectId, repoPath, ctx): Promise<MirrorInfo> {
      assertGuid(projectId, 'projectId');
      assertCtx(ctx, projectId);
      const { gitDir } = await inspectSource(repoPath, ctx);
      await assertCapacity();
      const M = mirrorPath(projectId);
      return deps.lock.withLock(projectId, async () => {
        throwIfAborted(ctx, 'mirror_fetch');
        await ensureMirror(M, gitDir, ctx);
        await fetchMirror(M, gitDir, ctx);
        const branches = await listBranches(M, ctx);
        return { mirrorPath: M, branches, fetchedAt: toIso(clock.now()) };
      });
    },

    async resolveBase(projectId, ref, ctx) {
      assertGuid(projectId, 'projectId');
      assertCtx(ctx, projectId);
      const M = await requireMirror(projectId);
      return resolveRef(M, ref, 'any', ctx);
    },

    async refreshBaseSnapshot(projectId, sha, ctx) {
      assertGuid(projectId, 'projectId');
      assertCtx(ctx, projectId);
      assertSha(sha, 'sha');
      const M = await requireMirror(projectId);
      return deps.lock.withLock(projectId, async () => {
        const full = await resolveRef(M, sha, 'any', ctx);
        const segments = [projectId, '_base'];
        const base = resolveWithin(ws, ...segments);
        await ensureTaskDirs([projectId]);
        await removeWorktreeAt(M, base, segments, ctx, false);
        const r = await mirrorOp(ctx, 'worktree_add', A.worktreeAddBase(M, base, full), [M, base]);
        if (r.exitCode !== 0) {
          await guardedRemove(segments).catch(() => undefined);
          await mirrorOp(ctx, 'worktree_prune', A.worktreePrune(M), [M]).catch(() => undefined);
          throw gitFailed('worktree_add', r);
        }
        return { path: base, sha: full };
      });
    },

    async createAttemptWorktree(i, ctx): Promise<WorktreeInfo> {
      assertGuid(i.projectId, 'projectId');
      assertGuid(i.taskId, 'taskId');
      assertAttemptNumber(i.attemptNumber);
      assertSha(i.baseSha, 'baseSha');
      if (i.startSha !== undefined) assertSha(i.startSha, 'startSha');
      assertCtx(ctx, i.projectId);
      await assertCapacity();
      const M = await requireMirror(i.projectId);
      const relPath = worktreeRelPath(i.projectId, i.taskId, i.attemptNumber);
      const segments = relPath.split('/');
      const W = resolveWithin(ws, ...segments);
      await ensureTaskDirs(segments.slice(0, 2));
      if ((await lstatOrNull(W)) !== null) {
        throw new GitError('Worktree path already exists', {
          details: { operation: 'worktree_add', exitCode: null, stderrTail: '', reason: 'worktree_exists', relPath },
        });
      }

      let branchName: string | null = null;
      let keyLength: 8 | 12 | 32 = 8;
      for (const k of KEY_LENGTHS) {
        const name = branchNameFor(i.taskId, i.attemptNumber, k);
        const r = await mirrorOp(ctx, 'resolve_ref', A.localBranchExists(M, name), [M], {
          success: (c) => c === 0 || c === 1,
        });
        if (r.exitCode === 1) {
          branchName = name;
          keyLength = k;
          break;
        }
        if (r.exitCode !== 0) throw gitFailed('resolve_ref', r);
      }
      if (branchName === null) {
        throw new GitError('No free branch name for this attempt', {
          details: { operation: 'worktree_add', exitCode: null, stderrTail: '', reason: 'branch_name_exhausted' },
        });
      }
      const startSha = i.startSha ?? i.baseSha;
      const lockLabel =
        typeof ctx.attemptId === 'string' && GUID_REGEX.test(ctx.attemptId)
          ? ctx.attemptId
          : `${shortKey(i.taskId, 32)}-a${i.attemptNumber}`;
      const added = await mirrorOp(
        ctx,
        'worktree_add',
        A.worktreeAddAttempt(M, lockLabel, branchName, W, startSha),
        [M, W],
      );
      if (added.exitCode !== 0) {
        // Rollback: nothing of a failed add may survive (directory, admin entry, new branch).
        await guardedRemove(segments).catch(() => undefined);
        await mirrorOp(ctx, 'worktree_prune', A.worktreePrune(M), [M]).catch(() => undefined);
        await mirrorOp(ctx, 'branch_delete', A.branchDelete(M, branchName), [M], {
          success: (c, err) => c === 0 || /not found/i.test(err),
        }).catch(() => undefined);
        throw gitFailed('worktree_add', added);
      }
      const adminDir = await findAdminDir(M, W, null, ctx, true);
      return { path: W, relPath, adminDir, branchName, baseSha: i.baseSha, startSha, keyLength };
    },

    async isWorktreeUsable(i, ctx) {
      assertGuid(i.projectId, 'projectId');
      assertCtx(ctx, i.projectId);
      const { segments } = parseWorktreeRelPath(i.relPath, i.projectId, ['attempt']);
      assertBranchName(i.branchName, 'branchName');
      const W = resolveWithin(ws, ...segments);
      try {
        const st = await lstatOrNull(W);
        if (st === null || st.isSymbolicLink() || !st.isDirectory()) return false;
        const M = mirrorPath(i.projectId);
        if (!(await mirrorExists(M))) return false;
        const r = await mirrorOp(ctx, 'worktree_list', A.worktreeList(M), [M]);
        if (r.exitCode !== 0) return false;
        let entry = null;
        for (const e of parseWorktreeList(r.stdout)) {
          if (!e.bare && (await samePath(e.worktree, W, platform))) {
            entry = e;
            break;
          }
        }
        if (entry === null || entry.prunable || entry.branch !== `refs/heads/${i.branchName}`) return false;
        const admin = await findAdminDir(M, W, null, ctx, false);
        return (await lstatOrNull(path.join(admin, 'HEAD'))) !== null;
      } catch (e) {
        logger.debug({ err: serializeError(e) }, 'worktree not usable');
        return false;
      }
    },

    measureSize,
    freeBytes,
    assertCapacity,

    async commitAll(wt, message, ctx) {
      const w = await worktreePaths(wt, ctx);
      const msg = normalizeMessage(message);
      const size = await measureTree(w.W, cfg.sizeScanMaxEntries);
      if (size.truncated || size.bytes > cfg.workspaceMaxBytes) {
        throw new WorkspaceQuotaError('Workspace exceeds its size quota', {
          details: { ...size, maxBytes: cfg.workspaceMaxBytes, maxEntries: cfg.sizeScanMaxEntries },
        });
      }
      const add = await worktreeOp(ctx, w, 'add', A.add(w.A, w.W));
      if (add.exitCode !== 0) throw gitFailed('add', add);
      const staged = await worktreeOp(ctx, w, 'diff_cached_quiet', A.diffCachedQuiet(w.A, w.W), {
        success: (c) => c === 0 || c === 1,
      });
      if (staged.exitCode !== 0 && staged.exitCode !== 1) throw gitFailed('diff_cached_quiet', staged);
      const committed = staged.exitCode === 1;
      if (committed) {
        const c = await worktreeOp(
          ctx,
          w,
          'commit',
          A.commit(w.A, w.W, cfg.authorName, cfg.authorEmail),
          { stdin: msg },
        );
        if (c.exitCode !== 0) throw gitFailed('commit', c);
      }
      return { committed, headSha: await revParseHead(ctx, w) };
    },

    async collectCommits(wt, ctx): Promise<CommitInfo[]> {
      const w = await worktreePaths(wt, ctx);
      const r = await worktreeOp(ctx, w, 'log', A.log(w.A, w.W, cfg.commitsMax, wt.baseSha));
      if (r.exitCode !== 0) throw gitFailed('log', r);
      const commits = parseLog(r.stdout);
      if (commits === null) throw gitFailed('log', r, 'Unexpected git log output');
      return commits.slice(0, cfg.commitsMax);
    },

    async collectChanges(wt, ctx): Promise<CollectedChanges> {
      const w = await worktreePaths(wt, ctx);
      const big = { maxStdoutBytes: DIFF_STDOUT_MAX };
      const ns = await worktreeOp(ctx, w, 'diff_name_status', A.diffNameStatus(w.A, w.W, wt.baseSha), big);
      if (ns.exitCode !== 0) throw gitFailed('diff_name_status', ns);
      const nm = await worktreeOp(ctx, w, 'diff_numstat', A.diffNumstat(w.A, w.W, wt.baseSha), big);
      if (nm.exitCode !== 0) throw gitFailed('diff_numstat', nm);
      const pt = await worktreeOp(ctx, w, 'diff_patch', A.diffPatch(w.A, w.W, wt.baseSha), big);
      if (pt.exitCode !== 0) throw gitFailed('diff_patch', pt);
      const parsed = parseNameStatusZ(ns.stdout, cfg.diffMaxFiles, ns.stdoutTruncated);
      const numstat = parseNumstatZ(nm.stdout);
      const files = assembleChangedFiles({
        entries: parsed.entries,
        numstat,
        patchChunks: splitPatch(pt.stdout),
        patchStdoutTruncated: pt.stdoutTruncated,
        perFileMaxBytes: cfg.changedFilePatchMaxBytes,
      });
      let additions = 0;
      let deletions = 0;
      for (const s of numstat.values()) {
        additions += s.additions ?? 0;
        deletions += s.deletions ?? 0;
      }
      return {
        files,
        filesChanged: parsed.total,
        additions,
        deletions,
        truncatedFileList: parsed.truncated,
      };
    },

    async exportPatch(wt, ctx) {
      const w = await worktreePaths(wt, ctx);
      const r = await worktreeOp(ctx, w, 'format_patch', A.formatPatch(w.A, w.W, wt.baseSha), {
        maxStdoutBytes: cfg.patchExportMaxBytes + 1,
      });
      if (r.exitCode !== 0) throw gitFailed('format_patch', r);
      const content = r.stdout;
      const tooLarge = r.stdoutTruncated || content.length > cfg.patchExportMaxBytes;
      return {
        gzip: tooLarge ? null : await gzip(content, { level: 6 }),
        byteLength: content.length,
        sha256: sha256(content),
        tooLarge,
      };
    },

    async mergeCheck(i, ctx): Promise<MergeCheckResult> {
      let latestBaseSha: string | null = null;
      try {
        assertGuid(i.projectId, 'projectId');
        assertCtx(ctx, i.projectId);
        assertBranchName(i.baseBranch, 'baseBranch');
        assertSha(i.headSha, 'headSha');
        const M = await requireMirror(i.projectId);
        await deps.lock.withLock(i.projectId, async () => {
          const src = await mirrorSourceGitDir(M, ctx);
          await assertCapacity();
          await fetchMirror(M, src, ctx);
        });
        latestBaseSha = await resolveRef(M, i.baseBranch, 'branch', ctx);
        const mt = await mirrorOp(ctx, 'merge_tree', A.mergeTree(M, latestBaseSha, i.headSha), [M], {
          maxStdoutBytes: DIFF_STDOUT_MAX,
          success: (c) => c === 0 || c === 1,
        });
        if (mt.exitCode !== 0 && mt.exitCode !== 1) throw gitFailed('merge_tree', mt);
        const { conflicts } = parseMergeTree(mt.stdout);
        const mb = await mirrorOp(
          ctx,
          'merge_base',
          A.mergeBaseIsAncestor(M, latestBaseSha, i.headSha),
          [M],
          { success: (c) => c === 0 || c === 1 },
        );
        if (mb.exitCode !== 0 && mb.exitCode !== 1) throw gitFailed('merge_base', mb);
        return {
          status: mt.exitCode === 1 ? 'conflicts' : 'clean',
          baseBranch: i.baseBranch,
          latestBaseSha,
          headSha: i.headSha,
          conflicts: mt.exitCode === 1 ? conflicts : [],
          isFastForward: mb.exitCode === 0,
          error: null,
          checkedAt: toIso(clock.now()),
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.warn({ err: serializeError(e), projectId: i.projectId }, 'merge check failed');
        return {
          status: 'error',
          baseBranch: String(i.baseBranch),
          latestBaseSha,
          headSha: String(i.headSha),
          conflicts: [],
          isFastForward: false,
          error: maskText(message).slice(0, 1000),
          checkedAt: toIso(clock.now()),
        };
      }
    },

    async removeWorktree(i, ctx) {
      assertGuid(i.projectId, 'projectId');
      assertCtx(ctx, i.projectId);
      const { kind, segments } = parseWorktreeRelPath(i.relPath, i.projectId);
      const W = resolveWithin(ws, ...segments);
      await removeWorktreeAt(mirrorPath(i.projectId), W, segments, ctx, kind === 'attempt');
    },

    async deleteBranch(i, ctx) {
      assertGuid(i.projectId, 'projectId');
      assertCtx(ctx, i.projectId);
      assertBranchName(i.branchName, 'branchName');
      if (!i.branchName.startsWith(BRANCH_PREFIX)) {
        throw invalid('branchName', `Only ${BRANCH_PREFIX}* branches can be deleted`);
      }
      const M = mirrorPath(i.projectId);
      if (!(await mirrorExists(M))) return;
      const r = await mirrorOp(ctx, 'branch_delete', A.branchDelete(M, i.branchName), [M], {
        success: (c, err) => c === 0 || /not found/i.test(err),
      });
      if (!r.success) throw gitFailed('branch_delete', r);
    },

    async gcMirror(projectId, ctx) {
      assertGuid(projectId, 'projectId');
      assertCtx(ctx, projectId);
      const M = mirrorPath(projectId);
      if (!(await mirrorExists(M))) return;
      await deps.lock.withLock(projectId, async () => {
        const r = await mirrorOp(ctx, 'gc', A.gc(M), [M], { timeoutMs: GC_TIMEOUT_MS });
        if (r.exitCode !== 0) throw gitFailed('gc', r);
      });
    },
  };
  return manager;
}

