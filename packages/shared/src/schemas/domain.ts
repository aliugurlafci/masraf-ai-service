// Domain / response DTO schemas (contract §3.2). Response schemas are plain z.object; z.infer == the DTO type.
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
  EFFORT_LEVELS,
  FAILURE_REASONS,
  GIT_OPERATION_KINDS,
  INDEX_MODES,
  LOG_SOURCES,
  LOG_STREAMS,
  MCP_OPERATION_KINDS,
  MCP_OPERATION_STATUSES,
  MERGE_CHECK_STATUSES,
  PROJECT_STATUSES,
  ROLES,
  TASK_EVENT_TYPES,
  TASK_STATUSES,
  TEST_CASE_STATUSES,
  TEST_RUN_STATUSES,
  WORKER_STATUSES,
  WORKSPACE_KINDS,
  WORKSPACE_STATUSES,
} from '../constants';
import { ERROR_CODES } from '../errors';
import { DeadLetterJobDataSchema } from './queue';
import {
  BigIdSchema,
  IdSchema,
  IsoDateTimeSchema,
  jsonRecord,
  nonNegInt,
  nullableId,
  nullableIso,
} from './common';

const nullableString = z.string().nullable();
const nullableInt = z.int().nullable();
const nullableNumber = z.number().nullable();

export const FieldIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
  code: z.string(),
});

export const UserSchema = z.object({
  id: IdSchema,
  username: z.string(),
  displayName: z.string(),
  email: nullableString,
  role: z.enum(ROLES),
  isActive: z.boolean(),
  lockedUntil: nullableIso,
  lastLoginAt: nullableIso,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type User = z.infer<typeof UserSchema>;

export const ApiTokenSchema = z.object({
  id: IdSchema,
  name: z.string(),
  prefix: z.string(),
  readOnly: z.boolean(),
  expiresAt: IsoDateTimeSchema,
  lastUsedAt: nullableIso,
  revokedAt: nullableIso,
  createdAt: IsoDateTimeSchema,
});
export type ApiToken = z.infer<typeof ApiTokenSchema>;

export const TeamSchema = z.object({
  id: IdSchema,
  name: z.string(),
  description: nullableString,
  managerAgentId: nullableId,
  ownedPaths: z.array(z.string()),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Team = z.infer<typeof TeamSchema>;

export const AgentSchema = z.object({
  id: IdSchema,
  teamId: IdSchema,
  parentAgentId: nullableId,
  name: z.string(),
  title: z.string(),
  description: nullableString,
  isManager: z.boolean(),
  model: z.string(),
  effort: z.enum(EFFORT_LEVELS).nullable(),
  allowedTools: z.array(z.string()),
  disallowedTools: z.array(z.string()),
  instructions: nullableString,
  maxTimeoutSeconds: z.int(),
  maxBudgetUsd: nullableNumber,
  isActive: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Agent = z.infer<typeof AgentSchema>;

export const TeamDetailSchema = TeamSchema.extend({ agents: z.array(AgentSchema) });
export type TeamDetail = z.infer<typeof TeamDetailSchema>;

export const ProjectSchema = z.object({
  id: IdSchema,
  name: z.string(),
  description: nullableString,
  repoPath: z.string(),
  defaultBranch: nullableString,
  status: z.enum(PROJECT_STATUSES),
  statusDetail: nullableString,
  testCommand: z.array(z.string()).nullable(),
  testTimeoutSeconds: z.int(),
  junitReportPath: nullableString,
  requireIndex: z.boolean(),
  autoIndex: z.boolean(),
  indexMode: z.enum(INDEX_MODES),
  defaultAgentId: nullableId,
  defaultTimeoutSeconds: z.int(),
  workspaceMaxBytes: nullableInt,
  headSha: nullableString,
  lastSyncedAt: nullableIso,
  lastIndexedAt: nullableIso,
  lastIndexOperationId: nullableId,
  createdByUserId: IdSchema,
  archivedAt: nullableIso,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

export const TaskSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  agentId: IdSchema,
  createdByUserId: IdSchema,
  title: z.string(),
  prompt: z.string(),
  acceptanceCriteria: nullableString,
  scope: nullableString,
  baseRef: nullableString,
  model: z.string(),
  effort: z.enum(EFFORT_LEVELS).nullable(),
  timeoutSeconds: z.int(),
  maxBudgetUsd: nullableNumber,
  status: z.enum(TASK_STATUSES),
  statusReason: z.enum(FAILURE_REASONS).nullable(),
  statusDetail: nullableString,
  currentAttemptId: nullableId,
  attemptCount: nonNegInt,
  autoRecoveryCount: nonNegInt,
  cancelRequestedAt: nullableIso,
  cancelRequestedByUserId: nullableId,
  correlationId: nullableString,
  queuedAt: nullableIso,
  startedAt: nullableIso,
  finishedAt: nullableIso,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Task = z.infer<typeof TaskSchema>;

export const CommitInfoSchema = z.object({
  sha: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  authoredAt: IsoDateTimeSchema,
  subject: z.string(),
});
export type CommitInfo = z.infer<typeof CommitInfoSchema>;

export const MergeCheckSchema = z.object({
  status: z.enum(MERGE_CHECK_STATUSES),
  baseBranch: z.string(),
  latestBaseSha: nullableString,
  headSha: z.string(),
  conflicts: z.array(z.string()),
  isFastForward: z.boolean(),
  error: nullableString,
  checkedAt: IsoDateTimeSchema,
});
export type MergeCheck = z.infer<typeof MergeCheckSchema>;

export const TaskAttemptSchema = z.object({
  id: IdSchema,
  taskId: IdSchema,
  attemptNumber: z.int().min(1),
  trigger: z.enum(ATTEMPT_TRIGGERS),
  mode: z.enum(ATTEMPT_MODES),
  previousAttemptId: nullableId,
  status: z.enum(ATTEMPT_STATUSES),
  stage: z.enum(ACTIVE_TASK_STATUSES).nullable(),
  failureReason: z.enum(FAILURE_REASONS).nullable(),
  failureDetail: nullableString,
  additionalInstructions: nullableString,
  baseRefOverride: nullableString,
  workspaceId: nullableId,
  branchName: nullableString,
  baseSha: nullableString,
  headSha: nullableString,
  workerId: nullableString,
  pid: nullableInt,
  pgid: nullableInt,
  processStartedAt: nullableIso,
  processEndedAt: nullableIso,
  exitCode: nullableInt,
  exitSignal: nullableString,
  timeoutSeconds: z.int(),
  deadlineAt: nullableIso,
  queuedAt: IsoDateTimeSchema,
  startedAt: nullableIso,
  endedAt: nullableIso,
  lastHeartbeatAt: nullableIso,
  filesChanged: nullableInt,
  additions: nullableInt,
  deletions: nullableInt,
  commits: z.array(CommitInfoSchema),
  mergeCheck: MergeCheckSchema.nullable(),
  correlationId: nullableString,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type TaskAttempt = z.infer<typeof TaskAttemptSchema>;

export const TaskLogSchema = z.object({
  id: BigIdSchema,
  taskId: IdSchema,
  attemptId: IdSchema,
  seq: nonNegInt,
  stream: z.enum(LOG_STREAMS),
  source: z.enum(LOG_SOURCES),
  content: z.string(),
  byteLength: nonNegInt,
  createdAt: IsoDateTimeSchema,
});
export type TaskLog = z.infer<typeof TaskLogSchema>;

export const TaskEventSchema = z.object({
  id: BigIdSchema,
  taskId: IdSchema,
  attemptId: nullableId,
  type: z.enum(TASK_EVENT_TYPES),
  fromStatus: z.enum(TASK_STATUSES).nullable(),
  toStatus: z.enum(TASK_STATUSES).nullable(),
  actorType: z.enum(ACTOR_TYPES),
  actorUserId: nullableId,
  actorLabel: nullableString,
  reason: z.enum(FAILURE_REASONS).nullable(),
  data: jsonRecord.nullable(),
  correlationId: nullableString,
  createdAt: IsoDateTimeSchema,
});
export type TaskEvent = z.infer<typeof TaskEventSchema>;

const claudeResultFields = {
  resultSubtype: nullableString,
  isError: z.boolean().nullable(),
  stopReason: nullableString,
  terminalReason: nullableString,
  numTurns: nullableInt,
  totalCostUsd: nullableNumber,
  inputTokens: nullableInt,
  outputTokens: nullableInt,
  cacheCreationInputTokens: nullableInt,
  cacheReadInputTokens: nullableInt,
  durationMs: nullableInt,
  durationApiMs: nullableInt,
  permissionDenialsCount: nullableInt,
  permissionDenials: z.array(z.unknown()).nullable(),
  resultText: nullableString,
};

export const ClaudeResultSummarySchema = z.object({
  ...claudeResultFields,
  status: z.enum(['completed', 'failed', 'killed']),
});
export type ClaudeResultSummary = z.infer<typeof ClaudeResultSummarySchema>;

export const ClaudeSessionSchema = z.object({
  ...claudeResultFields,
  id: IdSchema,
  attemptId: IdSchema,
  taskId: IdSchema,
  sessionId: nullableString,
  resumedFromSessionId: nullableString,
  status: z.enum(CLAUDE_SESSION_STATUSES),
  model: z.string(),
  cliVersion: nullableString,
  permissionMode: z.string(),
  tools: z.array(z.string()).nullable(),
  mcpServers: z.array(z.object({ name: z.string(), status: z.string() })).nullable(),
  apiKeySource: nullableString,
  startedAt: IsoDateTimeSchema,
  initAt: nullableIso,
  endedAt: nullableIso,
});
export type ClaudeSession = z.infer<typeof ClaudeSessionSchema>;

export const WorkspaceSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  taskId: nullableId,
  kind: z.enum(WORKSPACE_KINDS),
  createdByAttemptId: nullableId,
  path: z.string(),
  branchName: nullableString,
  baseSha: nullableString,
  headSha: nullableString,
  status: z.enum(WORKSPACE_STATUSES),
  workerId: nullableString,
  quotaBytes: nonNegInt,
  sizeBytes: nullableInt,
  sizeCheckedAt: nullableIso,
  retainUntil: nullableIso,
  errorDetail: nullableString,
  removedAt: nullableIso,
  branchDeletedAt: nullableIso,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const ChangedFileSchema = z.object({
  id: BigIdSchema,
  attemptId: IdSchema,
  taskId: IdSchema,
  path: z.string(),
  oldPath: nullableString,
  changeType: z.enum(CHANGE_TYPES),
  similarity: nullableInt,
  additions: nullableInt,
  deletions: nullableInt,
  isBinary: z.boolean(),
  patchBytes: nonNegInt,
  patchTruncated: z.boolean(),
  /** Patch text removed by PATCH_RETENTION_DAYS (§6.5); the file metadata is kept. */
  patchPurged: z.boolean(),
  createdAt: IsoDateTimeSchema,
});
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

export const DiffFileSchema = ChangedFileSchema.extend({ patch: nullableString });
export type DiffFile = z.infer<typeof DiffFileSchema>;
/** git-manager output, database input. */
export type ChangedFileInput = Omit<
  DiffFile,
  'id' | 'attemptId' | 'taskId' | 'createdAt' | 'patchPurged'
>;

export const TestRunSchema = z.object({
  id: IdSchema,
  attemptId: IdSchema,
  taskId: IdSchema,
  command: z.array(z.string()),
  junitPath: nullableString,
  status: z.enum(TEST_RUN_STATUSES),
  exitCode: nullableInt,
  signal: nullableString,
  durationMs: nullableInt,
  total: nonNegInt,
  passed: nonNegInt,
  failed: nonNegInt,
  errored: nonNegInt,
  skipped: nonNegInt,
  reportParsed: z.boolean(),
  reportError: nullableString,
  startedAt: IsoDateTimeSchema,
  endedAt: nullableIso,
});
export type TestRun = z.infer<typeof TestRunSchema>;

export const TestResultSchema = z.object({
  id: BigIdSchema,
  testRunId: IdSchema,
  suiteName: nullableString,
  className: nullableString,
  name: z.string(),
  filePath: nullableString,
  status: z.enum(TEST_CASE_STATUSES),
  durationMs: nullableInt,
  failureType: nullableString,
  failureMessage: nullableString,
  failureDetail: nullableString,
  createdAt: IsoDateTimeSchema,
});
export type TestResult = z.infer<typeof TestResultSchema>;

export const GitOperationSchema = z.object({
  id: BigIdSchema,
  projectId: IdSchema,
  taskId: nullableId,
  attemptId: nullableId,
  workerId: z.string(),
  operation: z.enum(GIT_OPERATION_KINDS),
  args: z.array(z.string()),
  cwd: nullableString,
  exitCode: nullableInt,
  signal: nullableString,
  success: z.boolean(),
  timedOut: z.boolean(),
  durationMs: nonNegInt,
  stderrTail: nullableString,
  correlationId: nullableString,
  startedAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
});
export type GitOperation = z.infer<typeof GitOperationSchema>;

export const McpIndexOperationSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  taskId: nullableId,
  attemptId: nullableId,
  workspaceId: nullableId,
  kind: z.enum(MCP_OPERATION_KINDS),
  indexName: z.string(),
  mode: z.enum(INDEX_MODES).nullable(),
  status: z.enum(MCP_OPERATION_STATUSES),
  requestedByUserId: nullableId,
  workerId: nullableString,
  startedAt: nullableIso,
  endedAt: nullableIso,
  durationMs: nullableInt,
  nodeCount: nullableInt,
  edgeCount: nullableInt,
  result: z.unknown(),
  errorCode: nullableString,
  errorMessage: nullableString,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type McpIndexOperation = z.infer<typeof McpIndexOperationSchema>;

export const AuditLogSchema = z.object({
  id: BigIdSchema,
  occurredAt: IsoDateTimeSchema,
  action: z.enum(AUDIT_ACTIONS),
  outcome: z.enum(AUDIT_OUTCOMES),
  actorType: z.enum(ACTOR_TYPES),
  actorUserId: nullableId,
  actorTokenId: nullableId,
  actorLabel: z.string(),
  entityType: z.enum(AUDIT_ENTITY_TYPES),
  entityId: nullableString,
  before: z.unknown(),
  after: z.unknown(),
  detail: z.unknown(),
  ip: nullableString,
  userAgent: nullableString,
  requestId: nullableString,
  correlationId: nullableString,
});
export type AuditLog = z.infer<typeof AuditLogSchema>;

export const WorkerNodeSchema = z.object({
  id: z.string(),
  hostname: z.string(),
  pid: z.int(),
  appVersion: z.string(),
  cliVersion: nullableString,
  mcpVersion: nullableString,
  concurrency: z.int(),
  activeJobs: nonNegInt,
  status: z.enum(WORKER_STATUSES),
  diskFreeBytes: nullableInt,
  startedAt: IsoDateTimeSchema,
  lastHeartbeatAt: IsoDateTimeSchema,
  stoppedAt: nullableIso,
});
export type WorkerNode = z.infer<typeof WorkerNodeSchema>;

export const TaskDetailSchema = z.object({
  task: TaskSchema,
  currentAttempt: TaskAttemptSchema.nullable(),
  project: z.object({ id: IdSchema, name: z.string(), status: z.enum(PROJECT_STATUSES) }),
  agent: z.object({ id: IdSchema, name: z.string(), title: z.string() }),
  createdBy: z.object({ id: IdSchema, username: z.string(), displayName: z.string() }),
  actions: z.object({
    canCancel: z.boolean(),
    canRetry: z.boolean(),
    canRetryContinue: z.boolean(),
  }),
});
export type TaskDetail = z.infer<typeof TaskDetailSchema>;

export const ProjectIndexStatusSchema = z.object({
  projectId: IdSchema,
  indexName: z.string(),
  mcpEnabled: z.boolean(),
  activeOperation: McpIndexOperationSchema.nullable(),
  lastOperation: McpIndexOperationSchema.nullable(),
  lastSuccessfulOperation: McpIndexOperationSchema.nullable(),
  nodeCount: nullableInt,
  edgeCount: nullableInt,
  indexedAt: nullableIso,
  projectHeadSha: nullableString,
  stale: z.boolean(),
});
export type ProjectIndexStatus = z.infer<typeof ProjectIndexStatusSchema>;

export const QueueStatsSchema = z.object({
  name: z.string(),
  waiting: nonNegInt,
  active: nonNegInt,
  delayed: nonNegInt,
  prioritized: nonNegInt,
  failed: nonNegInt,
  completed: nonNegInt,
  paused: z.boolean(),
});
export type QueueStats = z.infer<typeof QueueStatsSchema>;

export const QueueStatusSchema = z.object({
  queues: z.array(QueueStatsSchema),
  deadLetterCount: nonNegInt,
  /** Redis INFO memory (§6.1, T-M7); null when INFO failed. maxBytes null = no maxmemory set. */
  redisMemory: z
    .object({ usedBytes: nonNegInt, maxBytes: nonNegInt.nullable(), policy: z.string().max(64) })
    .nullable(),
  checkedAt: IsoDateTimeSchema,
});
export type QueueStatus = z.infer<typeof QueueStatusSchema>;

export const DeadLetterEntrySchema = z.object({
  jobId: z.string(),
  data: DeadLetterJobDataSchema,
  createdAt: IsoDateTimeSchema,
});
export type DeadLetterEntry = z.infer<typeof DeadLetterEntrySchema>;

export const McpStatusSchema = z.object({
  mcpEnabled: z.boolean(),
  workers: z.array(
    z.object({
      workerId: z.string(),
      status: z.enum(WORKER_STATUSES),
      mcpVersion: nullableString,
      cliVersion: nullableString,
      lastHeartbeatAt: IsoDateTimeSchema,
    }),
  ),
  recentOperations: z.array(McpIndexOperationSchema),
});
export type McpStatus = z.infer<typeof McpStatusSchema>;

const HealthStatusSchema = z.enum(['ok', 'fail']);
export const HealthSchema = z.object({
  status: HealthStatusSchema,
  version: z.string(),
  uptimeSeconds: z.number().min(0),
  checks: z.record(
    z.string(),
    z.object({ status: HealthStatusSchema, latencyMs: nullableNumber, detail: nullableString }),
  ),
});
export type Health = z.infer<typeof HealthSchema>;

export const ProblemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.int().min(100).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.enum(ERROR_CODES),
  requestId: z.string(),
  correlationId: z.string(),
  errors: z.array(FieldIssueSchema).optional(),
  retryAfterSeconds: nonNegInt.optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

/** Generic page wrapper: `{ items, nextCursor }`. */
export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}
