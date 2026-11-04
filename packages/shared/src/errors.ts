// Error catalogue and error classes (contract §2.1, §9.6).
import type { z } from 'zod';
import type { TaskStatus } from './constants';

/** Codes sent to clients as Problem Details. */
const PUBLIC_ERROR_CODES = [
  'validation_failed',
  'invalid_json',
  'invalid_cursor',
  'idempotency_key_invalid',
  'unauthenticated',
  'invalid_credentials',
  'session_expired',
  'csrf_failed',
  'forbidden',
  'token_not_allowed',
  'not_found',
  'route_not_found',
  'patch_unavailable',
  'merge_check_unavailable',
  'method_not_allowed',
  'not_acceptable',
  'conflict',
  'invalid_transition',
  'task_not_cancellable',
  'task_not_retryable',
  'retry_limit_reached',
  'project_not_ready',
  'project_archived',
  'project_name_taken',
  'project_repo_taken',
  'index_in_progress',
  'agent_inactive',
  'username_taken',
  'last_admin',
  'idempotency_key_in_use',
  'unique_violation',
  'precondition_failed',
  'payload_too_large',
  'unsupported_media_type',
  'idempotency_key_mismatch',
  'model_not_allowed',
  'prompt_too_large',
  'tool_not_allowed',
  'precondition_required',
  'rate_limited',
  'login_throttled',
  'sse_connection_limit',
  'internal_error',
  'service_unavailable',
  'dependency_unavailable',
  'mcp_disabled',
] as const;

/** Internal codes: never sent directly; mapped to 500 if leaked. */
const INTERNAL_ERROR_CODES = [
  'config_invalid',
  'db_name_guard',
  'db_unavailable',
  'db_deadlock',
  'redis_unavailable',
  'migration_checksum_mismatch',
  'migration_lock_timeout',
  'path_escape',
  'unsafe_argument',
  'process_spawn_failed',
  'process_kill_failed',
  'git_failed',
  'git_timeout',
  'git_ref_not_found',
  'git_repo_invalid',
  'workspace_quota_exceeded',
  'insufficient_disk_space',
  'mcp_unavailable',
  'mcp_tool_missing',
  'mcp_tool_schema_mismatch',
  'mcp_tool_error',
  'mcp_timeout',
  'mcp_protocol_error',
  'claude_probe_failed',
  'junit_invalid',
] as const;

export const ERROR_CODES = [...PUBLIC_ERROR_CODES, ...INTERNAL_ERROR_CODES] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorCatalogEntry {
  code: ErrorCode;
  status: number;
  title: string;
}

const CATALOG_ROWS: readonly (readonly [ErrorCode, number, string])[] = [
  ['validation_failed', 400, 'Request validation failed'],
  ['invalid_json', 400, 'Malformed JSON body'],
  ['invalid_cursor', 400, 'Invalid pagination cursor'],
  ['idempotency_key_invalid', 400, 'Invalid Idempotency-Key'],
  ['unauthenticated', 401, 'Authentication required'],
  ['invalid_credentials', 401, 'Invalid username or password'],
  ['session_expired', 401, 'Session expired'],
  ['csrf_failed', 403, 'CSRF validation failed'],
  ['forbidden', 403, 'Permission denied'],
  ['token_not_allowed', 403, 'Not allowed with an API token'],
  ['not_found', 404, 'Resource not found'],
  ['route_not_found', 404, 'Route not found'],
  ['patch_unavailable', 404, 'Patch not available'],
  ['merge_check_unavailable', 404, 'Merge check not available'],
  ['method_not_allowed', 405, 'Method not allowed'],
  ['not_acceptable', 406, 'Not acceptable'],
  ['conflict', 409, 'Conflict'],
  ['invalid_transition', 409, 'Invalid task state transition'],
  ['task_not_cancellable', 409, 'Task cannot be cancelled'],
  ['task_not_retryable', 409, 'Task cannot be retried'],
  ['retry_limit_reached', 409, 'Retry limit reached'],
  ['project_not_ready', 409, 'Project is not ready'],
  ['project_archived', 409, 'Project is archived'],
  ['project_name_taken', 409, 'Project name already exists'],
  ['project_repo_taken', 409, 'Repository already registered'],
  ['index_in_progress', 409, 'Index operation already in progress'],
  ['agent_inactive', 409, 'Agent is inactive'],
  ['username_taken', 409, 'Username already exists'],
  ['last_admin', 409, 'Cannot remove the last active admin'],
  ['idempotency_key_in_use', 409, 'Request with this Idempotency-Key is in progress'],
  ['unique_violation', 409, 'Duplicate value'],
  ['precondition_failed', 412, 'Resource has changed'],
  ['payload_too_large', 413, 'Payload too large'],
  ['unsupported_media_type', 415, 'Unsupported media type'],
  ['idempotency_key_mismatch', 422, 'Idempotency-Key reused with a different request'],
  ['model_not_allowed', 422, 'Model not allowed'],
  ['prompt_too_large', 422, 'Prompt too large'],
  ['tool_not_allowed', 422, 'Tool rule not allowed'],
  ['precondition_required', 428, 'If-Match header required'],
  ['rate_limited', 429, 'Too many requests'],
  ['login_throttled', 429, 'Too many login attempts'],
  ['sse_connection_limit', 429, 'Too many live streams'],
  ['internal_error', 500, 'Internal error'],
  ['service_unavailable', 503, 'Service unavailable'],
  ['dependency_unavailable', 503, 'Dependency unavailable'],
  ['mcp_disabled', 503, 'Code index is disabled'],
  ['config_invalid', 500, 'Invalid configuration'],
  ['db_name_guard', 500, 'Database name not allowed for this environment'],
  ['db_unavailable', 500, 'Database unavailable'],
  ['db_deadlock', 500, 'Database deadlock'],
  ['redis_unavailable', 500, 'Redis unavailable'],
  ['migration_checksum_mismatch', 500, 'Migration checksum mismatch'],
  ['migration_lock_timeout', 500, 'Migration lock timeout'],
  ['path_escape', 500, 'Path escapes its root'],
  ['unsafe_argument', 500, 'Unsafe process argument'],
  ['process_spawn_failed', 500, 'Process spawn failed'],
  ['process_kill_failed', 500, 'Process kill failed'],
  ['git_failed', 500, 'Git operation failed'],
  ['git_timeout', 500, 'Git operation timed out'],
  ['git_ref_not_found', 500, 'Git ref not found'],
  ['git_repo_invalid', 500, 'Invalid Git repository'],
  ['workspace_quota_exceeded', 500, 'Workspace quota exceeded'],
  ['insufficient_disk_space', 500, 'Insufficient disk space'],
  ['mcp_unavailable', 500, 'Code index server unavailable'],
  ['mcp_tool_missing', 500, 'Code index tool missing'],
  ['mcp_tool_schema_mismatch', 500, 'Code index tool schema mismatch'],
  ['mcp_tool_error', 500, 'Code index tool error'],
  ['mcp_timeout', 500, 'Code index operation timed out'],
  ['mcp_protocol_error', 500, 'Code index protocol error'],
  ['claude_probe_failed', 500, 'Claude CLI probe failed'],
  ['junit_invalid', 500, 'Invalid JUnit report'],
];

export const ERROR_CATALOG: Readonly<Record<ErrorCode, ErrorCatalogEntry>> = Object.freeze(
  Object.fromEntries(
    CATALOG_ROWS.map(([code, status, title]) => [code, Object.freeze({ code, status, title })]),
  ) as Record<ErrorCode, ErrorCatalogEntry>,
);

export function problemTypeUri(code: ErrorCode): string {
  return `/api/v1/problems/${code}`;
}

/** Internal codes that mean "a dependency is temporarily unavailable" (§9.6). */
const DEPENDENCY_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'db_unavailable',
  'db_deadlock',
  'redis_unavailable',
]);
const PUBLIC_CODE_SET: ReadonlySet<ErrorCode> = new Set<ErrorCode>(PUBLIC_ERROR_CODES);
const DEPENDENCY_RETRY_AFTER_SECONDS = 5;

export interface PublicErrorMapping {
  code: ErrorCode;
  status: number;
  retryAfterSeconds: number | null;
}

/**
 * Maps any error code to what the API may send (§9.6): public codes pass through; `db_unavailable`,
 * `db_deadlock` (after retries) and `redis_unavailable` become 503 `dependency_unavailable` with
 * `Retry-After: 5`; every other internal code becomes 500 `internal_error`.
 */
export function toPublicError(code: ErrorCode): PublicErrorMapping {
  if (DEPENDENCY_ERROR_CODES.has(code)) {
    return {
      code: 'dependency_unavailable',
      status: ERROR_CATALOG.dependency_unavailable.status,
      retryAfterSeconds: DEPENDENCY_RETRY_AFTER_SECONDS,
    };
  }
  if (!PUBLIC_CODE_SET.has(code)) {
    return { code: 'internal_error', status: 500, retryAfterSeconds: null };
  }
  return { code, status: ERROR_CATALOG[code].status, retryAfterSeconds: null };
}

export interface FieldIssue {
  path: string;
  message: string;
  code: string;
}

export interface OrcErrorOptions {
  details?: Record<string, unknown>;
  cause?: unknown;
  expose?: boolean;
}

export class OrcError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly expose: boolean;

  constructor(code: ErrorCode, message?: string, options?: OrcErrorOptions) {
    const entry = ERROR_CATALOG[code];
    super(
      message ?? entry.title,
      options && 'cause' in options ? { cause: options.cause } : undefined,
    );
    this.name = new.target.name;
    this.code = code;
    this.status = entry.status;
    this.details = options?.details ? Object.freeze({ ...options.details }) : undefined;
    this.expose = options?.expose ?? entry.status < 500;
  }
}

export type ValidationSource =
  'body' | 'query' | 'params' | 'headers' | 'env' | 'job' | 'stream' | 'mcp';

export class ValidationError extends OrcError {
  readonly issues: readonly FieldIssue[];

  constructor(
    issues: readonly FieldIssue[],
    message?: string,
    options?: Omit<OrcErrorOptions, 'expose'>,
  ) {
    super('validation_failed', message, options);
    this.issues = Object.freeze(issues.map((i) => Object.freeze({ ...i })));
  }

  static fromZod(err: z.ZodError, source: ValidationSource): ValidationError {
    const issues: FieldIssue[] = err.issues.map((issue) => ({
      path: [source, ...issue.path.map((p) => String(p))].join('.'),
      message: issue.message,
      code: issue.code,
    }));
    return new ValidationError(issues, `Invalid ${source}`, { cause: err });
  }
}

export class NotFoundError extends OrcError {
  constructor(message?: string, options?: OrcErrorOptions) {
    super('not_found', message, options);
  }
}

export class ConflictError extends OrcError {
  constructor(message?: string, options?: OrcErrorOptions) {
    super('conflict', message, options);
  }
}

export class PreconditionFailedError extends OrcError {
  constructor(message?: string, options?: OrcErrorOptions) {
    super('precondition_failed', message, options);
  }
}

export class InvalidTransitionError extends OrcError {
  readonly from: TaskStatus;
  readonly to: TaskStatus;

  constructor(from: TaskStatus, to: TaskStatus, options?: Omit<OrcErrorOptions, 'details'>) {
    super('invalid_transition', `Invalid task state transition: ${from} -> ${to}`, {
      ...options,
      details: { from, to },
    });
    this.from = from;
    this.to = to;
  }
}

export function isOrcError(e: unknown): e is OrcError {
  return e instanceof OrcError;
}
