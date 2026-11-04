import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { McpIndexOperation } from '@orc/shared';
import { useApi } from '../../api/ApiContext';
import { isApiError } from '../../api/errors';
import { queryKeys } from '../../api/queryKeys';
import { CopyButton } from '../../components/CopyButton';
import { ErrorView } from '../../components/ErrorView';
import { Empty, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { DateTime, KeyValues, LoadMore } from '../../components/ui';
import { formatBytes, formatDuration, formatNumber, formatUsd, humanize, stringifyJson } from '../../lib/format';

function isNotFound(error: unknown): boolean {
  return isApiError(error) && error.status === 404;
}

/** `changes` tab: `/changed-files` table. */
export function ChangedFilesTab({ taskId, attemptId }: { taskId: string; attemptId: string | undefined }) {
  const api = useApi();
  const files = useQuery({
    queryKey: queryKeys.taskArtefact(taskId, 'changed-files', attemptId),
    queryFn: () => api.changedFiles(taskId, attemptId),
  });
  if (files.isPending) return <Loading label="Loading changed files" />;
  if (files.isError) return <ErrorView error={files.error} onRetry={() => void files.refetch()} />;
  if (files.data.length === 0) return <Empty>No changed files were captured for this attempt.</Empty>;
  return (
    <div className="table-wrap">
      <table className="table compact">
        <thead>
          <tr>
            <th scope="col">Path</th>
            <th scope="col">Old path</th>
            <th scope="col">Change</th>
            <th scope="col" className="num">+</th>
            <th scope="col" className="num">-</th>
            <th scope="col">Flags</th>
          </tr>
        </thead>
        <tbody>
          {files.data.map((f) => (
            <tr key={f.id}>
              <td className="mono">{f.path}</td>
              <td className="mono">{f.oldPath ?? ''}</td>
              <td>{f.changeType}</td>
              <td className="num add">{f.additions ?? '-'}</td>
              <td className="num del">{f.deletions ?? '-'}</td>
              <td className="small">
                {[
                  f.isBinary ? 'binary' : null,
                  f.patchTruncated ? `truncated (${formatBytes(f.patchBytes)})` : null,
                  f.patchPurged ? 'purged' : null,
                ]
                  .filter(Boolean)
                  .join(', ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** `events` tab: `/events` paged. */
export function EventsTab({ taskId }: { taskId: string }) {
  const api = useApi();
  const events = useInfiniteQuery({
    queryKey: [...queryKeys.taskEvents(taskId), 'paged'],
    queryFn: ({ pageParam }) => api.events(taskId, { cursor: pageParam, limit: 50 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  if (events.isPending) return <Loading label="Loading events" />;
  if (events.isError) return <ErrorView error={events.error} onRetry={() => void events.refetch()} />;
  const items = events.data.pages.flatMap((p) => p.items);
  if (items.length === 0) return <Empty>No events recorded.</Empty>;
  return (
    <>
      <div className="table-wrap">
        <table className="table compact">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Event</th>
              <th scope="col">Status</th>
              <th scope="col">Actor</th>
              <th scope="col">Details</th>
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id}>
                <td>
                  <DateTime value={e.createdAt} />
                </td>
                <td>{humanize(e.type)}</td>
                <td>
                  {e.fromStatus ? <StatusBadge status={e.fromStatus} /> : null}
                  {e.fromStatus || e.toStatus ? ' → ' : ''}
                  {e.toStatus ? <StatusBadge status={e.toStatus} /> : null}
                </td>
                <td className="small">
                  {e.actorType}
                  {e.actorLabel ? ` · ${e.actorLabel}` : ''}
                </td>
                <td className="small">
                  {e.reason ? <div>{humanize(e.reason)}</div> : null}
                  {e.data ? (
                    <details>
                      <summary>data</summary>
                      <pre className="json">{stringifyJson(e.data)}</pre>
                    </details>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={events.hasNextPage} loading={events.isFetchingNextPage} onLoad={() => void events.fetchNextPage()} />
    </>
  );
}

/** `session` tab: `/session` (model, CLI version, session id, cost, tokens, turns, permission denials). */
export function SessionTab({ taskId, attemptId }: { taskId: string; attemptId: string | undefined }) {
  const api = useApi();
  const session = useQuery({
    queryKey: queryKeys.taskArtefact(taskId, 'session', attemptId),
    queryFn: () => api.session(taskId, attemptId),
  });
  if (session.isPending) return <Loading label="Loading Claude session" />;
  if (session.isError) {
    if (isNotFound(session.error)) return <Empty>No Claude session was recorded for this attempt.</Empty>;
    return <ErrorView error={session.error} onRetry={() => void session.refetch()} />;
  }
  const s = session.data;
  return (
    <div className="grid-2">
      <section className="card">
        <h3>Session</h3>
        <KeyValues
          items={[
            ['Status', <StatusBadge key="s" status={s.status} />],
            ['Model', <code key="m">{s.model}</code>],
            ['CLI version', s.cliVersion ?? '-'],
            [
              'Session id',
              s.sessionId ? (
                <span key="id">
                  <code>{s.sessionId}</code> <CopyButton value={s.sessionId} />
                </span>
              ) : (
                '-'
              ),
            ],
            ['Resumed from', s.resumedFromSessionId ?? '-'],
            ['Permission mode', s.permissionMode],
            ['API key source', s.apiKeySource ?? '-'],
            ['Started', <DateTime key="st" value={s.startedAt} />],
            ['Ended', <DateTime key="en" value={s.endedAt} />],
            ['Tools', s.tools ? String(s.tools.length) : '-'],
            ['MCP servers', s.mcpServers?.map((m) => `${m.name} (${m.status})`).join(', ') || '-'],
          ]}
        />
      </section>
      <section className="card">
        <h3>Result</h3>
        <KeyValues
          items={[
            ['Result', s.resultSubtype ?? '-'],
            ['Error', s.isError === null ? '-' : s.isError ? 'yes' : 'no'],
            ['Stop reason', s.stopReason ?? s.terminalReason ?? '-'],
            ['Turns', formatNumber(s.numTurns)],
            ['Cost', formatUsd(s.totalCostUsd)],
            ['Input tokens', formatNumber(s.inputTokens)],
            ['Output tokens', formatNumber(s.outputTokens)],
            ['Cache write / read', `${formatNumber(s.cacheCreationInputTokens)} / ${formatNumber(s.cacheReadInputTokens)}`],
            ['Duration (API)', `${formatDuration(s.durationMs)} (${formatDuration(s.durationApiMs)})`],
            ['Permission denials', formatNumber(s.permissionDenialsCount)],
          ]}
        />
        {s.permissionDenials && s.permissionDenials.length > 0 ? (
          <details>
            <summary>Permission denials</summary>
            <pre className="json">{stringifyJson(s.permissionDenials)}</pre>
          </details>
        ) : null}
        {s.resultText ? (
          <details>
            <summary>Result text</summary>
            <pre className="result-text">{s.resultText}</pre>
          </details>
        ) : null}
      </section>
    </div>
  );
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry === 'string') {
      out.push(entry);
    } else if (typeof entry === 'object' && entry !== null) {
      const rec = entry as Record<string, unknown>;
      const name = rec.qualifiedName ?? rec.qualified_name ?? rec.name ?? rec.path ?? rec.file;
      out.push(typeof name === 'string' ? name : stringifyJson(entry));
    }
  }
  return out;
}

function ImpactResult({ op }: { op: McpIndexOperation }) {
  const result = op.result;
  if (result === null || result === undefined) {
    return <Empty>The impact analysis produced no result.</Empty>;
  }
  const record = typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : null;
  const files = stringList(record?.changedFiles ?? record?.changed_files);
  const symbols = stringList(record?.impactedSymbols ?? record?.impacted_symbols ?? record?.symbols);
  if (files === null && symbols === null) {
    return <pre className="json">{stringifyJson(result)}</pre>;
  }
  return (
    <div className="grid-2">
      <section>
        <h4>Changed files ({files?.length ?? 0})</h4>
        {files && files.length > 0 ? (
          <ul className="plain-list mono">{files.map((f, i) => <li key={`${f}-${i}`}>{f}</li>)}</ul>
        ) : (
          <Empty>None reported.</Empty>
        )}
      </section>
      <section>
        <h4>Impacted symbols ({symbols?.length ?? 0})</h4>
        {symbols && symbols.length > 0 ? (
          <ul className="plain-list mono">{symbols.map((s, i) => <li key={`${s}-${i}`}>{s}</li>)}</ul>
        ) : (
          <Empty>None reported.</Empty>
        )}
      </section>
      <details className="span-2">
        <summary>Raw result</summary>
        <pre className="json">{stringifyJson(result)}</pre>
      </details>
    </div>
  );
}

/** `impact` tab: `/impact` (impact_analysis operation). */
export function ImpactTab({ taskId, attemptId }: { taskId: string; attemptId: string | undefined }) {
  const api = useApi();
  const impact = useQuery({
    queryKey: queryKeys.taskArtefact(taskId, 'impact', attemptId),
    queryFn: () => api.impact(taskId, attemptId),
  });
  if (impact.isPending) return <Loading label="Loading impact analysis" />;
  if (impact.isError) {
    if (isNotFound(impact.error)) return <Empty>No MCP impact analysis was run for this attempt.</Empty>;
    return <ErrorView error={impact.error} onRetry={() => void impact.refetch()} />;
  }
  const op = impact.data;
  return (
    <div className="impact">
      <KeyValues
        items={[
          ['Status', <StatusBadge key="s" status={op.status} />],
          ['Index', <code key="i">{op.indexName}</code>],
          ['Duration', formatDuration(op.durationMs)],
          ['Nodes / edges', `${formatNumber(op.nodeCount)} / ${formatNumber(op.edgeCount)}`],
          ['Error', op.errorCode ? `${op.errorCode}${op.errorMessage ? `: ${op.errorMessage}` : ''}` : '-'],
        ]}
      />
      <ImpactResult op={op} />
    </div>
  );
}
