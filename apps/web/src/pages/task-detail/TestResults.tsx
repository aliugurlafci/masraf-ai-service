import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { TEST_CASE_STATUSES } from '@orc/shared';
import type { TestCaseStatus, TestRun } from '@orc/shared';
import { useState } from 'react';
import { useApi } from '../../api/ApiContext';
import { queryKeys } from '../../api/queryKeys';
import { ErrorView } from '../../components/ErrorView';
import { Banner, Empty, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { DateTime, LoadMore } from '../../components/ui';
import { formatDuration } from '../../lib/format';

const RESULTS_PAGE = 50;

function RunResults({ taskId, run }: { taskId: string; run: TestRun }) {
  const api = useApi();
  const [status, setStatus] = useState<TestCaseStatus | ''>(run.failed + run.errored > 0 ? 'failed' : '');
  const results = useInfiniteQuery({
    queryKey: [...queryKeys.taskArtefact(taskId, 'test-results', run.id), status],
    queryFn: ({ pageParam }) =>
      api.testResults(taskId, run.id, { status: status === '' ? undefined : status, cursor: pageParam, limit: RESULTS_PAGE }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = results.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="test-results">
      <label className="inline-label">
        Show{' '}
        <select value={status} onChange={(e) => setStatus(e.target.value as TestCaseStatus | '')}>
          <option value="">all cases</option>
          {TEST_CASE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      {results.isPending ? (
        <Loading label="Loading test cases" />
      ) : results.isError ? (
        <ErrorView error={results.error} onRetry={() => void results.refetch()} />
      ) : items.length === 0 ? (
        <Empty>{status ? `No ${status} test cases.` : run.reportParsed ? 'The report contains no test cases.' : 'No JUnit report was parsed for this run.'}</Empty>
      ) : (
        <>
          <ul className="case-list">
            {items.map((result) => {
              const failing = result.status === 'failed' || result.status === 'error';
              const label = [result.suiteName, result.className, result.name].filter(Boolean).join(' › ');
              return (
                <li key={result.id} className={`case case-${result.status}`}>
                  {failing ? (
                    <details>
                      <summary>
                        <StatusBadge status={result.status} /> <span className="case-name">{label}</span>{' '}
                        <span className="muted small">{formatDuration(result.durationMs)}</span>
                      </summary>
                      {result.filePath ? <p className="mono small">{result.filePath}</p> : null}
                      {result.failureType ? <p><code>{result.failureType}</code></p> : null}
                      {result.failureMessage ? <p className="failure-message">{result.failureMessage}</p> : null}
                      {result.failureDetail ? <pre className="failure-detail">{result.failureDetail}</pre> : null}
                    </details>
                  ) : (
                    <div>
                      <StatusBadge status={result.status} /> <span className="case-name">{label}</span>{' '}
                      <span className="muted small">{formatDuration(result.durationMs)}</span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <LoadMore hasMore={results.hasNextPage} loading={results.isFetchingNextPage} onLoad={() => void results.fetchNextPage()} />
        </>
      )}
    </div>
  );
}

function RunCard({ taskId, run }: { taskId: string; run: TestRun }) {
  return (
    <section className="test-run card" aria-label={`Test run ${run.command.join(' ')}`}>
      <header className="test-run-header">
        <StatusBadge status={run.status} />
        <code className="test-command">{run.command.join(' ')}</code>
        <span className="muted small">
          <DateTime value={run.startedAt} /> · {formatDuration(run.durationMs)}
          {run.exitCode !== null ? ` · exit ${run.exitCode}` : ''}
          {run.signal ? ` · ${run.signal}` : ''}
        </span>
      </header>
      <div className="stat-row" aria-label="Test counts">
        <div className="stat">
          <span className="stat-label">Total</span>
          <span className="stat-value">{run.total}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Passed</span>
          <span className="stat-value success">{run.passed}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Failed</span>
          <span className={run.failed > 0 ? 'stat-value danger' : 'stat-value'}>{run.failed}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Errors</span>
          <span className={run.errored > 0 ? 'stat-value danger' : 'stat-value'}>{run.errored}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Skipped</span>
          <span className="stat-value">{run.skipped}</span>
        </div>
      </div>
      {run.reportError ? (
        <Banner tone="warning" title="JUnit report could not be parsed">
          {run.reportError}
        </Banner>
      ) : null}
      <RunResults taskId={taskId} run={run} />
    </section>
  );
}

/** `tests` tab: runs with counts and paged results (contract §20.2). */
export function TestResults({
  taskId,
  attemptId,
  projectId,
}: {
  taskId: string;
  attemptId: string | undefined;
  projectId: string;
}) {
  const api = useApi();
  const runs = useQuery({
    queryKey: queryKeys.taskArtefact(taskId, 'tests', attemptId),
    queryFn: () => api.testRuns(taskId, attemptId),
  });
  const project = useQuery({
    queryKey: queryKeys.projectDetail(projectId),
    queryFn: ({ signal }) => api.getProject(projectId, signal),
    enabled: runs.isSuccess && runs.data.length === 0,
  });

  if (runs.isPending) return <Loading label="Loading test runs" />;
  if (runs.isError) return <ErrorView error={runs.error} onRetry={() => void runs.refetch()} />;
  if (runs.data.length === 0) {
    if (project.isPending) return <Loading label="Loading project" lines={1} />;
    const noCommand = project.isSuccess && project.data.data.testCommand === null;
    return (
      <Empty>
        {noCommand
          ? 'No test command configured for this project, so no tests were run.'
          : 'No test runs were recorded for this attempt.'}
      </Empty>
    );
  }
  return (
    <div className="test-runs">
      {runs.data.map((run) => (
        <RunCard key={run.id} taskId={taskId} run={run} />
      ))}
    </div>
  );
}
