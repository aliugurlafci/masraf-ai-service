import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { CSRF_TOKEN, IDS, id, makeAgent, makeIndexStatus, makeMe, makeProject, page } from '../../test/fixtures';
import { installFetch, json } from '../../test/http';
import type { FetchMock } from '../../test/http';
import { renderApp } from '../../test/render';

describe('projects (contract §20.1 /projects)', () => {
  let http: FetchMock;

  beforeEach(() => {
    http = installFetch();
    http.on('GET', '/api/v1/auth/me', json(makeMe('admin')));
    http.on('GET', '/api/v1/agents', json([makeAgent()]));
    http.on(
      'GET',
      '/api/v1/projects',
      json(
        page([
          makeProject(),
          makeProject({ id: id(11), name: 'Legacy portal', repoPath: 'team/legacy', status: 'invalid', statusDetail: 'not a git repository' }),
        ]),
      ),
    );
  });

  it('lists projects with status badges', async () => {
    renderApp('/projects');

    const link = await screen.findByRole('link', { name: 'Legacy portal' });
    const row = link.closest('tr') as HTMLElement;
    expect(within(row).getByText('invalid')).toHaveAttribute('data-status', 'invalid');
    expect(screen.getByRole('link', { name: 'Billing service' })).toHaveAttribute('href', `/projects/${IDS.project}`);
  });

  it('creates a project with an Idempotency-Key and CSRF header, then opens it', async () => {
    const created = makeProject({ id: id(12), name: 'Payments', repoPath: 'team/payments', status: 'validating' });
    http.on('POST', '/api/v1/projects', json(created, 201, { Location: `/api/v1/projects/${id(12)}` }));
    http.on('GET', `/api/v1/projects/${id(12)}`, json(created, 200, { ETag: '"p1"' }));
    http.on('GET', `/api/v1/projects/${id(12)}/index-status`, json(makeIndexStatus({ projectId: id(12) })));
    http.on('GET', `/api/v1/projects/${id(12)}/index-operations`, json(page([])));
    const { user } = renderApp('/projects');

    await user.click(await screen.findByRole('button', { name: 'New project' }));
    const dialog = screen.getByRole('dialog', { name: 'New project' });
    await user.type(within(dialog).getByLabelText('Name'), 'Payments');
    await user.type(within(dialog).getByLabelText('Repository path'), 'team/payments');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));

    expect(await screen.findByRole('heading', { name: /^Payments/, level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(`/projects/${id(12)}`);
    const [req] = http.calls('POST', '/api/v1/projects');
    expect(req?.headers.get('X-CSRF-Token')).toBe(CSRF_TOKEN);
    expect(req?.headers.get('Idempotency-Key')).toMatch(/^[A-Za-z0-9_.:-]{8,255}$/);
    expect(req?.body).toMatchObject({ name: 'Payments', repoPath: 'team/payments' });
  });

  it('hides the create action without project:create', async () => {
    http.on('GET', '/api/v1/auth/me', json(makeMe('auditor')));
    renderApp('/projects');

    expect(await screen.findByRole('link', { name: 'Billing service' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New project' })).not.toBeInTheDocument();
  });
});
