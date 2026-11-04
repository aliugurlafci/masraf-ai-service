// Schema-valid DTO fixtures for web tests (the API client validates every response).
import { ROLE_PERMISSIONS } from '@orc/shared';
import type {
  Agent,
  ChangedFile,
  ClaudeEventPayload,
  DiffFile,
  EndEventPayload,
  ErrorEventPayload,
  HeartbeatEventPayload,
  LogEventPayload,
  McpIndexOperation,
  MeResponse,
  MergeCheck,
  Project,
  ProjectIndexStatus,
  Role,
  StatusEventPayload,
  Task,
  TaskAttempt,
  TaskDetail,
  TestResult,
  TestRun,
  User,
} from '@orc/shared';

export const T0 = '2026-11-02T10:00:00.000Z';

/** Deterministic lower-case GUID: `id(1)` => 00000000-0000-4000-8000-000000000001. */
export function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export const IDS = {
  user: id(1),
  project: id(10),
  agent: id(20),
  team: id(30),
  task: id(100),
  attempt1: id(201),
  attempt2: id(202),
  testRun: id(300),
  indexOp: id(400),
} as const;

export const CSRF_TOKEN = 'csrf-token-from-me';

export function makeUser(role: Role = 'admin', overrides: Partial<User> = {}): User {
  return {
    id: IDS.user,
    username: role,
    displayName: `${role[0]?.toUpperCase() ?? ''}${role.slice(1)} User`,
    email: null,
    role,
    isActive: true,
    lockedUntil: null,
    lastLoginAt: T0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function makeMe(role: Role = 'admin', overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user: makeUser(role),
    permissions: [...ROLE_PERMISSIONS[role]],
    authMethod: 'session',
    csrfToken: CSRF_TOKEN,
    sessionExpiresAt: '2026-11-02T22:00:00.000Z',
    tokenReadOnly: false,
    ...overrides,
  };
}

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: IDS.project,
    name: 'Billing service',
    description: null,
    repoPath: 'team/billing',
    defaultBranch: 'main',
    status: 'ready',
    statusDetail: null,
    testCommand: ['npm', 'test'],
    testTimeoutSeconds: 900,
    junitReportPath: 'reports/junit.xml',
    requireIndex: false,
    autoIndex: true,
    indexMode: 'moderate',
    defaultAgentId: IDS.agent,
    defaultTimeoutSeconds: 3600,
    workspaceMaxBytes: null,
    headSha: 'a'.repeat(40),
    lastSyncedAt: T0,
    lastIndexedAt: T0,
    lastIndexOperationId: null,
    createdByUserId: IDS.user,
    archivedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: IDS.agent,
    teamId: IDS.team,
    parentAgentId: null,
    name: 'backend-dev',
    title: 'Backend developer',
    description: null,
    isManager: false,
    model: 'claude-sonnet-4-5',
    effort: null,
    allowedTools: ['Read', 'Edit'],
    disallowedTools: [],
    instructions: null,
    maxTimeoutSeconds: 7200,
    maxBudgetUsd: null,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: IDS.task,
    projectId: IDS.project,
    agentId: IDS.agent,
    createdByUserId: IDS.user,
    title: 'Fix invoice rounding',
    prompt: 'Fix the rounding bug',
    acceptanceCriteria: null,
    scope: null,
    baseRef: null,
    model: 'claude-sonnet-4-5',
    effort: null,
    timeoutSeconds: 3600,
    maxBudgetUsd: null,
    status: 'running',
    statusReason: null,
    statusDetail: null,
    currentAttemptId: IDS.attempt1,
    attemptCount: 1,
    autoRecoveryCount: 0,
    cancelRequestedAt: null,
    cancelRequestedByUserId: null,
    correlationId: null,
    queuedAt: T0,
    startedAt: T0,
    finishedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function makeAttempt(overrides: Partial<TaskAttempt> = {}): TaskAttempt {
  return {
    id: IDS.attempt1,
    taskId: IDS.task,
    attemptNumber: 1,
    trigger: 'initial',
    mode: 'fresh',
    previousAttemptId: null,
    status: 'active',
    stage: 'running',
    failureReason: null,
    failureDetail: null,
    additionalInstructions: null,
    baseRefOverride: null,
    workspaceId: null,
    branchName: 'orc/task-1',
    baseSha: null,
    headSha: null,
    workerId: 'worker-1',
    pid: null,
    pgid: null,
    processStartedAt: null,
    processEndedAt: null,
    exitCode: null,
    exitSignal: null,
    timeoutSeconds: 3600,
    deadlineAt: null,
    queuedAt: T0,
    startedAt: T0,
    endedAt: null,
    lastHeartbeatAt: null,
    filesChanged: null,
    additions: null,
    deletions: null,
    commits: [],
    mergeCheck: null,
    correlationId: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function makeTaskDetail(
  task: Partial<Task> = {},
  actions: Partial<TaskDetail['actions']> = {},
): TaskDetail {
  const t = makeTask(task);
  return {
    task: t,
    currentAttempt: t.currentAttemptId ? makeAttempt({ id: t.currentAttemptId }) : null,
    project: { id: IDS.project, name: 'Billing service', status: 'ready' },
    agent: { id: IDS.agent, name: 'backend-dev', title: 'Backend developer' },
    createdBy: { id: IDS.user, username: 'admin', displayName: 'Admin User' },
    actions: { canCancel: false, canRetry: false, canRetryContinue: false, ...actions },
  };
}

export function makeOperation(overrides: Partial<McpIndexOperation> = {}): McpIndexOperation {
  return {
    id: IDS.indexOp,
    projectId: IDS.project,
    taskId: null,
    attemptId: null,
    workspaceId: null,
    kind: 'project_index',
    indexName: 'orc-billing',
    mode: 'moderate',
    status: 'succeeded',
    requestedByUserId: IDS.user,
    workerId: 'worker-1',
    startedAt: T0,
    endedAt: T0,
    durationMs: 1200,
    nodeCount: 1500,
    edgeCount: 4200,
    result: null,
    errorCode: null,
    errorMessage: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function makeIndexStatus(overrides: Partial<ProjectIndexStatus> = {}): ProjectIndexStatus {
  return {
    projectId: IDS.project,
    indexName: 'orc-billing',
    mcpEnabled: true,
    activeOperation: null,
    lastOperation: makeOperation(),
    lastSuccessfulOperation: makeOperation(),
    nodeCount: 1500,
    edgeCount: 4200,
    indexedAt: T0,
    projectHeadSha: 'a'.repeat(40),
    stale: false,
    ...overrides,
  };
}

export function makeChangedFile(n: number, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    id: String(n),
    attemptId: IDS.attempt1,
    taskId: IDS.task,
    path: `src/file-${n}.ts`,
    oldPath: null,
    changeType: 'M',
    similarity: null,
    additions: 2,
    deletions: 1,
    isBinary: false,
    patchBytes: 120,
    patchTruncated: false,
    patchPurged: false,
    createdAt: T0,
    ...overrides,
  };
}

export function makeDiffFile(n: number, overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    ...makeChangedFile(n),
    patch: [
      `diff --git a/src/file-${n}.ts b/src/file-${n}.ts`,
      `--- a/src/file-${n}.ts`,
      `+++ b/src/file-${n}.ts`,
      '@@ -10,3 +10,4 @@ export function total()',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      '+const c = 4;',
      ' return a + b;',
      '',
    ].join('\n'),
    ...overrides,
  };
}

export function makeMergeCheck(overrides: Partial<MergeCheck> = {}): MergeCheck {
  return {
    status: 'clean',
    baseBranch: 'main',
    latestBaseSha: 'b'.repeat(40),
    headSha: 'c'.repeat(40),
    conflicts: [],
    isFastForward: false,
    error: null,
    checkedAt: T0,
    ...overrides,
  };
}

export function makeTestRun(overrides: Partial<TestRun> = {}): TestRun {
  return {
    id: IDS.testRun,
    attemptId: IDS.attempt1,
    taskId: IDS.task,
    command: ['npm', 'test'],
    junitPath: 'reports/junit.xml',
    status: 'failed',
    exitCode: 1,
    signal: null,
    durationMs: 4200,
    total: 12,
    passed: 10,
    failed: 1,
    errored: 0,
    skipped: 1,
    reportParsed: true,
    reportError: null,
    startedAt: T0,
    endedAt: T0,
    ...overrides,
  };
}

export function makeTestResult(n: number, overrides: Partial<TestResult> = {}): TestResult {
  return {
    id: String(n),
    testRunId: IDS.testRun,
    suiteName: 'invoice',
    className: 'InvoiceTotals',
    name: `case ${n}`,
    filePath: 'test/invoice.test.ts',
    status: 'passed',
    durationMs: 12,
    failureType: null,
    failureMessage: null,
    failureDetail: null,
    createdAt: T0,
    ...overrides,
  };
}

export function claudeEvent(line: number, overrides: Partial<ClaudeEventPayload> = {}): ClaudeEventPayload {
  return {
    v: 1,
    type: 'claude',
    taskId: IDS.task,
    attemptId: IDS.attempt1,
    line,
    block: 0,
    kind: 'assistant_text',
    text: `assistant line ${line}`,
    toolName: null,
    toolUseId: null,
    isError: null,
    data: null,
    at: T0,
    ...overrides,
  };
}

export function page<T>(items: T[], nextCursor: string | null = null): { items: T[]; nextCursor: string | null } {
  return { items, nextCursor };
}

export function statusEvent(overrides: Partial<StatusEventPayload> = {}): StatusEventPayload {
  return {
    v: 1,
    type: 'status',
    taskId: IDS.task,
    attemptId: IDS.attempt1,
    attemptNumber: 1,
    status: 'running',
    previousStatus: 'queued',
    reason: null,
    detail: null,
    cancelRequested: false,
    at: T0,
    ...overrides,
  };
}

export function logEvent(seq: number, overrides: Partial<LogEventPayload> = {}): LogEventPayload {
  return {
    v: 1,
    type: 'log',
    taskId: IDS.task,
    attemptId: IDS.attempt1,
    seq,
    stream: 'stdout',
    source: 'orchestrator',
    content: `log line ${seq}\n`,
    at: T0,
    ...overrides,
  };
}

export function endEvent(overrides: Partial<EndEventPayload> = {}): EndEventPayload {
  return {
    v: 1,
    type: 'end',
    taskId: IDS.task,
    attemptId: IDS.attempt1,
    status: 'completed',
    reason: null,
    at: T0,
    ...overrides,
  };
}

export function heartbeatEvent(at: string = T0): HeartbeatEventPayload {
  return { v: 1, type: 'heartbeat', at };
}

export function streamErrorEvent(overrides: Partial<ErrorEventPayload> = {}): ErrorEventPayload {
  return { v: 1, type: 'error', code: 'internal_error', message: 'The event stream failed', at: T0, ...overrides };
}
