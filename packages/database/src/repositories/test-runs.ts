// TestRuns and TestResults (contract §2.5).
import { OrcError, TEST_CASE_STATUSES } from '@orc/shared';
import { T, assertBigId, assertGuid, assertInt, first, run, truncateChars, truncateUtf8 } from '../sql.js';
import type { RepoContext } from '../sql.js';
import type { NewTestResult, TestRunRepository } from '../types.js';
import { mapTestResult, mapTestRun } from './mappers.js';

/** At most this many TestResults rows are kept per run (failures are kept first). */
export const TEST_RESULTS_MAX_ROWS = 5000;
export const TEST_RESULT_ROWS_PER_STATEMENT = 200;
const FAILURE_DETAIL_MAX_BYTES = 16_384;

const RUN_START = `INSERT INTO orc.TestRuns (AttemptId, TaskId, CommandJson, JUnitPath)
OUTPUT inserted.*
VALUES (@attemptId, @taskId, @command, @junitPath);`;
const RUN_FINISH = `UPDATE orc.TestRuns SET
  Status = @status, ExitCode = @exitCode, Signal = @signal, DurationMs = @durationMs, Total = @total, Passed = @passed,
  Failed = @failed, Errored = @errored, Skipped = @skipped, ReportParsed = @reportParsed, ReportError = @reportError,
  EndedAt = SYSUTCDATETIME()
WHERE Id = @id;`;
const RESULTS_INSERT_BATCH = `INSERT INTO orc.TestResults
  (TestRunId, SuiteName, ClassName, Name, FilePath, Status, DurationMs, FailureType, FailureMessage, FailureDetail)
SELECT @testRunId, j.SuiteName, j.ClassName, j.Name, j.FilePath, j.Status, j.DurationMs, j.FailureType,
  j.FailureMessage, j.FailureDetail
FROM OPENJSON(@rows) WITH (
  Ord INT '$.o',
  SuiteName NVARCHAR(MAX) '$.su',
  ClassName NVARCHAR(MAX) '$.cl',
  Name NVARCHAR(MAX) '$.n',
  FilePath NVARCHAR(MAX) '$.f',
  Status VARCHAR(MAX) '$.s',
  DurationMs INT '$.d',
  FailureType NVARCHAR(MAX) '$.ft',
  FailureMessage NVARCHAR(MAX) '$.fm',
  FailureDetail NVARCHAR(MAX) '$.fd'
) AS j
ORDER BY j.Ord;`;
const RUNS_BY_ATTEMPT = 'SELECT * FROM orc.TestRuns WHERE AttemptId = @attemptId ORDER BY StartedAt, Id;';
const RESULTS_LIST = `SELECT TOP (@limit) * FROM orc.TestResults
WHERE TestRunId = @testRunId AND (@status IS NULL OR Status = @status) AND (@afterId IS NULL OR Id > @afterId)
ORDER BY Id ASC
OPTION (RECOMPILE);`;

const cap = (v: string | null, n: number): string | null => (v === null ? null : truncateChars(v, n));

/** Keeps failures/errors first when more than TEST_RESULTS_MAX_ROWS rows arrive; preserves input order. */
export function selectKeptResults<R extends { status: string }>(rows: readonly R[]): R[] {
  if (rows.length <= TEST_RESULTS_MAX_ROWS) return [...rows];
  const keep = new Set<number>();
  rows.forEach((r, i) => {
    if (keep.size < TEST_RESULTS_MAX_ROWS && (r.status === 'failed' || r.status === 'error')) keep.add(i);
  });
  rows.forEach((_r, i) => {
    if (keep.size < TEST_RESULTS_MAX_ROWS) keep.add(i);
  });
  return rows.filter((_r, i) => keep.has(i));
}

function resultJson(r: NewTestResult, ord: number): Record<string, unknown> {
  if (!(TEST_CASE_STATUSES as readonly string[]).includes(r.status)) {
    throw new OrcError('validation_failed', `Invalid test case status ${String(r.status)}`);
  }
  return {
    o: ord,
    su: cap(r.suiteName, 400),
    cl: cap(r.className, 400),
    n: truncateChars(r.name, 400),
    f: cap(r.filePath, 400),
    s: r.status,
    d: r.durationMs === null ? null : Math.max(0, Math.min(Math.round(r.durationMs), 2_147_483_647)),
    ft: cap(r.failureType, 200),
    fm: cap(r.failureMessage, 4000),
    fd: r.failureDetail === null ? null : truncateUtf8(r.failureDetail, FAILURE_DETAIL_MAX_BYTES),
  };
}

export function createTestRunRepository(ctx: RepoContext): TestRunRepository {
  return {
    async start(r) {
      const { rows } = await run(ctx, RUN_START, [
        ['attemptId', T.guid, r.attemptId],
        ['taskId', T.guid, r.taskId],
        ['command', T.nvarcharMax, JSON.stringify(r.command)],
        ['junitPath', T.nvarchar(400), r.junitPath],
      ]);
      const row = first(rows);
      if (!row) throw new OrcError('internal_error', 'TestRuns insert returned no row');
      return mapTestRun(row);
    },
    async finish(id, r) {
      await run(ctx, RUN_FINISH, [
        ['id', T.guid, id],
        ['status', T.varchar(10), r.status],
        ['exitCode', T.int, r.exitCode],
        ['signal', T.varchar(16), r.signal],
        ['durationMs', T.bigint, r.durationMs],
        ['total', T.int, r.total],
        ['passed', T.int, r.passed],
        ['failed', T.int, r.failed],
        ['errored', T.int, r.errored],
        ['skipped', T.int, r.skipped],
        ['reportParsed', T.bit, r.reportParsed],
        ['reportError', T.nvarchar(1000), cap(r.reportError, 1000)],
      ]);
    },
    async insertResults(testRunId, rows) {
      assertGuid(testRunId, 'testRunId');
      if (rows.length === 0) return;
      const payload = selectKeptResults(rows).map(resultJson);
      await ctx.exec.atomic('testRuns.insertResults', async (exec) => {
        const c: RepoContext = { ...ctx, exec };
        for (let start = 0; start < payload.length; start += TEST_RESULT_ROWS_PER_STATEMENT) {
          await run(c, RESULTS_INSERT_BATCH, [
            ['testRunId', T.guid, testRunId],
            ['rows', T.nvarcharMax, JSON.stringify(payload.slice(start, start + TEST_RESULT_ROWS_PER_STATEMENT))],
          ]);
        }
      });
    },
    async listByAttempt(attemptId) {
      return (await run(ctx, RUNS_BY_ATTEMPT, [['attemptId', T.guid, attemptId]])).rows.map(mapTestRun);
    },
    async listResults(q) {
      const { rows } = await run(ctx, RESULTS_LIST, [
        ['limit', T.int, assertInt(q.limit, 'limit', 1, 10_000)],
        ['testRunId', T.guid, q.testRunId],
        ['status', T.varchar(8), q.status ?? null],
        ['afterId', T.bigint, q.afterId === undefined ? null : assertBigId(q.afterId, 'afterId')],
      ]);
      return rows.map(mapTestResult);
    },
  };
}
