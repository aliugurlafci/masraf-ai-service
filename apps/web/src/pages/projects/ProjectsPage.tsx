import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PROJECT_STATUSES } from '@orc/shared';
import type { CreateProjectRequest, ProjectStatus } from '@orc/shared';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { queryKeys } from '../../api/queryKeys';
import { useCan } from '../../auth/session';
import { Dialog } from '../../components/Dialog';
import { ErrorView } from '../../components/ErrorView';
import { Empty, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { DateTime, LoadMore, PageHeader } from '../../components/ui';
import { IdempotencyKeys } from '../../lib/idempotency';
import { ProjectForm } from './ProjectForm';

function parseStatus(value: string | null): ProjectStatus | undefined {
  return (PROJECT_STATUSES as readonly string[]).includes(value ?? '') ? (value as ProjectStatus) : undefined;
}

function CreateProjectDialog({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const can = useCan();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [keys] = useState(() => new IdempotencyKeys());
  const agents = useQuery({
    queryKey: queryKeys.agentList({ includeInactive: false }),
    queryFn: () => api.listAgents(),
    enabled: can('agent:read'),
  });
  const create = useMutation({
    mutationFn: (body: CreateProjectRequest) => api.createProject(body, keys.keyFor(body)),
    onSettled: (_data, error) => keys.settle(error),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      onClose();
      await navigate(`/projects/${res.data.id}`);
    },
  });
  return (
    <Dialog title="New project" onClose={onClose} busy={create.isPending} wide>
      <ProjectForm
        agents={agents.data ?? []}
        submitting={create.isPending}
        error={create.error}
        onCancel={onClose}
        onSubmit={(submit) => {
          if (submit.mode === 'create') {
            create.mutate(submit.body);
          }
        }}
      />
    </Dialog>
  );
}

export function ProjectsPage() {
  const api = useApi();
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const status = parseStatus(params.get('status'));
  const [creating, setCreating] = useState(false);

  const projects = useInfiniteQuery({
    queryKey: queryKeys.projectList({ status: status ?? null, paged: true }),
    queryFn: ({ pageParam }) => api.listProjects({ status, cursor: pageParam, limit: 25 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const items = projects.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader
        title="Projects"
        actions={
          can('project:create') ? (
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              New project
            </button>
          ) : null
        }
      />
      <div className="toolbar">
        <label>
          Status{' '}
          <select
            value={status ?? ''}
            onChange={(e) => {
              const next = new URLSearchParams(params);
              if (e.target.value) {
                next.set('status', e.target.value);
              } else {
                next.delete('status');
              }
              setParams(next, { replace: true });
            }}
          >
            <option value="">All</option>
            {PROJECT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>
      {projects.isPending ? (
        <Loading label="Loading projects" />
      ) : projects.isError ? (
        <ErrorView error={projects.error} onRetry={() => void projects.refetch()} />
      ) : items.length === 0 ? (
        <Empty>
          {status ? `No ${status} projects.` : 'No projects registered yet.'}
          {can('project:create') && !status ? ' Use "New project" to register a repository.' : ''}
        </Empty>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Status</th>
                  <th scope="col">Repository</th>
                  <th scope="col">Branch</th>
                  <th scope="col">Last sync</th>
                  <th scope="col">Last index</th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={`/projects/${p.id}`}>{p.name}</Link>
                      {p.description ? <div className="muted small clamp">{p.description}</div> : null}
                    </td>
                    <td>
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="mono small">{p.repoPath}</td>
                    <td className="mono small">{p.defaultBranch ?? 'HEAD'}</td>
                    <td>
                      <DateTime value={p.lastSyncedAt} />
                    </td>
                    <td>
                      <DateTime value={p.lastIndexedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <LoadMore
            hasMore={projects.hasNextPage}
            loading={projects.isFetchingNextPage}
            onLoad={() => void projects.fetchNextPage()}
          />
        </>
      )}
      {creating ? <CreateProjectDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}
