import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { INDEX_MODES } from '@orc/shared';
import type { IndexMode, McpIndexOperation, ProjectIndexStatus, ProjectStatus } from '@orc/shared';
import { useState } from 'react';
import { useApi } from '../../api/ApiContext';
import { hasErrorCode, isApiError } from '../../api/errors';
import { queryKeys } from '../../api/queryKeys';
import { useCan } from '../../auth/session';
import { ErrorView, ProblemMessage } from '../../components/ErrorView';
import { Empty, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { DateTime, KeyValues, LoadMore } from '../../components/ui';
import { formatDuration, formatNumber, humanize } from '../../lib/format';

export const INDEX_POLL_MS = 5_000;

function isActiveOperation(op: McpIndexOperation | null | undefined): boolean {
  return op !== null && op !== undefined && (op.status === 'queued' || op.status === 'running');
}

function disabledReason(
  status: ProjectIndexStatus,
  projectStatus: ProjectStatus,
  lastError: unknown,
): string | null {
  if (!status.mcpEnabled || hasErrorCode(lastError, 'mcp_disabled')) {
    return 'Code indexing is disabled on this installation (codebase-memory-mcp is not enabled).';
  }
  if (isActiveOperation(status.activeOperation) || hasErrorCode(lastError, 'index_in_progress')) {
    return 'An index operation is already queued or running for this project.';
  }
  if (projectStatus !== 'ready') {
    return `The project must be ready before it can be indexed (current status: ${projectStatus}).`;
  }
  return null;
}

export function IndexStatusPanel({
  projectId,
  projectStatus,
}: {
  projectId: string;
  projectStatus: ProjectStatus;
}) {
  const api = useApi();
  const can = useCan();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<IndexMode | ''>('');

  const status = useQuery({
    queryKey: queryKeys.projectIndexStatus(projectId),
    queryFn: () => api.indexStatus(projectId),
    refetchInterval: (query) =>
      isActiveOperation(query.state.data?.activeOperation) ? INDEX_POLL_MS : false,
  });

  const index = useMutation({
    mutationFn: () => api.requestIndex(projectId, mode === '' ? undefined : mode),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
    },
  });

  if (status.isPending) {
    return <Loading label="Loading index status" />;
  }
  if (status.isError) {
    return <ErrorView error={status.error} onRetry={() => void status.refetch()} />;
  }

  const s = status.data;
  const active = s.activeOperation;
  const reason = disabledReason(s, projectStatus, index.error);
  const mutationProblem =
    isApiError(index.error) &&
    !hasErrorCode(index.error, 'mcp_disabled') &&
    !hasErrorCode(index.error, 'index_in_progress')
      ? index.error
      : null;

  return (
    <div className="index-status">
      <div className="card-header">
        <h3>
          Code index{' '}
          {s.stale ? <StatusBadge status="stale" label="stale" /> : null}
          {!s.mcpEnabled ? <StatusBadge status="offline" label="disabled" /> : null}
        </h3>
        {can('project:index') ? (
          <div className="inline-form">
            <label>
              <span className="visually-hidden">Index mode</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as IndexMode | '')} disabled={reason !== null}>
                <option value="">Project default mode</option>
                {INDEX_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => index.mutate()}
              disabled={reason !== null || index.isPending}
              aria-describedby={reason ? 'index-disabled-reason' : undefined}
            >
              {index.isPending ? 'Requesting…' : 'Index now'}
            </button>
          </div>
        ) : null}
      </div>
      {can('project:index') && reason ? (
        <p id="index-disabled-reason" className="muted small">
          {reason}
        </p>
      ) : null}
      {mutationProblem ? <ProblemMessage error={mutationProblem} /> : null}
      {index.isSuccess ? (
        <p className="muted small" role="status">
          Index operation {humanize(index.data.status)}.
        </p>
      ) : null}
      <KeyValues
        items={[
          ['Index name', <code key="n">{s.indexName}</code>],
          ['Nodes', formatNumber(s.nodeCount)],
          ['Edges', formatNumber(s.edgeCount)],
          ['Indexed at', <DateTime key="i" value={s.indexedAt} />],
          ['Project head', s.projectHeadSha ? <code key="h">{s.projectHeadSha.slice(0, 12)}</code> : '-'],
          ['Freshness', s.stale ? 'Stale: the index does not match the project head' : s.indexedAt ? 'Up to date' : 'Not indexed yet'],
        ]}
      />
      {active ? (
        <div className="banner banner-info" role="status">
          <strong className="banner-title">
            {humanize(active.kind)} {humanize(active.status)}
          </strong>
          <div className="banner-body">
            Requested <DateTime value={active.createdAt} />
            {active.startedAt ? (
              <>
                , started <DateTime value={active.startedAt} />
              </>
            ) : null}
            . Refreshing every {INDEX_POLL_MS / 1000} s.
          </div>
        </div>
      ) : null}
      {s.lastOperation && s.lastOperation.status === 'failed' ? (
        <div className="banner banner-danger" role="alert">
          <strong className="banner-title">Last index operation failed</strong>
          <div className="banner-body">
            {s.lastOperation.errorCode ? <code>{s.lastOperation.errorCode}</code> : null}{' '}
            {s.lastOperation.errorMessage ?? ''}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function IndexOperations({ projectId }: { projectId: string }) {
  const api = useApi();
  const ops = useInfiniteQuery({
    queryKey: queryKeys.projectIndexOperations(projectId),
    queryFn: ({ pageParam }) => api.indexOperations(projectId, { cursor: pageParam, limit: 10 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  if (ops.isPending) {
    return <Loading label="Loading index operations" />;
  }
  if (ops.isError) {
    return <ErrorView error={ops.error} onRetry={() => void ops.refetch()} />;
  }
  const items = ops.data.pages.flatMap((p) => p.items);
  if (items.length === 0) {
    return <Empty>No index operations have been run for this project.</Empty>;
  }
  return (
    <>
      <div className="table-wrap">
        <table className="table compact">
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col">Status</th>
              <th scope="col">Mode</th>
              <th scope="col">Requested</th>
              <th scope="col" className="num">Duration</th>
              <th scope="col" className="num">Nodes / edges</th>
              <th scope="col">Error</th>
            </tr>
          </thead>
          <tbody>
            {items.map((op) => (
              <tr key={op.id}>
                <td>{humanize(op.kind)}</td>
                <td>
                  <StatusBadge status={op.status} />
                </td>
                <td>{op.mode ?? '-'}</td>
                <td>
                  <DateTime value={op.createdAt} />
                </td>
                <td className="num">{formatDuration(op.durationMs)}</td>
                <td className="num">
                  {formatNumber(op.nodeCount)} / {formatNumber(op.edgeCount)}
                </td>
                <td className="small">
                  {op.errorCode ? <code>{op.errorCode}</code> : null} {op.errorMessage ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={ops.hasNextPage} loading={ops.isFetchingNextPage} onLoad={() => void ops.fetchNextPage()} />
    </>
  );
}
