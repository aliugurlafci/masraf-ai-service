import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDS, T0, id, makeAgent, makeMe } from '../../test/fixtures';
import { installFetch, json, problem } from '../../test/http';
import type { FetchMock } from '../../test/http';
import { renderApp } from '../../test/render';

const never = () => new Promise<Response>(() => undefined);

const TEAM = {
  id: IDS.team,
  name: 'Backend',
  description: null,
  managerAgentId: null,
  ownedPaths: ['apps/api'],
  createdAt: T0,
  updatedAt: T0,
};

describe('agents (contract §20.1 /agents)', () => {
  let http: FetchMock;

  beforeEach(() => {
    http = installFetch();
    http.on('GET', '/api/v1/auth/me', json(makeMe('admin')));
    http.on('GET', '/api/v1/teams', json([TEAM]));
    http.on(
      'GET',
      '/api/v1/agents',
      json([
        makeAgent(),
        makeAgent({ id: id(21), name: 'old-bot', title: 'Retired bot', isActive: false, isManager: true, disallowedTools: ['Bash'] }),
      ]),
    );
  });

  it('shows a loading state while agents load', async () => {
    http.on('GET', '/api/v1/agents', never);
    renderApp('/agents');

    expect(await screen.findByText('Loading agents…')).toBeInTheDocument();
    expect(screen.getByRole('status', { busy: true })).toBeInTheDocument();
  });

  it('lists agents with team, model, tool counts and status', async () => {
    renderApp('/agents');

    const button = await screen.findByRole('button', { name: 'Retired bot' });
    const row = button.closest('tr') as HTMLElement;
    expect(within(row).getByText('inactive')).toHaveAttribute('data-status', 'offline');
    expect(within(row).getByText('2 allowed · 1 denied')).toBeInTheDocument();
    const first = screen.getByRole('button', { name: 'Backend developer' }).closest('tr') as HTMLElement;
    expect(await within(first).findByText('Backend')).toBeInTheDocument();
    expect(within(first).getByText('claude-sonnet-4-5')).toBeInTheDocument();
    expect(within(first).getByText('active')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New agent' })).toBeInTheDocument();
  });

  it('shows an empty state when no agent matches the filters', async () => {
    http.on('GET', '/api/v1/agents', json([]));
    renderApp('/agents');

    expect(await screen.findByText('No agents match these filters.')).toBeInTheDocument();
  });

  it('shows the API error with a retry action', async () => {
    http.on('GET', '/api/v1/agents', problem(500, 'internal_error', 'Agents unavailable'));
    renderApp('/agents');

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Agents unavailable')).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  it('opens the detail drawer for a selected agent', async () => {
    http.on('GET', `/api/v1/agents/${IDS.agent}`, json(makeAgent({ instructions: 'Be careful.' }), 200, { ETag: '"a1"' }));
    const { user } = renderApp('/agents');

    await user.click(await screen.findByRole('button', { name: 'Backend developer' }));

    const drawer = await screen.findByRole('complementary', { name: 'Agent details' });
    expect(await within(drawer).findByText('Be careful.')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Edit agent' })).toBeInTheDocument();
    expect(within(drawer).getByText('Read')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(`agent=${IDS.agent}`);

    await user.click(within(drawer).getByRole('button', { name: 'Close agent details' }));
    expect(screen.queryByRole('complementary', { name: 'Agent details' })).not.toBeInTheDocument();
  });

  it('shows an error in the drawer when the agent cannot be loaded', async () => {
    http.on('GET', `/api/v1/agents/${IDS.agent}`, problem(500, 'internal_error', 'Agent lookup failed'));
    renderApp(`/agents?agent=${IDS.agent}`);

    const drawer = await screen.findByRole('complementary', { name: 'Agent details' });
    expect(await within(drawer).findByText('Agent lookup failed')).toBeInTheDocument();
  });

  it('hides management actions without agent:manage and the edit button in the drawer', async () => {
    http.on('GET', '/api/v1/auth/me', json(makeMe('operator')));
    http.on('GET', `/api/v1/agents/${IDS.agent}`, json(makeAgent(), 200, { ETag: '"a1"' }));
    renderApp(`/agents?agent=${IDS.agent}`);

    const drawer = await screen.findByRole('complementary', { name: 'Agent details' });
    expect(await within(drawer).findByText('Allowed tools')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New agent' })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: 'Edit agent' })).not.toBeInTheDocument();
  });

  it('requests inactive agents only when the filter is ticked', async () => {
    const { user } = renderApp('/agents');
    await screen.findByRole('button', { name: 'Backend developer' });
    expect(http.calls('GET', '/api/v1/agents')[0]?.search.get('includeInactive')).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: 'Include inactive' }));

    await waitFor(() =>
      expect(http.calls('GET', '/api/v1/agents').at(-1)?.search.get('includeInactive')).toBe('true'),
    );
  });
});
