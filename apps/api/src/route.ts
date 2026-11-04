// Declarative route table: one definition drives the Express route (auth guard -> rate limiter -> permission -> Zod
// validation -> handler, contract §9.1) and its OpenAPI 3.1 operation (§9.5).
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import type { z } from 'zod';
import { OrcError, ValidationError } from '@orc/shared';
import type { Permission, RateLimitClass } from '@orc/shared';
import type { Viewer } from '@orc/task-manager';
import { requestContext, state } from './context.js';
import { auditDenied } from './audit.js';
import { clearSessionCookie } from './auth.js';
import { problem, sendProblem } from './problem.js';
import { refuseExhaustedAuthBudget } from './rate-limit.js';
import type { RateLimiters } from './rate-limit.js';
import type { AppDeps, AuthenticatedState, RequestContext } from './types.js';

/** P = public, S = session cookie only, S/T = session or PAT (§9.5 Auth column). */
export type AuthMode = 'public' | 'session' | 'any';
export type HttpMethod = 'get' | 'post' | 'patch' | 'delete';

export interface ResponseDoc {
  description: string;
  /** JSON body schema (application/json unless `contentType`). */
  schema?: z.ZodType;
  contentType?: string;
  /** Documented response header names. */
  headers?: readonly string[];
}

export interface RequestHeaderDoc {
  name: 'If-Match' | 'If-None-Match' | 'Idempotency-Key' | 'Last-Event-ID' | 'Accept' | 'Accept-Encoding';
  required: boolean;
  description: string;
}

type Out<S> = S extends z.ZodType ? z.output<S> : undefined;

export interface HandlerCtx<P, Q, B> {
  req: Request;
  res: Response;
  params: P;
  query: Q;
  body: B;
  deps: AppDeps;
  /** Request ids / client data for services and audit. */
  ctx: RequestContext;
  /** The authenticated viewer (guaranteed on non-public routes). */
  viewer(): Viewer;
  auth(): AuthenticatedState;
}

export interface RouteDef<
  P extends z.ZodType | undefined = undefined,
  Q extends z.ZodType | undefined = undefined,
  B extends z.ZodType | undefined = undefined,
> {
  method: HttpMethod;
  /** Express path relative to /api/v1 (e.g. `/tasks/:taskId`). */
  path: string;
  operationId: string;
  summary: string;
  tag: string;
  auth: AuthMode;
  /** Any-of permission list checked at route level (403 forbidden + audit authz.denied). */
  permission?: readonly Permission[];
  rateClass: RateLimitClass | null;
  params?: P;
  query?: Q;
  body?: B;
  /** Body schema is optional (missing body => `{}`). */
  bodyOptional?: boolean;
  headers?: readonly RequestHeaderDoc[];
  responses: Readonly<Record<number, ResponseDoc>>;
  handler(c: HandlerCtx<Out<P>, Out<Q>, Out<B>>): Promise<void>;
}

export interface AnyRouteDef {
  method: HttpMethod;
  path: string;
  operationId: string;
  summary: string;
  tag: string;
  auth: AuthMode;
  permission?: readonly Permission[];
  rateClass: RateLimitClass | null;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  bodyOptional?: boolean;
  headers?: readonly RequestHeaderDoc[];
  responses: Readonly<Record<number, ResponseDoc>>;
  handler(c: HandlerCtx<unknown, unknown, unknown>): Promise<void>;
}

export function defineRoute<
  P extends z.ZodType | undefined = undefined,
  Q extends z.ZodType | undefined = undefined,
  B extends z.ZodType | undefined = undefined,
>(def: RouteDef<P, Q, B>): AnyRouteDef {
  return def;
}

export const API_PREFIX = '/api/v1';

/** `/tasks/:taskId` -> `/api/v1/tasks/{taskId}`. */
export function openApiPath(path: string): string {
  return `${API_PREFIX}${path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`;
}

/** Regex matching concrete request paths of a route template (405 detection). */
export function pathMatcher(path: string): RegExp {
  const pattern = `${API_PREFIX}${path}`
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${pattern}/?$`);
}

function authGuard(def: AnyRouteDef, deps: AppDeps, limiters: RateLimiters): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (def.auth === 'public') {
      next();
      return;
    }
    const auth = state(res).auth;
    if (auth.kind === 'anonymous') {
      if (await refuseExhaustedAuthBudget(req, res, limiters)) return;
      if (auth.failure === 'session_expired') {
        clearSessionCookie(deps, res);
        sendProblem(req, res, problem('session_expired'));
        return;
      }
      sendProblem(req, res, problem('unauthenticated'));
      return;
    }
    if (def.auth === 'session' && auth.credential.kind === 'token') {
      sendProblem(req, res, problem('token_not_allowed'));
      return;
    }
    next();
  };
}

function permissionGuard(def: AnyRouteDef, deps: AppDeps): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const auth = state(res).auth;
    if (auth.kind !== 'authenticated') {
      next();
      return;
    }
    const readOnlyViolation =
      auth.credential.kind === 'token' && auth.credential.readOnly && req.method !== 'GET' && req.method !== 'HEAD';
    const required = def.permission ?? [];
    const missing = required.length > 0 && !required.some((p) => auth.permissions.has(p));
    if (!readOnlyViolation && !missing) {
      next();
      return;
    }
    await auditDenied(deps, req, res, 'authz.denied', {
      permission: required,
      reason: readOnlyViolation ? 'read_only_token' : 'missing_permission',
    });
    sendProblem(req, res, problem('forbidden', readOnlyViolation ? 'Read-only API token' : 'Permission denied'));
  };
}

function parseOrThrow(schema: z.ZodType, value: unknown, source: 'params' | 'query' | 'body'): unknown {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error, source);
  return parsed.data;
}

function handlerOf(def: AnyRouteDef, deps: AppDeps): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const params = def.params ? parseOrThrow(def.params, req.params, 'params') : undefined;
    const query = def.query ? parseOrThrow(def.query, req.query, 'query') : undefined;
    let body: unknown;
    if (def.body) {
      const raw: unknown = req.body;
      body = parseOrThrow(def.body, raw === undefined && def.bodyOptional === true ? {} : raw, 'body');
    }
    res.locals['params'] = params;
    res.locals['query'] = query;
    res.locals['body'] = body;
    const auth = (): AuthenticatedState => {
      const a = state(res).auth;
      if (a.kind !== 'authenticated') throw new OrcError('unauthenticated');
      return a;
    };
    await def.handler({
      req,
      res,
      params: res.locals['params'] as unknown,
      query: res.locals['query'] as unknown,
      body: res.locals['body'] as unknown,
      deps,
      ctx: requestContext(req, res),
      auth,
      viewer: () => auth().viewer,
    });
  };
}

export function mountRoutes(
  router: Router,
  defs: readonly AnyRouteDef[],
  deps: AppDeps,
  limiters: RateLimiters,
): void {
  for (const def of defs) {
    const chain: RequestHandler[] = [authGuard(def, deps, limiters)];
    if (def.rateClass !== null) chain.push(limiters.middleware(def.rateClass));
    chain.push(permissionGuard(def, deps), handlerOf(def, deps));
    router[def.method](def.path, ...chain);
  }
}
