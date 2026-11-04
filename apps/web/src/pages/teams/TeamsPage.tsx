import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Agent, CreateTeamRequest, Team, TeamDetail, UpdateTeamRequest } from '@orc/shared';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { fieldErrorsOf, hasErrorCode, isApiError } from '../../api/errors';
import { queryKeys } from '../../api/queryKeys';
import { useCan } from '../../auth/session';
import { Dialog } from '../../components/Dialog';
import { ErrorView, ProblemMessage } from '../../components/ErrorView';
import { Empty, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { DateTime, Field, KeyValues, PageHeader } from '../../components/ui';

function TeamForm({
  team,
  agents,
  submitting,
  error,
  notice,
  onSubmit,
  onCancel,
}: {
  team?: TeamDetail;
  agents: readonly Agent[];
  submitting: boolean;
  error: unknown;
  notice?: string | null;
  onSubmit: (body: CreateTeamRequest | UpdateTeamRequest) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(team?.name ?? '');
  const [description, setDescription] = useState(team?.description ?? '');
  const [managerAgentId, setManagerAgentId] = useState(team?.managerAgentId ?? '');
  const [ownedPaths, setOwnedPaths] = useState((team?.ownedPaths ?? []).join('\n'));
  const [localError, setLocalError] = useState<string | null>(null);
  const serverErrors = fieldErrorsOf(error);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const paths = ownedPaths
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean);
    if (!name.trim()) {
      setLocalError('Name is required.');
      return;
    }
    if (paths.length > 50 || paths.some((p) => p.length > 200)) {
      setLocalError('At most 50 owned paths of up to 200 characters each.');
      return;
    }
    setLocalError(null);
    const body: CreateTeamRequest = {
      name: name.trim(),
      description: description.trim() || null,
      managerAgentId: managerAgentId || null,
      ownedPaths: paths,
    };
    if (!team) {
      onSubmit(body);
      return;
    }
    const patch: Record<string, unknown> = {};
    if (body.name !== team.name) patch.name = body.name;
    if (body.description !== team.description) patch.description = body.description;
    if (body.managerAgentId !== team.managerAgentId) patch.managerAgentId = body.managerAgentId;
    if (JSON.stringify(body.ownedPaths) !== JSON.stringify(team.ownedPaths)) patch.ownedPaths = body.ownedPaths;
    if (Object.keys(patch).length === 0) {
      setLocalError('Nothing changed.');
      return;
    }
    onSubmit(patch);
  };

  return (
    <form className="form" onSubmit={submit} noValidate>
      {notice ? (
        <div className="banner banner-warning" role="alert">
          {notice}
        </div>
      ) : null}
      {isApiError(error) && Object.keys(serverErrors).length === 0 && error.code !== 'precondition_failed' ? (
        <ProblemMessage error={error} />
      ) : null}
      {localError ? <p className="field-error">{localError}</p> : null}
      <Field label="Name" error={serverErrors.name}>
        {(p) => <input {...p} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label="Description" error={serverErrors.description}>
        {(p) => <textarea {...p} rows={2} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />}
      </Field>
      <Field label="Manager agent" error={serverErrors.managerAgentId}>
        {(p) => (
          <select {...p} value={managerAgentId} onChange={(e) => setManagerAgentId(e.target.value)}>
            <option value="">None</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title} ({a.name})
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Owned paths" error={serverErrors.ownedPaths} hint="One path per line (max 50).">
        {(p) => <textarea {...p} rows={4} className="mono" value={ownedPaths} onChange={(e) => setOwnedPaths(e.target.value)} />}
      </Field>
      <div className="form-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? 'Saving…' : team ? 'Save team' : 'Create team'}
        </button>
      </div>
    </form>
  );
}

function TeamPanel({ teamId, onClose }: { teamId: string; onClose: () => void }) {
  const api = useApi();
  const can = useCan();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [formVersion, setFormVersion] = useState(0);
  const team = useQuery({ queryKey: queryKeys.team(teamId), queryFn: () => api.getTeam(teamId) });
  const agents = useQuery({
    queryKey: queryKeys.agentList({ includeInactive: true }),
    queryFn: () => api.listAgents({ includeInactive: true }),
    enabled: can('agent:read'),
  });
  const update = useMutation({
    mutationFn: (body: UpdateTeamRequest) => api.updateTeam(teamId, body, team.data?.etag ?? null),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.teams });
      setEditing(false);
      setNotice(null);
    },
    onError: async (error) => {
      if (hasErrorCode(error, 'precondition_failed')) {
        await team.refetch();
        setNotice('The team was changed by someone else. The form shows the current version; review and save again.');
        setFormVersion((v) => v + 1);
      }
    },
  });

  return (
    <aside className="drawer" aria-label="Team details">
      <header className="drawer-header">
        <h2>{team.data?.data.name ?? 'Team'}</h2>
        <button type="button" className="btn btn-ghost btn-small" onClick={onClose} aria-label="Close team details">
          ×
        </button>
      </header>
      {team.isPending ? (
        <Loading label="Loading team" />
      ) : team.isError ? (
        <ErrorView error={team.error} onRetry={() => void team.refetch()} notFoundWhat="team" />
      ) : editing ? (
        <TeamForm
          key={`${formVersion}:${team.data.etag ?? ''}`}
          team={team.data.data}
          agents={agents.data ?? team.data.data.agents}
          submitting={update.isPending}
          error={update.error}
          notice={notice}
          onCancel={() => setEditing(false)}
          onSubmit={(body) => update.mutate(body)}
        />
      ) : (
        <div className="drawer-body">
          {can('team:manage') ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                update.reset();
                setNotice(null);
                setEditing(true);
              }}
            >
              Edit team
            </button>
          ) : null}
          {team.data.data.description ? <p>{team.data.data.description}</p> : null}
          <KeyValues
            items={[
              [
                'Manager',
                team.data.data.agents.find((a) => a.id === team.data.data.managerAgentId)?.title ??
                  (team.data.data.managerAgentId ? team.data.data.managerAgentId : 'None'),
              ],
              ['Updated', <DateTime key="u" value={team.data.data.updatedAt} />],
            ]}
          />
          <h3>Owned paths</h3>
          {team.data.data.ownedPaths.length === 0 ? (
            <Empty>No owned paths.</Empty>
          ) : (
            <ul className="plain-list mono">{team.data.data.ownedPaths.map((p) => <li key={p}>{p}</li>)}</ul>
          )}
          <h3>Agents</h3>
          {team.data.data.agents.length === 0 ? (
            <Empty>No agents in this team.</Empty>
          ) : (
            <ul className="plain-list">
              {team.data.data.agents.map((a) => (
                <li key={a.id}>
                  {a.title} <span className="muted mono small">{a.name}</span>{' '}
                  {!a.isActive ? <StatusBadge status="offline" label="inactive" /> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </aside>
  );
}

function CreateTeamDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (team: Team) => void }) {
  const api = useApi();
  const can = useCan();
  const queryClient = useQueryClient();
  const agents = useQuery({
    queryKey: queryKeys.agentList({ includeInactive: true }),
    queryFn: () => api.listAgents({ includeInactive: true }),
    enabled: can('agent:read'),
  });
  const create = useMutation({
    mutationFn: (body: CreateTeamRequest) => api.createTeam(body),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.teams });
      onCreated(res.data);
    },
  });
  return (
    <Dialog title="New team" onClose={onClose} busy={create.isPending}>
      <TeamForm
        agents={agents.data ?? []}
        submitting={create.isPending}
        error={create.error}
        onCancel={onClose}
        onSubmit={(body) => create.mutate(body as CreateTeamRequest)}
      />
    </Dialog>
  );
}

export function TeamsPage() {
  const api = useApi();
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const selected = params.get('team');
  const [creating, setCreating] = useState(false);
  const teams = useQuery({ queryKey: queryKeys.teams, queryFn: () => api.listTeams() });

  const select = (teamId: string | null) => {
    const next = new URLSearchParams(params);
    if (teamId) next.set('team', teamId);
    else next.delete('team');
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="Teams"
        actions={
          can('team:manage') ? (
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              New team
            </button>
          ) : null
        }
      />
      <div className={selected ? 'with-drawer' : undefined}>
        <div>
          {teams.isPending ? (
            <Loading label="Loading teams" />
          ) : teams.isError ? (
            <ErrorView error={teams.error} onRetry={() => void teams.refetch()} />
          ) : teams.data.length === 0 ? (
            <Empty>No teams defined.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Team</th>
                    <th scope="col">Owned paths</th>
                    <th scope="col">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {teams.data.map((t) => (
                    <tr key={t.id} className={t.id === selected ? 'selected' : undefined}>
                      <td>
                        <button type="button" className="link-button" onClick={() => select(t.id)}>
                          {t.name}
                        </button>
                        {t.description ? <div className="muted small clamp">{t.description}</div> : null}
                      </td>
                      <td className="mono small">{t.ownedPaths.join(', ') || '-'}</td>
                      <td>
                        <DateTime value={t.updatedAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {selected ? <TeamPanel key={selected} teamId={selected} onClose={() => select(null)} /> : null}
      </div>
      {creating ? (
        <CreateTeamDialog
          onClose={() => setCreating(false)}
          onCreated={(team) => {
            setCreating(false);
            select(team.id);
          }}
        />
      ) : null}
    </>
  );
}
