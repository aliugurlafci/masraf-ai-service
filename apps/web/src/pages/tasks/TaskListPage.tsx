import { useInfiniteQuery } from '@tanstack/react-query';
import { TASK_STATUSES } from '@orc/shared';
import type { TaskStatus } from '@orc/shared';
import { Link, useSearchParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { queryKeys } from '../../api/queryKeys';
import { useCan, useMe } from '../../auth/session';
import { ErrorView } from '../../components/ErrorView';
import { Empty, Loading } from '../../components/States';
import { TaskTable } from '../../components/TaskTable';
import { LoadMore, PageHeader } from '../../components/ui';
import { humanize } from '../../lib/format';
import { useProjectNames, useProjectOptions } from '../useProjectNames';

function parseStatuses(raw: string | null): TaskStatus[] {
  if (!raw) {
    return [];
  }
  const allowed = TASK_STATUSES as readonly string[];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is TaskStatus => allowed.includes(s));
}

export function TaskListPage() {
  const api = useApi();
  const can = useCan();
  const me = useMe().data;
  const [params, setParams] = useSearchParams();
  const statuses = parseStatuses(params.get('status'));
  const projectId = params.get('projectId') ?? '';
  const mine = can('task:read:any') && params.get('mine') === '1';
  const createdBy = mine ? me?.user.id : undefined;
  const projectOptions = useProjectOptions();
  const projectNames = useProjectNames();

  const filters = { status: statuses, projectId, createdBy: createdBy ?? null };
  const tasks = useInfiniteQuery({
    queryKey: queryKeys.taskList(filters),
    queryFn: ({ pageParam }) =>
      api.listTasks({
        cursor: pageParam,
        limit: 25,
        status: statuses,
        projectId: projectId || undefined,
        createdBy,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const updateParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null || value === '') {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    setParams(next, { replace: true });
  };

  const toggleStatus = (status: TaskStatus, on: boolean) => {
    const set = new Set(statuses);
    if (on) {
      set.add(status);
    } else {
      set.delete(status);
    }
    updateParam('status', TASK_STATUSES.filter((s) => set.has(s)).join(','));
  };

  const items = tasks.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = statuses.length > 0 || projectId !== '' || mine;

  return (
    <>
      <PageHeader
        title="Tasks"
        actions={
          can('task:create') ? (
            <Link className="btn btn-primary" to="/tasks/new">
              New task
            </Link>
          ) : null
        }
      />
      <div className="toolbar">
        <label>
          Project{' '}
          <select value={projectId} onChange={(e) => updateParam('projectId', e.target.value)}>
            <option value="">All projects</option>
            {(projectOptions.data?.items ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {can('task:read:any') ? (
          <label>
            <input type="checkbox" checked={mine} onChange={(e) => updateParam('mine', e.target.checked ? '1' : null)} />{' '}
            Only my tasks
          </label>
        ) : null}
        <details className="status-filter">
          <summary>Status{statuses.length > 0 ? ` (${statuses.length})` : ''}</summary>
          <fieldset>
            <legend className="visually-hidden">Status filter</legend>
            {TASK_STATUSES.map((s) => (
              <label key={s}>
                <input type="checkbox" checked={statuses.includes(s)} onChange={(e) => toggleStatus(s, e.target.checked)} />{' '}
                {humanize(s)}
              </label>
            ))}
          </fieldset>
        </details>
        {filtered ? (
          <button type="button" className="btn btn-ghost btn-small" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
            Clear filters
          </button>
        ) : null}
      </div>
      {tasks.isPending ? (
        <Loading label="Loading tasks" />
      ) : tasks.isError ? (
        <ErrorView error={tasks.error} onRetry={() => void tasks.refetch()} />
      ) : items.length === 0 ? (
        <Empty>{filtered ? 'No tasks match these filters.' : 'No tasks yet.'}</Empty>
      ) : (
        <>
          <TaskTable tasks={items} projectNames={projectNames} />
          <LoadMore hasMore={tasks.hasNextPage} loading={tasks.isFetchingNextPage} onLoad={() => void tasks.fetchNextPage()} />
        </>
      )}
    </>
  );
}
