import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Agent, CreateAgentRequest, UpdateAgentRequest } from '@orc/shared';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { hasErrorCode } from '../../api/errors';
import { queryKeys } from '../../api/queryKeys';
import { useCan } from '../../auth/session';
import { Dialog } from '../../components/Dialog';
import { ErrorView } from '../../components/ErrorView';
import { Empty, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { DateTime, KeyValues, PageHeader } from '../../components/ui';
import { formatDuration, formatUsd } from '../../lib/format';
import { AgentForm } from './AgentForm';

const CONFLICT_NOTICE = 'The agent was changed by someone else. The form shows the current version; review and save again.';

function AgentDrawer({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const api = useApi();
  const can = useCan();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [formVersion, setFormVersion] = useState(0);
  const agent = useQuery({ queryKey: queryKeys.agent(agentId), queryFn: () => api.getAgent(agentId) });
  const teams = useQuery({ queryKey: queryKeys.teams, queryFn: () => api.listTeams(), enabled: can('team:read') });
  const agents = useQuery({
    queryKey: queryKeys.agentList({ includeInactive: true }),
    queryFn: () => api.listAgents({ includeInactive: true }),
  });

  const update = useMutation({
    mutationFn: (body: UpdateAgentRequest) => api.updateAgent(agentId, body, agent.data?.etag ?? null),
    onSuccess: (res) => {
      queryClient.setQueryData(queryKeys.agent(agentId), res);
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
      setEditing(false);
      setNotice(null);
    },
    onError: async (error) => {
      if (hasErrorCode(error, 'precondition_failed')) {
        await agent.refetch();
        setNotice(CONFLICT_NOTICE);
        setFormVersion((v) => v + 1);
      }
    },
  });

  return (
    <aside className="drawer" aria-label="Agent details">
      <header className="drawer-header">
        <h2>{agent.data ? agent.data.data.title : 'Agent'}</h2>
        <button type="button" className="btn btn-ghost btn-small" onClick={onClose} aria-label="Close agent details">
          ×
        </button>
      </header>
      {agent.isPending ? (
        <Loading label="Loading agent" />
      ) : agent.isError ? (
        <ErrorView error={agent.error} onRetry={() => void agent.refetch()} notFoundWhat="agent" />
      ) : editing ? (
        <AgentForm
          key={`${formVersion}:${agent.data.etag ?? ''}`}
          agent={agent.data.data}
          teams={teams.data ?? []}
          agents={agents.data ?? []}
          submitting={update.isPending}
          error={update.error}
          notice={notice}
          onCancel={() => setEditing(false)}
          onSubmit={(submit) => {
            if (submit.mode === 'edit') update.mutate(submit.body);
          }}
        />
      ) : (
        <AgentDetails
          agent={agent.data.data}
          teamName={teams.data?.find((t) => t.id === agent.data.data.teamId)?.name}
          onEdit={
            can('agent:manage')
              ? () => {
                  update.reset();
                  setNotice(null);
                  setEditing(true);
                }
              : undefined
          }
        />
      )}
    </aside>
  );
}

function AgentDetails({ agent, teamName, onEdit }: { agent: Agent; teamName?: string; onEdit?: () => void }) {
  return (
    <div className="drawer-body">
      {onEdit ? (
        <button type="button" className="btn" onClick={onEdit}>
          Edit agent
        </button>
      ) : null}
      <KeyValues
        items={[
          ['Name', <code key="n">{agent.name}</code>],
          ['Team', teamName ?? agent.teamId],
          ['Status', <StatusBadge key="s" status={agent.isActive ? 'ready' : 'offline'} label={agent.isActive ? 'active' : 'inactive'} />],
          ['Manager', agent.isManager ? 'yes' : 'no'],
          ['Model', <code key="m">{agent.model}</code>],
          ['Effort', agent.effort ?? 'default'],
          ['Max timeout', formatDuration(agent.maxTimeoutSeconds * 1000)],
          ['Max budget', formatUsd(agent.maxBudgetUsd)],
          ['Updated', <DateTime key="u" value={agent.updatedAt} />],
        ]}
      />
      {agent.description ? <p>{agent.description}</p> : null}
      <h3>Allowed tools</h3>
      {agent.allowedTools.length === 0 ? (
        <Empty>No allowed tool rules.</Empty>
      ) : (
        <ul className="plain-list mono">{agent.allowedTools.map((t, i) => <li key={`${t}-${i}`}>{t}</li>)}</ul>
      )}
      <h3>Disallowed tools</h3>
      {agent.disallowedTools.length === 0 ? (
        <Empty>No disallowed tool rules.</Empty>
      ) : (
        <ul className="plain-list mono">{agent.disallowedTools.map((t, i) => <li key={`${t}-${i}`}>{t}</li>)}</ul>
      )}
      <h3>Instructions</h3>
      {agent.instructions ? <pre className="instructions">{agent.instructions}</pre> : <Empty>No agent instructions.</Empty>}
    </div>
  );
}

function CreateAgentDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (agent: Agent) => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const teams = useQuery({ queryKey: queryKeys.teams, queryFn: () => api.listTeams() });
  const agents = useQuery({
    queryKey: queryKeys.agentList({ includeInactive: true }),
    queryFn: () => api.listAgents({ includeInactive: true }),
  });
  const create = useMutation({
    mutationFn: (body: CreateAgentRequest) => api.createAgent(body),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
      onCreated(res.data);
    },
  });
  return (
    <Dialog title="New agent" onClose={onClose} busy={create.isPending} wide>
      {teams.isPending ? (
        <Loading label="Loading teams" />
      ) : teams.isError ? (
        <ErrorView error={teams.error} onRetry={() => void teams.refetch()} />
      ) : teams.data.length === 0 ? (
        <Empty>Create a team first; every agent belongs to a team.</Empty>
      ) : (
        <AgentForm
          teams={teams.data}
          agents={agents.data ?? []}
          submitting={create.isPending}
          error={create.error}
          onCancel={onClose}
          onSubmit={(submit) => {
            if (submit.mode === 'create') create.mutate(submit.body);
          }}
        />
      )}
    </Dialog>
  );
}

export function AgentsPage() {
  const api = useApi();
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const teamId = params.get('teamId') ?? '';
  const includeInactive = params.get('inactive') === '1';
  const selected = params.get('agent');
  const [creating, setCreating] = useState(false);

  const teams = useQuery({ queryKey: queryKeys.teams, queryFn: () => api.listTeams(), enabled: can('team:read') });
  const agents = useQuery({
    queryKey: queryKeys.agentList({ teamId, includeInactive }),
    queryFn: () => api.listAgents({ teamId: teamId || undefined, includeInactive }),
  });
  const teamNames = new Map((teams.data ?? []).map((t) => [t.id, t.name] as const));

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="Agents"
        actions={
          can('agent:manage') ? (
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              New agent
            </button>
          ) : null
        }
      />
      <div className="toolbar">
        <label>
          Team{' '}
          <select value={teamId} onChange={(e) => setParam('teamId', e.target.value)}>
            <option value="">All teams</option>
            {(teams.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={includeInactive} onChange={(e) => setParam('inactive', e.target.checked ? '1' : null)} />{' '}
          Include inactive
        </label>
      </div>
      <div className={selected ? 'with-drawer' : undefined}>
        <div>
          {agents.isPending ? (
            <Loading label="Loading agents" />
          ) : agents.isError ? (
            <ErrorView error={agents.error} onRetry={() => void agents.refetch()} />
          ) : agents.data.length === 0 ? (
            <Empty>No agents match these filters.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Agent</th>
                    <th scope="col">Team</th>
                    <th scope="col">Model</th>
                    <th scope="col">Tools</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.data.map((a) => (
                    <tr key={a.id} className={a.id === selected ? 'selected' : undefined}>
                      <td>
                        <button type="button" className="link-button" onClick={() => setParam('agent', a.id)}>
                          {a.title}
                        </button>
                        <div className="muted small mono">
                          {a.name}
                          {a.isManager ? ' · manager' : ''}
                        </div>
                      </td>
                      <td>{teamNames.get(a.teamId) ?? '-'}</td>
                      <td className="mono small">{a.model}</td>
                      <td className="small">
                        {a.allowedTools.length} allowed · {a.disallowedTools.length} denied
                      </td>
                      <td>
                        <StatusBadge status={a.isActive ? 'ready' : 'offline'} label={a.isActive ? 'active' : 'inactive'} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {selected ? <AgentDrawer key={selected} agentId={selected} onClose={() => setParam('agent', null)} /> : null}
      </div>
      {creating ? (
        <CreateAgentDialog
          onClose={() => setCreating(false)}
          onCreated={(agent) => {
            setCreating(false);
            setParam('agent', agent.id);
          }}
        />
      ) : null}
    </>
  );
}
