import { useQuery } from '@tanstack/react-query';
import type { WorkerNode } from '@orc/shared';
import { Link } from 'react-router';
import { useApi } from '../api/ApiContext';
import { queryKeys } from '../api/queryKeys';
import { useCan } from '../auth/session';
import { ErrorView } from '../components/ErrorView';
import { Empty, Loading } from '../components/States';
import { StatusBadge } from '../components/StatusBadge';
import { TaskTable } from '../components/TaskTable';
import { DateTime, PageHeader } from '../components/ui';
import { formatBytes, formatNumber } from '../lib/format';
import { useProjectNames } from './useProjectNames';

const SYSTEM_REFRESH_MS = 10_000;

function QueuePanel() {
  const api = useApi();
  const queue = useQuery({
    queryKey: queryKeys.queue,
    queryFn: () => api.queue(),
    refetchInterval: SYSTEM_REFRESH_MS,
  });
  return (
    <section className="card" aria-labelledby="queue-title">
      <h2 id="queue-title">Queues</h2>
      {queue.isPending ? (
        <Loading label="Loading queue status" />
      ) : queue.isError ? (
        <ErrorView error={queue.error} onRetry={() => void queue.refetch()} />
      ) : (
        <>
          <div className="stat-row">
            <div className="stat">
              <span className="stat-label">Dead letters</span>
              <span className={queue.data.deadLetterCount > 0 ? 'stat-value danger' : 'stat-value'}>
                {formatNumber(queue.data.deadLetterCount)}
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">Redis memory</span>
              <span className="stat-value">
                {queue.data.redisMemory
                  ? `${formatBytes(queue.data.redisMemory.usedBytes)} / ${
                      queue.data.redisMemory.maxBytes === null
                        ? 'no limit'
                        : formatBytes(queue.data.redisMemory.maxBytes)
                    }`
                  : 'unknown'}
              </span>
              {queue.data.redisMemory ? (
                <span className="stat-hint">policy {queue.data.redisMemory.policy}</span>
              ) : null}
            </div>
          </div>
          {queue.data.queues.length === 0 ? (
            <Empty>No queues reported.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table compact">
                <thead>
                  <tr>
                    <th scope="col">Queue</th>
                    <th scope="col" className="num">Waiting</th>
                    <th scope="col" className="num">Active</th>
                    <th scope="col" className="num">Delayed</th>
                    <th scope="col" className="num">Failed</th>
                    <th scope="col" className="num">Completed</th>
                    <th scope="col">State</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.data.queues.map((q) => (
                    <tr key={q.name}>
                      <td className="mono">{q.name}</td>
                      <td className="num">{formatNumber(q.waiting + q.prioritized)}</td>
                      <td className="num">{formatNumber(q.active)}</td>
                      <td className="num">{formatNumber(q.delayed)}</td>
                      <td className="num">{formatNumber(q.failed)}</td>
                      <td className="num">{formatNumber(q.completed)}</td>
                      <td>{q.paused ? <StatusBadge status="draining" label="paused" /> : 'running'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small">
            Checked <DateTime value={queue.data.checkedAt} />
          </p>
        </>
      )}
    </section>
  );
}

function WorkersPanel() {
  const api = useApi();
  const workers = useQuery({
    queryKey: queryKeys.workers,
    queryFn: () => api.workers(),
    refetchInterval: SYSTEM_REFRESH_MS,
  });
  return (
    <section className="card" aria-labelledby="workers-title">
      <h2 id="workers-title">Workers</h2>
      {workers.isPending ? (
        <Loading label="Loading workers" />
      ) : workers.isError ? (
        <ErrorView error={workers.error} onRetry={() => void workers.refetch()} />
      ) : workers.data.length === 0 ? (
        <Empty>No worker has registered yet. Tasks stay queued until a worker is running.</Empty>
      ) : (
        <WorkerTable workers={workers.data} />
      )}
    </section>
  );
}

export function WorkerTable({ workers }: { workers: readonly WorkerNode[] }) {
  return (
    <div className="table-wrap">
      <table className="table compact">
        <thead>
          <tr>
            <th scope="col">Worker</th>
            <th scope="col">Status</th>
            <th scope="col" className="num">Jobs</th>
            <th scope="col">Last heartbeat</th>
            <th scope="col">Versions</th>
            <th scope="col" className="num">Disk free</th>
          </tr>
        </thead>
        <tbody>
          {workers.map((w) => (
            <tr key={w.id}>
              <td>
                <span className="mono">{w.hostname}</span>
                <span className="muted small"> pid {w.pid}</span>
              </td>
              <td>
                <StatusBadge status={w.status} />
              </td>
              <td className="num">
                {w.activeJobs} / {w.concurrency}
              </td>
              <td>
                <DateTime value={w.lastHeartbeatAt} />
              </td>
              <td className="small">
                app {w.appVersion} · claude {w.cliVersion ?? '-'} · mcp {w.mcpVersion ?? '-'}
              </td>
              <td className="num">{formatBytes(w.diskFreeBytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecentTasksPanel() {
  const api = useApi();
  const can = useCan();
  const projectNames = useProjectNames();
  const tasks = useQuery({
    queryKey: queryKeys.recentTasks,
    queryFn: () => api.listTasks({ limit: 10 }),
    refetchInterval: SYSTEM_REFRESH_MS,
  });
  return (
    <section className="card span-2" aria-labelledby="recent-title">
      <div className="card-header">
        <h2 id="recent-title">{can('task:read:any') ? 'Recent tasks (all users)' : 'Your recent tasks'}</h2>
        <Link to="/tasks">All tasks</Link>
      </div>
      {tasks.isPending ? (
        <Loading label="Loading recent tasks" />
      ) : tasks.isError ? (
        <ErrorView error={tasks.error} onRetry={() => void tasks.refetch()} />
      ) : tasks.data.items.length === 0 ? (
        <Empty>
          No tasks yet.{' '}
          {can('task:create') ? <Link to="/tasks/new">Create the first task.</Link> : null}
        </Empty>
      ) : (
        <TaskTable tasks={tasks.data.items} projectNames={projectNames} />
      )}
    </section>
  );
}

export function DashboardPage() {
  const can = useCan();
  return (
    <>
      <PageHeader
        title="Dashboard"
        actions={
          can('task:create') ? (
            <Link className="btn btn-primary" to="/tasks/new">
              New task
            </Link>
          ) : null
        }
      />
      <div className="grid-2">
        <RecentTasksPanel />
        {can('system:read') ? <QueuePanel /> : null}
        {can('system:read') ? <WorkersPanel /> : null}
      </div>
    </>
  );
}
