// /auth: login, logout, me, password, personal access tokens (contract §9.5, §15.2-§15.4).
import { z } from 'zod';
import { RateLimiterRes } from 'rate-limiter-flexible';
import {
  ApiTokenSchema,
  ChangePasswordRequestSchema,
  CreateApiTokenRequestSchema,
  CreatedApiTokenSchema,
  IdSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  MeResponseSchema,
  OrcError,
  toIso,
} from '@orc/shared';
import {
  DEFAULT_SCRYPT_PARAMS,
  dummyPasswordVerify,
  generateCsrfToken,
  generatePat,
  generateSessionToken,
  hashPassword,
  validatePasswordPolicy,
  verifyPassword,
} from '@orc/security';
import type { ScryptParams } from '@orc/security';
import type { UserRecord } from '@orc/database';
import { auditContext, writeAudit } from '../audit.js';
import { clearSessionCookie, permissionsOf, sessionCookie } from '../auth.js';
import { sendJson, setLocation } from '../http.js';
import { toApiToken, toUser } from '../mappers.js';
import type { RateLimiters } from '../rate-limit.js';
import { defineRoute } from '../route.js';
import type { AnyRouteDef } from '../route.js';
import type { AppDeps } from '../types.js';

const REDIS_BOUND_MS = 2_000;

export function scryptParams(deps: AppDeps): ScryptParams {
  return { ...DEFAULT_SCRYPT_PARAMS, N: deps.config.passwordScryptN };
}

export function loginUserKey(usernameLower: string): string {
  return `user:${usernameLower}`;
}

async function bounded<T>(p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new OrcError('redis_unavailable', 'login throttle timed out')), REDIS_BOUND_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function throttled(retryAfterSeconds: number): OrcError {
  return new OrcError('login_throttled', 'Too many login attempts', {
    details: { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)) },
  });
}

/** Login throttling is the brute-force defence: Redis failures fail closed (503, §9.6). */
function failClosed(limiters: RateLimiters, err: unknown): OrcError {
  limiters.warnUnavailable('login', err);
  return new OrcError('redis_unavailable', 'Login throttle unavailable', { cause: err });
}

const TokenParams = z.object({ tokenId: IdSchema });

export function authRoutes(limiters: RateLimiters): AnyRouteDef[] {
  return [
    defineRoute({
      method: 'post',
      path: '/auth/login',
      operationId: 'login',
      summary: 'Log in with username and password (sets the session cookie)',
      tag: 'auth',
      auth: 'public',
      rateClass: 'login',
      body: LoginRequestSchema,
      responses: {
        200: { description: 'Logged in', schema: LoginResponseSchema, headers: ['Set-Cookie'] },
        401: { description: 'invalid_credentials' },
        429: { description: 'login_throttled', headers: ['Retry-After'] },
      },
      async handler(c) {
        const { deps, body } = c;
        const repos = deps.db.repos;
        const { config } = deps;
        const nowMs = deps.clock ? deps.clock.nowMs() : Date.now();
        const userKey = loginUserKey(body.username);
        let current: RateLimiterRes | null;
        try {
          current = await bounded(limiters.loginUser.get(userKey));
        } catch (err) {
          throw failClosed(limiters, err);
        }
        if (current !== null && current.consumedPoints > config.loginMaxFailures) {
          throw throttled(current.msBeforeNext / 1000);
        }
        const user = await repos.users.findByUsername(body.username);
        if (user !== null && user.lockedUntil !== null && Date.parse(user.lockedUntil) > nowMs) {
          throw throttled((Date.parse(user.lockedUntil) - nowMs) / 1000);
        }
        let verified = { ok: false, needsRehash: false };
        if (user) verified = await verifyPassword(body.password, user.passwordHash, scryptParams(deps));
        else await dummyPasswordVerify();

        if (!user || !verified.ok || !user.isActive) {
          await recordFailure(deps, limiters, c.req, c.res, body.username, user, nowMs);
          throw new OrcError('invalid_credentials', 'Invalid username or password');
        }

        await bounded(limiters.loginUser.delete(userKey)).catch((err: unknown) => {
          deps.logger.warn({ err }, 'login failure counter reset failed');
        });
        if (verified.needsRehash) {
          try {
            await repos.users.update(user.id, user.rowVer, {
              passwordHash: await hashPassword(body.password, scryptParams(deps)),
            });
          } catch (err) {
            deps.logger.warn({ err, userId: user.id }, 'password rehash failed');
          }
        }
        const { token, hash } = generateSessionToken();
        const csrfToken = generateCsrfToken();
        const session = await repos.authSessions.insert({
          userId: user.id,
          tokenHash: hash,
          csrfToken,
          absoluteTtlSeconds: config.sessionAbsoluteTtlSeconds,
          idleTtlSeconds: config.sessionIdleTtlSeconds,
          ip: c.ctx.ip,
          userAgent: c.ctx.userAgent,
        });
        await repos.users.recordLoginSuccess(user.id);
        const fresh = (await repos.users.findById(user.id)) ?? user;
        await writeAudit(deps, {
          action: 'auth.login',
          actor: { type: 'user', userId: user.id, label: user.username },
          entityType: 'session',
          entityId: session.id,
          outcome: 'success',
          ...auditContext(c.req, c.res),
        });
        c.res.append('Set-Cookie', sessionCookie(deps, token));
        sendJson(c.res, 200, {
          user: toUser(fresh),
          csrfToken,
          expiresAt: toIso(session.expiresAt),
          permissions: [...permissionsOf(user.role)],
        });
      },
    }),
    defineRoute({
      method: 'post',
      path: '/auth/logout',
      operationId: 'logout',
      summary: 'Log out (revokes the session, clears the cookie)',
      tag: 'auth',
      auth: 'session',
      rateClass: 'auth',
      responses: { 204: { description: 'Logged out', headers: ['Set-Cookie'] } },
      async handler(c) {
        const auth = c.auth();
        if (auth.credential.kind === 'session') {
          await c.deps.db.repos.authSessions.revoke(auth.credential.sessionId, 'logout');
          await writeAudit(c.deps, {
            action: 'auth.logout',
            actor: { type: 'user', userId: auth.user.id, label: auth.user.username },
            entityType: 'session',
            entityId: auth.credential.sessionId,
            outcome: 'success',
            ...auditContext(c.req, c.res),
          });
        }
        clearSessionCookie(c.deps, c.res);
        c.res.status(204).end();
      },
    }),
    defineRoute({
      method: 'get',
      path: '/auth/me',
      operationId: 'getMe',
      summary: 'Current user, permissions and authentication method',
      tag: 'auth',
      auth: 'any',
      rateClass: 'read',
      responses: { 200: { description: 'Current identity', schema: MeResponseSchema } },
      handler(c) {
        const auth = c.auth();
        const cred = auth.credential;
        sendJson(c.res, 200, {
          user: toUser(auth.user),
          permissions: [...auth.permissions],
          authMethod: cred.kind,
          csrfToken: cred.kind === 'session' ? cred.csrfToken : null,
          sessionExpiresAt: cred.kind === 'session' ? toIso(cred.expiresAt) : null,
          tokenReadOnly: cred.kind === 'token' && cred.readOnly,
        });
        return Promise.resolve();
      },
    }),
    defineRoute({
      method: 'post',
      path: '/auth/password',
      operationId: 'changePassword',
      summary: 'Change the own password (other sessions are revoked)',
      tag: 'auth',
      auth: 'session',
      rateClass: 'auth',
      body: ChangePasswordRequestSchema,
      responses: { 204: { description: 'Password changed' }, 401: { description: 'invalid_credentials' } },
      async handler(c) {
        const { deps, body } = c;
        const auth = c.auth();
        const repos = deps.db.repos;
        const user = await repos.users.findById(auth.user.id);
        if (!user) throw new OrcError('unauthenticated');
        const verified = await verifyPassword(body.currentPassword, user.passwordHash, scryptParams(deps));
        if (!verified.ok) throw new OrcError('invalid_credentials', 'Current password is incorrect');
        validatePasswordPolicy(body.newPassword, user.username);
        await repos.users.update(user.id, user.rowVer, {
          passwordHash: await hashPassword(body.newPassword, scryptParams(deps)),
        });
        const except = auth.credential.kind === 'session' ? auth.credential.sessionId : undefined;
        const revoked = await repos.authSessions.revokeAllForUser(user.id, 'password_changed', except);
        await writeAudit(deps, {
          action: 'auth.password_changed',
          actor: { type: 'user', userId: user.id, label: user.username },
          entityType: 'user',
          entityId: user.id,
          outcome: 'success',
          detail: { revokedSessions: revoked },
          ...auditContext(c.req, c.res),
        });
        c.res.status(204).end();
      },
    }),
    defineRoute({
      method: 'get',
      path: '/auth/tokens',
      operationId: 'listApiTokens',
      summary: 'List own personal access tokens',
      tag: 'auth',
      auth: 'session',
      permission: ['token:manage:own'],
      rateClass: 'read',
      responses: { 200: { description: 'Own tokens', schema: z.array(ApiTokenSchema) } },
      async handler(c) {
        const rows = await c.deps.db.repos.apiTokens.listByUser(c.viewer().userId);
        sendJson(c.res, 200, rows.map(toApiToken));
      },
    }),
    defineRoute({
      method: 'post',
      path: '/auth/tokens',
      operationId: 'createApiToken',
      summary: 'Create a personal access token (returned once)',
      tag: 'auth',
      auth: 'session',
      permission: ['token:manage:own'],
      rateClass: 'auth',
      body: CreateApiTokenRequestSchema,
      responses: {
        201: { description: 'Created token', schema: CreatedApiTokenSchema, headers: ['Location'] },
        409: { description: 'conflict (name)' },
      },
      async handler(c) {
        const { deps, body } = c;
        const viewer = c.viewer();
        const pat = generatePat();
        const nowMs = deps.clock ? deps.clock.nowMs() : Date.now();
        let created;
        try {
          created = await deps.db.repos.apiTokens.insert({
            userId: viewer.userId,
            name: body.name,
            prefix: pat.prefix,
            tokenHash: pat.hash,
            readOnly: body.readOnly,
            expiresAt: new Date(nowMs + body.expiresInDays * 86_400_000),
          });
        } catch (err) {
          if (err instanceof OrcError && err.code === 'unique_violation') {
            throw new OrcError('conflict', 'A token with this name already exists', { cause: err });
          }
          throw err;
        }
        await writeAudit(deps, {
          action: 'auth.token_created',
          actor: { type: 'user', userId: viewer.userId, label: viewer.username ?? viewer.userId },
          entityType: 'api_token',
          entityId: created.id,
          outcome: 'success',
          after: { name: created.name, prefix: created.prefix, readOnly: created.readOnly, expiresAt: created.expiresAt },
          ...auditContext(c.req, c.res),
        });
        setLocation(c.res, `/auth/tokens/${created.id}`);
        sendJson(c.res, 201, { token: pat.token, apiToken: toApiToken(created) });
      },
    }),
    defineRoute({
      method: 'delete',
      path: '/auth/tokens/:tokenId',
      operationId: 'revokeApiToken',
      summary: 'Revoke an own personal access token',
      tag: 'auth',
      auth: 'session',
      permission: ['token:manage:own'],
      rateClass: 'auth',
      params: TokenParams,
      responses: { 204: { description: 'Revoked' }, 404: { description: 'not_found' } },
      async handler(c) {
        const viewer = c.viewer();
        const ok = await c.deps.db.repos.apiTokens.revoke(c.params.tokenId, viewer.userId);
        if (!ok) throw new OrcError('not_found', 'Token not found');
        await writeAudit(c.deps, {
          action: 'auth.token_revoked',
          actor: { type: 'user', userId: viewer.userId, label: viewer.username ?? viewer.userId },
          entityType: 'api_token',
          entityId: c.params.tokenId,
          outcome: 'success',
          ...auditContext(c.req, c.res),
        });
        c.res.status(204).end();
      },
    }),
  ];
}

async function recordFailure(
  deps: AppDeps,
  limiters: RateLimiters,
  req: Parameters<typeof auditContext>[0],
  res: Parameters<typeof auditContext>[1],
  username: string,
  user: UserRecord | null,
  nowMs: number,
): Promise<void> {
  const { config } = deps;
  const userKey = loginUserKey(username);
  let counted: RateLimiterRes;
  try {
    counted = await bounded(limiters.loginUser.consume(userKey));
  } catch (err) {
    if (!(err instanceof RateLimiterRes)) throw failClosed(limiters, err);
    counted = err;
  }
  let lockedUntil: Date | null = null;
  if (counted.consumedPoints === config.loginMaxFailures) {
    try {
      await bounded(limiters.loginUser.block(userKey, config.loginLockSeconds));
    } catch (err) {
      throw failClosed(limiters, err);
    }
    lockedUntil = new Date(nowMs + config.loginLockSeconds * 1000);
    await writeAudit(deps, {
      action: 'auth.lockout',
      actor: user ? { type: 'user', userId: user.id, label: user.username } : { type: 'system', label: 'anonymous' },
      entityType: 'user',
      entityId: user?.id ?? null,
      outcome: 'success',
      detail: { username, lockSeconds: config.loginLockSeconds },
      ...auditContext(req, res),
    });
  }
  if (user) await deps.db.repos.users.recordLoginFailure(user.id, lockedUntil);
  await writeAudit(deps, {
    action: 'auth.login',
    actor: user ? { type: 'user', userId: user.id, label: user.username } : { type: 'system', label: 'anonymous' },
    entityType: 'session',
    entityId: null,
    outcome: 'failure',
    detail: { username, reason: user ? (user.isActive ? 'bad_password' : 'inactive') : 'unknown_user' },
    ...auditContext(req, res),
  });
}
