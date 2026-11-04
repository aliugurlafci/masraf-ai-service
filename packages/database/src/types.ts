// Public types of @orc/database (contract §2.5).
import type sql from 'mssql';
import type {
  Agent,
  ApiToken,
  AttemptMode,
  AttemptStatus,
  AuditAction,
  AuditEntityType,
  AuditLog,
  AuditOutcome,
  BigId,
  ChangedFile,
  ChangedFileInput,
  ClaudeResultSummary,
  ClaudeSession,
  CommitInfo,
  Effort,
  FailureReason,
  GitOperation,
  IndexMode,
  IsoDateTime,
  LogStream,
  McpIndexOperation,
  McpOperationKind,
  McpOperationStatus,
  MergeCheck,
  Project,
  ProjectStatus,
  Role,
  Task,
  TaskAttempt,
  TaskEvent,
  TaskLog,
  TaskStatus,
  Team,
  TestCaseStatus,
  TestResult,
  TestRun,
  User,
  Uuid,
  WorkerNode,
  WorkerStatus,
  Workspace,
  WorkspaceKind,
  WorkspaceStatus,
} from '@orc/shared';

export type DatabaseAppName = 'orc-api' | 'orc-worker' | 'orc-db-cli' | 'orc-test';

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  /** PEM -> tedious cryptoCredentialsDetails.ca */
  caCert: string | null;
  poolMin: number;
  poolMax: number;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  appName: DatabaseAppName;
}

export type TxIsolationLevel = 'READ_COMMITTED' | 'REPEATABLE_READ' | 'SERIALIZABLE';

export interface TxOptions {
  name: string;
  isolationLevel?: TxIsolationLevel;
  /** default 3 */
  maxRetries?: number;
}

export interface TxContext {
  readonly repos: Repositories;
  readonly tx: sql.Transaction;
}

export interface Database {
  readonly pool: sql.ConnectionPool;
  /** autocommit, pool-bound */
  readonly repos: Repositories;
  /** BEGIN..COMMIT; on 1205/1222 rollback and re-run fn (exp. backoff 50ms*2^n + jitter 0-50ms, cap 2s). */
  transaction<T>(fn: (t: TxContext) => Promise<T>, opts: TxOptions): Promise<T>;
  /** SELECT 1, timeout 2s */
  ping(): Promise<void>;
  /** MAX(Version) FROM orc.SchemaMigrations */
  schemaVersion(): Promise<number>;
  close(): Promise<void>;
}

// ---- record types: shared DTO type + server-only fields ---------------------------------
export type UserRecord = User & { rowVer: string; passwordHash: string; failedLoginCount: number };
export type ProjectRecord = Project & { rowVer: string };
export type AgentRecord = Agent & { rowVer: string };
export type TeamRecord = Team & { rowVer: string };
export type TaskRecord = Task & { rowVer: string };
export type AttemptRecord = TaskAttempt & { rowVer: string };

export interface AuthSessionRecord {
  id: Uuid;
  userId: Uuid;
  csrfToken: string;
  createdAt: Date;
  expiresAt: Date;
  idleExpiresAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
  ip: string | null;
  userAgent: string | null;
}

export interface ApiTokenRecord extends ApiToken {
  userId: Uuid;
}

export interface IdempotencyRecord {
  id: BigId;
  userId: Uuid;
  scope: string;
  keyValue: string;
  requestHash: Buffer;
  status: 'in_progress' | 'completed';
  responseStatus: number | null;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
  resourceId: string | null;
  lockedUntil: Date;
  expiresAt: Date;
}

export type Actor =
  | { type: 'user'; userId: Uuid; label: string }
  | { type: 'token'; userId: Uuid; tokenId: Uuid; label: string }
  | { type: 'worker'; workerId: string }
  | { type: 'system'; label: string };

export interface AuditContext {
  requestId?: string | null;
  correlationId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** descending lists */
export interface Keyset {
  createdAt: IsoDateTime;
  id: string;
}

/** repos return up to limit+1 rows; caller derives nextCursor */
export interface ListOpts {
  limit: number;
  after?: Keyset;
}

export interface Repositories {
  users: UserRepository;
  authSessions: AuthSessionRepository;
  apiTokens: ApiTokenRepository;
  idempotency: IdempotencyRepository;
  projects: ProjectRepository;
  agents: AgentRepository;
  teams: TeamRepository;
  tasks: TaskRepository;
  attempts: AttemptRepository;
  taskState: TaskStateStore;
  taskLogs: TaskLogRepository;
  taskEvents: TaskEventRepository;
  claudeSessions: ClaudeSessionRepository;
  workspaces: WorkspaceRepository;
  changedFiles: ChangedFileRepository;
  patches: AttemptPatchRepository;
  testRuns: TestRunRepository;
  gitOperations: GitOperationRepository;
  mcpOperations: McpIndexOperationRepository;
  audit: AuditLogRepository;
  workerNodes: WorkerNodeRepository;
}

export interface UserRepository {
  findById(id: Uuid): Promise<UserRecord | null>;
  findByUsername(usernameLower: string): Promise<UserRecord | null>;
  list(o: ListOpts): Promise<UserRecord[]>;
  insert(u: {
    username: string;
    displayName: string;
    email: string | null;
    role: Role;
    passwordHash: string;
  }): Promise<UserRecord>;
  /** PreconditionFailedError on RowVer mismatch */
  update(
    id: Uuid,
    expectedRowVer: string,
    patch: Partial<Pick<User, 'displayName' | 'email' | 'role' | 'isActive'>> & {
      passwordHash?: string;
    },
  ): Promise<UserRecord>;
  /** FailedLoginCount += 1 */
  recordLoginFailure(id: Uuid, lockedUntil: Date | null): Promise<void>;
  /** count=0, LockedUntil=NULL, LastLoginAt=SYSUTCDATETIME() */
  recordLoginSuccess(id: Uuid): Promise<void>;
  unlock(id: Uuid): Promise<void>;
  countActiveAdmins(): Promise<number>;
}

export interface AuthSessionRepository {
  /** T-M3: ExpiresAt = DATEADD(SECOND, @absoluteTtl, SYSUTCDATETIME()); IdleExpiresAt = the smaller of
   *  DATEADD(SECOND, @idleTtl, SYSUTCDATETIME()) and ExpiresAt. DB time only. */
  insert(s: {
    userId: Uuid;
    tokenHash: Buffer;
    csrfToken: string;
    absoluteTtlSeconds: number;
    idleTtlSeconds: number;
    ip: string | null;
    userAgent: string | null;
  }): Promise<AuthSessionRecord>;
  /** not revoked, not expired (DB time), user active */
  findActiveByTokenHash(hash: Buffer): Promise<{ session: AuthSessionRecord; user: UserRecord } | null>;
  /** IdleExpiresAt capped at ExpiresAt; LastSeenAt = SYSUTCDATETIME(); WHERE RevokedAt IS NULL. */
  touch(id: Uuid, idleTtlSeconds: number): Promise<void>;
  revoke(id: Uuid, reason: string): Promise<void>;
  revokeAllForUser(userId: Uuid, reason: string, exceptSessionId?: Uuid): Promise<number>;
  deleteExpired(before: Date, batchSize: number): Promise<number>;
}

export interface ApiTokenRepository {
  insert(t: {
    userId: Uuid;
    name: string;
    prefix: string;
    tokenHash: Buffer;
    readOnly: boolean;
    expiresAt: Date;
  }): Promise<ApiTokenRecord>;
  findActiveByHash(hash: Buffer): Promise<{ token: ApiTokenRecord; user: UserRecord } | null>;
  listByUser(userId: Uuid): Promise<ApiTokenRecord[]>;
  revoke(id: Uuid, userId: Uuid): Promise<boolean>;
  revokeAllForUser(userId: Uuid): Promise<number>;
  /** callers throttle to 1/min/token */
  touchLastUsed(id: Uuid): Promise<void>;
}

export interface IdempotencyRepository {
  tryBegin(i: {
    userId: Uuid;
    scope: string;
    keyValue: string;
    requestHash: Buffer;
    lockSeconds: number;
    ttlSeconds: number;
  }): Promise<{ kind: 'started'; id: BigId } | { kind: 'existing'; record: IdempotencyRecord }>;
  /** only when LockedUntil < SYSUTCDATETIME() */
  takeOver(id: BigId, lockSeconds: number): Promise<boolean>;
  complete(
    id: BigId,
    r: { status: number; headers: Record<string, string>; body: string; resourceId: string | null },
  ): Promise<void>;
  /** DELETE (5xx path) */
  release(id: BigId): Promise<void>;
  deleteExpired(before: Date, batchSize: number): Promise<number>;
}

export type NewProject = Pick<
  Project,
  | 'name'
  | 'description'
  | 'repoPath'
  | 'testCommand'
  | 'testTimeoutSeconds'
  | 'junitReportPath'
  | 'requireIndex'
  | 'autoIndex'
  | 'indexMode'
  | 'defaultAgentId'
  | 'defaultTimeoutSeconds'
  | 'workspaceMaxBytes'
  | 'createdByUserId'
> & { defaultBranch: string | null };

export type ProjectPatch = Partial<Omit<NewProject, 'repoPath' | 'createdByUserId'>> & {
  archived?: boolean;
};

export interface ProjectRepository {
  findById(id: Uuid): Promise<ProjectRecord | null>;
  list(o: ListOpts & { status?: ProjectStatus }): Promise<ProjectRecord[]>;
  /** Status 'validating' */
  insert(p: NewProject): Promise<ProjectRecord>;
  update(id: Uuid, expectedRowVer: string, patch: ProjectPatch): Promise<ProjectRecord>;
  /** worker */
  updateSyncState(
    id: Uuid,
    s: {
      status: ProjectStatus;
      statusDetail: string | null;
      defaultBranch?: string;
      headSha?: string;
      synced: boolean;
    },
  ): Promise<void>;
  /** worker */
  updateIndexState(id: Uuid, s: { lastIndexOperationId: Uuid; indexedAt: boolean }): Promise<void>;
}

export type AgentInput = Omit<Agent, 'id' | 'createdAt' | 'updatedAt'>;

export interface AgentRepository {
  findById(id: Uuid): Promise<AgentRecord | null>;
  list(f: { teamId?: Uuid; activeOnly?: boolean }): Promise<AgentRecord[]>;
  insert(a: AgentInput): Promise<AgentRecord>;
  update(id: Uuid, expectedRowVer: string, patch: Partial<AgentInput>): Promise<AgentRecord>;
}

export type TeamInput = Omit<Team, 'id' | 'createdAt' | 'updatedAt'>;

export interface TeamRepository {
  findById(id: Uuid): Promise<TeamRecord | null>;
  list(): Promise<TeamRecord[]>;
  insert(t: TeamInput): Promise<TeamRecord>;
  update(id: Uuid, expectedRowVer: string, patch: Partial<TeamInput>): Promise<TeamRecord>;
}

export interface TaskListFilter {
  ownerUserId?: Uuid;
  projectId?: Uuid;
  statuses?: readonly TaskStatus[];
}

export interface TaskRepository {
  findById(id: Uuid): Promise<TaskRecord | null>;
  /** Returns null when the task does not exist OR viewer may not read it (ownership enforced in SQL). */
  findVisible(id: Uuid, viewer: { userId: Uuid; canReadAny: boolean }): Promise<TaskRecord | null>;
  list(o: ListOpts & TaskListFilter): Promise<TaskRecord[]>;
  findCancelRequested(ids: readonly Uuid[]): Promise<{ id: Uuid; cancelRequestedAt: Date }[]>;
  /** Tasks with Status='queued' whose current attempt is 'queued' and QueuedAt < SYSUTCDATETIME()-minAgeMs. */
  findQueuedForReconcile(
    minAgeMs: number,
    limit: number,
  ): Promise<{ taskId: Uuid; attemptId: Uuid; attemptNumber: number; correlationId: string | null }[]>;
}

export interface AttemptRepository {
  findById(id: Uuid): Promise<AttemptRecord | null>;
  /** AttemptNumber ASC */
  listByTask(taskId: Uuid): Promise<AttemptRecord[]>;
  /** ProcessStartedAt = SYSUTCDATETIME() */
  setProcess(id: Uuid, p: { pid: number; pgid: number | null; workerId: string }): Promise<void>;
  setProcessExit(id: Uuid, p: { exitCode: number | null; exitSignal: string | null }): Promise<void>;
  /** Returns ids still owned; any id missing from the result is SUPERSEDED (§13.9). */
  heartbeat(ids: readonly Uuid[], workerId: string): Promise<Uuid[]>;
  setWorkspace(id: Uuid, w: { workspaceId: Uuid; branchName: string; baseSha: string }): Promise<void>;
  setReview(
    id: Uuid,
    r: {
      headSha: string;
      filesChanged: number;
      additions: number;
      deletions: number;
      commits: CommitInfo[];
      mergeCheck: MergeCheck | null;
    },
  ): Promise<void>;
  /** Status='active' AND LastHeartbeatAt < SYSUTCDATETIME()-staleMs */
  findStaleActive(staleMs: number, limit: number): Promise<AttemptRecord[]>;
  findActiveByWorker(workerId: string): Promise<AttemptRecord[]>;
}

export interface NewTaskInput {
  projectId: Uuid;
  agentId: Uuid;
  createdByUserId: Uuid;
  title: string;
  prompt: string;
  acceptanceCriteria: string | null;
  scope: string | null;
  baseRef: string | null;
  model: string;
  effort: Effort | null;
  timeoutSeconds: number;
  maxBudgetUsd: number | null;
  correlationId: string;
}

/** All mutating task-status operations. Each method = ONE transaction. */
export interface TaskStateStore {
  createTask(i: {
    task: NewTaskInput;
    actor: Actor;
    audit: AuditContext;
    idempotency?: {
      id: BigId;
      responseFactory: (
        task: TaskRecord,
        attempt: AttemptRecord,
      ) => { status: number; headers: Record<string, string>; body: string };
    };
  }): Promise<{ task: TaskRecord; attempt: AttemptRecord }>;
  /** ConflictError | PreconditionFailedError | InvalidTransitionError */
  transition(i: TransitionInput): Promise<TaskRecord>;
  claimAttempt(i: {
    attemptId: Uuid;
    workerId: string;
    actor: Actor;
  }): Promise<{ task: TaskRecord; attempt: AttemptRecord } | null>;
  /** settled(retry) or active(infra recovery) -> queued with a NEW attempt. */
  createAttempt(i: CreateAttemptInput): Promise<{ task: TaskRecord; attempt: AttemptRecord }>;
  /** created|queued -> cancelled (task + attempt) in one tx. */
  cancelPending(i: {
    taskId: Uuid;
    from: 'created' | 'queued';
    actor: Actor;
    audit: AuditContext;
    reasonText: string | null;
  }): Promise<TaskRecord>;
  /** Active states: sets CancelRequestedAt/By if NULL, inserts cancel_requested event + audit. Idempotent. */
  requestCancel(i: {
    taskId: Uuid;
    actor: Actor;
    audit: AuditContext;
    reasonText: string | null;
  }): Promise<TaskRecord>;
}

export interface CreateAttemptInput {
  taskId: Uuid;
  from: TaskStatus;
  expectedRowVer?: string;
  trigger: 'user_retry' | 'infra_recovery';
  mode: AttemptMode;
  previousAttemptId: Uuid;
  /** set only for infra_recovery */
  previousAttemptFinalStatus?: 'interrupted';
  interruptionReason?: 'worker_shutdown' | 'worker_lost';
  workspaceId: Uuid | null;
  baseRefOverride?: string | null;
  additionalInstructions: string | null;
  actor: Actor;
  audit: AuditContext;
  correlationId: string | null;
}

export interface TransitionInput {
  taskId: Uuid;
  from: TaskStatus;
  to: TaskStatus;
  expectedRowVer?: string;
  attemptId: Uuid | null;
  /** updates TaskAttempts.Status/Stage/EndedAt atomically */
  attemptStatus?: AttemptStatus;
  reason?: FailureReason | null;
  /** detail <= 2000 chars, masked */
  detail?: string | null;
  actor: Actor;
  audit?: AuditContext;
  correlationId: string | null;
  data?: Record<string, unknown>;
}

export type NewTaskLog = Pick<
  TaskLog,
  'taskId' | 'attemptId' | 'seq' | 'stream' | 'source' | 'content' | 'byteLength'
>;

export interface TaskLogRepository {
  /** Multi-row INSERT, <= 200 rows/statement, inside one tx. Violating UNIQUE(AttemptId,Seq) => 'unique_violation'. */
  appendBatch(rows: readonly NewTaskLog[]): Promise<void>;
  /** Seq ASC */
  listByAttempt(q: {
    attemptId: Uuid;
    stream?: LogStream;
    afterSeq?: number;
    limit: number;
  }): Promise<TaskLog[]>;
  /** Id ASC */
  listByTaskAfterId(q: { taskId: Uuid; afterId: BigId | null; limit: number }): Promise<TaskLog[]>;
  deleteOlderThan(before: Date, batchSize: number): Promise<number>;
}

export interface TaskEventRepository {
  insert(e: Omit<TaskEvent, 'id' | 'createdAt'>): Promise<TaskEvent>;
  /** Id ASC */
  listByTask(q: { taskId: Uuid; afterId?: BigId; limit: number }): Promise<TaskEvent[]>;
}

export interface ClaudeSessionRepository {
  /** T-M5: MERGE on AttemptId (insert, or reset + RunCount += 1). Only caller: the runner onSpawn handler. */
  start(s: {
    attemptId: Uuid;
    taskId: Uuid;
    sessionId: string | null;
    resumedFromSessionId: string | null;
    model: string;
    cliVersion: string;
    permissionMode: string;
  }): Promise<void>;
  recordInit(
    attemptId: Uuid,
    i: {
      sessionId: string;
      model: string;
      tools: string[];
      mcpServers: { name: string; status: string }[];
      apiKeySource: string | null;
      cliVersion: string | null;
    },
  ): Promise<void>;
  recordResult(attemptId: Uuid, r: ClaudeResultSummary): Promise<void>;
  findByAttempt(attemptId: Uuid): Promise<ClaudeSession | null>;
  findLatestWithSessionId(taskId: Uuid): Promise<ClaudeSession | null>;
}

export interface WorkspaceRepository {
  insert(w: {
    projectId: Uuid;
    taskId: Uuid | null;
    kind: WorkspaceKind;
    createdByAttemptId: Uuid | null;
    path: string;
    branchName: string | null;
    baseSha: string | null;
    quotaBytes: number;
    workerId: string;
  }): Promise<Workspace>;
  findById(id: Uuid): Promise<Workspace | null>;
  findBase(projectId: Uuid): Promise<Workspace | null>;
  setStatus(
    id: Uuid,
    status: WorkspaceStatus,
    patch?: { headSha?: string; retainUntil?: Date | null; errorDetail?: string | null },
  ): Promise<void>;
  recordSize(id: Uuid, sizeBytes: number): Promise<void>;
  /** kind 'attempt', status IN ('ready','retained','error'), RetainUntil < now, no active attempt uses it */
  findForCleanup(limit: number): Promise<Workspace[]>;
  /** status 'removed', BranchDeletedAt NULL, task settled > retentionDays */
  findBranchesForDeletion(retentionDays: number, limit: number): Promise<Workspace[]>;
  markBranchDeleted(id: Uuid): Promise<void>;
}

export type NewChangedFile = ChangedFileInput;

export interface ChangedFileRepository {
  /** DELETE + batched INSERT in one tx */
  replaceForAttempt(attemptId: Uuid, taskId: Uuid, files: readonly NewChangedFile[]): Promise<void>;
  listByAttempt(q: {
    attemptId: Uuid;
    includePatch: boolean;
    afterId?: BigId;
    limit: number;
  }): Promise<(ChangedFile & { patch?: string | null })[]>;
  /** F12: Patch = NULL, PatchPurgedAt = SYSUTCDATETIME() for rows of tasks settled before `before`. */
  purgePatchesOlderThan(before: Date, batchSize: number): Promise<number>;
}

export interface AttemptPatchRepository {
  upsert(p: {
    attemptId: Uuid;
    byteLength: number;
    sha256: Buffer;
    /** gzip */
    content: Buffer | null;
    tooLarge: boolean;
  }): Promise<void>;
  getMeta(attemptId: Uuid): Promise<{
    byteLength: number;
    sha256: string;
    tooLarge: boolean;
    purged: boolean;
    createdAt: IsoDateTime;
  } | null>;
  /** gzip bytes; null when tooLarge or purged */
  getContent(attemptId: Uuid): Promise<Buffer | null>;
  /** F12: ContentGzip = NULL, PurgedAt = SYSUTCDATETIME() */
  purgeOlderThan(before: Date, batchSize: number): Promise<number>;
}

export type TestRunFinish = Pick<
  TestRun,
  | 'status'
  | 'exitCode'
  | 'signal'
  | 'durationMs'
  | 'total'
  | 'passed'
  | 'failed'
  | 'errored'
  | 'skipped'
  | 'reportParsed'
  | 'reportError'
>;

export type NewTestResult = Omit<TestResult, 'id' | 'testRunId' | 'createdAt'>;

export interface TestRunRepository {
  start(r: { attemptId: Uuid; taskId: Uuid; command: string[]; junitPath: string | null }): Promise<TestRun>;
  finish(id: Uuid, r: TestRunFinish): Promise<void>;
  /** batched, <= 5000 rows kept */
  insertResults(testRunId: Uuid, rows: readonly NewTestResult[]): Promise<void>;
  listByAttempt(attemptId: Uuid): Promise<TestRun[]>;
  listResults(q: {
    testRunId: Uuid;
    status?: TestCaseStatus;
    afterId?: BigId;
    limit: number;
  }): Promise<TestResult[]>;
}

export interface GitOperationRepository {
  insert(o: Omit<GitOperation, 'id' | 'createdAt'>): Promise<void>;
  listByAttempt(attemptId: Uuid, limit: number): Promise<GitOperation[]>;
  deleteOlderThan(before: Date, batchSize: number): Promise<number>;
}

export interface McpViewer {
  userId: Uuid;
  canReadAny: boolean;
}

export interface McpIndexOperationRepository {
  /** unique_violation => index_in_progress */
  insert(o: {
    projectId: Uuid;
    taskId: Uuid | null;
    attemptId: Uuid | null;
    workspaceId: Uuid | null;
    kind: McpOperationKind;
    indexName: string;
    mode: IndexMode | null;
    status: 'queued' | 'running';
    requestedByUserId: Uuid | null;
    workerId: string | null;
  }): Promise<McpIndexOperation>;
  /** only from 'queued' */
  markRunning(id: Uuid, workerId: string): Promise<boolean>;
  finish(
    id: Uuid,
    r: {
      status: 'succeeded' | 'failed' | 'skipped';
      nodeCount: number | null;
      edgeCount: number | null;
      result: unknown;
      errorCode: string | null;
      errorMessage: string | null;
      durationMs: number;
    },
  ): Promise<void>;
  findById(id: Uuid): Promise<McpIndexOperation | null>;
  findActiveProjectOp(projectId: Uuid): Promise<McpIndexOperation | null>;
  findLatest(q: {
    projectId: Uuid;
    kind: McpOperationKind;
    status?: McpOperationStatus;
    attemptId?: Uuid;
  }): Promise<McpIndexOperation | null>;
  /** F3: viewer.canReadAny=false => kinds project_index | index_delete plus task-scoped rows of own tasks. */
  listByProject(q: { projectId: Uuid; viewer: McpViewer } & ListOpts): Promise<McpIndexOperation[]>;
  /** same visibility, CreatedAt DESC (GET /system/mcp) */
  findRecent(q: { limit: number; viewer: McpViewer }): Promise<McpIndexOperation[]>;
  /** 'running' with UpdatedAt older than staleMs -> failed('mcp_timeout') */
  failStaleRunning(staleMs: number): Promise<number>;
  /** never deletes the latest succeeded project_index per project */
  deleteOlderThan(before: Date, batchSize: number): Promise<number>;
}

export type AuditInsert = {
  action: AuditAction;
  actor: Actor;
  entityType: AuditEntityType;
  entityId: string | null;
  outcome: AuditOutcome;
  before?: unknown;
  after?: unknown;
  detail?: unknown;
} & AuditContext;

export interface AuditLogRepository {
  /** Masks before/after/detail with maskObject before INSERT. */
  insert(a: AuditInsert): Promise<void>;
  list(
    q: ListOpts & {
      actorUserId?: Uuid;
      action?: AuditAction;
      entityType?: AuditEntityType;
      entityId?: string;
      from?: Date;
      to?: Date;
    },
  ): Promise<AuditLog[]>;
}

export interface WorkerNodeRepository {
  /** LastHeartbeatAt = SYSUTCDATETIME() */
  upsertHeartbeat(h: {
    id: string;
    hostname: string;
    pid: number;
    appVersion: string;
    cliVersion: string | null;
    mcpVersion: string | null;
    concurrency: number;
    activeJobs: number;
    status: WorkerStatus;
    diskFreeBytes: number | null;
    startedAt: Date;
  }): Promise<void>;
  setStatus(id: string, status: WorkerStatus): Promise<void>;
  list(): Promise<WorkerNode[]>;
  markStaleOffline(staleMs: number): Promise<number>;
  deleteOfflineOlderThan(before: Date): Promise<number>;
}

// ---- migrations ------------------------------------------------------------------------------
export interface MigrationFile {
  version: number;
  name: string;
  file: string;
  sql: string;
  /** sha256 hex of file bytes with CRLF->LF */
  checksum: string;
}

export interface MigrationReport {
  applied: number[];
  skipped: number[];
  durationMs: number;
}
