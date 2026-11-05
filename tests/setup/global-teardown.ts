// Vitest globalSetup of the infrastructure projects (B-005): the run-level leak safety net. Registered AFTER
// tests/setup/global-infra.ts, so its "before" snapshot is taken once the test database is recreated and seeded, and
// its teardown (teardowns run in reverse order) finishes while the run still holds the database applock. Shared by
// every infrastructure project of one Vitest process (sharedRun): one snapshot at the start, one diff at the end.
//
// - Default: REPORT ONLY. tests/reports/leaks.json is rewritten on every run; leaks and failed scans are also
//   printed through the Vitest logger. Nothing is deleted and nothing is killed.
// - ORC_TEST_REAP=1: additionally removes this run's leaked orc-test- temp dirs (only when no other Vitest run is
//   active on the host) and kills this run's attributed fake-claude processes (tests/setup/leak-ledger.ts).
//   Database rows are NEVER deleted, not even with ORC_TEST_REAP=1.
// - ORC_TEST_LEAK_STRICT=1: any leak or any unavailable scan fails the run (exit code 1). The failure is signalled
//   through process.exitCode instead of a throw so that global-infra's teardown (applock release) still runs.
import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';
import { z } from 'zod';
import { countTestDbRows } from './leak-db';
import {
  RUN_ID_ENV,
  createLedgerContext,
  describeDirLeaks,
  diffSnapshots,
  reapDirs,
  reapProcesses,
  takeSnapshot,
} from './leak-ledger';
import type {
  DbDelta,
  DirLeakReport,
  LeakDiff,
  LeakSnapshot,
  LedgerContext,
  ProcessLeak,
  ProcessNote,
  ReapSkip,
} from './leak-ledger';
import { WorkerRecordSchema } from './leak-worker-record';
import type { WorkerRecord } from './leak-worker-record';
import { sharedRun } from './shared-run';
import type { Release } from './shared-run';

export const LEAK_REPORT_FILE = fileURLToPath(new URL('../reports/leaks.json', import.meta.url));
const SHARED_RUN_KEY = 'leak-guard';
/** Grace period for processes/dirs that are still being torn down when the last project finishes. */
const SETTLE_TIMEOUT_MS = 10_000;
const SETTLE_INTERVAL_MS = 500;

const FlagsSchema = z.object({
  ORC_TEST_REAP: z.string().optional(),
  ORC_TEST_LEAK_STRICT: z.string().optional(),
});

export interface LeakFlags {
  readonly reap: boolean;
  readonly strict: boolean;
}

/** Only the exact value "1" switches a mode on. */
export function readLeakFlags(env: NodeJS.ProcessEnv = process.env): LeakFlags {
  const flags = FlagsSchema.parse({
    ORC_TEST_REAP: env['ORC_TEST_REAP'],
    ORC_TEST_LEAK_STRICT: env['ORC_TEST_LEAK_STRICT'],
  });
  return { reap: flags.ORC_TEST_REAP === '1', strict: flags.ORC_TEST_LEAK_STRICT === '1' };
}

export type LeakStatus = 'clean' | 'warnings' | 'leaks' | 'scan-unavailable';

export interface LeakReport {
  readonly runId: string | null;
  readonly pid: number;
  readonly platform: NodeJS.Platform;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly mode: LeakFlags;
  /** Worker records received from tests/setup/leak-worker.ts (one per test file). */
  readonly workerRecords: number;
  readonly status: LeakStatus;
  readonly leaks: {
    readonly dirs: readonly DirLeakReport[];
    readonly processes: readonly ProcessLeak[];
    readonly db: readonly DbDelta[];
  };
  readonly warnings: {
    /** New orc-test- dirs seen while another Vitest run was active: not attributable, never removed. */
    readonly uncertainDirs: readonly DirLeakReport[];
    readonly unattributedProcesses: readonly ProcessNote[];
    readonly concurrentRuns: readonly number[];
  };
  readonly scanUnavailable: readonly string[];
  readonly reap: {
    readonly performed: boolean;
    readonly removedDirs: readonly string[];
    readonly killedPids: readonly number[];
    readonly skipped: readonly ReapSkip[];
  };
}

type Findings = Pick<LeakReport, 'leaks' | 'warnings' | 'scanUnavailable'>;

function leakCount(report: Findings): number {
  return report.leaks.dirs.length + report.leaks.processes.length + report.leaks.db.length;
}

/** The STRICT gate: a leak or an unavailable scan fails; warnings (unattributable items) do not. */
export function gateFails(report: Findings): boolean {
  return leakCount(report) > 0 || report.scanUnavailable.length > 0;
}

export function statusOf(report: Findings): LeakStatus {
  if (report.scanUnavailable.length > 0) return 'scan-unavailable';
  if (leakCount(report) > 0) return 'leaks';
  const w = report.warnings;
  if (w.uncertainDirs.length + w.unattributedProcesses.length > 0) return 'warnings';
  return 'clean';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Worker records reported by tests/setup/leak-worker.ts through the file tasks of this run. */
function workerRecords(project: TestProject): WorkerRecord[] {
  const records: WorkerRecord[] = [];
  try {
    for (const module of project.vitest.state.getTestModules()) {
      const parsed = WorkerRecordSchema.safeParse(module.meta().orcLeakWorker);
      if (parsed.success) records.push(parsed.data);
    }
  } catch {
    // Experimental state API unavailable: no worker records (orphans then stay unattributed, never killed).
  }
  return records;
}

function pendingLeaks(diff: LeakDiff): boolean {
  return diff.dirs.length + diff.ownedProcesses.length + diff.unattributedProcesses.length > 0;
}

async function writeReport(report: LeakReport): Promise<void> {
  await mkdir(path.dirname(LEAK_REPORT_FILE), { recursive: true });
  const temporary = `${LEAK_REPORT_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await rename(temporary, LEAK_REPORT_FILE);
}

function summarize(report: LeakReport): string[] {
  const lines = [
    `[leak-guard] ${report.status} (report: ${path.relative(process.cwd(), LEAK_REPORT_FILE)})`,
  ];
  for (const dir of report.leaks.dirs) {
    const git = dir.git.flatMap((g) => [...g.branches, ...g.worktrees.map((w) => `worktree ${w}`)]);
    lines.push(`  leaked dir ${dir.path}${git.length > 0 ? ` (${git.join(', ')})` : ''}`);
  }
  for (const p of report.leaks.processes)
    lines.push(`  leaked fake-claude pid ${p.pid} (${p.attribution})`);
  for (const d of report.leaks.db)
    lines.push(`  leftover rows in orc.${d.table}: ${d.before} -> ${d.after}`);
  for (const s of report.scanUnavailable) lines.push(`  scan unavailable: ${s}`);
  for (const dir of report.warnings.uncertainDirs)
    lines.push(`  warning: new dir during a concurrent run ${dir.path}`);
  for (const p of report.warnings.unattributedProcesses)
    lines.push(`  warning: unattributed fake-claude pid ${p.pid}`);
  if (report.reap.performed) {
    lines.push(
      `  reaped: ${report.reap.removedDirs.length} dir(s), ${report.reap.killedPids.length} process(es)`,
    );
    for (const s of report.reap.skipped) lines.push(`  not reaped ${s.item}: ${s.reason}`);
  }
  return lines;
}

interface GuardState {
  readonly project: TestProject;
  readonly flags: LeakFlags;
  readonly startedAt: string;
  readonly ctx: LedgerContext | null;
  readonly before: LeakSnapshot | null;
  readonly setupError: string | null;
}

async function analyse(
  state: GuardState,
  ctx: LedgerContext,
  before: LeakSnapshot,
): Promise<Omit<LeakReport, 'status' | 'finishedAt'>> {
  const workers = workerRecords(state.project);
  let after = await takeSnapshot(ctx);
  let diff = diffSnapshots(ctx, before, after, workers);
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (pendingLeaks(diff) && Date.now() < deadline) {
    await delay(SETTLE_INTERVAL_MS);
    after = await takeSnapshot(ctx);
    diff = diffSnapshots(ctx, before, after, workers);
  }
  diff = diffSnapshots(ctx, before, { ...after, db: await countTestDbRows() }, workers);

  // Directories carry no owner: they are this run's only when the whole window was observed without another run.
  const certain = before.processes.ok && after.processes.ok && diff.concurrentRuns.length === 0;
  const dirReports = await describeDirLeaks(ctx, diff.dirs);
  let reap: LeakReport['reap'] = { performed: false, removedDirs: [], killedPids: [], skipped: [] };
  if (state.flags.reap) {
    const dirs = certain
      ? await reapDirs(ctx, diff.dirs)
      : {
          removedDirs: [],
          killedPids: [],
          skipped: diff.dirs.map((d) => ({
            item: d.path,
            reason: 'another Vitest run was active or a process scan failed',
          })),
        };
    const processes = await reapProcesses(ctx, diff.ownedProcesses, workers);
    reap = {
      performed: true,
      removedDirs: dirs.removedDirs,
      killedPids: processes.killedPids,
      skipped: [...dirs.skipped, ...processes.skipped],
    };
  }
  return {
    runId: ctx.runId,
    pid: process.pid,
    platform: process.platform,
    startedAt: state.startedAt,
    mode: state.flags,
    workerRecords: workers.length,
    leaks: { dirs: certain ? dirReports : [], processes: diff.ownedProcesses, db: diff.db },
    warnings: {
      uncertainDirs: certain ? [] : dirReports,
      unattributedProcesses: diff.unattributedProcesses,
      concurrentRuns: diff.concurrentRuns,
    },
    scanUnavailable: diff.scanUnavailable,
    reap,
  };
}

async function finish(state: GuardState): Promise<void> {
  let partial: Omit<LeakReport, 'status' | 'finishedAt'>;
  try {
    if (state.ctx === null || state.before === null)
      throw new Error(state.setupError ?? 'leak guard was not set up');
    partial = await analyse(state, state.ctx, state.before);
  } catch (error) {
    partial = {
      runId: state.ctx?.runId ?? null,
      pid: process.pid,
      platform: process.platform,
      startedAt: state.startedAt,
      mode: state.flags,
      workerRecords: 0,
      leaks: { dirs: [], processes: [], db: [] },
      warnings: { uncertainDirs: [], unattributedProcesses: [], concurrentRuns: [] },
      scanUnavailable: [`leak guard failed: ${errorText(error)}`],
      reap: { performed: false, removedDirs: [], killedPids: [], skipped: [] },
    };
  }
  const report: LeakReport = {
    ...partial,
    status: statusOf(partial),
    finishedAt: new Date().toISOString(),
  };
  const logger = state.project.vitest.logger;
  try {
    await writeReport(report);
  } catch (error) {
    logger.error(`[leak-guard] could not write ${LEAK_REPORT_FILE}: ${errorText(error)}`);
  }
  if (report.status !== 'clean') logger.warn(summarize(report).join('\n'));
  if (state.flags.strict && gateFails(report)) {
    logger.error(
      `[leak-guard] FAILED (ORC_TEST_LEAK_STRICT=1): ${leakCount(report)} leak(s), ${report.scanUnavailable.length} unavailable scan(s)`,
    );
    process.exitCode = 1;
  }
}

async function start(project: TestProject): Promise<Release> {
  const flags = readLeakFlags();
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  let ctx: LedgerContext | null = null;
  let before: LeakSnapshot | null = null;
  let setupError: string | null = null;
  try {
    ctx = await createLedgerContext({ runId, rootPid: process.pid });
    // Inherited by the workers Vitest forks after global setup (and by children spawned with the full environment).
    process.env[RUN_ID_ENV] = runId;
    before = await takeSnapshot(ctx, { db: () => countTestDbRows() });
  } catch (error) {
    setupError = errorText(error);
  }
  const state: GuardState = { project, flags, startedAt, ctx, before, setupError };
  return async () => {
    try {
      await finish(state);
    } catch (error) {
      // Never let the guard skip global-infra's teardown (applock release): report and keep going.
      process.stderr.write(`[leak-guard] teardown failed: ${errorText(error)}\n`);
      if (flags.strict) process.exitCode = 1;
    } finally {
      if (process.env[RUN_ID_ENV] === runId) delete process.env[RUN_ID_ENV];
    }
  };
}

/** globalSetup entry: one guarded window per Vitest process, closed when the last infrastructure project ends. */
export default function setup(project: TestProject): Promise<Release> {
  return sharedRun(SHARED_RUN_KEY, () => start(project));
}
