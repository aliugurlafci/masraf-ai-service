import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDS, T0, makeMe, makeOperation, page } from '../../test/fixtures';
import { installFetch, json, problem } from '../../test/http';
import type { FetchMock } from '../../test/http';
import { renderApp } from '../../test/render';

const never = () => new Promise<Response>(() => undefined);

const WORKER = {
  id: 'worker-1',
  hostname: 'build-host',
  pid: 4321,
  appVersion: '1.0.0',
  cliVersion: '2.1.0',
  mcpVersion: '0.12.0',
  concurrency: 2,
  activeJobs: 1,
  status: 'ready',
  diskFreeBytes: 5_000_000_000,
  startedAt: T0,
  lastHeartbeatAt: T0,
  stoppedAt: null,
};

const QUEUE = {
  queues: [{ name: 'orc-tasks', waiting: 2, active: 1, delayed: 0, prioritized: 1, failed: 4, completed: 90, paused: true }],
  deadLetterCount: 3,
  redisMemory: { usedBytes: 1048576, maxBytes: null, policy: 'noeviction' },
  checkedAt: T0,
};

const DLQ_ENTRY = {
  jobId: 'dlq-1',
  createdAt: T0,
  data: {
    v: 1,
    sourceQueue: 'orc-tasks',
    jobName: 'run-task',
    jobId: 'job-9',
    data: { taskId: IDS.task },
    failedReason: 'Redis connection lost',
    attemptsMade: 3,
    failedAt: T0,
  },
};

describe('system (contract §20.1 /system)', () => {
  let http: FetchMock;

  beforeEach(() => {
    http = installFetch();
    http.on('GET', '/api/v1/auth/me', json(makeMe('admin')));
    http.on('GET', '/api/v1/system/workers', json([WORKER]));
    http.on('GET', '/api/v1/system/queue', json(QUEUE));
    http.on('GET', '/api/v1/system/dlq', json(page([DLQ_ENTRY])));
    http.on(
      'GET',
      '/api/v1/system/mcp',
      json({
        mcpEnabled: true,
        workers: [{ workerId: 'worker-1', status: 'ready', mcpVersion: '0.12.0', cliVersion: '2.1.0', lastHeartbeatAt: T0 }],
        recentOperations: [makeOperation({ status: 'failed', errorCode: 'index_timeout' })],
      }),
    );
  });

  it('shows a loading state on the default workers tab', async () => {
    http.on('GET', '/api/v1/system/workers', never);
    renderApp('/system');

    expect(await screen.findByRole('heading', { name: 'System', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('Loading workers…')).toBeInTheDocument();
    expect(screen.getByRole('status', { busy: true })).toBeInTheDocument();
  });

  it('lists workers and marks the active tab', async () => {
    renderApp('/system');

    expect(await screen.findByText('build-host')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Workers' })).toBeInTheDocument();
    const nav = within(screen.getByRole('navigation', { name: 'System sections' }));
    expect(nav.getByRole('button', { name: 'Workers' })).toHaveAttribute('aria-current', 'page');
    expect(nav.getByRole('button', { name: 'Queues' })).not.toHaveAttribute('aria-current');
  });

  it('shows the empty workers state', async () => {
    http.on('GET', '/api/v1/system/workers', json([]));
    renderApp('/system');

    expect(await screen.findByText('No worker has registered yet.')).toBeInTheDocument();
  });

  it('shows a workers error with retry', async () => {
    http.on('GET', '/api/v1/system/workers', problem(500, 'internal_error', 'Workers unavailable'));
    renderApp('/system');

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Workers unavailable')).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  it('switches to the queues tab and shows counters, redis memory and paused state', async () => {
    const { user } = renderApp('/system');
    await user.click(await screen.findByRole('button', { name: 'Queues' }));

    const panel = await screen.findByRole('region', { name: 'Queues' });
    expect(await within(panel).findByText('orc-tasks')).toBeInTheDocument();
    expect(within(panel).getByText('paused')).toBeInTheDocument();
    expect(within(panel).getByText('policy noeviction')).toBeInTheDocument();
    expect(within(panel).getByText('Dead letters').nextElementSibling).toHaveTextContent('3');
    expect(screen.getByTestId('location')).toHaveTextContent('?tab=queues');
  });

  it('shows a queues error', async () => {
    http.on('GET', '/api/v1/system/queue', problem(503, 'redis_unavailable', 'Redis unavailable'));
    renderApp('/system?tab=queues');

    expect(await screen.findByText('Redis unavailable')).toBeInTheDocument();
  });

  it('lists dead letters for system:manage and shows the empty state', async () => {
    const { unmount } = renderApp('/system?tab=dlq');
    expect(await screen.findByText('Redis connection lost')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dead letters' })).toHaveAttribute('aria-current', 'page');
    unmount();

    http.on('GET', '/api/v1/system/dlq', json(page([])));
    renderApp('/system?tab=dlq');
    expect(await screen.findByText('The dead-letter queue is empty.')).toBeInTheDocument();
  });

  it('shows a dead-letter error', async () => {
    http.on('GET', '/api/v1/system/dlq', problem(500, 'internal_error', 'DLQ unavailable'));
    renderApp('/system?tab=dlq');

    expect(await screen.findByText('DLQ unavailable')).toBeInTheDocument();
  });

  it('hides the dead-letter tab and denies direct access without system:manage', async () => {
    http.on('GET', '/api/v1/auth/me', json(makeMe('operator')));
    renderApp('/system?tab=dlq');

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dead letters' })).not.toBeInTheDocument();
    expect(http.calls('GET', '/api/v1/system/dlq')).toHaveLength(0);
  });

  it('shows MCP status with workers and recent operations', async () => {
    renderApp('/system?tab=mcp');

    expect(await screen.findByText('enabled')).toBeInTheDocument();
    expect(await screen.findByText('index_timeout')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'project' })).toHaveAttribute('href', `/projects/${IDS.project}`);
    expect(screen.getByText('orc-billing')).toBeInTheDocument();
  });

  it('shows MCP empty states', async () => {
    http.on('GET', '/api/v1/system/mcp', json({ mcpEnabled: false, workers: [], recentOperations: [] }));
    renderApp('/system?tab=mcp');

    expect(await screen.findByText('No worker reports an MCP version.')).toBeInTheDocument();
    expect(screen.getByText('No index operations yet.')).toBeInTheDocument();
    expect(screen.getByText('disabled')).toBeInTheDocument();
  });

  it('shows an MCP error', async () => {
    http.on('GET', '/api/v1/system/mcp', problem(500, 'internal_error', 'MCP status unavailable'));
    renderApp('/system?tab=mcp');

    expect(await screen.findByText('MCP status unavailable')).toBeInTheDocument();
  });
});
