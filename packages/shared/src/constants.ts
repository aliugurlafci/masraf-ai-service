// Domain constants (contract §3.1). `as const` arrays; union type = (typeof X)[number].

export const NODE_ENVS = ['production', 'development', 'test'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

/** How the Claude CLI authenticates (ADR-0036): subscription OAuth token (default) or an Anthropic API key. Never inferred from which secret is present. */
export const CLAUDE_AUTH_MODES = ['oauth', 'api_key'] as const;
export type ClaudeAuthMode = (typeof CLAUDE_AUTH_MODES)[number];

export const TASK_STATUSES = [
  'created',
  'queued',
  'preparing_workspace',
  'indexing',
  'running',
  'testing',
  'reviewing',
  'completed',
  'failed',
  'timed_out',
  'cancelled',
  'blocked',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ACTIVE_TASK_STATUSES = [
  'preparing_workspace',
  'indexing',
  'running',
  'testing',
  'reviewing',
] as const;
export type ActiveTaskStatus = (typeof ACTIVE_TASK_STATUSES)[number];

export const SETTLED_TASK_STATUSES = [
  'completed',
  'failed',
  'timed_out',
  'cancelled',
  'blocked',
] as const;
export type SettledTaskStatus = (typeof SETTLED_TASK_STATUSES)[number];

export const RETRYABLE_TASK_STATUSES = ['failed', 'timed_out', 'cancelled', 'blocked'] as const;
export type RetryableTaskStatus = (typeof RETRYABLE_TASK_STATUSES)[number];

export const ATTEMPT_STATUSES = [
  'queued',
  'active',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'blocked',
  'interrupted',
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const ATTEMPT_TRIGGERS = ['initial', 'user_retry', 'infra_recovery'] as const;
export type AttemptTrigger = (typeof ATTEMPT_TRIGGERS)[number];

export const ATTEMPT_MODES = ['fresh', 'continue', 'resume'] as const;
export type AttemptMode = (typeof ATTEMPT_MODES)[number];

export const FAILURE_REASONS = [
  'cancelled_by_user',
  'timeout',
  'project_unavailable',
  'base_ref_not_found',
  'insufficient_disk_space',
  'index_required_failed',
  'workspace_error',
  'disk_quota_exceeded',
  'claude_cli_unavailable',
  'claude_start_failed',
  'security_violation',
  'claude_exit_nonzero',
  'claude_result_error',
  'claude_protocol_error',
  'budget_exceeded',
  'output_limit_exceeded',
  'prompt_too_large',
  'test_failed',
  'test_command_error',
  'test_timeout',
  'review_failed',
  'worker_shutdown',
  'worker_lost',
  'recovery_limit_reached',
  'queue_exhausted',
  'invalid_job',
  'internal_error',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export const ROLES = ['admin', 'operator', 'auditor'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'task:create',
  'task:read:own',
  'task:read:any',
  'task:cancel:own',
  'task:cancel:any',
  'task:retry:own',
  'task:retry:any',
  'project:read',
  'project:create',
  'project:update',
  'project:index',
  'agent:read',
  'agent:manage',
  'team:read',
  'team:manage',
  'user:read',
  'user:manage',
  'token:manage:own',
  'system:read',
  'system:manage',
  'audit:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const EFFORT_LEVELS = ['low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export const PROJECT_STATUSES = ['validating', 'ready', 'invalid', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const INDEX_MODES = ['full', 'moderate', 'fast'] as const;
export type IndexMode = (typeof INDEX_MODES)[number];

export const MCP_OPERATION_KINDS = [
  'project_index',
  'task_index',
  'task_reindex',
  'impact_analysis',
  'index_delete',
] as const;
export type McpOperationKind = (typeof MCP_OPERATION_KINDS)[number];

/**
 * Operations that belong to one task attempt (§9.5 visibility): viewers without `task:read:any` see
 * them only for their own tasks, and their `result` is serialized only by `GET /tasks/:id/impact`.
 */
export const TASK_SCOPED_MCP_OPERATION_KINDS = [
  'task_index',
  'task_reindex',
  'impact_analysis',
] as const satisfies readonly McpOperationKind[];
export type TaskScopedMcpOperationKind = (typeof TASK_SCOPED_MCP_OPERATION_KINDS)[number];

export const MCP_OPERATION_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'skipped',
] as const;
export type McpOperationStatus = (typeof MCP_OPERATION_STATUSES)[number];

export const LOG_STREAMS = ['stdout', 'stderr', 'system', 'claude'] as const;
export type LogStream = (typeof LOG_STREAMS)[number];

export const LOG_SOURCES = ['claude', 'test', 'orchestrator', 'git', 'mcp'] as const;
export type LogSource = (typeof LOG_SOURCES)[number];

export const CHANGE_TYPES = ['A', 'M', 'D', 'R', 'C', 'T'] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export const MERGE_CHECK_STATUSES = ['clean', 'conflicts', 'error', 'not_run'] as const;
export type MergeCheckStatus = (typeof MERGE_CHECK_STATUSES)[number];

export const TEST_RUN_STATUSES = [
  'running',
  'passed',
  'failed',
  'error',
  'timed_out',
  'cancelled',
] as const;
export type TestRunStatus = (typeof TEST_RUN_STATUSES)[number];

export const TEST_CASE_STATUSES = ['passed', 'failed', 'error', 'skipped'] as const;
export type TestCaseStatus = (typeof TEST_CASE_STATUSES)[number];

export const WORKSPACE_KINDS = ['attempt', 'base'] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

export const WORKSPACE_STATUSES = [
  'creating',
  'ready',
  'in_use',
  'retained',
  'removing',
  'removed',
  'error',
] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export const WORKER_STATUSES = ['starting', 'ready', 'draining', 'offline'] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export const CLAUDE_SESSION_STATUSES = [
  'starting',
  'running',
  'completed',
  'failed',
  'killed',
] as const;
export type ClaudeSessionStatus = (typeof CLAUDE_SESSION_STATUSES)[number];

export const ACTOR_TYPES = ['user', 'token', 'worker', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const AUDIT_OUTCOMES = ['success', 'failure', 'denied'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const AUDIT_ENTITY_TYPES = [
  'user',
  'session',
  'api_token',
  'project',
  'task',
  'attempt',
  'agent',
  'team',
  'worker',
  'index_operation',
  'system',
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/** Contract §15.6. */
export const AUDIT_ACTIONS = [
  'auth.login',
  'auth.logout',
  'auth.lockout',
  'auth.password_changed',
  'auth.session_revoked',
  'auth.csrf_rejected',
  'auth.token_created',
  'auth.token_revoked',
  'authz.denied',
  'user.created',
  'user.updated',
  'user.disabled',
  'user.unlocked',
  'project.created',
  'project.updated',
  'project.archived',
  'project.sync_requested',
  'project.synced',
  'project.sync_failed',
  'project.index_requested',
  'project.indexed',
  'project.index_failed',
  'task.created',
  'task.status_changed',
  'task.cancel_requested',
  'task.retry_requested',
  'task.recovered',
  'agent.created',
  'agent.updated',
  'team.created',
  'team.updated',
  'security.violation',
  'security.path_escape',
  'security.orphan_killed',
  'worker.started',
  'worker.stopped',
  'queue.job_dead_lettered',
  'maintenance.retention_run',
  'maintenance.workspace_removed',
  'maintenance.audit_purged',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const TASK_EVENT_TYPES = [
  'task_created',
  'status_changed',
  'attempt_created',
  'attempt_claimed',
  'cancel_requested',
  'workspace_ready',
  'index_started',
  'index_completed',
  'index_failed',
  'claude_started',
  'claude_init',
  'claude_exited',
  'test_started',
  'test_completed',
  'review_completed',
  'artifacts_captured',
  'recovery_scheduled',
  'resume_fallback',
  'orphan_killed',
  'security_violation',
  'warning',
] as const;
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

export const GIT_OPERATION_KINDS = [
  'version',
  'validate_source',
  'mirror_init',
  'mirror_config',
  'mirror_fetch',
  'resolve_ref',
  'list_branches',
  'worktree_add',
  'worktree_lock',
  'worktree_unlock',
  'worktree_remove',
  'worktree_prune',
  'worktree_list',
  'add',
  'diff_cached_quiet',
  'commit',
  'rev_parse',
  'rev_list',
  'log',
  'diff_name_status',
  'diff_numstat',
  'diff_patch',
  'format_patch',
  'merge_tree',
  'merge_base',
  'branch_delete',
  'gc',
] as const;
export type GitOperationKind = (typeof GIT_OPERATION_KINDS)[number];

export const SSE_EVENT_TYPES = [
  'status',
  'log',
  'claude',
  'test',
  'diff',
  'heartbeat',
  'end',
  'error',
] as const;
export type SseEventType = (typeof SSE_EVENT_TYPES)[number];

export const CLAUDE_EVENT_KINDS = [
  'init',
  'assistant_text',
  'thinking',
  'tool_use',
  'tool_result',
  'result',
  'rate_limit',
  'system',
  'unknown',
  'invalid',
] as const;
export type ClaudeEventKind = (typeof CLAUDE_EVENT_KINDS)[number];

export const RATE_LIMIT_CLASSES = [
  'login',
  'auth',
  'write',
  'task_create',
  'read',
  'stream',
  'public',
] as const;
export type RateLimitClass = (typeof RATE_LIMIT_CLASSES)[number];

export const QUEUE_NAMES = {
  tasks: 'orc-tasks',
  tasksDlq: 'orc-tasks-dlq',
  projects: 'orc-projects',
  maintenance: 'orc-maintenance',
  apiMaintenance: 'orc-api-maintenance',
} as const;

export const JOB_NAMES = {
  runAttempt: 'run-attempt',
  deadLetter: 'dead-letter',
  syncProject: 'sync-project',
  indexProject: 'index-project',
  retention: 'retention',
  workspaceCleanup: 'workspace-cleanup',
  staleAttemptRecovery: 'stale-attempt-recovery',
  queuedReconciler: 'queued-reconciler',
  staleWorkers: 'stale-workers',
  mirrorGc: 'mirror-gc',
  authCleanup: 'auth-cleanup',
} as const;

/** UTF-8 bytes of title + prompt + acceptanceCriteria + scope (contract §3.3); exceeding => 422 prompt_too_large. */
export const TASK_TEXT_MAX_BYTES = 98_304;

/** Agent instructions: <= 4000 chars AND <= 4096 UTF-8 bytes (Layer 1 must fit `--append-system-prompt`). */
export const AGENT_INSTRUCTIONS_MAX_CHARS = 4000;
export const AGENT_INSTRUCTIONS_MAX_BYTES = 4096;
/** Hard cap of the Layer-1 `--append-system-prompt` text; larger => `prompt_too_large` (§10.2 row 16). */
export const APPEND_SYSTEM_PROMPT_MAX_BYTES = 8192;
/** `ClaudeEventPayload.text` cap in SSE/Redis stream events; the full line stays in TaskLogs (§3.4). */
export const CLAUDE_EVENT_TEXT_MAX_CHARS = 2000;

/** Reserved prompt fence prefix; stripped from untrusted data (contract §2.1, §10.10). */
export const DATA_FENCE_PREFIX = '<<<ORC:' as const;
