// auth-cleanup (contract §6.5, §14.7): expired sessions (> 1 day past expiry) and expired idempotency keys are
// deleted. It runs as an in-process timer of every API instance (no BullMQ job); runs are idempotent, so concurrent
// instances only repeat no-op deletes.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import sql from 'mssql';
import { randomBytes } from 'node:crypto';
import type { Database } from '@orc/database';
import { sha256 } from '@orc/security';
import { AUTH_CLEANUP_INTERVAL_MS, createAuthCleanup } from '../../apps/api/src/maintenance';
import { openDb, openPool, query, resetDb } from '../helpers/database/db';
import { createUser } from '../helpers/database/fixtures';
import { silentLogger } from '../helpers/database/env';

describe('auth-cleanup', () => {
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

  it('deletes sessions expired for more than a day and expired idempotency keys, keeping live rows', async () => {
    const user = await createUser(db);
    const mk = () =>
      db.repos.authSessions.insert({
        userId: user.id,
        tokenHash: sha256(randomBytes(32)),
        csrfToken: randomBytes(16).toString('hex'),
        absoluteTtlSeconds: 3600,
        idleTtlSeconds: 600,
        ip: null,
        userAgent: null,
      });
    const old = await mk();
    const live = await mk();
    await query(
      migrator,
      `UPDATE orc.AuthSessions SET CreatedAt = DATEADD(DAY, -3, SYSUTCDATETIME()), ExpiresAt = DATEADD(DAY, -2, SYSUTCDATETIME()),
       IdleExpiresAt = DATEADD(DAY, -2, SYSUTCDATETIME()), LastSeenAt = DATEADD(DAY, -2, SYSUTCDATETIME()) WHERE Id = @id;`,
      [['id', sql.UniqueIdentifier, old.id]],
    );
    const begun = await db.repos.idempotency.tryBegin({
      userId: user.id,
      scope: 'POST /api/v1/tasks',
      keyValue: 'cleanup-key-1',
      requestHash: sha256('x'),
      lockSeconds: 60,
      ttlSeconds: 60,
    });
    expect(begun.kind).toBe('started');
    await query(
      migrator,
      `UPDATE orc.IdempotencyKeys SET CreatedAt = DATEADD(HOUR, -2, SYSUTCDATETIME()), LockedUntil = DATEADD(HOUR, -2, SYSUTCDATETIME()),
       ExpiresAt = DATEADD(HOUR, -1, SYSUTCDATETIME()) WHERE KeyValue = @k;`,
      [['k', sql.NVarChar(255), 'cleanup-key-1']],
    );

    const cleanup = createAuthCleanup({ db, logger: silentLogger() });
    const report = await cleanup.runOnce();
    expect(report.errors).toEqual([]);
    expect(report.counts.sessions).toBeGreaterThanOrEqual(1);
    expect(report.counts.idempotencyKeys).toBeGreaterThanOrEqual(1);
    const rows = await query<{ Id: string }>(migrator, 'SELECT Id FROM orc.AuthSessions WHERE UserId = @u;', [
      ['u', sql.UniqueIdentifier, user.id],
    ]);
    expect(rows.map((r) => r.Id.toLowerCase())).toEqual([live.id]);
    cleanup.start();
    await cleanup.stop();
  });

  it('is idempotent across instances: concurrent runs never fail and a repeated run deletes nothing more', async () => {
    const user = await createUser(db);
    const expired = await db.repos.authSessions.insert({
      userId: user.id,
      tokenHash: sha256(randomBytes(32)),
      csrfToken: randomBytes(16).toString('hex'),
      absoluteTtlSeconds: 3600,
      idleTtlSeconds: 600,
      ip: null,
      userAgent: null,
    });
    await query(
      migrator,
      `UPDATE orc.AuthSessions SET CreatedAt = DATEADD(DAY, -4, SYSUTCDATETIME()), ExpiresAt = DATEADD(DAY, -3, SYSUTCDATETIME()),
       IdleExpiresAt = DATEADD(DAY, -3, SYSUTCDATETIME()), LastSeenAt = DATEADD(DAY, -3, SYSUTCDATETIME()) WHERE Id = @id;`,
      [['id', sql.UniqueIdentifier, expired.id]],
    );
    const instanceA = createAuthCleanup({ db, logger: silentLogger() });
    const instanceB = createAuthCleanup({ db, logger: silentLogger() });
    const [a, b] = await Promise.all([instanceA.runOnce(), instanceB.runOnce()]);
    expect([...a.errors, ...b.errors]).toEqual([]);
    expect(a.counts.sessions + b.counts.sessions).toBeGreaterThanOrEqual(1);
    const again = await instanceA.runOnce();
    expect(again.errors).toEqual([]);
    expect(again.counts.sessions).toBe(0);
    const rows = await query<{ Id: string }>(migrator, 'SELECT Id FROM orc.AuthSessions WHERE UserId = @u;', [
      ['u', sql.UniqueIdentifier, user.id],
    ]);
    expect(rows).toEqual([]);
  });
});

describe('auth-cleanup scheduling (in-process timer)', () => {
  interface Gate {
    calls: { sessions: number; idempotencyKeys: number };
    release(): void;
  }

  /** A Database stub whose session delete blocks until `release()` (lets a run span several timer ticks). */
  const gatedDb = (): { db: Database; gate: Gate } => {
    const waiting: (() => void)[] = [];
    const gate: Gate = {
      calls: { sessions: 0, idempotencyKeys: 0 },
      release() {
        for (const resolve of waiting.splice(0)) resolve();
      },
    };
    const stub = {
      repos: {
        authSessions: {
          deleteExpired: async (): Promise<number> => {
            gate.calls.sessions += 1;
            await new Promise<void>((resolve) => waiting.push(resolve));
            return 0;
          },
        },
        idempotency: {
          deleteExpired: (): Promise<number> => {
            gate.calls.idempotencyKeys += 1;
            return Promise.resolve(0);
          },
        },
      },
    };
    return { db: stub as unknown as Database, gate };
  };

  it('runs every AUTH_CLEANUP_INTERVAL_MS by default from one unref-ed timer; start() twice keeps one timer', async () => {
    vi.useFakeTimers();
    try {
      const { db: stubDb, gate } = gatedDb();
      const cleanup = createAuthCleanup({ db: stubDb, logger: silentLogger() });
      expect(vi.getTimerCount()).toBe(0);
      cleanup.start();
      cleanup.start();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(AUTH_CLEANUP_INTERVAL_MS - 1);
      expect(gate.calls.sessions).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(gate.calls.sessions).toBe(1);
      gate.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(gate.calls).toEqual({ sessions: 1, idempotencyKeys: 1 });
      await cleanup.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the interval timer never keeps the process alive (unref) and stop() releases it', async () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    try {
      const { db: stubDb } = gatedDb();
      const cleanup = createAuthCleanup({ db: stubDb, logger: silentLogger(), intervalMs: 60_000 });
      cleanup.start();
      expect(spy).toHaveBeenCalledTimes(1);
      const handle = spy.mock.results[0]?.value as NodeJS.Timeout;
      expect(handle.hasRef()).toBe(false);
      await cleanup.stop();
      expect(handle.hasRef()).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('never overlaps runs: ticks during a running cleanup are skipped; stop() clears the timer and awaits the run', async () => {
    vi.useFakeTimers();
    try {
      const { db: stubDb, gate } = gatedDb();
      const cleanup = createAuthCleanup({ db: stubDb, logger: silentLogger(), intervalMs: 1_000 });
      cleanup.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(gate.calls.sessions).toBe(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(gate.calls.sessions).toBe(1);
      gate.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(gate.calls.idempotencyKeys).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(gate.calls.sessions).toBe(2);

      let stopped = false;
      const stopping = cleanup.stop().then(() => {
        stopped = true;
      });
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);
      gate.release();
      await stopping;
      expect(gate.calls).toEqual({ sessions: 2, idempotencyKeys: 2 });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(gate.calls).toEqual({ sessions: 2, idempotencyKeys: 2 });
      await cleanup.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
