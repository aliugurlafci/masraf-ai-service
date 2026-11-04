// Problem Details (RFC 9457) and the error handler (contract §9.1, §9.6).
import type { NextFunction, Request, Response } from 'express';
import {
  ERROR_CATALOG,
  OrcError,
  ValidationError,
  problemTypeUri,
  toIso,
  toPublicError,
} from '@orc/shared';
import type { ErrorCode, FieldIssue, ProblemDetails } from '@orc/shared';
import type { Logger } from '@orc/logger';
import { maybeState } from './context.js';
import type { AppDeps } from './types.js';
import { auditDenied } from './audit.js';

export interface PublicProblem {
  status: number;
  code: ErrorCode;
  detail: string | undefined;
  errors: FieldIssue[] | undefined;
  retryAfterSeconds: number | null;
  /** True when the original error was a server-side failure (logged at error). */
  internal: boolean;
}

interface BodyParserError {
  type: string;
  status?: number;
}

function isBodyParserError(err: unknown): err is BodyParserError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    typeof err.type === 'string' &&
    'status' in err
  );
}

/** §9.2: every 503 carries Retry-After (dependency failures already map to 5 s through toPublicError). */
const DEFAULT_503_RETRY_AFTER_SECONDS = 5;

function retryAfterOf(err: OrcError): number | null {
  const raw = err.details?.['retryAfterSeconds'];
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.ceil(raw) : null;
}

function issuesOf(err: OrcError): FieldIssue[] | undefined {
  if (err instanceof ValidationError) return err.issues.map((i) => ({ ...i }));
  if (err.code === 'validation_failed') {
    const field = err.details?.['field'];
    if (typeof field === 'string') return [{ path: field, message: err.message, code: 'custom' }];
  }
  return undefined;
}

/** Maps any thrown value to what may leave the process (§9.6, F9). */
export function toPublicProblem(err: unknown): PublicProblem {
  if (err instanceof OrcError) {
    const mapped = toPublicError(err.code);
    const exposeDetail = mapped.status < 500 && mapped.code === err.code && err.expose;
    return {
      status: mapped.status,
      code: mapped.code,
      detail: exposeDetail ? err.message : undefined,
      errors: mapped.code === 'validation_failed' ? issuesOf(err) : undefined,
      retryAfterSeconds:
        mapped.retryAfterSeconds ??
        retryAfterOf(err) ??
        (mapped.status === 503 ? DEFAULT_503_RETRY_AFTER_SECONDS : null),
      internal: mapped.code === 'internal_error',
    };
  }
  if (isBodyParserError(err)) {
    const map: Record<string, ErrorCode> = {
      'entity.parse.failed': 'invalid_json',
      'entity.too.large': 'payload_too_large',
      'encoding.unsupported': 'unsupported_media_type',
      'charset.unsupported': 'unsupported_media_type',
      'entity.verify.failed': 'validation_failed',
      'request.aborted': 'validation_failed',
      'request.size.invalid': 'validation_failed',
    };
    const code = map[err.type];
    if (code !== undefined) {
      return {
        status: ERROR_CATALOG[code].status,
        code,
        detail: ERROR_CATALOG[code].title,
        errors: undefined,
        retryAfterSeconds: null,
        internal: false,
      };
    }
  }
  return {
    status: 500,
    code: 'internal_error',
    detail: undefined,
    errors: undefined,
    retryAfterSeconds: null,
    internal: true,
  };
}

export function problemBody(req: Request, res: Response, p: PublicProblem): ProblemDetails {
  const s = maybeState(res);
  const requestId = s?.requestId ?? 'unknown';
  const body: ProblemDetails = {
    type: problemTypeUri(p.code),
    title: ERROR_CATALOG[p.code].title,
    status: p.status,
    detail:
      p.status >= 500 ? `An internal error occurred. Reference: ${requestId}` : (p.detail ?? ERROR_CATALOG[p.code].title),
    instance: req.originalUrl.split('?')[0] ?? req.path,
    code: p.code,
    requestId,
    correlationId: s?.correlationId ?? requestId,
  };
  if (p.errors !== undefined && p.errors.length > 0) body.errors = p.errors;
  if (p.retryAfterSeconds !== null) body.retryAfterSeconds = p.retryAfterSeconds;
  return body;
}

/** Writes a Problem Details response (`application/problem+json`). */
export function sendProblem(req: Request, res: Response, p: PublicProblem): void {
  const body = problemBody(req, res, p);
  if (p.retryAfterSeconds !== null) res.setHeader('Retry-After', String(p.retryAfterSeconds));
  res.status(p.status);
  res.setHeader('Content-Type', 'application/problem+json; charset=utf-8');
  res.send(JSON.stringify(body));
}

export function problem(code: ErrorCode, detail?: string, retryAfterSeconds: number | null = null): PublicProblem {
  return {
    status: ERROR_CATALOG[code].status,
    code,
    detail,
    errors: undefined,
    retryAfterSeconds,
    internal: false,
  };
}

function logError(logger: Logger, err: unknown, p: PublicProblem, req: Request): void {
  if (p.internal) {
    logger.error({ err, code: p.code, method: req.method, path: req.path }, 'request failed');
  } else if (p.code === 'dependency_unavailable') {
    logger.warn({ err, code: p.code, method: req.method, path: req.path }, 'dependency unavailable');
  }
}

/** Final error handler: Problem Details, or an SSE `error` event once an event stream has started. */
export function errorHandler(deps: AppDeps) {
  return (err: unknown, req: Request, res: Response, next: NextFunction): void => {
    const p = toPublicProblem(err);
    logError(deps.logger, err, p, req);
    if (err instanceof OrcError && err.code === 'path_escape') {
      void auditDenied(deps, req, res, 'security.path_escape', { message: err.message });
    }
    if (res.headersSent) {
      if (maybeState(res)?.eventStream === true && !res.writableEnded) {
        const payload = {
          v: 1,
          type: 'error',
          code: p.code,
          message: p.status >= 500 ? ERROR_CATALOG[p.code].title : (p.detail ?? ERROR_CATALOG[p.code].title),
          at: toIso(new Date()),
        };
        res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
        res.end();
        return;
      }
      next(err);
      return;
    }
    sendProblem(req, res, p);
  };
}
