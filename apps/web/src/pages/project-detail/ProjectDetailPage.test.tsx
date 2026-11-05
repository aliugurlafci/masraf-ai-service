import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDS, makeAgent, makeIndexStatus, makeMe, makeProject, page } from '../../test/fixtures';
import { installFetch, json, problem } from '../../test/http';
import type { FetchMock } from '../../test/http';
import { renderApp } from '../../test/render';

const never = () => new Promise<Response>(() => undefined);
const PROJECT_URL = `/api/v1/projects/${IDS.project}`;

describe('project detail (contract §20.1 /projects/:projectId)', () => {
  let http: FetchMock;

  beforeEach(() => {
    http = installFetch();
    http.on('GET', '/api/v1/auth/me', json(makeMe('admin')));
    http.on('GET', '/api/v1/agents', json([makeAgent()]));
    http.on('GET', PROJECT_URL, json(makeProject({ description: 'Invoices and ledgers' }), 200, { ETag: '"p1"' }));
    http.on('GET', `${PROJECT_URL}/index-status`, json(makeIndexStatus()));
    http.on('GET', `${PROJECT_URL}/index-operations`, json(page([])));
  });

  it('shows a loading state before the project arrives', async () => {
    http.on('GET', PROJECT_URL, never);
    renderApp(`/projects/${IDS.project}`);

    expect(await screen.findByText('Loading project…')).toBeInTheDocument();
    expect(screen.getByRole('status', { busy: true })).toBeInTheDocument();
  });

  it('renders the project settings, status and actions', async () => {
    renderApp(`/projects/${IDS.project}`);

    expect(await screen.findByRole('heading', { name: /^Billing service/, level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Invoices and ledgers')).toBeInTheDocument();
    const settings = screen.getByRole('region', { name: 'Settings' });
    expect(within(settings).getByText('team/billing')).toBeInTheDocument();
    expect(within(settings).getByText('npm test')).toBeInTheDocument();
    expect(await within(settings).findByText('Backend developer')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Index operations' })).toBeInTheDocument();

    const main = within(screen.getByRole('main'));
    expect(main.getByRole('link', { name: 'New task' })).toHaveAttribute('href', `/tasks/new?projectId=${IDS.project}`);
    expect(main.getByRole('button', { name: 'Sync repository' })).toBeEnabled();
    expect(main.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(main.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
  });

  it('explains an invalid project and withholds task creation', async () => {
    http.on(
      'GET',
      PROJECT_URL,
      json(makeProject({ status: 'invalid', statusDetail: 'not a git repository' }), 200, { ETag: '"p2"' }),
    );
    renderApp(`/projects/${IDS.project}`);

    expect(await screen.findByText('not a git repository')).toBeInTheDocument();
    expect(within(screen.getByRole('main')).queryByRole('link', { name: 'New task' })).not.toBeInTheDocument();
  });

  it('offers Restore instead of edit/sync for an archived project', async () => {
    http.on('GET', PROJECT_URL, json(makeProject({ status: 'archived', archivedAt: '2026-11-02T11:00:00.000Z' }), 200, { ETag: '"p3"' }));
    renderApp(`/projects/${IDS.project}`);

    expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument();
    const main = within(screen.getByRole('main'));
    expect(main.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(main.queryByRole('button', { name: 'Sync repository' })).not.toBeInTheDocument();
  });

  it('hides mutating actions without project permissions', async () => {
    http.on('GET', '/api/v1/auth/me', json(makeMe('auditor')));
    renderApp(`/projects/${IDS.project}`);

    expect(await screen.findByRole('heading', { name: /^Billing service/, level: 1 })).toBeInTheDocument();
    const main = within(screen.getByRole('main'));
    expect(main.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(main.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    expect(main.queryByRole('button', { name: 'Sync repository' })).not.toBeInTheDocument();
  });

  it('shows a not-found view for an unknown project', async () => {
    http.on('GET', PROJECT_URL, problem(404, 'not_found', 'Project not found'));
    renderApp(`/projects/${IDS.project}`);

    expect(await screen.findByRole('heading', { name: /not found/i })).toBeInTheDocument();
  });

  it('shows the Problem details with a retry for a server error', async () => {
    http.on('GET', PROJECT_URL, problem(500, 'internal_error', 'Project lookup failed'));
    renderApp(`/projects/${IDS.project}`);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Project lookup failed')).toBeInTheDocument();
    expect(within(alert).getByText('req-12345678')).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeEnabled();
  });
});
