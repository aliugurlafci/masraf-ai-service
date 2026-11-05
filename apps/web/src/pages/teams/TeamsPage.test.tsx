import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDS, T0, id, makeAgent, makeMe } from '../../test/fixtures';
import { installFetch, json, problem } from '../../test/http';
import type { FetchMock } from '../../test/http';
import { renderApp } from '../../test/render';

const never = () => new Promise<Response>(() => undefined);

const TEAM = {
  id: IDS.team,
  name: 'Backend',
  description: 'APIs and workers',
  managerAgentId: null,
  ownedPaths: ['apps/api', 'packages/task-manager'],
  createdAt: T0,
  updatedAt: T0,
};

describe('teams (contract §20.1 /teams)', () => {
  let http: FetchMock;

  beforeEach(() => {
    http = installFetch();
    http.on('GET', '/api/v1/auth/me', json(makeMe('admin')));
    http.on('GET', '/api/v1/agents', json([makeAgent()]));
    http.on('GET', '/api/v1/teams', json([TEAM, { ...TEAM, id: id(31), name: 'Frontend', description: null, ownedPaths: [] }]));
  });

  it('shows a loading state while teams load', async () => {
    http.on('GET', '/api/v1/teams', never);
    renderApp('/teams');

    expect(await screen.findByText('Loading teams…')).toBeInTheDocument();
    expect(screen.getByRole('status', { busy: true })).toBeInTheDocument();
  });

  it('lists teams with description and owned paths', async () => {
    renderApp('/teams');

    const backend = (await screen.findByRole('button', { name: 'Backend' })).closest('tr') as HTMLElement;
    expect(within(backend).getByText('APIs and workers')).toBeInTheDocument();
    expect(within(backend).getByText('apps/api, packages/task-manager')).toBeInTheDocument();
    const frontend = screen.getByRole('button', { name: 'Frontend' }).closest('tr') as HTMLElement;
    expect(within(frontend).getByText('-')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New team' })).toBeInTheDocument();
  });

  it('shows an empty state when no team exists', async () => {
    http.on('GET', '/api/v1/teams', json([]));
    renderApp('/teams');

    expect(await screen.findByText('No teams defined.')).toBeInTheDocument();
  });

  it('shows the API error with a retry action', async () => {
    http.on('GET', '/api/v1/teams', problem(500, 'internal_error', 'Teams unavailable'));
    renderApp('/teams');

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Teams unavailable')).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  it('opens the team drawer with its agents and owned paths', async () => {
    http.on('GET', `/api/v1/teams/${IDS.team}`, json({ ...TEAM, agents: [makeAgent()] }, 200, { ETag: '"t1"' }));
    const { user } = renderApp('/teams');

    await user.click(await screen.findByRole('button', { name: 'Backend' }));

    const drawer = await screen.findByRole('complementary', { name: 'Team details' });
    expect(await within(drawer).findByText('backend-dev')).toBeInTheDocument();
    expect(within(drawer).getByText('apps/api')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Edit team' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(`team=${IDS.team}`);

    await user.click(within(drawer).getByRole('button', { name: 'Close team details' }));
    expect(screen.queryByRole('complementary', { name: 'Team details' })).not.toBeInTheDocument();
  });

  it('shows empty states inside the drawer for a team without agents or paths', async () => {
    http.on('GET', `/api/v1/teams/${id(31)}`, json({ ...TEAM, id: id(31), name: 'Frontend', ownedPaths: [], agents: [] }, 200, { ETag: '"t2"' }));
    renderApp(`/teams?team=${id(31)}`);

    const drawer = await screen.findByRole('complementary', { name: 'Team details' });
    expect(await within(drawer).findByText('No owned paths.')).toBeInTheDocument();
    expect(within(drawer).getByText('No agents in this team.')).toBeInTheDocument();
  });

  it('shows a not-found view in the drawer for an unknown team', async () => {
    http.on('GET', `/api/v1/teams/${IDS.team}`, problem(404, 'not_found', 'Team not found'));
    renderApp(`/teams?team=${IDS.team}`);

    const drawer = await screen.findByRole('complementary', { name: 'Team details' });
    expect(await within(drawer).findByRole('heading', { name: 'Not found' })).toBeInTheDocument();
  });

  it('hides management actions without team:manage', async () => {
    http.on('GET', '/api/v1/auth/me', json(makeMe('operator')));
    http.on('GET', `/api/v1/teams/${IDS.team}`, json({ ...TEAM, agents: [] }, 200, { ETag: '"t1"' }));
    renderApp(`/teams?team=${IDS.team}`);

    const drawer = await screen.findByRole('complementary', { name: 'Team details' });
    expect(await within(drawer).findByText('Owned paths')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New team' })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: 'Edit team' })).not.toBeInTheDocument();
  });
});
