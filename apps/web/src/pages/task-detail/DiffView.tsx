import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { DiffFile, MergeCheck } from '@orc/shared';
import { useApi } from '../../api/ApiContext';
import { patchDownloadUrl } from '../../api/endpoints';
import { hasErrorCode } from '../../api/errors';
import { queryKeys } from '../../api/queryKeys';
import { ErrorView } from '../../components/ErrorView';
import { Banner, Empty, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { LoadMore } from '../../components/ui';
import { formatBytes } from '../../lib/format';
import { parseUnifiedDiff } from '../../lib/unifiedDiff';

export const DIFF_PAGE_SIZE = 20;

const CHANGE_LABELS: Readonly<Record<string, string>> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type changed',
};

export function MergeCheckBadge({ taskId, attemptId }: { taskId: string; attemptId: string | undefined }) {
  const api = useApi();
  const check = useQuery({
    queryKey: queryKeys.taskArtefact(taskId, 'merge-check', attemptId),
    queryFn: () => api.mergeCheck(taskId, attemptId),
  });
  if (check.isPending) return <Loading label="Loading merge check" lines={1} />;
  if (check.isError) {
    if (hasErrorCode(check.error, 'merge_check_unavailable') || hasErrorCode(check.error, 'not_found')) {
      return <p className="muted small">Merge check not available for this attempt.</p>;
    }
    return <ErrorView error={check.error} onRetry={() => void check.refetch()} />;
  }
  return <MergeCheckSummary check={check.data} />;
}

function MergeCheckSummary({ check }: { check: MergeCheck }) {
  return (
    <div className="merge-check" data-testid="merge-check">
      <span>
        Merge check against <code>{check.baseBranch}</code>: <StatusBadge status={check.status} />
        {check.isFastForward ? <span className="muted small"> (fast-forward)</span> : null}
      </span>
      {check.status === 'conflicts' && check.conflicts.length > 0 ? (
        <div>
          <strong>Conflicting files</strong>
          <ul className="conflicts">
            {check.conflicts.map((path) => (
              <li key={path} className="mono">
                {path}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {check.status === 'error' && check.error ? <p className="field-error">{check.error}</p> : null}
    </div>
  );
}

function DiffBody({ file, taskId, attemptId }: { file: DiffFile; taskId: string; attemptId: string | undefined }) {
  if (file.patchPurged) {
    return (
      <Banner tone="info" title="Patch removed by retention">
        The diff text of this file was removed by the retention policy; the file metadata is kept.
      </Banner>
    );
  }
  if (file.isBinary) {
    return (
      <Banner tone="info" title="Binary file">
        Binary files are not displayed ({formatBytes(file.patchBytes)}).
      </Banner>
    );
  }
  if (file.patchTruncated) {
    return (
      <Banner tone="warning" title="Patch truncated">
        This file&apos;s diff is too large to display ({formatBytes(file.patchBytes)}).{' '}
        <a href={patchDownloadUrl(taskId, attemptId)}>Download the full patch</a>.
      </Banner>
    );
  }
  if (file.patch === null || file.patch.length === 0) {
    return <Empty>No textual changes (mode or rename only).</Empty>;
  }
  const lines = parseUnifiedDiff(file.patch);
  return (
    <div className="diff-scroll">
      <table className="diff-table">
        <tbody>
          {lines.map((line, i) => (
            <tr key={i} className={`diff-${line.kind}`}>
              <td className="ln" aria-label={line.oldNumber === null ? undefined : `old line ${line.oldNumber}`}>
                {line.oldNumber ?? ''}
              </td>
              <td className="ln" aria-label={line.newNumber === null ? undefined : `new line ${line.newNumber}`}>
                {line.newNumber ?? ''}
              </td>
              <td className="code">
                <span className="diff-marker" aria-hidden="true">
                  {line.kind === 'add' ? '+' : line.kind === 'delete' ? '-' : ' '}
                </span>
                {line.text}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DiffFileView({ file, taskId, attemptId }: { file: DiffFile; taskId: string; attemptId: string | undefined }) {
  return (
    <section className="diff-file" aria-label={file.path}>
      <header className="diff-file-header">
        <span className="mono diff-path">
          {file.oldPath && file.oldPath !== file.path ? (
            <>
              {file.oldPath} → {file.path}
            </>
          ) : (
            file.path
          )}
        </span>
        <span className="badge badge-neutral">{CHANGE_LABELS[file.changeType] ?? file.changeType}</span>
        <span className="add">+{file.additions ?? 0}</span>
        <span className="del">-{file.deletions ?? 0}</span>
      </header>
      <DiffBody file={file} taskId={taskId} attemptId={attemptId} />
    </section>
  );
}

/** `diff` tab: `/diff` pages of 20 files with merge-check badge (contract §20.2). */
export function DiffView({ taskId, attemptId }: { taskId: string; attemptId: string | undefined }) {
  const api = useApi();
  const diff = useInfiniteQuery({
    queryKey: queryKeys.taskArtefact(taskId, 'diff', attemptId),
    queryFn: ({ pageParam }) => api.diff(taskId, { attemptId, cursor: pageParam, limit: DIFF_PAGE_SIZE }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  return (
    <div className="diff-view">
      <div className="diff-toolbar">
        <MergeCheckBadge taskId={taskId} attemptId={attemptId} />
        <a className="btn btn-small" href={patchDownloadUrl(taskId, attemptId)}>
          Download patch
        </a>
      </div>
      {diff.isPending ? (
        <Loading label="Loading diff" />
      ) : diff.isError ? (
        <ErrorView error={diff.error} onRetry={() => void diff.refetch()} />
      ) : (
        <DiffFiles
          files={diff.data.pages.flatMap((p) => p.items)}
          taskId={taskId}
          attemptId={attemptId}
          hasMore={diff.hasNextPage}
          loading={diff.isFetchingNextPage}
          onLoad={() => void diff.fetchNextPage()}
        />
      )}
    </div>
  );
}

function DiffFiles({
  files,
  taskId,
  attemptId,
  hasMore,
  loading,
  onLoad,
}: {
  files: DiffFile[];
  taskId: string;
  attemptId: string | undefined;
  hasMore: boolean;
  loading: boolean;
  onLoad: () => void;
}) {
  if (files.length === 0) {
    return <Empty>No file changes were captured for this attempt.</Empty>;
  }
  return (
    <>
      {files.map((file) => (
        <DiffFileView key={file.id} file={file} taskId={taskId} attemptId={attemptId} />
      ))}
      <LoadMore hasMore={hasMore} loading={loading} onLoad={onLoad} />
    </>
  );
}
