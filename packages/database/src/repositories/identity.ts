// Users, AuthSessions, ApiTokens, IdempotencyKeys (contract §2.5, §15).
import { OrcError } from '@orc/shared';
import {
  T,
  assertBigId,
  assertInt,
  first,
  int,
  isGuid,
  keysetParams,
  pageTake,
  patchParams,
  run,
} from '../sql.js';
import type { Param, RepoContext } from '../sql.js';
import { rowVerToBuffer } from '../rowver.js';
import type {
  ApiTokenRepository,
  AuthSessionRepository,
  IdempotencyRepository,
  UserRecord,
  UserRepository,
} from '../types.js';
import { throwCasMiss } from './common.js';
import { USER_JOIN_COLUMNS, mapApiToken, mapAuthSession, mapIdempotency, mapUser } from './mappers.js';

const MAX_TTL_SECONDS = 31_536_000; // one year

// ---- users -------------------------------------------------------------------------------------

const USER_BY_ID = 'SELECT * FROM orc.Users WHERE Id = @id;';
const USER_BY_USERNAME = 'SELECT * FROM orc.Users WHERE Username = @username;';
const USER_LIST = `SELECT TOP (@take) * FROM orc.Users
WHERE (@afterCreatedAt IS NULL OR CreatedAt < @afterCreatedAt OR (CreatedAt = @afterCreatedAt AND Id < @afterId))
ORDER BY CreatedAt DESC, Id DESC;`;
const USER_INSERT = `INSERT INTO orc.Users (Username, DisplayName, Email, Role, PasswordHash)
OUTPUT inserted.*
VALUES (@username, @displayName, @email, @role, @passwordHash);`;
const USER_UPDATE = `UPDATE orc.Users SET
  DisplayName = CASE WHEN @set_displayName = 1 THEN @displayName ELSE DisplayName END,
  Email = CASE WHEN @set_email = 1 THEN @email ELSE Email END,
  Role = CASE WHEN @set_role = 1 THEN @role ELSE Role END,
  IsActive = CASE WHEN @set_isActive = 1 THEN @isActive ELSE IsActive END,
  PasswordHash = CASE WHEN @set_passwordHash = 1 THEN @passwordHash ELSE PasswordHash END,
  PasswordChangedAt = CASE WHEN @set_passwordHash = 1 THEN SYSUTCDATETIME() ELSE PasswordChangedAt END,
  UpdatedAt = SYSUTCDATETIME()
OUTPUT inserted.*
WHERE Id = @id AND RowVer = @rowVer;`;
const USER_EXISTS = 'SELECT 1 AS X FROM orc.Users WHERE Id = @id;';
const USER_LOGIN_FAILURE = `UPDATE orc.Users SET
  FailedLoginCount = FailedLoginCount + 1,
  LockedUntil = CASE WHEN @lockedUntil IS NULL THEN LockedUntil ELSE @lockedUntil END,
  UpdatedAt = SYSUTCDATETIME()
WHERE Id = @id;`;
const USER_LOGIN_SUCCESS = `UPDATE orc.Users SET
  FailedLoginCount = 0, LockedUntil = NULL, LastLoginAt = SYSUTCDATETIME(), UpdatedAt = SYSUTCDATETIME()
WHERE Id = @id;`;
const USER_UNLOCK = `UPDATE orc.Users SET FailedLoginCount = 0, LockedUntil = NULL, UpdatedAt = SYSUTCDATETIME()
WHERE Id = @id;`;
const USER_COUNT_ADMINS = "SELECT COUNT(*) AS N FROM orc.Users WHERE Role = 'admin' AND IsActive = 1;";

export function createUserRepository(ctx: RepoContext): UserRepository {
  return {
    async findById(id) {
      if (!isGuid(id)) return null;
      const row = first((await run(ctx, USER_BY_ID, [['id', T.guid, id]])).rows);
      return row ? mapUser(row) : null;
    },
    async findByUsername(usernameLower) {
      const row = first((await run(ctx, USER_BY_USERNAME, [['username', T.nvarchar(64), usernameLower]])).rows);
      return row ? mapUser(row) : null;
    },
    async list(o) {
      const { rows } = await run(ctx, USER_LIST, [['take', T.int, pageTake(o.limit)], ...keysetParams(o.after, 'guid')]);
      return rows.map((r) => mapUser(r));
    },
    async insert(u) {
      const { rows } = await run(ctx, USER_INSERT, [
        ['username', T.nvarchar(64), u.username],
        ['displayName', T.nvarchar(128), u.displayName],
        ['email', T.nvarchar(254), u.email],
        ['role', T.varchar(16), u.role],
        ['passwordHash', T.varchar(255), u.passwordHash],
      ]);
      const row = first(rows);
      if (!row) throw new OrcError('internal_error', 'Users insert returned no row');
      return mapUser(row);
    },
    async update(id, expectedRowVer, patch): Promise<UserRecord> {
      const { rows } = await run(ctx, USER_UPDATE, [
        ['id', T.guid, id],
        ['rowVer', T.binary(8), rowVerToBuffer(expectedRowVer)],
        ...patchParams(patch, [
          ['displayName', T.nvarchar(128)],
          ['email', T.nvarchar(254)],
          ['role', T.varchar(16)],
          ['isActive', T.bit],
          ['passwordHash', T.varchar(255)],
        ]),
      ]);
      const row = first(rows);
      if (row) return mapUser(row);
      return throwCasMiss(ctx, USER_EXISTS, id, 'User');
    },
    async recordLoginFailure(id, lockedUntil) {
      await run(ctx, USER_LOGIN_FAILURE, [
        ['id', T.guid, id],
        ['lockedUntil', T.dt, lockedUntil],
      ]);
    },
    async recordLoginSuccess(id) {
      await run(ctx, USER_LOGIN_SUCCESS, [['id', T.guid, id]]);
    },
    async unlock(id) {
      await run(ctx, USER_UNLOCK, [['id', T.guid, id]]);
    },
    async countActiveAdmins() {
      const row = first((await run(ctx, USER_COUNT_ADMINS)).rows);
      return row ? int(row, 'N') : 0;
    },
  };
}

// ---- auth sessions -------------------------------------------------------------------------------

const SESSION_INSERT = `DECLARE @now DATETIME2(3) = SYSUTCDATETIME();
DECLARE @expiresAt DATETIME2(3) = DATEADD(SECOND, @absoluteTtl, @now);
DECLARE @idleAt DATETIME2(3) = DATEADD(SECOND, @idleTtl, @now);
INSERT INTO orc.AuthSessions (UserId, TokenHash, CsrfToken, ExpiresAt, IdleExpiresAt, LastSeenAt, Ip, UserAgent, CreatedAt)
OUTPUT inserted.*
VALUES (@userId, @tokenHash, @csrfToken, @expiresAt,
  CASE WHEN @idleAt < @expiresAt THEN @idleAt ELSE @expiresAt END, @now, @ip, @userAgent, @now);`;
const SESSION_FIND_ACTIVE = `SELECT s.*, ${USER_JOIN_COLUMNS}
FROM orc.AuthSessions AS s
INNER JOIN orc.Users AS u ON u.Id = s.UserId
WHERE s.TokenHash = @tokenHash
  AND s.RevokedAt IS NULL
  AND s.ExpiresAt > SYSUTCDATETIME()
  AND s.IdleExpiresAt > SYSUTCDATETIME()
  AND u.IsActive = 1;`;
const SESSION_TOUCH = `UPDATE orc.AuthSessions SET
  IdleExpiresAt = CASE WHEN DATEADD(SECOND, @idleTtl, SYSUTCDATETIME()) < ExpiresAt
                       THEN DATEADD(SECOND, @idleTtl, SYSUTCDATETIME()) ELSE ExpiresAt END,
  LastSeenAt = SYSUTCDATETIME()
WHERE Id = @id AND RevokedAt IS NULL;`;
const SESSION_REVOKE = `UPDATE orc.AuthSessions SET RevokedAt = SYSUTCDATETIME(), RevokedReason = @reason
WHERE Id = @id AND RevokedAt IS NULL;`;
const SESSION_REVOKE_ALL = `UPDATE orc.AuthSessions SET RevokedAt = SYSUTCDATETIME(), RevokedReason = @reason
WHERE UserId = @userId AND RevokedAt IS NULL AND (@exceptId IS NULL OR Id <> @exceptId);`;
const SESSION_DELETE_EXPIRED = `DELETE TOP (@batch) FROM orc.AuthSessions
WHERE ExpiresAt < @before OR IdleExpiresAt < @before OR RevokedAt < @before;`;

export function createAuthSessionRepository(ctx: RepoContext): AuthSessionRepository {
  return {
    async insert(s) {
      const { rows } = await run(ctx, SESSION_INSERT, [
        ['userId', T.guid, s.userId],
        ['tokenHash', T.binary(32), s.tokenHash],
        ['csrfToken', T.varchar(64), s.csrfToken],
        ['absoluteTtl', T.int, assertInt(s.absoluteTtlSeconds, 'absoluteTtlSeconds', 1, MAX_TTL_SECONDS)],
        ['idleTtl', T.int, assertInt(s.idleTtlSeconds, 'idleTtlSeconds', 1, MAX_TTL_SECONDS)],
        ['ip', T.varchar(45), s.ip],
        ['userAgent', T.nvarchar(400), s.userAgent === null ? null : s.userAgent.slice(0, 400)],
      ]);
      const row = first(rows);
      if (!row) throw new OrcError('internal_error', 'AuthSessions insert returned no row');
      return mapAuthSession(row);
    },
    async findActiveByTokenHash(hash) {
      const row = first((await run(ctx, SESSION_FIND_ACTIVE, [['tokenHash', T.binary(32), hash]])).rows);
      return row ? { session: mapAuthSession(row), user: mapUser(row, 'U_') } : null;
    },
    async touch(id, idleTtlSeconds) {
      await run(ctx, SESSION_TOUCH, [
        ['id', T.guid, id],
        ['idleTtl', T.int, assertInt(idleTtlSeconds, 'idleTtlSeconds', 1, MAX_TTL_SECONDS)],
      ]);
    },
    async revoke(id, reason) {
      await run(ctx, SESSION_REVOKE, [
        ['id', T.guid, id],
        ['reason', T.varchar(32), reason],
      ]);
    },
    async revokeAllForUser(userId, reason, exceptSessionId) {
      const { rowsAffected } = await run(ctx, SESSION_REVOKE_ALL, [
        ['userId', T.guid, userId],
        ['reason', T.varchar(32), reason],
        ['exceptId', T.guid, exceptSessionId ?? null],
      ]);
      return rowsAffected;
    },
    async deleteExpired(before, batchSize) {
      const { rowsAffected } = await run(ctx, SESSION_DELETE_EXPIRED, [
        ['before', T.dt, before],
        ['batch', T.int, assertInt(batchSize, 'batchSize', 1, 100_000)],
      ]);
      return rowsAffected;
    },
  };
}

// ---- api tokens ------------------------------------------------------------------------------------

const TOKEN_INSERT = `INSERT INTO orc.ApiTokens (UserId, Name, Prefix, TokenHash, ReadOnly, ExpiresAt)
OUTPUT inserted.*
VALUES (@userId, @name, @prefix, @tokenHash, @readOnly, @expiresAt);`;
const TOKEN_FIND_ACTIVE = `SELECT t.*, ${USER_JOIN_COLUMNS}
FROM orc.ApiTokens AS t
INNER JOIN orc.Users AS u ON u.Id = t.UserId
WHERE t.TokenHash = @tokenHash AND t.RevokedAt IS NULL AND t.ExpiresAt > SYSUTCDATETIME() AND u.IsActive = 1;`;
const TOKEN_LIST_BY_USER = 'SELECT * FROM orc.ApiTokens WHERE UserId = @userId ORDER BY CreatedAt DESC, Id DESC;';
const TOKEN_REVOKE = `UPDATE orc.ApiTokens SET RevokedAt = SYSUTCDATETIME()
WHERE Id = @id AND UserId = @userId AND RevokedAt IS NULL;`;
const TOKEN_REVOKE_ALL = 'UPDATE orc.ApiTokens SET RevokedAt = SYSUTCDATETIME() WHERE UserId = @userId AND RevokedAt IS NULL;';
const TOKEN_TOUCH = 'UPDATE orc.ApiTokens SET LastUsedAt = SYSUTCDATETIME() WHERE Id = @id;';

export function createApiTokenRepository(ctx: RepoContext): ApiTokenRepository {
  return {
    async insert(t) {
      const { rows } = await run(ctx, TOKEN_INSERT, [
        ['userId', T.guid, t.userId],
        ['name', T.nvarchar(100), t.name],
        ['prefix', T.varchar(16), t.prefix],
        ['tokenHash', T.binary(32), t.tokenHash],
        ['readOnly', T.bit, t.readOnly],
        ['expiresAt', T.dt, t.expiresAt],
      ]);
      const row = first(rows);
      if (!row) throw new OrcError('internal_error', 'ApiTokens insert returned no row');
      return mapApiToken(row);
    },
    async findActiveByHash(hash) {
      const row = first((await run(ctx, TOKEN_FIND_ACTIVE, [['tokenHash', T.binary(32), hash]])).rows);
      return row ? { token: mapApiToken(row), user: mapUser(row, 'U_') } : null;
    },
    async listByUser(userId) {
      const { rows } = await run(ctx, TOKEN_LIST_BY_USER, [['userId', T.guid, userId]]);
      return rows.map(mapApiToken);
    },
    async revoke(id, userId) {
      const { rowsAffected } = await run(ctx, TOKEN_REVOKE, [
        ['id', T.guid, id],
        ['userId', T.guid, userId],
      ]);
      return rowsAffected > 0;
    },
    async revokeAllForUser(userId) {
      return (await run(ctx, TOKEN_REVOKE_ALL, [['userId', T.guid, userId]])).rowsAffected;
    },
    async touchLastUsed(id) {
      await run(ctx, TOKEN_TOUCH, [['id', T.guid, id]]);
    },
  };
}

// ---- idempotency keys --------------------------------------------------------------------------------

const IDEM_DELETE_EXPIRED_KEY = `DELETE FROM orc.IdempotencyKeys
WHERE UserId = @userId AND Scope = @scope AND KeyValue = @keyValue AND ExpiresAt < SYSUTCDATETIME();`;
const IDEM_TRY_INSERT = `INSERT INTO orc.IdempotencyKeys (UserId, Scope, KeyValue, RequestHash, Status, LockedUntil, ExpiresAt)
OUTPUT inserted.Id
SELECT @userId, @scope, @keyValue, @requestHash, 'in_progress',
  DATEADD(SECOND, @lockSeconds, SYSUTCDATETIME()), DATEADD(SECOND, @ttlSeconds, SYSUTCDATETIME())
WHERE NOT EXISTS (
  SELECT 1 FROM orc.IdempotencyKeys WITH (UPDLOCK, HOLDLOCK)
  WHERE UserId = @userId AND Scope = @scope AND KeyValue = @keyValue);`;
const IDEM_SELECT = 'SELECT * FROM orc.IdempotencyKeys WHERE UserId = @userId AND Scope = @scope AND KeyValue = @keyValue;';
const IDEM_TAKE_OVER = `UPDATE orc.IdempotencyKeys SET LockedUntil = DATEADD(SECOND, @lockSeconds, SYSUTCDATETIME()), UpdatedAt = SYSUTCDATETIME()
WHERE Id = @id AND Status = 'in_progress' AND LockedUntil < SYSUTCDATETIME();`;
const IDEM_COMPLETE = `UPDATE orc.IdempotencyKeys SET
  Status = 'completed', ResponseStatus = @status, ResponseHeadersJson = @headers, ResponseBody = @body,
  ResourceId = @resourceId, UpdatedAt = SYSUTCDATETIME()
WHERE Id = @id;`;
const IDEM_RELEASE = 'DELETE FROM orc.IdempotencyKeys WHERE Id = @id;';
const IDEM_DELETE_EXPIRED = 'DELETE TOP (@batch) FROM orc.IdempotencyKeys WHERE ExpiresAt < @before;';

export function completeIdempotencyParams(
  id: string,
  r: { status: number; headers: Record<string, string>; body: string; resourceId: string | null },
): Param[] {
  return [
    ['id', T.bigint, assertBigId(id, 'idempotency id')],
    ['status', T.int, assertInt(r.status, 'status', 100, 599)],
    ['headers', T.nvarchar(4000), JSON.stringify(r.headers)],
    ['body', T.nvarcharMax, r.body],
    ['resourceId', T.varchar(64), r.resourceId],
  ];
}

export const IDEMPOTENCY_COMPLETE_SQL = IDEM_COMPLETE;

export function createIdempotencyRepository(ctx: RepoContext): IdempotencyRepository {
  return {
    async tryBegin(i) {
      const keyParams = [
        ['userId', T.guid, i.userId],
        ['scope', T.varchar(64), i.scope],
        ['keyValue', T.varchar(255), i.keyValue],
      ] as const;
      return ctx.exec.atomic('idempotency.tryBegin', async (exec) => {
        const tx = { ...ctx, exec };
        await run(tx, IDEM_DELETE_EXPIRED_KEY, keyParams);
        const inserted = first(
          (
            await run(tx, IDEM_TRY_INSERT, [
              ...keyParams,
              ['requestHash', T.binary(32), i.requestHash],
              ['lockSeconds', T.int, assertInt(i.lockSeconds, 'lockSeconds', 1, MAX_TTL_SECONDS)],
              ['ttlSeconds', T.int, assertInt(i.ttlSeconds, 'ttlSeconds', 1, MAX_TTL_SECONDS)],
            ])
          ).rows,
        );
        if (inserted) {
          const id = inserted['Id'];
          return { kind: 'started' as const, id: typeof id === 'string' ? id : String(id) };
        }
        const existing = first((await run(tx, IDEM_SELECT, keyParams)).rows);
        if (!existing) throw new OrcError('conflict', 'Idempotency key changed concurrently');
        return { kind: 'existing' as const, record: mapIdempotency(existing) };
      });
    },
    async takeOver(id, lockSeconds) {
      const { rowsAffected } = await run(ctx, IDEM_TAKE_OVER, [
        ['id', T.bigint, assertBigId(id, 'idempotency id')],
        ['lockSeconds', T.int, assertInt(lockSeconds, 'lockSeconds', 1, MAX_TTL_SECONDS)],
      ]);
      return rowsAffected > 0;
    },
    async complete(id, r) {
      await run(ctx, IDEM_COMPLETE, completeIdempotencyParams(id, r));
    },
    async release(id) {
      await run(ctx, IDEM_RELEASE, [['id', T.bigint, assertBigId(id, 'idempotency id')]]);
    },
    async deleteExpired(before, batchSize) {
      const { rowsAffected } = await run(ctx, IDEM_DELETE_EXPIRED, [
        ['before', T.dt, before],
        ['batch', T.int, assertInt(batchSize, 'batchSize', 1, 100_000)],
      ]);
      return rowsAffected;
    },
  };
}

