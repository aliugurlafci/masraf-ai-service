import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDS, T0, makeAgent, makeMe, makeProject, makeTask, page } from '../test/fixtures';
import { installFetch, json, problem } from '../test/http';
import type { FetchMock } from '../test/http';
import { renderApp } from '../test/render';

const QUEUE = {
  queues: [{ name: 'orc-tasks', waiting: 2, active: 1, delayed: 0, prioritized: 1, failed: 4, completed: 90, paused: false }],
  deadLetterCount: 3,
  redisMemory: { usedBytes: 1048576, maxBytes: null, policy: 'noeviction' },
  checkedAt: T0,
};

const WORKER = {
  id: 'worker-1',
  hostname: 'build-host',
  pid: 4321,
  appVersion: '1.0.0',
  cliVersion: '2.1.0',
  mcpVersion: null,
  concurrency: 2,
  activeJobs: 1,
  status: 'ready',
  diskFreeBytes: 5_000_000_000,
  startedAt: T0,
  lastHeartbeatAt: T0,
  stoppedAt: null,
};

const never = () => new Promise<Response>(() => undefined);

describe('dashboard (contract §20.1 /)', () => {
  let http: FetchMock;

  beforeEach(() => {
    http = installFetch();
    http.on('GET', '/api/v1/auth/me', json(makeMe('admin')));
    http.on('GET', '/api/v1/projects', json(page([makeProject()])));
    http.on('GET', '/api/v1/agents', json([makeAgent()]));
    http.on('GET', '/api/v1/tasks', json(page([makeTask()])));
    http.on('GET', '/api/v1/system/queue', json(QUEUE));
    http.on('GET', '/api/v1/system/workers', json([WORKER]));
  });

  it('shows a loading state while the panels fetch', async () => {
    http.on('GET', '/api/v1/tasks', never);
    http.on('GET', '/api/v1/system/queue', never);
    http.on('GET', '/api/v1/system/workers', never);
    renderApp('/');

    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('Loading recent tasks…')).toBeInTheDocument();
    expect(screen.getByText('Loading queue status…')).toBeInTheDocument();
    expect(screen.getByText('Loading workers…')).toBeInTheDocument();
    expect(screen.getAllByRole('status', { busy: true }).length).toBeGreaterThanOrEqual(3);
  });

  it('shows recent tasks, queue figures and workers for an admin', async () => {
    renderApp('/');

    expect(await screen.findByRole('link', { name: 'Fix invoice rounding' })).toHaveAttribute('href', `/tasks/${IDS.task}`);
    expect(screen.getByRole('heading', { name: 'Recent tasks (all users)' })).toBeInTheDocument();
    expect(within(screen.getByRole('main')).getAllByRole('link', { name: 'New task' }).at(-1)).toHaveAttribute('href', '/tasks/new');

    const queues = screen.getByRole('region', { name: 'Queues' });
    expect(await within(queues).findByText('orc-tasks')).toBeInTheDocument();
    expect(within(queues).getByText('Dead letters').nextElementSibling).toHaveTextContent('3');

    const workers = screen.getByRole('region', { name: 'Workers' });
    expect(await within(workers).findByText('build-host')).toBeInTheDocument();
    expect(within(workers).getByText('1 / 2')).toBeInTheDocument();
  });

  it('shows empty states when nothing exists yet', async () => {
    http.on('GET', '/api/v1/tasks', json(page([])));
    http.on('GET', '/api/v1/system/queue', json({ ...QUEUE, queues: [], deadLetterCount: 0 }));
    http.on('GET', '/api/v1/system/workers', json([]));
    renderApp('/');

    expect(await screen.findByText(/No tasks yet\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create the first task.' })).toBeInTheDocument();
    expect(await screen.findByText('No queues reported.')).toBeInTheDocument();
    expect(await screen.findByText(/No worker has registered yet/)).toBeInTheDocument();
  });

  it('surfaces API errors per panel', async () => {
    http.on('GET', '/api/v1/tasks', problem(500, 'internal_error', 'Task listing failed'));
    http.on('GET', '/api/v1/system/queue', problem(500, 'internal_error', 'Queue unavailable'));
    http.on('GET', '/api/v1/system/workers', problem(500, 'internal_error', 'Workers unavailable'));
    renderApp('/');

    expect(await screen.findByText('Task listing failed')).toBeInTheDocument();
    expect(await screen.findByText('Queue unavailable')).toBeInTheDocument();
    expect(await screen.findByText('Workers unavailable')).toBeInTheDocument();
    expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(3);
  });

  it('hides system panels and the task action for a read-only own-tasks role', async () => {
    http.on('GET', '/api/v1/auth/me', json(makeMe('operator', { permissions: ['task:read:own', 'project:read'] })));
    renderApp('/');

    expect(await screen.findByRole('link', { name: 'Fix invoice rounding' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your recent tasks' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Queues' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Workers' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('main')).queryByRole('link', { name: 'New task' })).not.toBeInTheDocument();
    expect(http.calls('GET', '/api/v1/system/queue')).toHaveLength(0);
  });
});
