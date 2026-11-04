// /users administration (contract §9.5, §15.1, §15.2).
import { z } from 'zod';
import {
  CreateUserRequestSchema,
  IdSchema,
  NotFoundError,
  OrcError,
  PageQuerySchema,
  UpdateUserRequestSchema,
  UserSchema,
  pageOf,
} from '@orc/shared';
import { hashPassword, validatePasswordPolicy } from '@orc/security';
import { etagToRowVer } from '@orc/database';
import type { UserRecord } from '@orc/database';
import { actorOf, keysetFromCursor, keysetPage } from '@orc/task-manager';
import { auditContext, writeAudit } from '../audit.js';
import { requireIfMatch, sendEntity, sendJson, setLocation } from '../http.js';
import { toUser } from '../mappers.js';
import type { RateLimiters } from '../rate-limit.js';
import { defineRoute } from '../route.js';
import type { AnyRouteDef } from '../route.js';
import { loginUserKey, scryptParams } from './auth.js';

const UserParams = z.object({ userId: IdSchema });
const USER_LIST_FILTERS = { list: 'users' } as const;

function diff(before: UserRecord, after: UserRecord): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const keys = ['displayName', 'email', 'role', 'isActive'] as const;
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of keys) {
    if (before[k] !== after[k]) {
      b[k] = before[k];
      a[k] = after[k];
    }
  }
  return { before: b, after: a };
}

export function userRoutes(limiters: RateLimiters): AnyRouteDef[] {
  return [
    defineRoute({
      method: 'get',
      path: '/users',
      operationId: 'listUsers',
      summary: 'List users',
      tag: 'users',
      auth: 'session',
      permission: ['user:read'],
      rateClass: 'read',
      query: PageQuerySchema,
      responses: { 200: { description: 'Page of users', schema: pageOf(UserSchema) } },
      async handler(c) {
        const after = keysetFromCursor(c.query.cursor, USER_LIST_FILTERS);
        const rows = await c.deps.db.repos.users.list({ limit: c.query.limit, ...(after ? { after } : {}) });
        sendJson(c.res, 200, keysetPage(rows, c.query.limit, USER_LIST_FILTERS, toUser));
      },
    }),
    defineRoute({
      method: 'post',
      path: '/users',
      operationId: 'createUser',
      summary: 'Create a user',
      tag: 'users',
      auth: 'session',
      permission: ['user:manage'],
      rateClass: 'write',
      body: CreateUserRequestSchema,
      responses: {
        201: { description: 'Created user', schema: UserSchema, headers: ['Location', 'ETag'] },
        409: { description: 'username_taken' },
      },
      async handler(c) {
        const { deps, body } = c;
        validatePasswordPolicy(body.password, body.username);
        const passwordHash = await hashPassword(body.password, scryptParams(deps));
        let user: UserRecord;
        try {
          user = await deps.db.repos.users.insert({
            username: body.username,
            displayName: body.displayName,
            email: body.email ?? null,
            role: body.role,
            passwordHash,
          });
        } catch (err) {
          if (err instanceof OrcError && err.code === 'unique_violation') {
            throw new OrcError('username_taken', 'Username already exists', { cause: err });
          }
          throw err;
        }
        await writeAudit(deps, {
          action: 'user.created',
          actor: actorOf(c.viewer()),
          entityType: 'user',
          entityId: user.id,
          outcome: 'success',
          after: { username: user.username, role: user.role, displayName: user.displayName },
          ...auditContext(c.req, c.res),
        });
        setLocation(c.res, `/users/${user.id}`);
        sendEntity(c.req, c.res, 201, toUser(user), user.rowVer);
      },
    }),
    defineRoute({
      method: 'get',
      path: '/users/:userId',
      operationId: 'getUser',
      summary: 'Get a user',
      tag: 'users',
      auth: 'session',
      permission: ['user:read'],
      rateClass: 'read',
      params: UserParams,
      headers: [{ name: 'If-None-Match', required: false, description: 'ETag of a cached copy (304)' }],
      responses: {
        200: { description: 'User', schema: UserSchema, headers: ['ETag'] },
        304: { description: 'Not modified' },
        404: { description: 'not_found' },
      },
      async handler(c) {
        const user = await c.deps.db.repos.users.findById(c.params.userId);
        if (!user) throw new NotFoundError('User not found');
        sendEntity(c.req, c.res, 200, toUser(user), user.rowVer);
      },
    }),
    defineRoute({
      method: 'patch',
      path: '/users/:userId',
      operationId: 'updateUser',
      summary: 'Update a user (disable revokes sessions and tokens)',
      tag: 'users',
      auth: 'session',
      permission: ['user:manage'],
      rateClass: 'write',
      params: UserParams,
      body: UpdateUserRequestSchema,
      headers: [{ name: 'If-Match', required: true, description: 'ETag of the user' }],
      responses: {
        200: { description: 'Updated user', schema: UserSchema, headers: ['ETag'] },
        404: { description: 'not_found' },
        409: { description: 'last_admin' },
        412: { description: 'precondition_failed' },
        428: { description: 'precondition_required' },
      },
      async handler(c) {
        const { deps, body } = c;
        const ifMatch = requireIfMatch(c.req);
        const viewer = c.viewer();
        const repos = deps.db.repos;
        const before = await repos.users.findById(c.params.userId);
        if (!before) throw new NotFoundError('User not found');
        const rowVer = etagToRowVer(ifMatch);
        let passwordHash: string | undefined;
        if (body.password !== undefined) {
          validatePasswordPolicy(body.password, before.username);
          passwordHash = await hashPassword(body.password, scryptParams(deps));
        }
        const removesAdmin =
          before.role === 'admin' &&
          before.isActive &&
          ((body.role !== undefined && body.role !== 'admin') || body.isActive === false);
        const after = await deps.db.transaction(
          async (t) => {
            const updated = await t.repos.users.update(before.id, rowVer, {
              ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
              ...(body.email !== undefined ? { email: body.email } : {}),
              ...(body.role !== undefined ? { role: body.role } : {}),
              ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
              ...(passwordHash !== undefined ? { passwordHash } : {}),
            });
            if (removesAdmin && (await t.repos.users.countActiveAdmins()) === 0) {
              throw new OrcError('last_admin', 'Cannot remove the last active admin');
            }
            return updated;
          },
          { name: 'user.update', isolationLevel: 'SERIALIZABLE' },
        );
        const disabled = before.isActive && !after.isActive;
        const roleChanged = before.role !== after.role;
        const cred = c.auth().credential;
        const ownSession = viewer.userId === after.id && cred.kind === 'session' ? cred.sessionId : undefined;
        let revokedSessions = 0;
        let revokedTokens = 0;
        if (disabled) {
          revokedSessions = await repos.authSessions.revokeAllForUser(after.id, 'user_disabled');
          revokedTokens = await repos.apiTokens.revokeAllForUser(after.id);
        } else if (roleChanged || passwordHash !== undefined) {
          revokedSessions = await repos.authSessions.revokeAllForUser(
            after.id,
            roleChanged ? 'role_changed' : 'password_reset',
            ownSession,
          );
        }
        const ctx = auditContext(c.req, c.res);
        const actor = actorOf(viewer);
        const changes = diff(before, after);
        await writeAudit(deps, {
          action: disabled ? 'user.disabled' : 'user.updated',
          actor,
          entityType: 'user',
          entityId: after.id,
          outcome: 'success',
          before: changes.before,
          after: changes.after,
          detail: { revokedSessions, revokedTokens, passwordReset: passwordHash !== undefined },
          ...ctx,
        });
        if (passwordHash !== undefined) {
          await writeAudit(deps, {
            action: 'auth.password_changed',
            actor,
            entityType: 'user',
            entityId: after.id,
            outcome: 'success',
            detail: { reset: true },
            ...ctx,
          });
        }
        if (revokedSessions > 0) {
          await writeAudit(deps, {
            action: 'auth.session_revoked',
            actor,
            entityType: 'session',
            entityId: null,
            outcome: 'success',
            detail: { userId: after.id, count: revokedSessions, reason: disabled ? 'user_disabled' : 'user_updated' },
            ...ctx,
          });
        }
        sendEntity(c.req, c.res, 200, toUser(after), after.rowVer);
      },
    }),
    defineRoute({
      method: 'post',
      path: '/users/:userId/unlock',
      operationId: 'unlockUser',
      summary: 'Clear a login lockout',
      tag: 'users',
      auth: 'session',
      permission: ['user:manage'],
      rateClass: 'write',
      params: UserParams,
      responses: { 204: { description: 'Unlocked' }, 404: { description: 'not_found' } },
      async handler(c) {
        const repos = c.deps.db.repos;
        const user = await repos.users.findById(c.params.userId);
        if (!user) throw new NotFoundError('User not found');
        await repos.users.unlock(user.id);
        try {
          await limiters.loginUser.delete(loginUserKey(user.username));
        } catch (err) {
          c.deps.logger.warn({ err, userId: user.id }, 'login failure counter reset failed');
        }
        await writeAudit(c.deps, {
          action: 'user.unlocked',
          actor: actorOf(c.viewer()),
          entityType: 'user',
          entityId: user.id,
          outcome: 'success',
          ...auditContext(c.req, c.res),
        });
        c.res.status(204).end();
      },
    }),
  ];
}
