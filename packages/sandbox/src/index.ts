// @orc/sandbox — execution sandbox (contract §10.11, ADR-0024): runner protocol (Zod NDJSON v1),
// runner client (worker, SANDBOX_MODE=runner), runner server + lease manager (apps/runner) and the
// local launcher (SANDBOX_MODE=local).

export * from './protocol';
export type { RunnerErrorReason } from './errors';
export { runnerError, toErrorFrame, fromErrorFrame } from './errors';
export { FrameDecoder, encodeFrame, parseFrame } from './framing';
export type { EffectiveLimits, ResolveLeasePathsDeps } from './validation';
export {
  MCP_ENV_KEYS,
  MCP_ONLY_ENV_KEYS,
  PROBE_DIR_NAME,
  CLAUDE_ONLY_ENV_KEYS,
  allowedEnvKeys,
  validateSpawnEnv,
  validateSpawnEnvPaths,
  validateSpawnArgv,
  validateLeaseKey,
  isPathInside,
  pathsOverlap,
  resolveLeasePaths,
  resolveInLease,
  effectiveLimits,
  buildPrlimitCommand,
} from './validation';
export type { WalkFs, WalkStats, OwnershipWalkOptions } from './fs-walk';
export { nodeWalkFs, handoffMode, reclaimMode, chownTree, measureTree } from './fs-walk';
export type { ProcessTable, KillSignal, ProcfsTableOptions, KillUidOptions } from './proc-scan';
export { parseProcStatus, createProcfsTable, killUidProcesses } from './proc-scan';
export type { LeaseState, LeaseStateStore, StoredLeaseState } from './state-store';
export {
  LeaseStateSchema,
  createFileLeaseStateStore,
  createMemoryLeaseStateStore,
} from './state-store';
export type {
  IdentityMode,
  LaunchProcessOptions,
  LaunchProcessFn,
  ReleaseResult,
  AcquireInput,
  SpawnInput,
  LeaseManagerOptions,
  RecoveryReport,
  LeaseManager,
} from './lease-manager';
export { spawnAs, createDefaultLaunch, createLeaseManager } from './lease-manager';
export type { SocketFsOps, RunnerServerOptions, RunnerServer } from './server';
export { createRunnerServer } from './server';
export type {
  ReleaseOutcome,
  SandboxLauncher,
  RunnerClient,
  RunnerDisconnectInfo,
  RunnerClientOptions,
} from './client';
export { createRunnerClient, isRunnerDisconnected } from './client';
export type { LocalLauncherOptions, LocalLauncher } from './local';
export { createLocalLauncher } from './local';
export type { DetectCapsOptions, DetectedCaps } from './caps';
export { DEFAULT_PRLIMIT_CANDIDATES, parseCapEff, hasCap, detectRunnerCaps } from './caps';
export type {
  AnchorDirStats,
  AnchorDirHandle,
  AnchorFs,
  CbmAnchorOptions,
  CbmAnchorResult,
} from './cbm-anchor';
export {
  CBM_ANCHOR_MODE,
  CBM_ANCHOR_SUBDIRS,
  nodeAnchorFs,
  anchorCbmCacheDirs,
} from './cbm-anchor';
