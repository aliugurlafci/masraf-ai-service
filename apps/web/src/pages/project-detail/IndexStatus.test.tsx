import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeResponse, ProjectIndexStatus, ProjectStatus } from '@orc/shared';
import { CSRF_TOKEN, IDS, T0, makeIndexStatus, makeMe, makeOperation } from '../../test/fixtures';
import { installFetch, json, problem } from '../../test/http';
import type { FetchMock } from '../../test/http';
import { renderRoute } from '../../test/render';
import { INDEX_POLL_MS, IndexStatusPanel } from './IndexStatus';

const PROJECT_PATH = `/api/v1/projects/${IDS.project}`;
const STATUS_PATH = `${PROJECT_PATH}/index-status`;

function withoutIndexPermission(): MeResponse {
  const me = makeMe('admin');
  return { ...me, permissions: me.permissions.filter((p) => p !== 'project:index') };
}

function renderPanel(projectStatus: ProjectStatus = 'ready') {
  return renderRoute(<IndexStatusPanel projectId={IDS.project} projectStatus={projectStatus} />, {
    path: `/projects/${IDS.project}`,
    routePath: '/projects/:projectId',
  });
}

function value(label: string): string | null {
  return screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent ?? null;
}

describe('IndexStatusPanel (contract §20.1 /projects/:id)', () => {
  let http: FetchMock;
  let status: ProjectIndexStatus;

  beforeEach(() => {
    http = installFetch();
    status = makeIndexStatus();
    http.on('GET', '/api/v1/auth/me', json(makeMe('admin')));
    http.on('GET', STATUS_PATH, () => json(status));
  });

  it('shows the index fields', async () => {
    renderPanel();

    expect(await screen.findByText('orc-billing')).toBeInTheDocument();
    expect(value('Index name')).toBe('orc-billing');
    expect(value('Nodes')).toMatch(/^1[,.\s ]?500$/);
    expect(value('Edges')).toMatch(/^4[,.\s ]?200$/);
    expect(screen.getByText('Indexed at', { selector: 'dt' }).nextElementSibling?.querySelector('time')).toHaveAttribute(
      'dateTime',
      T0,
    );
    expect(value('Project head')).toBe('aaaaaaaaaaaa');
    expect(value('Freshness')).toBe('Up to date');
    expect(screen.queryByText('stale')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Index now' })).toBeEnabled();
  });

  it('shows the stale badge when the index does not match the project head', async () => {
    status = makeIndexStatus({ stale: true, projectHeadSha: 'd'.repeat(40) });
    renderPanel();

    const heading = await screen.findByRole('heading', { name: /Code index/ });
    expect(within(heading).getByText('stale')).toHaveAttribute('data-status', 'stale');
    expect(value('Freshness')).toBe('Stale: the index does not match the project head');
  });

  it('polls every 5 s while an operation is active and stops when it finished', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    status = makeIndexStatus({
      activeOperation: makeOperation({ id: '00000000-0000-4000-8000-000000000401', status: 'running', endedAt: null, durationMs: null }),
    });
    renderPanel();

    expect(await screen.findByText('project index running')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Index now' })).toBeDisabled();
    expect(screen.getByText('An index operation is already queued or running for this project.')).toBeInTheDocument();
    expect(http.calls('GET', STATUS_PATH)).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(INDEX_POLL_MS);
    });
    await waitFor(() => expect(http.calls('GET', STATUS_PATH)).toHaveLength(2));

    status = makeIndexStatus({ nodeCount: 1600 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INDEX_POLL_MS);
    });
    await waitFor(() => expect(http.calls('GET', STATUS_PATH)).toHaveLength(3));
    await waitFor(() => expect(screen.queryByText('project index running')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Index now' })).toBeEnabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(INDEX_POLL_MS * 3);
    });
    expect(http.calls('GET', STATUS_PATH)).toHaveLength(3);
  });

  it('hides the button without project:index', async () => {
    http.on('GET', '/api/v1/auth/me', json(withoutIndexPermission()));
    renderPanel();

    expect(await screen.findByText('orc-billing')).toBeInTheDocument();
    await waitFor(() => expect(http.calls('GET', '/api/v1/auth/me')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'Index now' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Index mode')).not.toBeInTheDocument();
  });

  it('disables the button with an explanation when MCP is disabled', async () => {
    status = makeIndexStatus({ mcpEnabled: false });
    renderPanel();

    expect(await screen.findByRole('button', { name: 'Index now' })).toBeDisabled();
    expect(
      screen.getByText('Code indexing is disabled on this installation (codebase-memory-mcp is not enabled).'),
    ).toBeInTheDocument();
    expect(screen.getByText('disabled')).toBeInTheDocument();
  });

  it('disables the button after a 503 mcp_disabled answer', async () => {
    http.on('POST', `${PROJECT_PATH}/index`, problem(503, 'mcp_disabled', 'Code index is disabled'));
    const { user } = renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Index now' }));

    expect(
      await screen.findByText('Code indexing is disabled on this installation (codebase-memory-mcp is not enabled).'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Index now' })).toBeDisabled();
  });

  it('disables the button while the project is not ready', async () => {
    renderPanel('validating');

    expect(await screen.findByRole('button', { name: 'Index now' })).toBeDisabled();
    expect(
      screen.getByText('The project must be ready before it can be indexed (current status: validating).'),
    ).toBeInTheDocument();
  });

  it('requests an index with the chosen mode and the CSRF header, then starts polling', async () => {
    http.on('POST', `${PROJECT_PATH}/index`, () => {
      const op = makeOperation({ id: '00000000-0000-4000-8000-000000000402', status: 'queued', mode: 'full', startedAt: null, endedAt: null, durationMs: null });
      status = makeIndexStatus({ activeOperation: op });
      return json(op, 202);
    });
    const { user } = renderPanel();

    await user.selectOptions(await screen.findByLabelText('Index mode'), 'full');
    await user.click(screen.getByRole('button', { name: 'Index now' }));

    expect(await screen.findByText('Index operation queued.')).toBeInTheDocument();
    const [req] = http.calls('POST', `${PROJECT_PATH}/index`);
    expect(req?.body).toEqual({ mode: 'full' });
    expect(req?.headers.get('X-CSRF-Token')).toBe(CSRF_TOKEN);
    expect(await screen.findByText('project index queued')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Index now' })).toBeDisabled();
  });
});
