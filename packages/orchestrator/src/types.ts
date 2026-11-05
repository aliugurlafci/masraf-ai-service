// Public types of @orc/orchestrator (contract §2.11, §13).
import type { Redis } from 'ioredis';
import type { Job } from 'bullmq';
import type {
  Clock,
  FailureReason,
  IdGenerator,
  LogSource,
  LogStream,
  RunAttemptJobData,
  SettledTaskStatus,
  TaskStatus,
  TestResult,
  Uuid,
} from '@orc/shared';
import type {
  HostPlatform,
  LaunchLease,
  LeaseMeasurement,
  ProcessLauncher,
  ProcessRegistry,
  SpawnFn,
} from '@orc/shared/node';
import type { Database } from '@orc/database';
import type { GitManager, WorkspaceLock } from '@orc/git-manager';
import type { McpManager } from '@orc/mcp-manager';
import type { AbortReason, ClaudeRunner } from '@orc/claude-runner';
import type { QueueRegistry, TaskService, TaskStreamPublisher } from '@orc/task-manager';
import type { SecretRegistry } from '@orc/security';
import type { Logger } from '@orc/logger';

export type { AbortReason } from '@orc/claude-runner';

export interface RetentionConfig {
  logDays: number;
  gitOpsDays: number;
  mcpOpsDays: number;
  patchDays: number;
  batchSize: number;
}

export interface OrchestratorConfig {
  workerId: string;
  workspacesRoot: string;
  projectsRoot: string;
  claudeHomeRoot: string;
  heartbeatIntervalMs: number;
  quotaCheckEveryNthHeartbeat: number;
  attemptStaleMs: number;
  selfFenceAfterMs: number;
  maxAutoRecoveries: number;
  logFlushIntervalMs: number;
  logFlushBytes: number;
  logBufferMaxBytes: number;
  promptMaxBytes: number;
  claudeMdMaxBytes: number;
  mcpEnabled: boolean;
  /** MCP_REQUIRED: a rejected Claude MCP runtime directory fails the attempt closed (ADR-0037). */
  mcpRequired: boolean;
  testOutputMaxBytes: number;
  junitMaxBytes: number;
  testKillGraceMs: number;
  artifactCaptureTimeoutMs: number;
  workspaceRetentionHours: number;
  branchRetentionDays: number;
  retention: RetentionConfig;
  platform: HostPlatform;
  // ---- additive fields (worker settings the pipeline needs; §10.4, §10.8, §11.6, §13.1, §13.5, §16.3) ----
  /** CBM_CACHE_DIR: tool-policy deny roots and the attempt lease path `<CBM_CACHE_DIR>/w/<workspaceId>`. */
  cbmCacheRoot: string;
  /** CLAUDE_BIN: basename recorded in the local process registry (orphan verification). */
  claudeBin: string;
  /** Version reported by the CLI probe (ClaudeSessions.CliVersion, WorkerNodes.CliVersion). */
  cliVersion: string | null;
  /** REDIS_PREFIX: `<P>:worker:<workerId>:hb`. */
  redisPrefix: string;
  /** DB_WRITE_RETRY_WINDOW_MS (§13.1). */
  dbWriteRetryWindowMs: number;
  /** WORKSPACE_MAX_BYTES (`Projects.WorkspaceMaxBytes` may only lower it). */
  workspaceMaxBytes: number;
  /** WORKSPACE_SIZE_SCAN_MAX_ENTRIES. */
  sizeScanMaxEntries: number;
  /** JUNIT_MAX_CASES. */
  junitMaxCases: number;
  /** MCP_INDEX_TIMEOUT_MS (stale-attempt-recovery fails `running` MCP operations older than twice this, §6.5). */
  mcpIndexTimeoutMs: number;
}

export interface OrchestratorDeps {
  db: Database;
  git: GitManager;
  mcp: McpManager;
  claude: ClaudeRunner;
  tasks: TaskService;
  queues: QueueRegistry;
  publisher: TaskStreamPublisher;
  /** Local process registry (git, claude and test processes in SANDBOX_MODE=local). */
  registry: ProcessRegistry;
  launcher: ProcessLauncher;
  workspaceLock: WorkspaceLock;
  secrets: SecretRegistry;
  logger: Logger;
  clock?: Clock;
  ids?: IdGenerator;
  spawn?: SpawnFn;
  config: OrchestratorConfig;
  /** Command connection: heartbeat key checks (§6.4 step 3, §6.5 stale-attempt-recovery). */
  redisCommand?: Redis;
  /** The DB MCP recorder (records the indexed head into project_index results, §12.5). */
  mcpRecorder?: { setProjectHead(projectId: Uuid, headSha: string): void };
}

/** Hooks the heartbeat uses for an attempt (lock/lease renewal and quota measurement). */
export interface ActiveAttemptHooks {
  /** Renews the workspace lock and the runner lease; false => ownership lost (superseded, §13.9). */
  renew(): Promise<boolean>;
  /** Size of the worktree while it is leased (null when it cannot be measured now). */
  measure(): Promise<LeaseMeasurement | null>;
  quotaBytes(): number;
}

export interface ActiveAttempt {
  attemptId: Uuid;
  taskId: Uuid;
  stage: TaskStatus;
  startedAt: Date;
  controller: AbortController;
  workspacePath: string | null;
  hooks?: ActiveAttemptHooks;
}

export type SupersedeKind = 'superseded' | 'fenced';

export interface ActiveAttemptRegistry {
  register(a: ActiveAttempt): void;
  unregister(attemptId: Uuid): void;
  abort(attemptId: Uuid, reason: AbortReason): boolean;
  abortAll(reason: AbortReason): number;
  list(): readonly ActiveAttempt[];
  size(): number;
  // ---- additive (§13.1 self-fencing, §13.9 superseded) ----
  get(attemptId: Uuid): ActiveAttempt | undefined;
  /** Marks the attempt as no longer owned and aborts it with `worker_shutdown` semantics (no recovery, no DB writes). */
  supersede(attemptId: Uuid, kind: SupersedeKind): boolean;
  supersededKind(attemptId: Uuid): SupersedeKind | null;
  // ---- additive (§10.11 item 5: runner lost) ----
  /**
   * The runner dropped a process connection or lost the attempt's lease (runner restart/crash): aborts the attempt;
   * the pipeline then interrupts it as `worker_lost` (infra recovery, §5.2) instead of settling it. Ignored for a
   * superseded attempt. Returns false when the attempt is unknown.
   */
  markRunnerLost(attemptId: Uuid): boolean;
  runnerLost(attemptId: Uuid): boolean;
}

export type AttemptOutcome = {
  status: SettledTaskStatus | 'interrupted' | 'noop';
  reason: FailureReason | null;
};

export interface AttemptPipeline {
  run(job: RunAttemptJobData, signal: AbortSignal): Promise<AttemptOutcome>;
}

export interface AttemptLogSink {
  write(stream: LogStream, source: LogSource, text: string): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  /** Additive: drops everything buffered and stops writing (superseded/fenced attempts make no DB writes, §13.9). */
  discard(): void;
  readonly nextSeq: number;
  readonly droppedBytes: number;
}

export interface TestRunOutcome {
  status: 'passed' | 'failed' | 'error' | 'timed_out' | 'cancelled';
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  testRunId: Uuid;
  counts: { total: number; passed: number; failed: number; errored: number; skipped: number };
}

export interface TestRunner {
  run(i: {
    taskId: Uuid;
    attemptId: Uuid;
    cwd: string;
    tmpDir: string;
    command: readonly string[];
    timeoutMs: number;
    junitPath: string | null;
    lease: LaunchLease;
    signal: AbortSignal;
    sink: AttemptLogSink;
    /**
     * Called after the test process exited and before the worker reads the JUnit report (additive). In runner mode the
     * leased worktree belongs to the sandbox uid (0700), so the pipeline releases (reclaims) the lease here.
     */
    beforeReport?: () => Promise<void>;
  }): Promise<TestRunOutcome>;
}

export interface ParsedJUnit {
  cases: Omit<TestResult, 'id' | 'testRunId' | 'createdAt'>[];
  counts: TestRunOutcome['counts'];
  truncated: boolean;
}

export interface Heartbeat {
  start(): void;
  stop(): Promise<void>;
  tick(): Promise<void>;
  // ---- additive ----
  /** Consecutive failed DB heartbeats (3 => readiness fail, §14.3). */
  readonly consecutiveDbFailures: number;
  /** Disables the quota checks (graceful shutdown step 1). */
  disableQuotaChecks(): void;
}

export interface WorkerNodeInfo {
  appVersion: string;
  cliVersion: string | null;
  mcpVersion: string | null;
  startedAt: Date;
}

export type MaintenanceJob = Job<unknown>;
