// Users, AuthSessions, ApiTokens, IdempotencyKeys repositories as orc_api (§2.5, §15).
import { createHash, randomBytes } from 'node:crypto';
import sql from 'mssql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PreconditionFailedError } from '@orc/shared';
import type { Database, UserRecord } from '@orc/database';
import { openDb, openPool, query, resetDb } from '../../helpers/database/db';
import { createUser, uniq } from '../../helpers/database/fixtures';

const hash = (): Buffer => createHash('sha256').update(randomBytes(32)).digest();

describe('identity repositories (orc_api)', () => {
  let db: Database;
  let migrator: sql.ConnectionPool;

  beforeAll(async () => {
    db = await openDb('orc_api');
    migrator = await openPool('orc_migrator', 1);
  });

  afterAll(async () => {
    await db.close();
    await migrator.close();
    await resetDb();
  });

  describe('users', () => {
    it('inserts, finds and lists users with keyset pagination', async () => {
      const created: UserRecord[] = [];
      for (let i = 0; i < 5; i += 1) created.push(await createUser(db));
      const u = created[0]!;
      expect(u).toMatchObject({ role: 'operator', isActive: true, failedLoginCount: 0, lockedUntil: null, lastLoginAt: null });
      expect(u.rowVer).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(await db.repos.users.findById(u.id)).toEqual(u);
      expect(await db.repos.users.findByUsername(u.username)).toEqual(u);
      expect(await db.repos.users.findById('not-a-guid')).toBeNull();
      expect(await db.repos.users.findByUsername('nobody-here')).toBeNull();

      const page1 = await db.repos.users.list({ limit: 2 });
      expect(page1).toHaveLength(3);
      const last = page1[1]!;
      const page2 = await db.repos.users.list({ limit: 2, after: { createdAt: last.createdAt, id: last.id } });
      const ids = [...page1.slice(0, 2), ...page2].map((x) => x.id);
      expect(new Set(ids).size).toBe(ids.length);
      const all = await db.repos.users.list({ limit: 100 });
      expect(all.map((x) => x.id)).toEqual(
        [...all].sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1)).map((x) => x.id),
      );
    });

    it('rejects duplicate usernames with unique_violation and bad roles as a CHECK gap', async () => {
      const u = await createUser(db);
      await expect(createUser(db, { username: u.username })).rejects.toMatchObject({ code: 'unique_violation' });
      await expect(
        db.repos.users.insert({ username: uniq('x'), displayName: 'x', email: null, role: 'root' as 'admin', passwordHash: 'h' }),
      ).rejects.toMatchObject({ code: 'internal_error' });
    });

    it('updates with RowVer optimistic concurrency', async () => {
      const u = await createUser(db);
      const updated = await db.repos.users.update(u.id, u.rowVer, { displayName: 'Renamed', role: 'auditor', passwordHash: 'new-hash' });
      expect(updated).toMatchObject({ displayName: 'Renamed', role: 'auditor', passwordHash: 'new-hash', email: null });
      expect(updated.rowVer).not.toBe(u.rowVer);
      await expect(db.repos.users.update(u.id, u.rowVer, { displayName: 'Stale' })).rejects.toBeInstanceOf(PreconditionFailedError);
      await expect(db.repos.users.update('00000000-0000-0000-0000-000000000001', u.rowVer, {})).rejects.toMatchObject({
        code: 'not_found',
      });
      expect((await db.repos.users.findById(u.id))?.displayName).toBe('Renamed');
    });

    it('persists lockout state (§15.4)', async () => {
      const u = await createUser(db);
      const until = new Date(Date.now() + 900_000);
      await db.repos.users.recordLoginFailure(u.id, null);
      await db.repos.users.recordLoginFailure(u.id, until);
      let row = await db.repos.users.findById(u.id);
      expect(row?.failedLoginCount).toBe(2);
      expect(new Date(row?.lockedUntil ?? 0).getTime()).toBe(until.getTime());
      await db.repos.users.unlock(u.id);
      row = await db.repos.users.findById(u.id);
      expect(row?.lockedUntil).toBeNull();
      await db.repos.users.recordLoginFailure(u.id, until);
      await db.repos.users.recordLoginSuccess(u.id);
      row = await db.repos.users.findById(u.id);
      expect(row).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
      expect(row?.lastLoginAt).not.toBeNull();
    });

    it('counts active admins', async () => {
      const before = await db.repos.users.countActiveAdmins();
      const admin = await createUser(db, { role: 'admin' });
      expect(await db.repos.users.countActiveAdmins()).toBe(before + 1);
      await db.repos.users.update(admin.id, admin.rowVer, { isActive: false });
      expect(await db.repos.users.countActiveAdmins()).toBe(before);
    });
  });

  describe('auth sessions', () => {
    it('applies TTLs in DB time with the idle expiry capped at the absolute one (T-M3)', async () => {
      const u = await createUser(db);
      const tokenHash = hash();
      const s = await db.repos.authSessions.insert({
        userId: u.id,
        tokenHash,
        csrfToken: 'c'.repeat(43),
        absoluteTtlSeconds: 100,
        idleTtlSeconds: 500,
        ip: '127.0.0.1',
        userAgent: 'vitest',
      });
      expect(s.idleExpiresAt.getTime()).toBe(s.expiresAt.getTime());
      expect(s.expiresAt.getTime() - s.createdAt.getTime()).toBe(100_000);
      const found = await db.repos.authSessions.findActiveByTokenHash(tokenHash);
      expect(found?.session.id).toBe(s.id);
      expect(found?.user.id).toBe(u.id);
      expect(await db.repos.authSessions.findActiveByTokenHash(hash())).toBeNull();

      await db.repos.authSessions.touch(s.id, 50);
      const [row] = await query<{ Idle: Date; Exp: Date }>(
        migrator,
        'SELECT IdleExpiresAt AS Idle, ExpiresAt AS Exp FROM orc.AuthSessions WHERE Id = @id;',
        [['id', sql.UniqueIdentifier, s.id]],
      );
      expect(row!.Idle.getTime()).toBeLessThanOrEqual(row!.Exp.getTime());
    });

    it('hides revoked, expired and inactive-user sessions; revokes all but one', async () => {
      const u = await createUser(db);
      const make = (ttl: number) =>
        db.repos.authSessions.insert({ userId: u.id, tokenHash: hash(), csrfToken: 'x', absoluteTtlSeconds: ttl, idleTtlSeconds: ttl, ip: null, userAgent: null });
      const a = await make(3600);
      const b = await make(3600);
      const c = await make(3600);
      const hashOf = async (id: string): Promise<Buffer> =>
        (await query<{ H: Buffer }>(migrator, 'SELECT TokenHash AS H FROM orc.AuthSessions WHERE Id = @id;', [['id', sql.UniqueIdentifier, id]]))[0]!.H;

      await db.repos.authSessions.revoke(a.id, 'logout');
      expect(await db.repos.authSessions.findActiveByTokenHash(await hashOf(a.id))).toBeNull();
      expect(await db.repos.authSessions.revokeAllForUser(u.id, 'password_changed', b.id)).toBe(1);
      expect(await db.repos.authSessions.findActiveByTokenHash(await hashOf(c.id))).toBeNull();
      expect(await db.repos.authSessions.findActiveByTokenHash(await hashOf(b.id))).not.toBeNull();
      await db.repos.users.update(u.id, (await db.repos.users.findById(u.id))!.rowVer, { isActive: false });
      expect(await db.repos.authSessions.findActiveByTokenHash(await hashOf(b.id))).toBeNull();
    });

    it('deletes expired sessions in batches', async () => {
      const u = await createUser(db);
      for (let i = 0; i < 3; i += 1) {
        await db.repos.authSessions.insert({ userId: u.id, tokenHash: hash(), csrfToken: 'x', absoluteTtlSeconds: 1, idleTtlSeconds: 1, ip: null, userAgent: null });
      }
      const future = new Date(Date.now() + 3_600_000);
      expect(await db.repos.authSessions.deleteExpired(future, 2)).toBe(2);
      expect(await db.repos.authSessions.deleteExpired(future, 100)).toBeGreaterThanOrEqual(1);
      expect(await db.repos.authSessions.deleteExpired(future, 100)).toBe(0);
    });
  });

  describe('api tokens', () => {
    it('inserts, finds, lists, touches and revokes PATs', async () => {
      const u = await createUser(db);
      const tokenHash = hash();
      const t = await db.repos.apiTokens.insert({
        userId: u.id,
        name: 'ci',
        prefix: 'orc_pat_abcd',
        tokenHash,
        readOnly: true,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      expect(t).toMatchObject({ userId: u.id, name: 'ci', readOnly: true, revokedAt: null, lastUsedAt: null });
      expect((await db.repos.apiTokens.findActiveByHash(tokenHash))?.token.id).toBe(t.id);
      await db.repos.apiTokens.touchLastUsed(t.id);
      expect((await db.repos.apiTokens.listByUser(u.id))[0]?.lastUsedAt).not.toBeNull();
      const other = await createUser(db);
      expect(await db.repos.apiTokens.revoke(t.id, other.id)).toBe(false);
      expect(await db.repos.apiTokens.revoke(t.id, u.id)).toBe(true);
      expect(await db.repos.apiTokens.revoke(t.id, u.id)).toBe(false);
      expect(await db.repos.apiTokens.findActiveByHash(tokenHash)).toBeNull();
    });

    it('ignores expired tokens and revokes all for a user', async () => {
      const u = await createUser(db);
      const expiredHash = hash();
      await db.repos.apiTokens.insert({ userId: u.id, name: 'old', prefix: 'orc_pat_old1', tokenHash: expiredHash, readOnly: false, expiresAt: new Date(Date.now() - 1000) });
      expect(await db.repos.apiTokens.findActiveByHash(expiredHash)).toBeNull();
      for (let i = 0; i < 2; i += 1) {
        await db.repos.apiTokens.insert({ userId: u.id, name: `t${i}`, prefix: `orc_pat_t${i}xx`, tokenHash: hash(), readOnly: false, expiresAt: new Date(Date.now() + 60_000) });
      }
      // The expired token is not revoked yet, so it is revoked too.
      expect(await db.repos.apiTokens.revokeAllForUser(u.id)).toBe(3);
      expect(await db.repos.apiTokens.revokeAllForUser(u.id)).toBe(0);
    });
  });

  describe('idempotency keys', () => {
    it('starts once, returns the existing record afterwards and completes it', async () => {
      const u = await createUser(db);
      const key = { userId: u.id, scope: 'POST /tasks', keyValue: uniq('key'), requestHash: hash(), lockSeconds: 30, ttlSeconds: 86_400 };
      const first = await db.repos.idempotency.tryBegin(key);
      expect(first.kind).toBe('started');
      const id = first.kind === 'started' ? first.id : '';
      expect(id).toMatch(/^[0-9]+$/);
      const second = await db.repos.idempotency.tryBegin(key);
      expect(second).toMatchObject({ kind: 'existing', record: { id, status: 'in_progress', responseStatus: null } });
      expect(await db.repos.idempotency.takeOver(id, 30)).toBe(false);

      await db.repos.idempotency.complete(id, { status: 201, headers: { location: '/x' }, body: '{"ok":true}', resourceId: 'r1' });
      const done = await db.repos.idempotency.tryBegin(key);
      expect(done).toMatchObject({
        kind: 'existing',
        record: { status: 'completed', responseStatus: 201, responseHeaders: { location: '/x' }, responseBody: '{"ok":true}', resourceId: 'r1' },
      });
    });

    it('lets a caller take over an expired lock, and releases keys', async () => {
      const u = await createUser(db);
      const key = { userId: u.id, scope: 'POST /projects', keyValue: uniq('key'), requestHash: hash(), lockSeconds: 1, ttlSeconds: 60 };
      const started = await db.repos.idempotency.tryBegin(key);
      const id = started.kind === 'started' ? started.id : '';
      await query(migrator, 'UPDATE orc.IdempotencyKeys SET LockedUntil = DATEADD(SECOND, -5, SYSUTCDATETIME()) WHERE Id = @id;', [
        ['id', sql.BigInt, id],
      ]);
      expect(await db.repos.idempotency.takeOver(id, 30)).toBe(true);
      expect(await db.repos.idempotency.takeOver(id, 30)).toBe(false);
      await db.repos.idempotency.release(id);
      expect((await db.repos.idempotency.tryBegin(key)).kind).toBe('started');
    });

    it('replaces an expired key and deletes expired keys in batches', async () => {
      const u = await createUser(db);
      const key = { userId: u.id, scope: 'POST /tasks', keyValue: uniq('key'), requestHash: hash(), lockSeconds: 1, ttlSeconds: 60 };
      const a = await db.repos.idempotency.tryBegin(key);
      await query(migrator, 'UPDATE orc.IdempotencyKeys SET ExpiresAt = DATEADD(SECOND, -1, SYSUTCDATETIME()) WHERE UserId = @u;', [
        ['u', sql.UniqueIdentifier, u.id],
      ]);
      const b = await db.repos.idempotency.tryBegin(key);
      expect(b.kind).toBe('started');
      expect(b.kind === 'started' && a.kind === 'started' && b.id !== a.id).toBe(true);
      await query(migrator, 'UPDATE orc.IdempotencyKeys SET ExpiresAt = DATEADD(SECOND, -1, SYSUTCDATETIME()) WHERE UserId = @u;', [
        ['u', sql.UniqueIdentifier, u.id],
      ]);
      expect(await db.repos.idempotency.deleteExpired(new Date(Date.now() + 1000), 10)).toBeGreaterThanOrEqual(1);
    });

    it('rejects malformed BIGINT ids before binding', async () => {
      await expect(db.repos.idempotency.release('12x')).rejects.toMatchObject({ code: 'validation_failed' });
    });
  });
});
