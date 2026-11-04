import { useInfiniteQuery } from '@tanstack/react-query';
import type { TaskLog } from '@orc/shared';
import { useApi } from '../../api/ApiContext';
import { queryKeys } from '../../api/queryKeys';
import { ErrorView } from '../../components/ErrorView';
import { Empty, Loading } from '../../components/States';
import { LoadMore } from '../../components/ui';

const PAGE = 500;

function nextAfterSeq(page: { items: TaskLog[]; nextCursor: string | null }): number | undefined {
  if (page.nextCursor === null) return undefined;
  const fromCursor = Number(page.nextCursor);
  if (Number.isInteger(fromCursor)) return fromCursor;
  const last = page.items[page.items.length - 1];
  return last ? last.seq : undefined;
}

/** Stored output of one attempt from MSSQL (`GET /tasks/:id/logs`), oldest first ("load earlier"). */
export function LogHistory({ taskId, attemptId }: { taskId: string; attemptId: string | null }) {
  const api = useApi();
  const logs = useInfiniteQuery({
    queryKey: [...queryKeys.taskArtefact(taskId, 'logs', attemptId ?? undefined)],
    queryFn: ({ pageParam }) =>
      api.logs(taskId, { attemptId: attemptId ?? undefined, afterSeq: pageParam, limit: PAGE }),
    initialPageParam: -1,
    getNextPageParam: nextAfterSeq,
  });

  if (logs.isPending) return <Loading label="Loading stored output" />;
  if (logs.isError) return <ErrorView error={logs.error} onRetry={() => void logs.refetch()} />;
  const rows = logs.data.pages.flatMap((p) => p.items);
  if (rows.length === 0) return <Empty>No stored output for this attempt.</Empty>;
  return (
    <div className="log-history">
      <div className="output output-history" role="log" aria-label="Stored output">
        {rows.map((row) => (
          <div
            key={row.id}
            className={`out-row out-log out-${row.stream}${row.stream === 'claude' ? ' out-dim' : ''}`}
            data-stream={row.stream}
          >
            <span className="out-tag">
              {row.stream} #{row.seq}
            </span>
            <pre>{row.content}</pre>
          </div>
        ))}
      </div>
      <LoadMore hasMore={logs.hasNextPage} loading={logs.isFetchingNextPage} onLoad={() => void logs.fetchNextPage()} />
    </div>
  );
}
