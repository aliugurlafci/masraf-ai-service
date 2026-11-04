import { useInfiniteQuery } from '@tanstack/react-query';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, GUID_REGEX } from '@orc/shared';
import type { AuditAction, AuditEntityType } from '@orc/shared';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import type { AuditLogParams } from '../../api/endpoints';
import { queryKeys } from '../../api/queryKeys';
import { ErrorView } from '../../components/ErrorView';
import { Empty, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { DateTime, LoadMore, PageHeader } from '../../components/ui';
import { stringifyJson } from '../../lib/format';

const FILTER_KEYS = ['action', 'entityType', 'entityId', 'actorUserId', 'from', 'to'] as const;

function toIsoOrUndefined(local: string | null): string | undefined {
  if (!local) return undefined;
  const ms = Date.parse(local);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function paramsToFilters(params: URLSearchParams): AuditLogParams {
  const action = params.get('action');
  const entityType = params.get('entityType');
  const actorUserId = params.get('actorUserId')?.trim().toLowerCase();
  return {
    action: (AUDIT_ACTIONS as readonly string[]).includes(action ?? '') ? (action as AuditAction) : undefined,
    entityType: (AUDIT_ENTITY_TYPES as readonly string[]).includes(entityType ?? '')
      ? (entityType as AuditEntityType)
      : undefined,
    entityId: params.get('entityId')?.trim() || undefined,
    actorUserId: actorUserId && GUID_REGEX.test(actorUserId) ? actorUserId : undefined,
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
  };
}

export function AuditPage() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const filters = paramsToFilters(params);
  const [draft, setDraft] = useState(() => ({
    action: params.get('action') ?? '',
    entityType: params.get('entityType') ?? '',
    entityId: params.get('entityId') ?? '',
    actorUserId: params.get('actorUserId') ?? '',
    from: toLocalInput(params.get('from')),
    to: toLocalInput(params.get('to')),
  }));
  const [draftError, setDraftError] = useState<string | null>(null);

  const logs = useInfiniteQuery({
    queryKey: queryKeys.audit({ ...filters }),
    queryFn: ({ pageParam }) => api.auditLogs({ ...filters, cursor: pageParam, limit: 50 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const actor = draft.actorUserId.trim().toLowerCase();
    if (actor && !GUID_REGEX.test(actor)) {
      setDraftError('Actor user id must be a GUID.');
      return;
    }
    const from = toIsoOrUndefined(draft.from);
    const to = toIsoOrUndefined(draft.to);
    if (from && to && Date.parse(from) > Date.parse(to)) {
      setDraftError('"To" must not be before "From".');
      return;
    }
    setDraftError(null);
    const next = new URLSearchParams();
    const values: Record<(typeof FILTER_KEYS)[number], string | undefined> = {
      action: draft.action || undefined,
      entityType: draft.entityType || undefined,
      entityId: draft.entityId.trim() || undefined,
      actorUserId: actor || undefined,
      from,
      to,
    };
    for (const key of FILTER_KEYS) {
      const value = values[key];
      if (value) next.set(key, value);
    }
    setParams(next, { replace: true });
  };

  const items = logs.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader title="Audit log" />
      <form className="toolbar filters" onSubmit={apply}>
        <label>
          Action{' '}
          <select value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })}>
            <option value="">Any</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label>
          Entity{' '}
          <select value={draft.entityType} onChange={(e) => setDraft({ ...draft, entityType: e.target.value })}>
            <option value="">Any</option>
            {AUDIT_ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          Entity id <input value={draft.entityId} maxLength={128} onChange={(e) => setDraft({ ...draft, entityId: e.target.value })} />
        </label>
        <label>
          Actor user id{' '}
          <input value={draft.actorUserId} maxLength={36} onChange={(e) => setDraft({ ...draft, actorUserId: e.target.value })} />
        </label>
        <label>
          From <input type="datetime-local" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </label>
        <label>
          To <input type="datetime-local" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </label>
        <button type="submit" className="btn">
          Apply
        </button>
        {draftError ? (
          <span className="field-error" role="alert">
            {draftError}
          </span>
        ) : null}
      </form>
      {logs.isPending ? (
        <Loading label="Loading audit log" />
      ) : logs.isError ? (
        <ErrorView error={logs.error} onRetry={() => void logs.refetch()} />
      ) : items.length === 0 ? (
        <Empty>No audit entries match these filters.</Empty>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Action</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Entity</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {items.map((log) => (
                  <tr key={log.id}>
                    <td>
                      <DateTime value={log.occurredAt} />
                    </td>
                    <td className="mono small">{log.action}</td>
                    <td>
                      <StatusBadge status={log.outcome} />
                    </td>
                    <td className="small">
                      {log.actorLabel} <span className="muted">({log.actorType})</span>
                      {log.ip ? <div className="muted">{log.ip}</div> : null}
                    </td>
                    <td className="small">
                      {log.entityType}
                      {log.entityId ? <div className="mono">{log.entityId}</div> : null}
                    </td>
                    <td className="small">
                      {log.before !== null || log.after !== null || log.detail !== null ? (
                        <details>
                          <summary>JSON</summary>
                          {log.before !== null ? (
                            <>
                              <strong>Before</strong>
                              <pre className="json">{stringifyJson(log.before)}</pre>
                            </>
                          ) : null}
                          {log.after !== null ? (
                            <>
                              <strong>After</strong>
                              <pre className="json">{stringifyJson(log.after)}</pre>
                            </>
                          ) : null}
                          {log.detail !== null ? (
                            <>
                              <strong>Detail</strong>
                              <pre className="json">{stringifyJson(log.detail)}</pre>
                            </>
                          ) : null}
                        </details>
                      ) : null}
                      {log.requestId ? <div className="muted mono">req {log.requestId}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <LoadMore hasMore={logs.hasNextPage} loading={logs.isFetchingNextPage} onLoad={() => void logs.fetchNextPage()} />
        </>
      )}
    </>
  );
}
