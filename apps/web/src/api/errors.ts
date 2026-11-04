// Problem Details (RFC 9457, contract §9.6) parsing for the web client.
import { ERROR_CATALOG, ERROR_CODES, ProblemDetailsSchema } from '@orc/shared';
import type { ErrorCode, FieldIssue } from '@orc/shared';

export type ApiErrorKind = 'http' | 'network' | 'invalid_response';

export interface ApiErrorInit {
  kind: ApiErrorKind;
  status: number;
  code: string;
  title: string;
  detail: string | null;
  requestId: string | null;
  correlationId: string | null;
  retryAfterSeconds: number | null;
  fieldIssues: readonly FieldIssue[];
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  /** HTTP status; 0 when the server could not be reached. */
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string | null;
  readonly requestId: string | null;
  readonly correlationId: string | null;
  readonly retryAfterSeconds: number | null;
  readonly fieldIssues: readonly FieldIssue[];
  /** Epoch ms when the error was received (anchor for Retry-After countdowns). */
  readonly receivedAt: number;

  constructor(init: ApiErrorInit) {
    super(init.detail ?? init.title);
    this.name = 'ApiError';
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.detail = init.detail;
    this.requestId = init.requestId;
    this.correlationId = init.correlationId;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.fieldIssues = init.fieldIssues;
    this.receivedAt = Date.now();
  }

  is(code: ErrorCode): boolean {
    return this.code === code;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function hasErrorCode(value: unknown, code: ErrorCode): boolean {
  return value instanceof ApiError && value.code === code;
}

/** `Retry-After` is either delta-seconds or an HTTP-date. */
export function parseRetryAfter(header: string | null, nowMs: number = Date.now()): number | null {
  if (header === null) {
    return null;
  }
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) {
    return null;
  }
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}

function isErrorCode(value: string): value is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(value);
}

function fallbackCode(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'validation_failed';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 412:
      return 'precondition_failed';
    case 413:
      return 'payload_too_large';
    case 428:
      return 'precondition_required';
    case 429:
      return 'rate_limited';
    case 503:
      return 'service_unavailable';
    default:
      return 'internal_error';
  }
}

/** Builds an ApiError from a non-2xx response body (Problem Details when valid, else a synthetic one). */
export function problemFromResponse(status: number, headers: Headers, body: unknown): ApiError {
  const headerRetry = parseRetryAfter(headers.get('Retry-After'));
  const headerRequestId = headers.get('X-Request-Id');
  const parsed = ProblemDetailsSchema.safeParse(body);
  if (parsed.success) {
    const p = parsed.data;
    return new ApiError({
      kind: 'http',
      status,
      code: p.code,
      title: p.title,
      detail: p.detail ?? null,
      requestId: p.requestId,
      correlationId: p.correlationId,
      retryAfterSeconds: headerRetry ?? p.retryAfterSeconds ?? null,
      fieldIssues: p.errors ?? [],
    });
  }
  const loose = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const rawCode = typeof loose.code === 'string' ? loose.code : '';
  const code = isErrorCode(rawCode) ? rawCode : fallbackCode(status);
  return new ApiError({
    kind: 'http',
    status,
    code,
    title: typeof loose.title === 'string' ? loose.title : ERROR_CATALOG[code].title,
    detail: typeof loose.detail === 'string' ? loose.detail : null,
    requestId: typeof loose.requestId === 'string' ? loose.requestId : headerRequestId,
    correlationId: typeof loose.correlationId === 'string' ? loose.correlationId : null,
    retryAfterSeconds: headerRetry,
    fieldIssues: [],
  });
}

export function networkError(cause: unknown): ApiError {
  const err = new ApiError({
    kind: 'network',
    status: 0,
    code: 'network_error',
    title: 'Cannot reach the server',
    detail: 'The request did not reach the API. Check your connection and try again.',
    requestId: null,
    correlationId: null,
    retryAfterSeconds: null,
    fieldIssues: [],
  });
  err.cause = cause;
  return err;
}

export function invalidResponseError(status: number, headers: Headers, cause: unknown): ApiError {
  const err = new ApiError({
    kind: 'invalid_response',
    status,
    code: 'invalid_response',
    title: 'Unexpected response from the server',
    detail: 'The API answered with data this version of the web app does not understand.',
    requestId: headers.get('X-Request-Id'),
    correlationId: headers.get('X-Correlation-Id'),
    retryAfterSeconds: null,
    fieldIssues: [],
  });
  err.cause = cause;
  return err;
}

/**
 * Maps Problem field issues (`body.prompt`, `body.allowedTools.2`) to form field keys
 * (`prompt`, `allowedTools.2`). Only the first message per field is kept.
 */
export function fieldErrorsOf(error: unknown, source = 'body'): Record<string, string> {
  if (!(error instanceof ApiError)) {
    return {};
  }
  const out: Record<string, string> = {};
  const prefix = `${source}.`;
  for (const issue of error.fieldIssues) {
    const key = issue.path.startsWith(prefix) ? issue.path.slice(prefix.length) : issue.path;
    if (out[key] === undefined) {
      out[key] = issue.message;
    }
  }
  return out;
}
