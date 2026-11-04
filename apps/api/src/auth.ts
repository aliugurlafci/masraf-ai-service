// Authentication (session cookie | PAT | anonymous), CSRF double-submit and Origin check (contract §9.1, §15.2, §15.3).
import type { NextFunction, Request, Response } from 'express';
import { parseCookie, stringifySetCookie } from 'cookie';
import { ROLE_PERMISSIONS } from '@orc/shared';
import type { Permission, Role } from '@orc/shared';
import { sha256, timingSafeEqualStr } from '@orc/security';
import type { UserRecord } from '@orc/database';
import type { Viewer } from '@orc/task-manager';
import { state } from './context.js';
import { auditContext, writeAudit } from './audit.js';
import { problem, sendProblem } from './problem.js';
import { refuseExhaustedAuthBudget } from './rate-limit.js';
import type { AuthFailureThrottle, RateLimiters } from './rate-limit.js';
import type { AppDeps, AuthenticatedState, Credential, RequestState } from './types.js';

const PAT_REGEX = /^orc_pat_[A-Za-z0-9_-]{20,128}$/;
const SESSION_TOKEN_REGEX = /^[A-Za-z0-9_-]{20,128}$/;
/** Idle extension / PAT last-used writes happen at most once per minute (§15.2, §15.3). */
export const TOUCH_INTERVAL_MS = 60_000;
const UNSAFE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isUnsafeMethod(method: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase());
}

export function sessionCookieName(cookieSecure: boolean): string {
  return cookieSecure ? '__Host-orc_sid' : 'orc_sid';
}

export function sessionCookie(deps: AppDeps, token: string): string {
  return stringifySetCookie({
    name: sessionCookieName(deps.config.cookieSecure),
    value: token,
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure: deps.config.cookieSecure,
    maxAge: deps.config.sessionAbsoluteTtlSeconds,
  });
}

export function clearSessionCookie(deps: AppDeps, res: Response): void {
  res.append(
    'Set-Cookie',
    stringifySetCookie({
      name: sessionCookieName(deps.config.cookieSecure),
      value: '',
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: deps.config.cookieSecure,
      maxAge: 0,
    }),
  );
}

export function permissionsOf(role: Role): ReadonlySet<Permission> {
  return new Set<Permission>(ROLE_PERMISSIONS[role]);
}

export function viewerOf(user: UserRecord, credential: Credential): Viewer {
  return {
    userId: user.id,
    role: user.role,
    permissions: permissionsOf(user.role),
    tokenId: credential.kind === 'token' ? credential.tokenId : null,
    readOnly: credential.kind === 'token' && credential.readOnly,
    username: user.username,
  };
}

export function authenticated(user: UserRecord, credential: Credential): AuthenticatedState {
  const viewer = viewerOf(user, credential);
  return {
    kind: 'authenticated',
    user,
    role: user.role,
    permissions: viewer.permissions,
    credential,
    viewer,
  };
}

/** Cookie header -> res.locals.orc.cookies (cookie package; §9.1). */
export function cookieParser() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.get('cookie');
    state(res).cookies = header === undefined ? {} : parseCookie(header);
    next();
  };
}

/**
 * Resolves the credential of a request (session | PAT | anonymous); never rejects: routes enforce auth (§9.1).
 * Before a credential DB lookup the client IP's `auth` budget is checked: an exhausted IP is not looked up at all
 * (anonymous, failure `rate_limited`), and every failed lookup counts against it, so bogus credentials cost at most
 * the class's points in lookups per IP and window.
 */
export function authenticate(deps: AppDeps, throttle: AuthFailureThrottle) {
  const repos = deps.db.repos;
  const nowMs = (): number => (deps.clock ? deps.clock.nowMs() : Date.now());
  const refusedBeforeLookup = async (req: Request, s: RequestState): Promise<boolean> => {
    const verdict = await throttle.check(req);
    if (!verdict.limited) return false;
    s.auth = { kind: 'anonymous', failure: 'rate_limited' };
    s.authThrottle = { counted: false, limited: verdict.res };
    return true;
  };
  const failedLookup = async (
    req: Request,
    s: RequestState,
    failure: 'unauthenticated' | 'session_expired',
  ): Promise<void> => {
    const verdict = await throttle.record(req);
    s.auth = { kind: 'anonymous', failure: verdict.limited ? 'rate_limited' : failure };
    s.authThrottle = { counted: true, limited: verdict.limited ? verdict.res : null };
  };
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const s = state(res);
    const authorization = req.get('authorization');
    if (authorization !== undefined) {
      const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
      const token = match?.[1];
      if (token === undefined || !PAT_REGEX.test(token)) {
        s.auth = { kind: 'anonymous', failure: 'unauthenticated' };
        next();
        return;
      }
      if (await refusedBeforeLookup(req, s)) {
        next();
        return;
      }
      const tokenHash = sha256(token);
      const found = await repos.apiTokens.findActiveByHash(tokenHash);
      if (found === null || !found.user.isActive) {
        await failedLookup(req, s, 'unauthenticated');
        next();
        return;
      }
      const lastUsed = found.token.lastUsedAt === null ? 0 : Date.parse(found.token.lastUsedAt);
      if (nowMs() - lastUsed >= TOUCH_INTERVAL_MS) {
        repos.apiTokens.touchLastUsed(found.token.id).catch((err: unknown) => {
          deps.logger.warn({ err, tokenId: found.token.id }, 'token last-used update failed');
        });
      }
      s.auth = authenticated(found.user, {
        kind: 'token',
        tokenId: found.token.id,
        tokenHash,
        readOnly: found.token.readOnly,
      });
      next();
      return;
    }
    const cookieValue = s.cookies[sessionCookieName(deps.config.cookieSecure)];
    if (cookieValue === undefined || cookieValue === '') {
      next();
      return;
    }
    if (!SESSION_TOKEN_REGEX.test(cookieValue)) {
      s.auth = { kind: 'anonymous', failure: 'session_expired' };
      next();
      return;
    }
    if (await refusedBeforeLookup(req, s)) {
      next();
      return;
    }
    const tokenHash = sha256(cookieValue);
    const found = await repos.authSessions.findActiveByTokenHash(tokenHash);
    if (found === null || !found.user.isActive) {
      await failedLookup(req, s, 'session_expired');
      next();
      return;
    }
    const { session, user } = found;
    if (nowMs() - session.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS) {
      try {
        await repos.authSessions.touch(session.id, deps.config.sessionIdleTtlSeconds);
      } catch (err) {
        deps.logger.warn({ err, sessionId: session.id }, 'session idle extension failed');
      }
    }
    s.auth = authenticated(user, {
      kind: 'session',
      sessionId: session.id,
      tokenHash,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
    });
    next();
  };
}

/**
 * Unsafe methods: `Origin`, when present, must equal PUBLIC_ORIGIN (also on /auth/login); session-authenticated
 * requests must carry `X-CSRF-Token` equal to the session's token (except /auth/login). PATs never need CSRF (§15.2).
 * Anonymous rejections count against the client IP's `auth` budget; once it is exhausted they answer 429 without an
 * audit row, so unauthenticated floods cannot cause unbounded DB writes.
 */
export function csrfProtection(deps: AppDeps, limiters: RateLimiters) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!isUnsafeMethod(req.method)) {
      next();
      return;
    }
    const s = state(res);
    const origin = req.get('origin');
    const originOk = origin === undefined || origin === deps.config.publicOrigin;
    const isLogin = req.path === '/api/v1/auth/login';
    let tokenOk = true;
    if (s.auth.kind === 'authenticated' && s.auth.credential.kind === 'session' && !isLogin) {
      const presented = req.get('x-csrf-token');
      tokenOk = presented !== undefined && timingSafeEqualStr(presented, s.auth.credential.csrfToken);
    }
    if (originOk && tokenOk) {
      next();
      return;
    }
    const auth = s.auth;
    if (auth.kind === 'anonymous' && (await refuseExhaustedAuthBudget(req, res, limiters))) return;
    await writeAudit(deps, {
      action: 'auth.csrf_rejected',
      actor:
        auth.kind === 'authenticated'
          ? { type: 'user', userId: auth.user.id, label: auth.user.username }
          : { type: 'system', label: 'anonymous' },
      entityType: 'session',
      entityId: auth.kind === 'authenticated' && auth.credential.kind === 'session' ? auth.credential.sessionId : null,
      outcome: 'denied',
      detail: { method: req.method, path: req.path, reason: originOk ? 'token' : 'origin' },
      ...auditContext(req, res),
    });
    sendProblem(req, res, problem('csrf_failed', originOk ? 'CSRF token missing or invalid' : 'Origin not allowed'));
  };
}
