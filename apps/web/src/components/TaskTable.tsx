import type { Task } from '@orc/shared';
import { Link } from 'react-router';
import { DateTime } from './ui';
import { StatusBadge } from './StatusBadge';

export function TaskTable({
  tasks,
  projectNames,
}: {
  tasks: readonly Task[];
  projectNames?: ReadonlyMap<string, string>;
}) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Title</th>
            <th scope="col">Status</th>
            <th scope="col">Project</th>
            <th scope="col">Model</th>
            <th scope="col" className="num">
              Attempts
            </th>
            <th scope="col">Created</th>
            <th scope="col">Finished</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.id}>
              <td>
                <Link to={`/tasks/${task.id}`}>{task.title}</Link>
                {task.cancelRequestedAt && task.finishedAt === null ? (
                  <span className="muted small"> (cancel requested)</span>
                ) : null}
              </td>
              <td>
                <StatusBadge status={task.status} />
              </td>
              <td>
                <Link to={`/projects/${task.projectId}`}>
                  {projectNames?.get(task.projectId) ?? 'Project'}
                </Link>
              </td>
              <td className="mono small">{task.model}</td>
              <td className="num">{task.attemptCount}</td>
              <td>
                <DateTime value={task.createdAt} />
              </td>
              <td>
                <DateTime value={task.finishedAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
