import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { queryKeys } from '../../api/queryKeys';
import { useCan } from '../../auth/session';
import { ErrorView } from '../../components/ErrorView';
import { Empty, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { DateTime, LoadMore, PageHeader } from '../../components/ui';
import { formatBytes, formatDuration, formatNumber, humanize, stringifyJson } from '../../lib/format';
import { ForbiddenView } from '../errors/ErrorPages';
import { WorkerTable } from '../DashboardPage';

const REFRESH_MS = 10_000;
const TABS = ['workers', 'queues', 'dlq', 'mcp'] as const;
type SystemTab = (typeof TABS)[number];
const LABELS: Readonly<Record<SystemTab, string>> = {
  workers: 'Workers',
  queues: 'Queues',
  dlq: 'Dead letters',
  mcp: 'Code index (MCP)',
};

function WorkersTab() {
  const api = useApi();
  const workers = useQuery({ queryKey: queryKeys.workers, queryFn: () => api.workers(), refetchInterval: REFRESH_MS });
  if (workers.isPending) return <Loading label="Loading workers" />;
  if (workers.isError) return <ErrorView error={workers.error} onRetry={() => void workers.refetch()} />;
  if (workers.data.length === 0) return <Empty>No worker has registered yet.</Empty>;
  return <WorkerTable workers={workers.data} />;
}

function QueuesTab() {
  const api = useApi();
  const queue = useQuery({ queryKey: queryKeys.queue, queryFn: () => api.queue(), refetchInterval: REFRESH_MS });
  if (queue.isPending) return <Loading label="Loading queues" />;
  if (queue.isError) return <ErrorView error={queue.error} onRetry={() => void queue.refetch()} />;
  const q = queue.data;
  return (
    <>
      <div className="stat-row">
        <div className="stat">
          <span className="stat-label">Dead letters</span>
          <span className={q.deadLetterCount > 0 ? 'stat-value danger' : 'stat-value'}>{formatNumber(q.deadLetterCount)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Redis memory used</span>
          <span className="stat-value">{q.redisMemory ? formatBytes(q.redisMemory.usedBytes) : 'unknown'}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Redis maxmemory</span>
          <span className="stat-value">
            {q.redisMemory ? (q.redisMemory.maxBytes === null ? 'not set' : formatBytes(q.redisMemory.maxBytes)) : 'unknown'}
          </span>
          {q.redisMemory ? <span className="stat-hint">policy {q.redisMemory.policy}</span> : null}
        </div>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Queue</th>
              <th scope="col" className="num">Waiting</th>
              <th scope="col" className="num">Prioritized</th>
              <th scope="col" className="num">Active</th>
              <th scope="col" className="num">Delayed</th>
              <th scope="col" className="num">Failed</th>
              <th scope="col" className="num">Completed</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {q.queues.map((s) => (
              <tr key={s.name}>
                <td className="mono">{s.name}</td>
                <td className="num">{formatNumber(s.waiting)}</td>
                <td className="num">{formatNumber(s.prioritized)}</td>
                <td className="num">{formatNumber(s.active)}</td>
                <td className="num">{formatNumber(s.delayed)}</td>
                <td className="num">{formatNumber(s.failed)}</td>
                <td className="num">{formatNumber(s.completed)}</td>
                <td>{s.paused ? <StatusBadge status="draining" label="paused" /> : 'running'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        Checked <DateTime value={q.checkedAt} />
      </p>
    </>
  );
}

function DlqTab() {
  const api = useApi();
  const dlq = useInfiniteQuery({
    queryKey: queryKeys.dlq,
    queryFn: ({ pageParam }) => api.deadLetters({ cursor: pageParam, limit: 25 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  if (dlq.isPending) return <Loading label="Loading dead letters" />;
  if (dlq.isError) return <ErrorView error={dlq.error} onRetry={() => void dlq.refetch()} />;
  const items = dlq.data.pages.flatMap((p) => p.items);
  if (items.length === 0) return <Empty>The dead-letter queue is empty.</Empty>;
  return (
    <>
      <ul className="dlq-list">
        {items.map((entry) => (
          <li key={entry.jobId} className="card">
            <div className="dlq-head">
              <code>{entry.data.sourceQueue}</code> · {entry.data.jobName} · job <code>{entry.data.jobId}</code> ·{' '}
              {entry.data.attemptsMade} attempts · failed <DateTime value={entry.data.failedAt} />
            </div>
            <p className="failure-message">{entry.data.failedReason}</p>
            <details>
              <summary>Job data</summary>
              <pre className="json">{stringifyJson(entry.data.data)}</pre>
            </details>
          </li>
        ))}
      </ul>
      <LoadMore hasMore={dlq.hasNextPage} loading={dlq.isFetchingNextPage} onLoad={() => void dlq.fetchNextPage()} />
    </>
  );
}

function McpTab() {
  const api = useApi();
  const mcp = useQuery({ queryKey: queryKeys.mcp, queryFn: () => api.mcp(), refetchInterval: REFRESH_MS });
  if (mcp.isPending) return <Loading label="Loading MCP status" />;
  if (mcp.isError) return <ErrorView error={mcp.error} onRetry={() => void mcp.refetch()} />;
  const m = mcp.data;
  return (
    <>
      <p>
        Code indexing is{' '}
        {m.mcpEnabled ? <StatusBadge status="ready" label="enabled" /> : <StatusBadge status="offline" label="disabled" />}
      </p>
      <h3>Workers</h3>
      {m.workers.length === 0 ? (
        <Empty>No worker reports an MCP version.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table compact">
            <thead>
              <tr>
                <th scope="col">Worker</th>
                <th scope="col">Status</th>
                <th scope="col">MCP</th>
                <th scope="col">Claude CLI</th>
                <th scope="col">Last heartbeat</th>
              </tr>
            </thead>
            <tbody>
              {m.workers.map((w) => (
                <tr key={w.workerId}>
                  <td className="mono">{w.workerId}</td>
                  <td>
                    <StatusBadge status={w.status} />
                  </td>
                  <td>{w.mcpVersion ?? '-'}</td>
                  <td>{w.cliVersion ?? '-'}</td>
                  <td>
                    <DateTime value={w.lastHeartbeatAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>Recent operations</h3>
      {m.recentOperations.length === 0 ? (
        <Empty>No index operations yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table compact">
            <thead>
              <tr>
                <th scope="col">Kind</th>
                <th scope="col">Status</th>
                <th scope="col">Project</th>
                <th scope="col">Index</th>
                <th scope="col">Requested</th>
                <th scope="col" className="num">Duration</th>
                <th scope="col">Error</th>
              </tr>
            </thead>
            <tbody>
              {m.recentOperations.map((op) => (
                <tr key={op.id}>
                  <td>{humanize(op.kind)}</td>
                  <td>
                    <StatusBadge status={op.status} />
                  </td>
                  <td>
                    <Link to={`/projects/${op.projectId}`}>project</Link>
                    {op.taskId ? (
                      <>
                        {' · '}
                        <Link to={`/tasks/${op.taskId}`}>task</Link>
                      </>
                    ) : null}
                  </td>
                  <td className="mono small">{op.indexName}</td>
                  <td>
                    <DateTime value={op.createdAt} />
                  </td>
                  <td className="num">{formatDuration(op.durationMs)}</td>
                  <td className="small">{op.errorCode ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function SystemPage() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: SystemTab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as SystemTab) : 'workers';
  const visibleTabs = TABS.filter((t) => t !== 'dlq' || can('system:manage'));

  return (
    <>
      <PageHeader title="System" subtitle="Workers, queues, dead letters and code index status (refreshes every 10 s)." />
      <nav className="tabs" aria-label="System sections">
        {visibleTabs.map((t) => (
          <button
            key={t}
            type="button"
            className={t === tab ? 'tab active' : 'tab'}
            aria-current={t === tab ? 'page' : undefined}
            onClick={() => setParams(t === 'workers' ? {} : { tab: t }, { replace: true })}
          >
            {LABELS[t]}
          </button>
        ))}
      </nav>
      <section className="tab-panel" aria-label={LABELS[tab]}>
        {tab === 'workers' ? <WorkersTab /> : null}
        {tab === 'queues' ? <QueuesTab /> : null}
        {tab === 'dlq' ? can('system:manage') ? <DlqTab /> : <ForbiddenView inline /> : null}
        {tab === 'mcp' ? <McpTab /> : null}
      </section>
    </>
  );
}
