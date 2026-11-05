// B-005 leak guard, end to end on the real host (Windows: CIM + PID chain; Linux via test:linux: /proc + PID chain
// + ORC_TEST_RUN_ID). Leaks are produced on purpose AFTER a "before" snapshot: an orc-test- temp dir with a git repo,
// a linked worktree and an orc/task-* branch, a hanging fake-claude started by this process, an orphaned fake-claude
// of a foreign run and a leftover orchestrator_test row. The ledger must find exactly the attributable ones, reap
// only those and never touch pre-existing, unprefixed or linked directories, the foreign process or the database.
// afterAll removes everything produced here, so the run-level guard (tests/setup/global-teardown.ts) stays clean.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sql from 'mssql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LeakFixtures } from '../helpers/common/leak-fixtures';
import type { LeakedRepo } from '../helpers/common/leak-fixtures';
import { isProcessAlive } from '../helpers/common/process';
import { openPool, query, resetDb } from '../helpers/database/db';
import { COUNTED_TABLES, countTestDbRows } from '../setup/leak-db';
import {
  createLedgerContext,
  describeDirLeaks,
  diffSnapshots,
  reapDirs,
  reapProcesses,
  takeSnapshot,
} from '../setup/leak-ledger';
import type { LeakDiff, LedgerContext, LeakSnapshot } from '../setup/leak-ledger';

const fixtures = new LeakFixtures();
const foreignRunId = randomUUID();
let pool: sql.ConnectionPool;
let ctx: LedgerContext;
let before: LeakSnapshot;
let diff: LeakDiff;
let leaked: LeakedRepo;
let preExisting: string;
let unprefixed: string;
/** A directory with another listed prefix (K6): the guard must catch it, not only orc-test-*. */
let otherPrefix: string;
/** `orc-cbm-rt-<6 chars>` mimics the product's runtime dir: never in the list, never a leak. */
let productDir: string;
let link: string;
let ownPid: number;
let orphanPid: number;
let markedOrphanPid: number;
const teamName = `leak-detection-${randomUUID()}`;

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

beforeAll(async () => {
  pool = await openPool('orc_migrator', 1);
  ctx = await createLedgerContext({ runId: randomUUID(), rootPid: process.pid });
  preExisting = await fixtures.makeDir('orc-test-pre-');
  before = await takeSnapshot(ctx, { db: () => countTestDbRows() });

  leaked = await fixtures.makeLeakedRepo();
  unprefixed = await fixtures.makeDir('orc-leakneg-');
  otherPrefix = await fixtures.makeDir('orc-wk-');
  productDir = await fixtures.makeDir('orc-cbm-rt-');
  link = await fixtures.makeDirLink('orc-test-link-', leaked.dir);
  ownPid = fixtures.spawnFakeClaude(ctx.runId);
  orphanPid = await fixtures.spawnOrphanFakeClaude(foreignRunId);
  markedOrphanPid = await fixtures.spawnOrphanFakeClaude(ctx.runId);
  await query(pool, 'INSERT INTO orc.Teams (Name) VALUES (@name);', [
    ['name', sql.NVarChar(100), teamName],
  ]);

  const after = await takeSnapshot(ctx, { db: () => countTestDbRows() });
  diff = diffSnapshots(ctx, before, after, []);
});

afterAll(async () => {
  try {
    await fixtures.cleanup();
  } finally {
    try {
      await resetDb();
    } finally {
      await pool.close();
    }
  }
});

describe('leak ledger (B-005)', () => {
  it('both snapshots are complete: temp root, process table and database were all readable', () => {
    expect(before.dirs.ok).toBe(true);
    expect(before.processes.ok).toBe(true);
    expect(before.db?.ok).toBe(true);
    expect(diff.scanUnavailable).toEqual([]);
  });

  it('counts every table of the orc schema', async () => {
    const rows = await query<{ name: string }>(
      pool,
      "SELECT t.name FROM sys.tables AS t WHERE t.schema_id = SCHEMA_ID(N'orc') ORDER BY t.name;",
    );
    expect(rows.map((r) => r.name).sort()).toEqual([...COUNTED_TABLES].sort());
  });

  it('finds the leaked orc-test- directory with its worktree and orc/task branch', async () => {
    const found = diff.dirs.filter((d) => samePath(d.path, leaked.dir));
    expect(found).toHaveLength(1);
    const [report] = await describeDirLeaks(ctx, found);
    expect(report?.inspection.complete).toBe(true);
    expect(report?.inspection.links).toEqual([]);
    expect(report?.inspection.externalGitdirs).toEqual([]);
    const repo = report?.git.find((g) => samePath(g.repo, leaked.repo));
    expect(repo?.error).toBeNull();
    expect(repo?.branches).toEqual([leaked.branch]);
    expect(repo?.worktrees.some((w) => samePath(w, leaked.worktree))).toBe(true);
  });

  it('finds a leaked directory of another listed prefix (orc-wk-), not only orc-test-', () => {
    expect(diff.dirs.filter((d) => samePath(d.path, otherPrefix))).toHaveLength(1);
  });

  it('never lists a pre-existing, an unprefixed, a product-prefixed or a linked directory', () => {
    for (const decoy of [preExisting, unprefixed, productDir, link]) {
      expect(
        diff.dirs.some((d) => samePath(d.path, decoy)),
        decoy,
      ).toBe(false);
    }
  });

  it('attributes the fake-claude started by this process through its PID chain', () => {
    expect(diff.ownedProcesses.find((p) => p.pid === ownPid)?.attribution).toBe('chain');
  });

  it('never attributes an orphan of a foreign run', () => {
    expect(diff.ownedProcesses.map((p) => p.pid)).not.toContain(orphanPid);
    expect(diff.unattributedProcesses.map((p) => p.pid)).toContain(orphanPid);
  });

  it('attributes an orphan by its run marker only where the environment is readable (Linux /proc)', () => {
    if (process.platform === 'linux') {
      expect(diff.ownedProcesses.find((p) => p.pid === markedOrphanPid)?.attribution).toBe(
        'run-marker',
      );
    } else {
      // Windows: CIM cannot read another process' environment, so without a PID chain it stays unattributed.
      expect(diff.ownedProcesses.map((p) => p.pid)).not.toContain(markedOrphanPid);
      expect(diff.unattributedProcesses.map((p) => p.pid)).toContain(markedOrphanPid);
    }
  });

  it('reports the leftover database row', () => {
    expect(diff.db).toContainEqual(expect.objectContaining({ table: 'Teams' }));
    const teams = diff.db.find((d) => d.table === 'Teams');
    expect((teams?.after ?? 0) - (teams?.before ?? 0)).toBe(1);
  });

  it('reaps the attributed directory and process, never the foreign process or the database row', async () => {
    const mine = diff.dirs.filter(
      (d) => samePath(d.path, leaked.dir) || samePath(d.path, otherPrefix),
    );
    const dirs = await reapDirs(ctx, mine);
    expect(dirs.skipped).toEqual([]);
    expect(dirs.removedDirs).toHaveLength(2);
    expect(existsSync(leaked.dir)).toBe(false);
    expect(existsSync(otherPrefix)).toBe(false);
    for (const decoy of [preExisting, unprefixed, productDir]) expect(existsSync(decoy), decoy).toBe(true);

    const own = diff.ownedProcesses.filter((p) => p.pid === ownPid);
    const procs = await reapProcesses(ctx, own, []);
    expect(procs.skipped).toEqual([]);
    expect(procs.killedPids).toEqual([ownPid]);
    expect(isProcessAlive(ownPid)).toBe(false);
    expect(isProcessAlive(orphanPid)).toBe(true);
    expect(isProcessAlive(markedOrphanPid)).toBe(true);

    const db = await countTestDbRows();
    expect(db.ok && db.counts.find((c) => c.table === 'Teams')?.rows).toBe(
      diff.db.find((d) => d.table === 'Teams')?.after,
    );
  });
});
