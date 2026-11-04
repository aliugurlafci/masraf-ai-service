// Database.transaction retries 1205 (deadlock victim) and 1222 (lock timeout) with backoff (§2.5).
import sql from 'mssql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@orc/database';
import { openDb, openPool, query, resetDb } from '../../helpers/database/db';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const BUMP = 'UPDATE orc.WorkerNodes SET ActiveJobs = ActiveJobs + 1 WHERE Id = @id;';
// SET LOCK_TIMEOUT takes no variables, so the short-timeout variant is a second constant batch.
const BUMP_WITH_LOCK_TIMEOUT = `SET LOCK_TIMEOUT 250;
UPDATE orc.WorkerNodes SET ActiveJobs = ActiveJobs + 1 WHERE Id = @id;`;

async function bump(tx: sql.Transaction, id: string, shortLockTimeout = false): Promise<void> {
  const req = new sql.Request(tx);
  req.input('id', sql.NVarChar(128), id);
  await req.query(shortLockTimeout ? BUMP_WITH_LOCK_TIMEOUT : BUMP);
}

describe('transaction deadlock / lock-timeout retry', () => {
  let worker: Database;
  let pool: sql.ConnectionPool;
  const A = 'deadlock-node-a';
  const B = 'deadlock-node-b';

  const jobs = async (id: string): Promise<number> =>
    (await query<{ J: number }>(pool, 'SELECT ActiveJobs AS J FROM orc.WorkerNodes WHERE Id = @id;', [['id', sql.NVarChar(128), id]]))[0]!.J;

  beforeAll(async () => {
    worker = await openDb('orc_worker');
    pool = await openPool('orc_worker', 2);
    for (const id of [A, B]) {
      await worker.repos.workerNodes.upsertHeartbeat({
        id, hostname: 'h', pid: 1, appVersion: 't', cliVersion: null, mcpVersion: null, concurrency: 1, activeJobs: 0, status: 'ready', diskFreeBytes: null, startedAt: new Date(),
      });
    }
  });

  afterAll(async () => {
    await worker.close();
    await pool.close();
    await resetDb();
  });

  it('re-runs the deadlock victim and both transactions commit', async () => {
    const [a0, b0] = [await jobs(A), await jobs(B)];
    const t1Holds = deferred();
    const t2Holds = deferred();
    let t1Runs = 0;
    let t2Runs = 0;
    const t1 = worker.transaction(
      async ({ tx }) => {
        t1Runs += 1;
        await bump(tx, A);
        if (t1Runs === 1) {
          t1Holds.resolve();
          await t2Holds.promise;
        }
        await bump(tx, B);
        return 't1';
      },
      { name: 'deadlock.t1' },
    );
    const t2 = worker.transaction(
      async ({ tx }) => {
        t2Runs += 1;
        await bump(tx, B);
        if (t2Runs === 1) {
          t2Holds.resolve();
          await t1Holds.promise;
        }
        await bump(tx, A);
        return 't2';
      },
      { name: 'deadlock.t2' },
    );
    expect(await Promise.all([t1, t2])).toEqual(['t1', 't2']);
    expect(t1Runs + t2Runs).toBe(3);
    expect(await jobs(A)).toBe(a0 + 2);
    expect(await jobs(B)).toBe(b0 + 2);
  });

  it('retries a lock timeout (1222) and succeeds once the blocker commits', async () => {
    const holder = new sql.Transaction(pool);
    await holder.begin();
    await bump(holder, A);
    const before = await jobs(B);
    let runs = 0;
    const result = await worker.transaction(
      async ({ tx }) => {
        runs += 1;
        if (runs === 2) await holder.commit();
        await bump(tx, A, true);
        return runs;
      },
      { name: 'locktimeout.retry', maxRetries: 3 },
    );
    expect(result).toBe(2);
    expect(await jobs(B)).toBe(before);
  });

  it('gives up after maxRetries with db_deadlock and leaves no partial writes', async () => {
    const holder = new sql.Transaction(pool);
    await holder.begin();
    await bump(holder, A);
    const b0 = await jobs(B).catch(() => -1);
    let runs = 0;
    try {
      await expect(
        worker.transaction(
          async ({ tx }) => {
            runs += 1;
            await bump(tx, B);
            await bump(tx, A, true);
          },
          { name: 'locktimeout.exhausted', maxRetries: 1 },
        ),
      ).rejects.toMatchObject({ code: 'db_deadlock' });
    } finally {
      await holder.rollback();
    }
    expect(runs).toBe(2);
    expect(await jobs(B)).toBe(b0);
  });
});
