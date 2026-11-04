import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeMe } from '../test/fixtures';
import { installFetch, json, problem } from '../test/http';
import type { FetchMock } from '../test/http';
import { renderApp } from '../test/render';

describe('route guards (contract §20.1)', () => {
  let http: FetchMock;

  beforeEach(() => {
    http = installFetch();
  });

  it('redirects unauthenticated users to /login?next=<path>', async () => {
    http.on('GET', '/api/v1/auth/me', () => problem(401, 'unauthenticated', 'Authentication required'));

    renderApp('/tasks?status=failed');

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(
      `/login?next=${encodeURIComponent('/tasks?status=failed')}`,
    );
  });

  it('renders the 403 page in place when the permission is missing', async () => {
    http.on('GET', '/api/v1/auth/me', json(makeMe('operator')));

    renderApp('/audit');

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/audit');
    expect(http.calls('GET', '/api/v1/audit-logs')).toHaveLength(0);
  });

  it('renders the 404 page for unknown routes', async () => {
    http.on('GET', '/api/v1/auth/me', json(makeMe('admin')));

    renderApp('/definitely/not/a/page');

    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument();
  });

  it('shows only navigation entries the role is allowed to use', async () => {
    http.on('GET', '/api/v1/auth/me', json(makeMe('auditor')));
    http.on('GET', '/api/v1/teams', json([]));

    renderApp('/teams');

    const nav = await screen.findByRole('navigation', { name: 'Main' });
    const links = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent);
    expect(links).toEqual(['Dashboard', 'Tasks', 'Projects', 'Agents', 'Teams', 'System', 'Audit', 'Account']);
    expect(within(nav).queryByRole('link', { name: 'New task' })).not.toBeInTheDocument();
    expect(await screen.findByText('No teams defined.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New team' })).not.toBeInTheDocument();
  });

  it('hides audit and admin actions from operators but offers task creation', async () => {
    http.on('GET', '/api/v1/auth/me', json(makeMe('operator')));
    http.on('GET', '/api/v1/teams', json([]));

    renderApp('/teams');

    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'New task' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Audit' })).not.toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Teams' })).toHaveAttribute('aria-current', 'page');
  });
});
