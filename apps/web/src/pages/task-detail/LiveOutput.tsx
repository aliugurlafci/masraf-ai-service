import type { ClaudeEventPayload, LogEventPayload } from '@orc/shared';
import { useLayoutEffect, useRef, useState } from 'react';
import { Banner, Empty } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { formatDuration, formatTime, formatUsd, humanize, stringifyJson } from '../../lib/format';
import { LogHistory } from './LogHistory';
import { MAX_RENDERED_ITEMS } from './taskStream';
import type { StreamItem, StreamState } from './taskStream';

type Row =
  | { kind: 'item'; item: Exclude<StreamItem, { type: 'log' }> }
  | { kind: 'logs'; key: string; stream: LogEventPayload['stream']; events: LogEventPayload[] };

/** Groups consecutive log events of the same stream (stdout/stderr/system). */
export function toRows(items: readonly StreamItem[]): Row[] {
  const rows: Row[] = [];
  for (const item of items) {
    if (item.type === 'log') {
      const last = rows[rows.length - 1];
      if (last && last.kind === 'logs' && last.stream === item.event.stream && last.events[0]?.attemptId === item.event.attemptId) {
        last.events.push(item.event);
      } else {
        rows.push({ kind: 'logs', key: item.key, stream: item.event.stream, events: [item.event] });
      }
    } else {
      rows.push({ kind: 'item', item });
    }
  }
  return rows;
}

function num(data: Record<string, unknown> | null, key: string): number | null {
  const value = data?.[key];
  return typeof value === 'number' ? value : null;
}

function str(data: Record<string, unknown> | null, key: string): string | null {
  const value = data?.[key];
  return typeof value === 'string' ? value : null;
}

function preview(text: string | null, max = 120): string {
  if (!text) return '';
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

function ClaudeRow({ event }: { event: ClaudeEventPayload }) {
  switch (event.kind) {
    case 'assistant_text':
      return (
        <div className="out-row out-assistant" data-kind="assistant_text">
          <pre>{event.text ?? ''}</pre>
        </div>
      );
    case 'thinking':
      return (
        <details className="out-row out-thinking" data-kind="thinking">
          <summary>Thinking</summary>
          <pre>{event.text ?? ''}</pre>
        </details>
      );
    case 'tool_use':
      return (
        <details className="out-row out-tool" data-kind="tool_use">
          <summary>
            <span className="out-tag">tool</span> <strong>{event.toolName ?? 'unknown tool'}</strong>{' '}
            <span className="muted">{preview(event.text)}</span>
          </summary>
          <pre>{event.text ?? ''}</pre>
        </details>
      );
    case 'tool_result':
      return (
        <details className={event.isError ? 'out-row out-tool out-error' : 'out-row out-tool'} data-kind="tool_result">
          <summary>
            <span className="out-tag">{event.isError ? 'tool error' : 'result'}</span>{' '}
            <span className="muted">{preview(event.text)}</span>
          </summary>
          <pre>{event.text ?? ''}</pre>
        </details>
      );
    case 'result': {
      const isError = event.data?.isError === true || event.isError === true;
      return (
        <div className={isError ? 'out-row out-result out-error' : 'out-row out-result'} data-kind="result">
          <strong>Claude finished</strong>
          <span>subtype {str(event.data, 'subtype') ?? '-'}</span>
          <span>turns {num(event.data, 'numTurns') ?? '-'}</span>
          <span>cost {formatUsd(num(event.data, 'totalCostUsd'))}</span>
          <span>duration {formatDuration(num(event.data, 'durationMs'))}</span>
          {event.text ? <pre>{event.text}</pre> : null}
        </div>
      );
    }
    case 'init': {
      const tools = num(event.data, 'tools');
      const servers = event.data?.mcpServers;
      return (
        <div className="out-row out-init" data-kind="init">
          <span className="out-tag">session</span> model {str(event.data, 'model') ?? '-'} · tools {tools ?? '-'}
          {Array.isArray(servers) ? ` · MCP ${servers.length}` : ''}
          {str(event.data, 'sessionId') ? <span className="muted mono"> · {str(event.data, 'sessionId')}</span> : null}
        </div>
      );
    }
    case 'rate_limit':
    case 'system':
      return (
        <div className="out-row out-dim" data-kind={event.kind}>
          <span className="out-tag">{event.kind === 'rate_limit' ? 'rate limit' : 'system'}</span>{' '}
          {event.text ?? (event.data ? preview(stringifyJson(event.data), 200) : '')}
        </div>
      );
    case 'unknown':
    case 'invalid':
      return (
        <div className="out-row out-dim out-raw" data-kind={event.kind}>
          <pre>{event.text ?? ''}</pre>
        </div>
      );
  }
}

function ItemRow({ item }: { item: Exclude<StreamItem, { type: 'log' }> }) {
  switch (item.type) {
    case 'claude':
      return <ClaudeRow event={item.event} />;
    case 'status':
      return (
        <div className="out-row out-status" data-kind="status">
          <span className="muted">{formatTime(item.event.at)}</span> <StatusBadge status={item.event.status} />
          {item.event.attemptNumber !== null ? <span className="muted"> attempt {item.event.attemptNumber}</span> : null}
          {item.event.reason ? <span> · {humanize(item.event.reason)}</span> : null}
          {item.event.detail ? <span className="muted"> · {item.event.detail}</span> : null}
          {item.event.gap ? <span className="muted"> · some earlier live events expired; history comes from the database</span> : null}
        </div>
      );
    case 'test':
      return (
        <div className="out-row out-test" data-kind="test">
          <span className="out-tag">tests</span> <StatusBadge status={item.event.status} /> {item.event.passed} passed ·{' '}
          {item.event.failed} failed · {item.event.errored} errors · {item.event.skipped} skipped
          {item.event.durationMs !== null ? ` · ${formatDuration(item.event.durationMs)}` : ''}
        </div>
      );
    case 'diff':
      return (
        <div className="out-row out-diff" data-kind="diff">
          <span className="out-tag">diff</span> {item.event.filesChanged} files ·{' '}
          <span className="add">+{item.event.additions}</span> <span className="del">-{item.event.deletions}</span> · merge
          check <StatusBadge status={item.event.mergeCheck} />
        </div>
      );
    case 'end':
      return (
        <div className="out-row out-end" data-kind="end">
          Task ended <StatusBadge status={item.event.status} />
          {item.event.reason ? <span> · {humanize(item.event.reason)}</span> : null}
        </div>
      );
  }
}

function ConnectionIndicator({ state }: { state: StreamState }) {
  let label: string;
  let tone: string;
  switch (state.connection) {
    case 'live':
      label = state.lastHeartbeatAt ? `Live · heartbeat ${formatTime(state.lastHeartbeatAt)}` : 'Live';
      tone = 'live';
      break;
    case 'connecting':
    case 'idle':
      label = 'Connecting…';
      tone = 'pending';
      break;
    case 'reconnecting':
      label =
        state.reconnectDelayMs !== null
          ? `Reconnecting in ${Math.round(state.reconnectDelayMs / 1000)} s (attempt ${state.reconnectAttempt})`
          : 'Reconnecting…';
      tone = 'pending';
      break;
    case 'ended':
      label = 'Ended';
      tone = 'ended';
      break;
    case 'stopped':
      label = 'Stream closed (task settled)';
      tone = 'ended';
      break;
    case 'not_found':
      label = 'Task no longer visible';
      tone = 'error';
      break;
    case 'unauthenticated':
      label = 'Signed out';
      tone = 'error';
      break;
  }
  return (
    <span className={`conn conn-${tone}`} role="status" aria-live="polite" data-connection={state.connection}>
      <span className="conn-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export function LiveOutput({
  taskId,
  state,
  attemptId,
}: {
  taskId: string;
  state: StreamState;
  /** When set, only events of this attempt are shown. */
  attemptId: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [showHistory, setShowHistory] = useState(false);

  const visible = attemptId
    ? state.items.filter((item) => item.event.attemptId === attemptId || item.event.attemptId === null)
    : state.items;
  const rows = toRows(visible);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el && pinned) {
      el.scrollTop = el.scrollHeight;
    }
  }, [rows.length, visible.length, pinned]);

  return (
    <div className="live-output">
      <div className="live-toolbar">
        <ConnectionIndicator state={state} />
        <span className="muted small">{visible.length.toLocaleString()} events</span>
        {!pinned ? (
          <button type="button" className="btn btn-small" onClick={() => setPinned(true)}>
            Jump to latest
          </button>
        ) : null}
      </div>
      {state.serverError ? (
        <Banner tone="danger" title="The live stream reported an error">
          <code>{state.serverError.code}</code> {state.serverError.message}
        </Banner>
      ) : null}
      {state.trimmed > 0 || showHistory ? (
        <div className="trimmed-note">
          {state.trimmed > 0 ? (
            <span className="muted small">
              {state.trimmed.toLocaleString()} earlier events were trimmed (at most{' '}
              {MAX_RENDERED_ITEMS.toLocaleString()} are kept on the page).
            </span>
          ) : null}{' '}
          <button type="button" className="btn btn-small" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? 'Hide earlier output' : 'Load earlier'}
          </button>
        </div>
      ) : null}
      {showHistory ? <LogHistory taskId={taskId} attemptId={attemptId ?? state.latestStatus?.attemptId ?? null} /> : null}
      <div
        ref={containerRef}
        className="output"
        role="log"
        aria-label="Live output"
        tabIndex={0}
        onScroll={(event) => {
          const el = event.currentTarget;
          const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
          if (atBottom !== pinned) {
            setPinned(atBottom);
          }
        }}
      >
        {rows.length === 0 ? (
          <Empty>
            {state.connection === 'live' || state.connection === 'connecting' || state.connection === 'idle'
              ? 'Waiting for output…'
              : 'No output was recorded.'}
          </Empty>
        ) : (
          rows.map((row) =>
            row.kind === 'logs' ? (
              <div key={row.key} className={`out-row out-log out-${row.stream}`} data-kind="log" data-stream={row.stream}>
                <span className="out-tag">{row.stream}</span>
                <pre>{row.events.map((e) => e.content).join('')}</pre>
              </div>
            ) : (
              <ItemRow key={row.item.key} item={row.item} />
            ),
          )
        )}
      </div>
    </div>
  );
}
