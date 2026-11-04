import { useQuery } from '@tanstack/react-query';
import type { TaskAttempt, TaskDetail } from '@orc/shared';
import { Link, useParams, useSearchParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { queryKeys } from '../../api/queryKeys';
import { ErrorView } from '../../components/ErrorView';
import { Banner, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { DateTime } from '../../components/ui';
import { formatDuration, formatUsd, humanize } from '../../lib/format';
import { ChangedFilesTab, EventsTab, ImpactTab, SessionTab } from './ArtefactTabs';
import { DiffView } from './DiffView';
import { LiveOutput } from './LiveOutput';
import { StatusTimeline } from './StatusTimeline';
import { TaskActions } from './TaskActions';
import { TestResults } from './TestResults';
import { useTaskStream } from './useTaskStream';

export const TASK_TABS = ['output', 'changes', 'diff', 'tests', 'events', 'session', 'impact'] as const;
export type TaskTab = (typeof TASK_TABS)[number];

const TAB_LABELS: Readonly<Record<TaskTab, string>> = {
  output: 'Output',
  changes: 'Changed files',
  diff: 'Diff',
  tests: 'Tests',
  events: 'Events',
  session: 'Session',
  impact: 'MCP impact',
};

function parseTab(raw: string | null): TaskTab {
  return (TASK_TABS as readonly string[]).includes(raw ?? '') ? (raw as TaskTab) : 'output';
}

function AttemptSelector({
  attempts,
  selected,
  currentAttemptId,
  onSelect,
}: {
  attempts: readonly TaskAttempt[];
  selected: string | null;
  currentAttemptId: string | null;
  onSelect: (attemptId: string | null) => void;
}) {
  if (attempts.length === 0) return null;
  return (
    <label className="attempt-select">
      Attempt{' '}
      <select
        value={selected ?? ''}
        onChange={(e) => onSelect(e.target.value === '' || e.target.value === currentAttemptId ? null : e.target.value)}
      >
        <option value="">Current attempt</option>
        {attempts.map((a) => (
          <option key={a.id} value={a.id}>
            #{a.attemptNumber} · {humanize(a.mode)} · {humanize(a.status)}
          </option>
        ))}
      </select>
    </label>
  );
}

function AttemptSummary({ attempt }: { attempt: TaskAttempt }) {
  return (
    <div className="attempt-summary small">
      <span>
        Attempt #{attempt.attemptNumber} <StatusBadge status={attempt.status} />
      </span>
      {attempt.stage ? <span>stage {humanize(attempt.stage)}</span> : null}
      {attempt.branchName ? (
        <span>
          branch <code>{attempt.branchName}</code>
        </span>
      ) : null}
      {attempt.filesChanged !== null ? (
        <span>
          {attempt.filesChanged} files <span className="add">+{attempt.additions ?? 0}</span>{' '}
          <span className="del">-{attempt.deletions ?? 0}</span>
        </span>
      ) : null}
      {attempt.workerId ? <span>worker {attempt.workerId}</span> : null}
      {attempt.failureReason ? (
        <span className="danger">
          {humanize(attempt.failureReason)}
          {attempt.failureDetail ? `: ${attempt.failureDetail}` : ''}
        </span>
      ) : null}
    </div>
  );
}

function Header({ detail, etag, onRetried }: { detail: TaskDetail; etag: string | null; onRetried: () => void }) {
  const { task, project, agent, createdBy } = detail;
  return (
    <header className="task-header">
      <div className="task-title-row">
        <h1>{task.title}</h1>
        <StatusBadge status={task.status} />
        <TaskActions detail={detail} etag={etag} onRetried={onRetried} />
      </div>
      <p className="task-meta small">
        <Link to={`/projects/${project.id}`}>{project.name}</Link> · {agent.title} ({agent.name}) · model{' '}
        <code>{task.model}</code>
        {task.effort ? ` · effort ${task.effort}` : ''} · by {createdBy.displayName} · created{' '}
        <DateTime value={task.createdAt} /> · timeout {formatDuration(task.timeoutSeconds * 1000)}
        {task.maxBudgetUsd !== null ? ` · budget ${formatUsd(task.maxBudgetUsd)}` : ''}
        {task.baseRef ? (
          <>
            {' '}
            · base <code>{task.baseRef}</code>
          </>
        ) : null}
      </p>
      {task.statusReason || task.statusDetail ? (
        <Banner tone={task.status === 'completed' ? 'info' : 'warning'} title={task.statusReason ? humanize(task.statusReason) : undefined}>
          {task.statusDetail}
        </Banner>
      ) : null}
    </header>
  );
}

function TaskDetailView({ taskId }: { taskId: string }) {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get('tab'));
  const attemptParam = params.get('attempt');

  const detailQuery = useQuery({
    queryKey: queryKeys.taskDetail(taskId),
    queryFn: ({ signal }) => api.getTask(taskId, signal),
  });
  const attempts = useQuery({
    queryKey: queryKeys.taskAttempts(taskId),
    queryFn: () => api.attempts(taskId),
    enabled: detailQuery.isSuccess,
  });
  const currentAttemptId = detailQuery.data?.data.task.currentAttemptId ?? null;
  const stream = useTaskStream(taskId, currentAttemptId, detailQuery.isSuccess);

  if (detailQuery.isPending) return <Loading label="Loading task" lines={5} />;
  if (detailQuery.isError) {
    return <ErrorView error={detailQuery.error} onRetry={() => void detailQuery.refetch()} notFoundWhat="task" />;
  }

  const detail = detailQuery.data.data;
  const etag = detailQuery.data.etag;
  const attemptList = attempts.data ?? [];
  const selectedAttemptId = attemptParam && attemptList.some((a) => a.id === attemptParam) ? attemptParam : null;
  const artefactAttemptId = selectedAttemptId ?? undefined;
  const shownAttempt =
    attemptList.find((a) => a.id === (selectedAttemptId ?? currentAttemptId)) ?? detail.currentAttempt ?? null;

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    setParams(next, { replace: key === 'attempt' ? false : true });
  };

  return (
    <article className="task-detail">
      <Header detail={detail} etag={etag} onRetried={() => setParam('attempt', null)} />
      <div className="task-overview">
        <StatusTimeline task={detail.task} />
        <div className="attempt-bar">
          <AttemptSelector
            attempts={attemptList}
            selected={selectedAttemptId}
            currentAttemptId={currentAttemptId}
            onSelect={(id) => setParam('attempt', id)}
          />
          {shownAttempt ? <AttemptSummary attempt={shownAttempt} /> : null}
        </div>
      </div>
      <nav className="tabs" aria-label="Task sections">
        {TASK_TABS.map((t) => {
          const next = new URLSearchParams(params);
          if (t === 'output') {
            next.delete('tab');
          } else {
            next.set('tab', t);
          }
          const qs = next.toString();
          return (
            <Link
              key={t}
              to={{ search: qs.length > 0 ? `?${qs}` : '' }}
              replace
              className={t === tab ? 'tab active' : 'tab'}
              aria-current={t === tab ? 'page' : undefined}
            >
              {TAB_LABELS[t]}
            </Link>
          );
        })}
      </nav>
      <section className="tab-panel" aria-label={TAB_LABELS[tab]}>
        {tab === 'output' ? <LiveOutput taskId={taskId} state={stream} attemptId={selectedAttemptId} /> : null}
        {tab === 'changes' ? <ChangedFilesTab taskId={taskId} attemptId={artefactAttemptId} /> : null}
        {tab === 'diff' ? <DiffView taskId={taskId} attemptId={artefactAttemptId} /> : null}
        {tab === 'tests' ? (
          <TestResults taskId={taskId} attemptId={artefactAttemptId} projectId={detail.project.id} />
        ) : null}
        {tab === 'events' ? <EventsTab taskId={taskId} /> : null}
        {tab === 'session' ? <SessionTab taskId={taskId} attemptId={artefactAttemptId} /> : null}
        {tab === 'impact' ? <ImpactTab taskId={taskId} attemptId={artefactAttemptId} /> : null}
      </section>
    </article>
  );
}

export function TaskDetailPage() {
  const { taskId = '' } = useParams();
  return <TaskDetailView key={taskId} taskId={taskId} />;
}
