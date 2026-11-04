import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpdateProjectRequest } from '@orc/shared';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { hasErrorCode, isApiError } from '../../api/errors';
import { queryKeys } from '../../api/queryKeys';
import { useCan } from '../../auth/session';
import { Dialog } from '../../components/Dialog';
import { ErrorView, ProblemMessage } from '../../components/ErrorView';
import { Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { DateTime, KeyValues, PageHeader } from '../../components/ui';
import { formatBytes, formatDuration } from '../../lib/format';
import { ProjectForm } from '../projects/ProjectForm';
import { IndexOperations, IndexStatusPanel } from './IndexStatus';

const CONFLICT_NOTICE =
  'This project was changed by someone else. The form now shows the current server version; review it and save again.';

export function ProjectDetailPage() {
  const { projectId = '' } = useParams();
  const api = useApi();
  const can = useCan();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [formVersion, setFormVersion] = useState(0);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);

  const project = useQuery({
    queryKey: queryKeys.projectDetail(projectId),
    queryFn: ({ signal }) => api.getProject(projectId, signal),
  });
  const agents = useQuery({
    queryKey: queryKeys.agentList({ includeInactive: false }),
    queryFn: () => api.listAgents(),
    enabled: can('agent:read'),
  });

  const update = useMutation({
    mutationFn: (body: UpdateProjectRequest) =>
      api.updateProject(projectId, body, project.data?.etag ?? null),
    onSuccess: (res) => {
      queryClient.setQueryData(queryKeys.projectDetail(projectId), res);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      setEditing(false);
      setConflictNotice(null);
    },
    onError: async (error) => {
      if (hasErrorCode(error, 'precondition_failed')) {
        await project.refetch();
        setConflictNotice(CONFLICT_NOTICE);
        setFormVersion((v) => v + 1);
      }
    },
  });

  const archive = useMutation({
    mutationFn: (archived: boolean) =>
      api.updateProject(projectId, { archived }, project.data?.etag ?? null),
    onSuccess: (res) => {
      queryClient.setQueryData(queryKeys.projectDetail(projectId), res);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
    onError: async (error) => {
      if (hasErrorCode(error, 'precondition_failed')) {
        await project.refetch();
      }
    },
  });

  const sync = useMutation({
    mutationFn: () => api.syncProject(projectId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) }),
  });

  if (project.isPending) {
    return <Loading label="Loading project" />;
  }
  if (project.isError) {
    return <ErrorView error={project.error} onRetry={() => void project.refetch()} notFoundWhat="project" />;
  }

  const p = project.data.data;
  const archived = p.status === 'archived';
  const agentName = p.defaultAgentId
    ? (agents.data?.find((a) => a.id === p.defaultAgentId)?.title ?? p.defaultAgentId)
    : 'None';

  return (
    <>
      <PageHeader
        title={
          <>
            {p.name} <StatusBadge status={p.status} />
          </>
        }
        subtitle={p.description}
        actions={
          <>
            {can('task:create') && p.status === 'ready' ? (
              <Link className="btn btn-primary" to={`/tasks/new?projectId=${p.id}`}>
                New task
              </Link>
            ) : null}
            {can('project:index') && !archived ? (
              <button type="button" className="btn" onClick={() => sync.mutate()} disabled={sync.isPending}>
                {sync.isPending ? 'Syncing…' : 'Sync repository'}
              </button>
            ) : null}
            {can('project:update') && !archived ? (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  update.reset();
                  setConflictNotice(null);
                  setEditing(true);
                }}
              >
                Edit
              </button>
            ) : null}
            {can('project:update') ? (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => archive.mutate(!archived)}
                disabled={archive.isPending}
              >
                {archived ? 'Restore' : 'Archive'}
              </button>
            ) : null}
          </>
        }
      />
      {p.statusDetail ? (
        <div className={p.status === 'invalid' ? 'banner banner-danger' : 'banner banner-info'} role="status">
          {p.statusDetail}
        </div>
      ) : null}
      {sync.isSuccess ? (
        <div className="banner banner-success" role="status">
          {sync.data.deduplicated
            ? 'A sync for this project is already queued.'
            : 'Repository sync queued.'}
        </div>
      ) : null}
      {sync.isError ? <ProblemMessageOrView error={sync.error} /> : null}
      {archive.isError ? <ProblemMessageOrView error={archive.error} /> : null}
      <div className="grid-2">
        <section className="card" aria-labelledby="project-settings">
          <h2 id="project-settings">Settings</h2>
          <KeyValues
            items={[
              ['Repository', <code key="r">{p.repoPath}</code>],
              ['Default branch', p.defaultBranch ?? 'HEAD'],
              ['Head', p.headSha ? <code key="h">{p.headSha.slice(0, 12)}</code> : '-'],
              ['Last sync', <DateTime key="s" value={p.lastSyncedAt} />],
              ['Test command', p.testCommand ? <code key="t">{p.testCommand.join(' ')}</code> : 'No test command configured'],
              ['Test timeout', formatDuration(p.testTimeoutSeconds * 1000)],
              ['JUnit report', p.junitReportPath ?? '-'],
              ['Default agent', agentName],
              ['Default task timeout', formatDuration(p.defaultTimeoutSeconds * 1000)],
              ['Workspace quota', p.workspaceMaxBytes === null ? 'Installation default' : formatBytes(p.workspaceMaxBytes)],
              ['Index mode', `${p.indexMode}${p.autoIndex ? ', automatic' : ''}${p.requireIndex ? ', required' : ''}`],
              ['Created', <DateTime key="c" value={p.createdAt} />],
              ['Archived', <DateTime key="a" value={p.archivedAt} />],
            ]}
          />
        </section>
        <section className="card" aria-label="Code index">
          <IndexStatusPanel projectId={p.id} projectStatus={p.status} />
        </section>
        <section className="card span-2" aria-labelledby="index-ops">
          <h2 id="index-ops">Index operations</h2>
          <IndexOperations projectId={p.id} />
        </section>
      </div>
      {editing ? (
        <Dialog title={`Edit ${p.name}`} onClose={() => setEditing(false)} busy={update.isPending} wide>
          <ProjectForm
            key={`${formVersion}:${project.data.etag ?? ''}`}
            project={p}
            agents={agents.data ?? []}
            submitting={update.isPending}
            error={update.error}
            notice={conflictNotice}
            onCancel={() => setEditing(false)}
            onSubmit={(submit) => {
              if (submit.mode === 'edit') {
                update.mutate(submit.body);
              }
            }}
          />
        </Dialog>
      ) : null}
    </>
  );
}

function ProblemMessageOrView({ error }: { error: unknown }) {
  return hasErrorCode(error, 'precondition_failed') ? (
    <div className="banner banner-warning" role="alert">
      The project changed in the meantime and has been reloaded. Please repeat the action.
    </div>
  ) : (
    <ErrorOrProblem error={error} />
  );
}

function ErrorOrProblem({ error }: { error: unknown }) {
  return isApiError(error) ? <ProblemMessage error={error} /> : <ErrorView error={error} />;
}
