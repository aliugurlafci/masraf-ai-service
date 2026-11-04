// Row -> record mappers. GUIDs are lower-cased, DATETIME2 -> ISO strings in DTOs, ROWVERSION -> base64url.
import { z } from 'zod';
import {
  ACTIVE_TASK_STATUSES,
  ACTOR_TYPES,
  ATTEMPT_MODES,
  ATTEMPT_STATUSES,
  ATTEMPT_TRIGGERS,
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  AUDIT_OUTCOMES,
  CHANGE_TYPES,
  CLAUDE_SESSION_STATUSES,
  CommitInfoSchema,
  EFFORT_LEVELS,
  FAILURE_REASONS,
  GIT_OPERATION_KINDS,
  INDEX_MODES,
  LOG_SOURCES,
  LOG_STREAMS,
  MCP_OPERATION_KINDS,
  MCP_OPERATION_STATUSES,
  MergeCheckSchema,
  PROJECT_STATUSES,
  ROLES,
  TASK_EVENT_TYPES,
  TASK_STATUSES,
  TEST_CASE_STATUSES,
  TEST_RUN_STATUSES,
  WORKER_STATUSES,
  WORKSPACE_KINDS,
  WORKSPACE_STATUSES,
} from '@orc/shared';
import type {
  AuditLog,
  ChangedFile,
  ClaudeSession,
  GitOperation,
  McpIndexOperation,
  TaskEvent,
  TaskLog,
  TestResult,
  TestRun,
  WorkerNode,
  Workspace,
} from '@orc/shared';
import {
  bigId,
  bigNum,
  bool,
  buf,
  date,
  guid,
  int,
  iso,
  json,
  jsonAs,
  nbigNum,
  nbool,
  ndate,
  nguid,
  nint,
  niso,
  nnum,
  noneOf,
  nstr,
  oneOf,
  rowVer,
  str,
} from '../sql.js';
import type { Row } from '../sql.js';
import type {
  AgentRecord,
  ApiTokenRecord,
  AttemptRecord,
  AuthSessionRecord,
  IdempotencyRecord,
  ProjectRecord,
  TaskRecord,
  TeamRecord,
  UserRecord,
} from '../types.js';

const stringArray = (v: unknown): string[] => z.array(z.string()).parse(v);
const stringRecord = (v: unknown): Record<string, string> => z.record(z.string(), z.string()).parse(v);
const objectRecord = (v: unknown): Record<string, unknown> => z.record(z.string(), z.unknown()).parse(v);
const mcpServers = (v: unknown): { name: string; status: string }[] =>
  z.array(z.object({ name: z.string(), status: z.string() })).parse(v);
const unknownArray = (v: unknown): unknown[] => z.array(z.unknown()).parse(v);

/** Column list for a user joined under alias `u` with the `U_` prefix (constant text). */
export const USER_JOIN_COLUMNS =
  'u.Id AS U_Id, u.Username AS U_Username, u.DisplayName AS U_DisplayName, u.Email AS U_Email, u.Role AS U_Role, ' +
  'u.PasswordHash AS U_PasswordHash, u.IsActive AS U_IsActive, u.FailedLoginCount AS U_FailedLoginCount, ' +
  'u.LockedUntil AS U_LockedUntil, u.LastLoginAt AS U_LastLoginAt, u.CreatedAt AS U_CreatedAt, ' +
  'u.UpdatedAt AS U_UpdatedAt, u.RowVer AS U_RowVer';

export function mapUser(r: Row, p: '' | 'U_' = ''): UserRecord {
  return {
    id: guid(r, `${p}Id`),
    username: str(r, `${p}Username`),
    displayName: str(r, `${p}DisplayName`),
    email: nstr(r, `${p}Email`),
    role: oneOf(ROLES, r, `${p}Role`),
    isActive: bool(r, `${p}IsActive`),
    lockedUntil: niso(r, `${p}LockedUntil`),
    lastLoginAt: niso(r, `${p}LastLoginAt`),
    createdAt: iso(r, `${p}CreatedAt`),
    updatedAt: iso(r, `${p}UpdatedAt`),
    rowVer: rowVer(r, `${p}RowVer`),
    passwordHash: str(r, `${p}PasswordHash`),
    failedLoginCount: int(r, `${p}FailedLoginCount`),
  };
}

export function mapAuthSession(r: Row): AuthSessionRecord {
  return {
    id: guid(r, 'Id'),
    userId: guid(r, 'UserId'),
    csrfToken: str(r, 'CsrfToken'),
    createdAt: date(r, 'CreatedAt'),
    expiresAt: date(r, 'ExpiresAt'),
    idleExpiresAt: date(r, 'IdleExpiresAt'),
    lastSeenAt: date(r, 'LastSeenAt'),
    revokedAt: ndate(r, 'RevokedAt'),
    ip: nstr(r, 'Ip'),
    userAgent: nstr(r, 'UserAgent'),
  };
}

export function mapApiToken(r: Row): ApiTokenRecord {
  return {
    id: guid(r, 'Id'),
    userId: guid(r, 'UserId'),
    name: str(r, 'Name'),
    prefix: str(r, 'Prefix'),
    readOnly: bool(r, 'ReadOnly'),
    expiresAt: iso(r, 'ExpiresAt'),
    lastUsedAt: niso(r, 'LastUsedAt'),
    revokedAt: niso(r, 'RevokedAt'),
    createdAt: iso(r, 'CreatedAt'),
  };
}

export function mapIdempotency(r: Row): IdempotencyRecord {
  return {
    id: bigId(r, 'Id'),
    userId: guid(r, 'UserId'),
    scope: str(r, 'Scope'),
    keyValue: str(r, 'KeyValue'),
    requestHash: buf(r, 'RequestHash'),
    status: oneOf(['in_progress', 'completed'] as const, r, 'Status'),
    responseStatus: nint(r, 'ResponseStatus'),
    responseHeaders: jsonAs(r, 'ResponseHeadersJson', stringRecord),
    responseBody: nstr(r, 'ResponseBody'),
    resourceId: nstr(r, 'ResourceId'),
    lockedUntil: date(r, 'LockedUntil'),
    expiresAt: date(r, 'ExpiresAt'),
  };
}

export function mapTeam(r: Row): TeamRecord {
  return {
    id: guid(r, 'Id'),
    name: str(r, 'Name'),
    description: nstr(r, 'Description'),
    managerAgentId: nguid(r, 'ManagerAgentId'),
    ownedPaths: jsonAs(r, 'OwnedPathsJson', stringArray) ?? [],
    createdAt: iso(r, 'CreatedAt'),
    updatedAt: iso(r, 'UpdatedAt'),
    rowVer: rowVer(r),
  };
}

export function mapAgent(r: Row): AgentRecord {
  return {
    id: guid(r, 'Id'),
    teamId: guid(r, 'TeamId'),
    parentAgentId: nguid(r, 'ParentAgentId'),
    name: str(r, 'Name'),
    title: str(r, 'Title'),
    description: nstr(r, 'Description'),
    isManager: bool(r, 'IsManager'),
    model: str(r, 'Model'),
    effort: noneOf(EFFORT_LEVELS, r, 'Effort'),
    allowedTools: jsonAs(r, 'AllowedToolsJson', stringArray) ?? [],
    disallowedTools: jsonAs(r, 'DisallowedToolsJson', stringArray) ?? [],
    instructions: nstr(r, 'Instructions'),
    maxTimeoutSeconds: int(r, 'MaxTimeoutSeconds'),
    maxBudgetUsd: nnum(r, 'MaxBudgetUsd'),
    isActive: bool(r, 'IsActive'),
    createdAt: iso(r, 'CreatedAt'),
    updatedAt: iso(r, 'UpdatedAt'),
    rowVer: rowVer(r),
  };
}

export function mapProject(r: Row): ProjectRecord {
  return {
    id: guid(r, 'Id'),
    name: str(r, 'Name'),
    description: nstr(r, 'Description'),
    repoPath: str(r, 'RepoPath'),
    defaultBranch: nstr(r, 'DefaultBranch'),
    status: oneOf(PROJECT_STATUSES, r, 'Status'),
    statusDetail: nstr(r, 'StatusDetail'),
    testCommand: jsonAs(r, 'TestCommandJson', stringArray),
    testTimeoutSeconds: int(r, 'TestTimeoutSeconds'),
    junitReportPath: nstr(r, 'JUnitReportPath'),
    requireIndex: bool(r, 'RequireIndex'),
    autoIndex: bool(r, 'AutoIndex'),
    indexMode: oneOf(INDEX_MODES, r, 'IndexMode'),
    defaultAgentId: nguid(r, 'DefaultAgentId'),
    defaultTimeoutSeconds: int(r, 'DefaultTimeoutSeconds'),
    workspaceMaxBytes: nbigNum(r, 'WorkspaceMaxBytes'),
    headSha: nstr(r, 'HeadSha'),
    lastSyncedAt: niso(r, 'LastSyncedAt'),
    lastIndexedAt: niso(r, 'LastIndexedAt'),
    lastIndexOperationId: nguid(r, 'LastIndexOperationId'),
    createdByUserId: guid(r, 'CreatedByUserId'),
    archivedAt: niso(r, 'ArchivedAt'),
    createdAt: iso(r, 'CreatedAt'),
    updatedAt: iso(r, 'UpdatedAt'),
    rowVer: rowVer(r),
  };
}

export function mapTask(r: Row): TaskRecord {
  return {
    id: guid(r, 'Id'),
    projectId: guid(r, 'ProjectId'),
    agentId: guid(r, 'AgentId'),
    createdByUserId: guid(r, 'CreatedByUserId'),
    title: str(r, 'Title'),
    prompt: str(r, 'Prompt'),
    acceptanceCriteria: nstr(r, 'AcceptanceCriteria'),
    scope: nstr(r, 'Scope'),
    baseRef: nstr(r, 'BaseRef'),
    model: str(r, 'Model'),
    effort: noneOf(EFFORT_LEVELS, r, 'Effort'),
    timeoutSeconds: int(r, 'TimeoutSeconds'),
    maxBudgetUsd: nnum(r, 'MaxBudgetUsd'),
    status: oneOf(TASK_STATUSES, r, 'Status'),
    statusReason: noneOf(FAILURE_REASONS, r, 'StatusReason'),
    statusDetail: nstr(r, 'StatusDetail'),
    currentAttemptId: nguid(r, 'CurrentAttemptId'),
    attemptCount: int(r, 'AttemptCount'),
    autoRecoveryCount: int(r, 'AutoRecoveryCount'),
    cancelRequestedAt: niso(r, 'CancelRequestedAt'),
    cancelRequestedByUserId: nguid(r, 'CancelRequestedByUserId'),
    correlationId: nstr(r, 'CorrelationId'),
    queuedAt: niso(r, 'QueuedAt'),
    startedAt: niso(r, 'StartedAt'),
    finishedAt: niso(r, 'FinishedAt'),
    createdAt: iso(r, 'CreatedAt'),
    updatedAt: iso(r, 'UpdatedAt'),
    rowVer: rowVer(r),
  };
}

export function mapAttempt(r: Row): AttemptRecord {
  return {
    id: guid(r, 'Id'),
    taskId: guid(r, 'TaskId'),
    attemptNumber: int(r, 'AttemptNumber'),
    trigger: oneOf(ATTEMPT_TRIGGERS, r, 'TriggerKind'),
    mode: oneOf(ATTEMPT_MODES, r, 'Mode'),
    previousAttemptId: nguid(r, 'PreviousAttemptId'),
    status: oneOf(ATTEMPT_STATUSES, r, 'Status'),
    stage: noneOf(ACTIVE_TASK_STATUSES, r, 'Stage'),
    failureReason: noneOf(FAILURE_REASONS, r, 'FailureReason'),
    failureDetail: nstr(r, 'FailureDetail'),
    additionalInstructions: nstr(r, 'AdditionalInstructions'),
    baseRefOverride: nstr(r, 'BaseRefOverride'),
    workspaceId: nguid(r, 'WorkspaceId'),
    branchName: nstr(r, 'BranchName'),
    baseSha: nstr(r, 'BaseSha'),
    headSha: nstr(r, 'HeadSha'),
    workerId: nstr(r, 'WorkerId'),
    pid: nint(r, 'Pid'),
    pgid: nint(r, 'Pgid'),
    processStartedAt: niso(r, 'ProcessStartedAt'),
    processEndedAt: niso(r, 'ProcessEndedAt'),
    exitCode: nint(r, 'ExitCode'),
    exitSignal: nstr(r, 'ExitSignal'),
    timeoutSeconds: int(r, 'TimeoutSeconds'),
    deadlineAt: niso(r, 'DeadlineAt'),
    queuedAt: iso(r, 'QueuedAt'),
    startedAt: niso(r, 'StartedAt'),
    endedAt: niso(r, 'EndedAt'),
    lastHeartbeatAt: niso(r, 'LastHeartbeatAt'),
    filesChanged: nint(r, 'FilesChanged'),
    additions: nint(r, 'Additions'),
    deletions: nint(r, 'Deletions'),
    commits: jsonAs(r, 'CommitsJson', (v) => z.array(CommitInfoSchema).parse(v)) ?? [],
    mergeCheck: jsonAs(r, 'MergeCheckJson', (v) => MergeCheckSchema.parse(v)),
    correlationId: nstr(r, 'CorrelationId'),
    createdAt: iso(r, 'CreatedAt'),
    updatedAt: iso(r, 'UpdatedAt'),
    rowVer: rowVer(r),
  };
}

export function mapTaskLog(r: Row): TaskLog {
  return {
    id: bigId(r, 'Id'),
    taskId: guid(r, 'TaskId'),
    attemptId: guid(r, 'AttemptId'),
    seq: int(r, 'Seq'),
    stream: oneOf(LOG_STREAMS, r, 'Stream'),
    source: oneOf(LOG_SOURCES, r, 'Source'),
    content: str(r, 'Content'),
    byteLength: int(r, 'ByteLength'),
    createdAt: iso(r, 'CreatedAt'),
  };
}

export function mapTaskEvent(r: Row): TaskEvent {
  return {
    id: bigId(r, 'Id'),
    taskId: guid(r, 'TaskId'),
    attemptId: nguid(r, 'AttemptId'),
    type: oneOf(TASK_EVENT_TYPES, r, 'EventType'),
    fromStatus: noneOf(TASK_STATUSES, r, 'FromStatus'),
    toStatus: noneOf(TASK_STATUSES, r, 'ToStatus'),
    actorType: oneOf(ACTOR_TYPES, r, 'ActorType'),
    actorUserId: nguid(r, 'ActorUserId'),
    actorLabel: nstr(r, 'ActorLabel'),
    reason: noneOf(FAILURE_REASONS, r, 'Reason'),
    data: jsonAs(r, 'DataJson', objectRecord),
    correlationId: nstr(r, 'CorrelationId'),
    createdAt: iso(r, 'CreatedAt'),
  };
}

export function mapClaudeSession(r: Row): ClaudeSession {
  return {
    id: guid(r, 'Id'),
    attemptId: guid(r, 'AttemptId'),
    taskId: guid(r, 'TaskId'),
    sessionId: nstr(r, 'SessionId'),
    resumedFromSessionId: nstr(r, 'ResumedFromSessionId'),
    status: oneOf(CLAUDE_SESSION_STATUSES, r, 'Status'),
    model: str(r, 'Model'),
    cliVersion: nstr(r, 'CliVersion'),
    permissionMode: str(r, 'PermissionMode'),
    tools: jsonAs(r, 'ToolsJson', stringArray),
    mcpServers: jsonAs(r, 'McpServersJson', mcpServers),
    apiKeySource: nstr(r, 'ApiKeySource'),
    resultSubtype: nstr(r, 'ResultSubtype'),
    isError: nbool(r, 'IsError'),
    stopReason: nstr(r, 'StopReason'),
    terminalReason: nstr(r, 'TerminalReason'),
    numTurns: nint(r, 'NumTurns'),
    totalCostUsd: nnum(r, 'TotalCostUsd'),
    inputTokens: nbigNum(r, 'InputTokens'),
    outputTokens: nbigNum(r, 'OutputTokens'),
    cacheCreationInputTokens: nbigNum(r, 'CacheCreationInputTokens'),
    cacheReadInputTokens: nbigNum(r, 'CacheReadInputTokens'),
    durationMs: nbigNum(r, 'DurationMs'),
    durationApiMs: nbigNum(r, 'DurationApiMs'),
    permissionDenialsCount: nint(r, 'PermissionDenialsCount'),
    permissionDenials: jsonAs(r, 'PermissionDenialsJson', unknownArray),
    resultText: nstr(r, 'ResultText'),
    startedAt: iso(r, 'StartedAt'),
    initAt: niso(r, 'InitAt'),
    endedAt: niso(r, 'EndedAt'),
  };
}

export function mapWorkspace(r: Row): Workspace {
  return {
    id: guid(r, 'Id'),
    projectId: guid(r, 'ProjectId'),
    taskId: nguid(r, 'TaskId'),
    kind: oneOf(WORKSPACE_KINDS, r, 'Kind'),
    createdByAttemptId: nguid(r, 'CreatedByAttemptId'),
    path: str(r, 'Path'),
    branchName: nstr(r, 'BranchName'),
    baseSha: nstr(r, 'BaseSha'),
    headSha: nstr(r, 'HeadSha'),
    status: oneOf(WORKSPACE_STATUSES, r, 'Status'),
    workerId: nstr(r, 'WorkerId'),
    quotaBytes: bigNum(r, 'QuotaBytes'),
    sizeBytes: nbigNum(r, 'SizeBytes'),
    sizeCheckedAt: niso(r, 'SizeCheckedAt'),
    retainUntil: niso(r, 'RetainUntil'),
    errorDetail: nstr(r, 'ErrorDetail'),
    removedAt: niso(r, 'RemovedAt'),
    branchDeletedAt: niso(r, 'BranchDeletedAt'),
    createdAt: iso(r, 'CreatedAt'),
    updatedAt: iso(r, 'UpdatedAt'),
  };
}

export function mapChangedFile(r: Row): ChangedFile {
  return {
    id: bigId(r, 'Id'),
    attemptId: guid(r, 'AttemptId'),
    taskId: guid(r, 'TaskId'),
    path: str(r, 'Path'),
    oldPath: nstr(r, 'OldPath'),
    changeType: oneOf(CHANGE_TYPES, r, 'ChangeType'),
    similarity: nint(r, 'Similarity'),
    additions: nint(r, 'Additions'),
    deletions: nint(r, 'Deletions'),
    isBinary: bool(r, 'IsBinary'),
    patchBytes: int(r, 'PatchBytes'),
    patchTruncated: bool(r, 'PatchTruncated'),
    patchPurged: r['PatchPurgedAt'] !== null && r['PatchPurgedAt'] !== undefined,
    createdAt: iso(r, 'CreatedAt'),
  };
}

export function mapTestRun(r: Row): TestRun {
  return {
    id: guid(r, 'Id'),
    attemptId: guid(r, 'AttemptId'),
    taskId: guid(r, 'TaskId'),
    command: jsonAs(r, 'CommandJson', stringArray) ?? [],
    junitPath: nstr(r, 'JUnitPath'),
    status: oneOf(TEST_RUN_STATUSES, r, 'Status'),
    exitCode: nint(r, 'ExitCode'),
    signal: nstr(r, 'Signal'),
    durationMs: nbigNum(r, 'DurationMs'),
    total: int(r, 'Total'),
    passed: int(r, 'Passed'),
    failed: int(r, 'Failed'),
    errored: int(r, 'Errored'),
    skipped: int(r, 'Skipped'),
    reportParsed: bool(r, 'ReportParsed'),
    reportError: nstr(r, 'ReportError'),
    startedAt: iso(r, 'StartedAt'),
    endedAt: niso(r, 'EndedAt'),
  };
}

export function mapTestResult(r: Row): TestResult {
  return {
    id: bigId(r, 'Id'),
    testRunId: guid(r, 'TestRunId'),
    suiteName: nstr(r, 'SuiteName'),
    className: nstr(r, 'ClassName'),
    name: str(r, 'Name'),
    filePath: nstr(r, 'FilePath'),
    status: oneOf(TEST_CASE_STATUSES, r, 'Status'),
    durationMs: nint(r, 'DurationMs'),
    failureType: nstr(r, 'FailureType'),
    failureMessage: nstr(r, 'FailureMessage'),
    failureDetail: nstr(r, 'FailureDetail'),
    createdAt: iso(r, 'CreatedAt'),
  };
}

export function mapGitOperation(r: Row): GitOperation {
  return {
    id: bigId(r, 'Id'),
    projectId: guid(r, 'ProjectId'),
    taskId: nguid(r, 'TaskId'),
    attemptId: nguid(r, 'AttemptId'),
    workerId: str(r, 'WorkerId'),
    operation: oneOf(GIT_OPERATION_KINDS, r, 'Operation'),
    args: jsonAs(r, 'ArgsJson', stringArray) ?? [],
    cwd: nstr(r, 'Cwd'),
    exitCode: nint(r, 'ExitCode'),
    signal: nstr(r, 'Signal'),
    success: bool(r, 'Success'),
    timedOut: bool(r, 'TimedOut'),
    durationMs: int(r, 'DurationMs'),
    stderrTail: nstr(r, 'StderrTail'),
    correlationId: nstr(r, 'CorrelationId'),
    startedAt: iso(r, 'StartedAt'),
    createdAt: iso(r, 'CreatedAt'),
  };
}

export function mapMcpOperation(r: Row): McpIndexOperation {
  return {
    id: guid(r, 'Id'),
    projectId: guid(r, 'ProjectId'),
    taskId: nguid(r, 'TaskId'),
    attemptId: nguid(r, 'AttemptId'),
    workspaceId: nguid(r, 'WorkspaceId'),
    kind: oneOf(MCP_OPERATION_KINDS, r, 'Kind'),
    indexName: str(r, 'IndexName'),
    mode: noneOf(INDEX_MODES, r, 'Mode'),
    status: oneOf(MCP_OPERATION_STATUSES, r, 'Status'),
    requestedByUserId: nguid(r, 'RequestedByUserId'),
    workerId: nstr(r, 'WorkerId'),
    startedAt: niso(r, 'StartedAt'),
    endedAt: niso(r, 'EndedAt'),
    durationMs: nbigNum(r, 'DurationMs'),
    nodeCount: nbigNum(r, 'NodeCount'),
    edgeCount: nbigNum(r, 'EdgeCount'),
    result: json(r, 'ResultJson'),
    errorCode: nstr(r, 'ErrorCode'),
    errorMessage: nstr(r, 'ErrorMessage'),
    createdAt: iso(r, 'CreatedAt'),
    updatedAt: iso(r, 'UpdatedAt'),
  };
}

export function mapAuditLog(r: Row): AuditLog {
  return {
    id: bigId(r, 'Id'),
    occurredAt: iso(r, 'OccurredAt'),
    action: oneOf(AUDIT_ACTIONS, r, 'Action'),
    outcome: oneOf(AUDIT_OUTCOMES, r, 'Outcome'),
    actorType: oneOf(ACTOR_TYPES, r, 'ActorType'),
    actorUserId: nguid(r, 'ActorUserId'),
    actorTokenId: nguid(r, 'ActorTokenId'),
    actorLabel: str(r, 'ActorLabel'),
    entityType: oneOf(AUDIT_ENTITY_TYPES, r, 'EntityType'),
    entityId: nstr(r, 'EntityId'),
    before: json(r, 'BeforeJson'),
    after: json(r, 'AfterJson'),
    detail: json(r, 'DetailJson'),
    ip: nstr(r, 'Ip'),
    userAgent: nstr(r, 'UserAgent'),
    requestId: nstr(r, 'RequestId'),
    correlationId: nstr(r, 'CorrelationId'),
  };
}

export function mapWorkerNode(r: Row): WorkerNode {
  return {
    id: str(r, 'Id'),
    hostname: str(r, 'Hostname'),
    pid: int(r, 'Pid'),
    appVersion: str(r, 'AppVersion'),
    cliVersion: nstr(r, 'CliVersion'),
    mcpVersion: nstr(r, 'McpVersion'),
    concurrency: int(r, 'Concurrency'),
    activeJobs: int(r, 'ActiveJobs'),
    status: oneOf(WORKER_STATUSES, r, 'Status'),
    diskFreeBytes: nbigNum(r, 'DiskFreeBytes'),
    startedAt: iso(r, 'StartedAt'),
    lastHeartbeatAt: iso(r, 'LastHeartbeatAt'),
    stoppedAt: niso(r, 'StoppedAt'),
  };
}
