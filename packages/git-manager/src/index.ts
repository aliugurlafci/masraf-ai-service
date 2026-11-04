// @orc/git-manager — public API (contract §2.6, §11).
export type {
  CollectedChanges,
  GitManager,
  GitManagerConfig,
  GitManagerDeps,
  GitOpContext,
  GitOperationRecorder,
  MergeCheckResult,
  MirrorInfo,
  MirrorLock,
  RedisLike,
  SourceRepoInfo,
  WorkspaceLease,
  WorkspaceLock,
  WorktreeInfo,
} from './types';
export { createGitManager } from './manager';
export { createRedisMirrorLock, createRedisWorkspaceLock } from './locks';
export { branchNameFor, sanitizeGitArgs, worktreeRelPath } from './naming';
export {
  GitError,
  GitRefNotFoundError,
  GitRepoInvalidError,
  GitTimeoutError,
  InsufficientDiskSpaceError,
  WorkspaceQuotaError,
} from './errors';
