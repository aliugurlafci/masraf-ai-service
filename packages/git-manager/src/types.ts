// Public types of @orc/git-manager (contract §2.6).
import type {
  ChangedFileInput,
  Clock,
  CommitInfo,
  GitOperation,
  IsoDateTime,
  MergeCheck,
  Uuid,
} from '@orc/shared';
import type { HostPlatform, ProcessRegistry, SpawnFn } from '@orc/shared/node';
import type { Logger } from '@orc/logger';

export interface GitManagerConfig {
  gitBin: string;
  projectsRoot: string;
  workspacesRoot: string;
  /** GIT_HOOKS_DIR: image-owned, empty, read-only directory used as core.hooksPath. */
  hooksDir: string;
  opTimeoutMs: number;
  fetchTimeoutMs: number;
  killGraceMs: number;
  authorName: string;
  authorEmail: string;
  changedFilePatchMaxBytes: number;
  patchExportMaxBytes: number;
  diffMaxFiles: number;
  commitsMax: number;
  workspaceMaxBytes: number;
  minFreeBytes: number;
  sizeScanMaxEntries: number;
  stderrTailChars: number;
  platform: HostPlatform;
}

/** Failures are logged, never thrown to the caller. */
export interface GitOperationRecorder {
  record(op: Omit<GitOperation, 'id' | 'createdAt'>): Promise<void>;
}

export interface MirrorLock {
  withLock<T>(
    projectId: Uuid,
    fn: () => Promise<T>,
    o?: { ttlMs?: number; waitMs?: number },
  ): Promise<T>;
}

export interface GitOpContext {
  projectId: Uuid;
  taskId?: Uuid | null;
  attemptId?: Uuid | null;
  correlationId?: string | null;
  signal?: AbortSignal;
}

export interface GitManagerDeps {
  logger: Logger;
  recorder: GitOperationRecorder;
  lock: MirrorLock;
  workerId: string;
  clock?: Clock;
  spawn?: SpawnFn;
  registry?: ProcessRegistry;
}

export interface SourceRepoInfo {
  absPath: string;
  isBare: boolean;
  defaultBranch: string;
  headSha: string;
}

export interface MirrorInfo {
  mirrorPath: string;
  branches: { name: string; sha: string }[];
  fetchedAt: IsoDateTime;
}

export interface WorktreeInfo {
  path: string;
  relPath: string;
  /** `<M>/worktrees/<id>`, resolved from the worker-owned mirror (§11.3); '' => re-resolved on use. */
  adminDir: string;
  branchName: string;
  baseSha: string;
  startSha: string;
  keyLength: 8 | 12 | 32;
}

export interface CollectedChanges {
  files: ChangedFileInput[];
  filesChanged: number;
  additions: number;
  deletions: number;
  truncatedFileList: boolean;
}

export type MergeCheckResult = MergeCheck;

export interface GitManager {
  /** Asserts >= 2.38 (merge-tree --write-tree). */
  version(): Promise<string>;
  /** §11.1 fixed dirs with §10.11 modes; asserts hooksDir exists, is empty and not writable by this process. */
  ensureRuntimeDirs(): Promise<void>;
  validateSource(repoPath: string, ctx: GitOpContext): Promise<SourceRepoInfo>;
  /** Under MirrorLock. */
  syncMirror(projectId: Uuid, repoPath: string, ctx: GitOpContext): Promise<MirrorInfo>;
  /** branch -> refs/remotes/origin/<ref>; sha -> verified commit; GitRefNotFoundError. */
  resolveBase(projectId: Uuid, ref: string, ctx: GitOpContext): Promise<string>;
  refreshBaseSnapshot(
    projectId: Uuid,
    sha: string,
    ctx: GitOpContext,
  ): Promise<{ path: string; sha: string }>;
  createAttemptWorktree(
    i: { projectId: Uuid; taskId: Uuid; attemptNumber: number; baseSha: string; startSha?: string },
    ctx: GitOpContext,
  ): Promise<WorktreeInfo>;
  isWorktreeUsable(
    i: { projectId: Uuid; relPath: string; branchName: string },
    ctx: GitOpContext,
  ): Promise<boolean>;
  /** lstat walk, no symlink follow, skips the '.git' file; only for unleased paths. */
  measureSize(absPath: string): Promise<{ bytes: number; entries: number; truncated: boolean }>;
  /** fs.statfs(workspacesRoot): bavail * bsize. */
  freeBytes(): Promise<number>;
  /** InsufficientDiskSpaceError. */
  assertCapacity(): Promise<void>;
  commitAll(
    wt: WorktreeInfo,
    message: string,
    ctx: GitOpContext,
  ): Promise<{ committed: boolean; headSha: string }>;
  /** base..HEAD, <= commitsMax. */
  collectCommits(wt: WorktreeInfo, ctx: GitOpContext): Promise<CommitInfo[]>;
  collectChanges(wt: WorktreeInfo, ctx: GitOpContext): Promise<CollectedChanges>;
  exportPatch(
    wt: WorktreeInfo,
    ctx: GitOpContext,
  ): Promise<{ gzip: Buffer | null; byteLength: number; sha256: Buffer; tooLarge: boolean }>;
  mergeCheck(
    i: { projectId: Uuid; baseBranch: string; headSha: string },
    ctx: GitOpContext,
  ): Promise<MergeCheckResult>;
  /** Idempotent; chmod -R u+rwX before the fs.rm fallback. */
  removeWorktree(i: { projectId: Uuid; relPath: string }, ctx: GitOpContext): Promise<void>;
  /** Idempotent. */
  deleteBranch(i: { projectId: Uuid; branchName: string }, ctx: GitOpContext): Promise<void>;
  gcMirror(projectId: Uuid, ctx: GitOpContext): Promise<void>;
}

/** Workspace lock lease (F7). renew false => lock lost (superseded). */
export interface WorkspaceLease {
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

export interface WorkspaceLock {
  tryAcquire(workspaceId: Uuid, ownerToken: string, ttlMs: number): Promise<WorkspaceLease | null>;
}

export interface RedisLike {
  set(...args: (string | number)[]): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}
