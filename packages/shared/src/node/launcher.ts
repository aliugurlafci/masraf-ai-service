// Process launcher abstraction for untrusted processes (contract §10.11). Types only: the
// implementations live in @orc/sandbox (`createRunnerClient` for SANDBOX_MODE=runner,
// `createLocalLauncher` for development/test hosts).
import type { IsoDateTime, Uuid } from '../primitives';
import type { KillResult, SupervisedProcess } from './process';

/** What is being launched; the runner applies per-kind env rules (ANTHROPIC_API_KEY only for `claude`). */
export type LaunchKind = 'claude' | 'test' | 'mcp';

/** Per-process rlimits applied by the runner (`prlimit`); omitted values use the runner defaults. */
export interface LaunchLimits {
  nproc?: number;
  nofile?: number;
  fsizeBytes?: number;
}

export interface LaunchLeaseRequest {
  /** `attempt-<attemptId>` or `op-<operationId>`; at most one live lease per key. */
  key: string;
  attemptId: Uuid | null;
  workerId: string;
  /**
   * Absolute paths handed to the lease's sandbox uid for its lifetime (worktree, `.meta` dir,
   * per-workspace Claude home, per-scope cbm cache dir). Each must lie inside WORKSPACES_ROOT,
   * CLAUDE_HOME_ROOT or CBM_CACHE_DIR and must not overlap a path of another live lease.
   */
  paths: readonly string[];
}

export interface LeaseMeasurement {
  bytes: number;
  entries: number;
  truncated: boolean;
}

export interface LaunchLease {
  readonly id: string;
  readonly key: string;
  /** Sandbox uid in runner mode; null in local mode. */
  readonly uid: number | null;
  /** Extends the lease TTL (called on every worker heartbeat). Rejects when the lease expired. */
  renew(): Promise<void>;
  /** lstat walk (no symlink follow) of a leased path, bounded by `maxEntries`. */
  measure(path: string, maxEntries: number): Promise<LeaseMeasurement>;
  /**
   * Kills every remaining process of the lease (uid-wide in runner mode), returns ownership of the
   * leased paths to the worker uid and normalizes modes (u+rwX). Idempotent.
   */
  release(): Promise<{ kill: KillResult; reclaimed: boolean }>;
}

export interface LaunchSpec {
  kind: LaunchKind;
  cmd: string;
  args: readonly string[];
  /** Must lie inside one of the lease's paths. */
  cwd: string;
  /** Final child environment (already allowlisted by the caller; re-checked by the runner). */
  env: Record<string, string>;
  limits?: LaunchLimits;
}

export interface LeaseInfo {
  id: string;
  key: string;
  attemptId: Uuid | null;
  workerId: string;
  uid: number | null;
  pids: number[];
  expiresAt: IsoDateTime;
}

export interface ProcessLauncher {
  readonly mode: 'local' | 'runner';
  acquire(request: LaunchLeaseRequest): Promise<LaunchLease>;
  spawn(lease: LaunchLease, spec: LaunchSpec): Promise<SupervisedProcess>;
  /** Live leases (startup recovery and orphan sweep release those not owned by an active attempt). */
  listLeases(): Promise<LeaseInfo[]>;
  close(): Promise<void>;
}
