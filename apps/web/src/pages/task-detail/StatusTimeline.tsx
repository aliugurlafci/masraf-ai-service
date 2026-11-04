import { useQuery } from '@tanstack/react-query';
import type { Task } from '@orc/shared';
import { useApi } from '../../api/ApiContext';
import { queryKeys } from '../../api/queryKeys';
import { StatusBadge } from '../../components/StatusBadge';
import { formatTime, humanize } from '../../lib/format';

interface Step {
  key: string;
  status: string;
  at: string;
  note: string | null;
}

/** Status history from `status_changed` events (first 100 events), falling back to task timestamps. */
export function StatusTimeline({ task }: { task: Task }) {
  const api = useApi();
  const events = useQuery({
    queryKey: [...queryKeys.taskEvents(task.id), 'timeline'],
    queryFn: () => api.events(task.id, { limit: 100 }),
  });

  const steps: Step[] = [{ key: 'created', status: 'created', at: task.createdAt, note: null }];
  if (events.data) {
    for (const e of events.data.items) {
      if (e.type === 'status_changed' && e.toStatus) {
        steps.push({ key: e.id, status: e.toStatus, at: e.createdAt, note: e.reason ? humanize(e.reason) : null });
      }
    }
  } else {
    if (task.queuedAt) steps.push({ key: 'queued', status: 'queued', at: task.queuedAt, note: null });
    if (task.startedAt) steps.push({ key: 'started', status: 'preparing_workspace', at: task.startedAt, note: null });
    if (task.finishedAt) steps.push({ key: 'finished', status: task.status, at: task.finishedAt, note: null });
  }
  const last = steps[steps.length - 1];
  if (last && last.status !== task.status) {
    steps.push({ key: 'current', status: task.status, at: task.updatedAt, note: null });
  }

  return (
    <ol className="timeline" aria-label="Status timeline">
      {steps.map((step) => (
        <li key={step.key}>
          <StatusBadge status={step.status} />
          <time dateTime={step.at} className="muted small">
            {formatTime(step.at)}
          </time>
          {step.note ? <span className="small"> {step.note}</span> : null}
        </li>
      ))}
    </ol>
  );
}
