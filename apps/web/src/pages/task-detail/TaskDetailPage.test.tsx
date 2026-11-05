import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { installEventSource } from '../../test/eventSource';
import { IDS, makeAttempt, makeMe, makeTaskDetail } from '../../test/fixtures';
import { installFetch, json, problem } from '../../test/http';
import type { FetchMock } from '../../test/http';
import { renderApp } from '../../test/render';

const never = () => new Promise<Response>(() => undefined);
const TASK_PATH = `/api/v1/tasks/${IDS.task}`;

describe('task detail page (contract §20.1 /tasks/:taskId)', () => {
  let http: FetchMock;

  beforeEach(() => {
    http = installFetch();
    installEventSource();
    http.on('GET', '/api/v1/auth/me', json(makeMe('operator')));
    http.on('GET', TASK_PATH, json(makeTaskDetail({ status: 'running' }), 200, { ETag: '"rv1"' }));
    http.on('GET', `${TASK_PATH}/attempts`, json([makeAttempt()]));
  });

  it('shows a loading state until the task arrives', async () => {
    http.on('GET', TASK_PATH, never);
    renderApp(`/tasks/${IDS.task}`);

    expect(await screen.findByText('Loading task…')).toBeInTheDocument();
    expect(screen.getByRole('status', { busy: true })).toBeInTheDocument();
  });

  it('renders the header, metadata, attempt summary and section tabs', async () => {
    renderApp(`/tasks/${IDS.task}`);

    expect(await screen.findByRole('heading', { name: 'Fix invoice rounding', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Billing service' })).toHaveAttribute('href', `/projects/${IDS.project}`);
    expect(screen.getByText(/Backend developer \(backend-dev\)/)).toBeInTheDocument();
    expect(await screen.findByText('Attempt #1')).toBeInTheDocument();
    expect(screen.getByText('orc/task-1')).toBeInTheDocument();

    const tabs = within(screen.getByRole('navigation', { name: 'Task sections' }));
    expect(tabs.getByRole('link', { name: 'Output' })).toHaveAttribute('aria-current', 'page');
    for (const label of ['Changed files', 'Diff', 'Tests', 'Events', 'Session', 'MCP impact']) {
      expect(tabs.getByRole('link', { name: label })).not.toHaveAttribute('aria-current');
    }
    expect(screen.getByRole('region', { name: 'Output' })).toBeInTheDocument();
    expect(await screen.findByRole('combobox', { name: /Attempt/ })).toBeInTheDocument();
  });

  it('shows the status reason of a failed task', async () => {
    http.on(
      'GET',
      TASK_PATH,
      json(makeTaskDetail({ status: 'failed', statusReason: 'timeout', statusDetail: 'Exceeded 3600 s' }), 200, { ETag: '"rv2"' }),
    );
    renderApp(`/tasks/${IDS.task}`);

    expect(await screen.findByText('Exceeded 3600 s')).toBeInTheDocument();
    expect(screen.getByText('timeout', { selector: '.banner-title' })).toBeInTheDocument();
  });

  it('switches to the changed files tab and shows its empty state', async () => {
    http.on('GET', `${TASK_PATH}/changed-files`, json([]));
    const { user } = renderApp(`/tasks/${IDS.task}`);

    await user.click(await screen.findByRole('link', { name: 'Changed files' }));

    expect(await screen.findByText('No changed files were captured for this attempt.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Changed files' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('?tab=changes');
  });

  it('shows an error inside a tab when its artefact request fails', async () => {
    http.on('GET', `${TASK_PATH}/changed-files`, problem(500, 'internal_error', 'Changed files unavailable'));
    renderApp(`/tasks/${IDS.task}?tab=changes`);

    expect(await screen.findByText('Changed files unavailable')).toBeInTheDocument();
  });

  it('shows a not-found view for an unknown task', async () => {
    http.on('GET', TASK_PATH, problem(404, 'not_found', 'Task not found'));
    renderApp(`/tasks/${IDS.task}`);

    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument();
    expect(screen.getByText(/The task you are looking for does not exist/)).toBeInTheDocument();
  });

  it('shows Problem details with request id and retry for a server error', async () => {
    http.on('GET', TASK_PATH, problem(500, 'internal_error', 'Task lookup failed'));
    renderApp(`/tasks/${IDS.task}`);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Task lookup failed')).toBeInTheDocument();
    expect(within(alert).getByText('req-12345678')).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeEnabled();
  });
});
