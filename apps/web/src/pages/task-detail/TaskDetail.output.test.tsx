import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskDetail } from '@orc/shared';
import { MockEventSource, installEventSource } from '../../test/eventSource';
import {
  IDS,
  T0,
  claudeEvent,
  endEvent,
  heartbeatEvent,
  logEvent,
  makeAttempt,
  makeMe,
  makeTaskDetail,
  statusEvent,
  streamErrorEvent,
} from '../../test/fixtures';
import { installFetch, json } from '../../test/http';
import type { FetchMock } from '../../test/http';
import { renderApp } from '../../test/render';

const TASK_PATH = `/api/v1/tasks/${IDS.task}`;
const STREAM_PATH = `${TASK_PATH}/stream`;

function outputKinds(): string[] {
  const log = screen.getByRole('log', { name: 'Live output' });
  return Array.from(log.querySelectorAll(':scope > [data-kind]')).map((el) => el.getAttribute('data-kind') ?? '');
}

function connection(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-connection]');
  if (!el) {
    throw new Error('connection indicator not rendered');
  }
  return el;
}

async function openStream(): Promise<MockEventSource> {
  await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
  const es = MockEventSource.latest();
  act(() => es.open());
  return es;
}

describe('task detail live output (contract §8.4, §20.2)', () => {
  let http: FetchMock;
  let detail: TaskDetail;

  beforeEach(() => {
    http = installFetch();
    installEventSource();
    detail = makeTaskDetail({ status: 'running' }, { canCancel: true });
    http.on('GET', '/api/v1/auth/me', json(makeMe('operator')));
    http.on('GET', TASK_PATH, () => json(detail, 200, { ETag: '"rv1"' }));
    http.on('GET', `${TASK_PATH}/attempts`, json([makeAttempt()]));
  });

  it('opens the same-origin stream and appends events in order, rendered per kind', async () => {
    renderApp(`/tasks/${IDS.task}`);
    const es = await openStream();
    expect(es.url).toBe(STREAM_PATH);

    act(() => {
      es.emit('status', statusEvent(), '1-0');
      es.emit('claude', claudeEvent(1, { kind: 'init', text: null, data: { model: 'claude-sonnet-4-5', sessionId: 'sess-1' } }), '2-0');
      es.emit('claude', claudeEvent(2, { text: 'I will fix the rounding.' }), '3-0');
      es.emit('claude', claudeEvent(3, { kind: 'thinking', text: 'secret reasoning' }), '4-0');
      es.emit('claude', claudeEvent(4, { kind: 'tool_use', toolName: 'Edit', text: '{"file_path":"src/a.ts"}' }), '5-0');
      es.emit('log', logEvent(1, { stream: 'stderr', content: 'npm WARN deprecated\n' }), '6-0');
      es.emit('log', logEvent(2, { stream: 'stderr', content: 'second warning\n' }), '7-0');
      es.emit('claude', claudeEvent(5, { kind: 'unknown', text: '{"type":"mystery"}' }), '8-0');
      es.emit(
        'claude',
        claudeEvent(6, { kind: 'result', text: null, data: { subtype: 'success', numTurns: 3, totalCostUsd: 0.12, durationMs: 5000 } }),
        '9-0',
      );
    });

    expect(outputKinds()).toEqual(['status', 'init', 'assistant_text', 'thinking', 'tool_use', 'log', 'unknown', 'result']);
    const log = screen.getByRole('log', { name: 'Live output' });
    expect(within(log).getByText('I will fix the rounding.').tagName).toBe('PRE');
    const thinking = log.querySelector('[data-kind="thinking"]');
    expect(thinking?.tagName).toBe('DETAILS');
    expect(thinking?.hasAttribute('open')).toBe(false);
    expect(within(log).getByText('Edit')).toBeInTheDocument();
    const stderr = log.querySelector('[data-kind="log"]');
    expect(stderr?.getAttribute('data-stream')).toBe('stderr');
    expect(stderr?.textContent).toContain('npm WARN deprecated\nsecond warning\n');
    expect(log.querySelector('[data-kind="unknown"]')).toHaveClass('out-dim');
    expect(within(log).getByText('Claude finished')).toBeInTheDocument();
    expect(within(log).getByText('turns 3')).toBeInTheDocument();
    expect(connection()).toHaveAttribute('data-connection', 'live');
  });

  it('reconnects after CLOSED with ?lastEventId and drops duplicates by the §8.4 keys', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderApp(`/tasks/${IDS.task}`);
    const first = await openStream();

    act(() => {
      first.emit('claude', claudeEvent(1, { text: 'line one' }), '100-0');
      first.emit('log', logEvent(1, { content: 'stdout one\n' }), '101-0');
      first.emit('claude', claudeEvent(2, { text: 'line two' }), '102-0');
    });
    const detailCallsBefore = http.calls('GET', TASK_PATH).length;

    act(() => first.fail(true));

    await waitFor(() => expect(connection()).toHaveTextContent('Reconnecting in 1 s (attempt 1)'));
    expect(http.calls('GET', TASK_PATH).length).toBe(detailCallsBefore + 1);
    expect(MockEventSource.instances).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(MockEventSource.instances).toHaveLength(2);
    const second = MockEventSource.latest();
    expect(second.url).toBe(`${STREAM_PATH}?lastEventId=${encodeURIComponent('102-0')}`);

    act(() => {
      second.open();
      // replayed events (same keys) must be dropped; status is never deduplicated
      second.emit('claude', claudeEvent(2, { text: 'line two' }), '102-0');
      second.emit('log', logEvent(1, { content: 'stdout one\n' }), '101-0');
      second.emit('status', statusEvent(), '103-0');
      second.emit('status', statusEvent(), '104-0');
      second.emit('claude', claudeEvent(3, { text: 'line three' }), '105-0');
      second.emit('claude', claudeEvent(3, { block: 1, text: 'line three, block two' }), '106-0');
    });

    const log = screen.getByRole('log', { name: 'Live output' });
    expect(within(log).getAllByText('line two')).toHaveLength(1);
    expect(within(log).getAllByText('stdout one')).toHaveLength(1);
    expect(within(log).getByText('line three')).toBeInTheDocument();
    expect(within(log).getByText('line three, block two')).toBeInTheDocument();
    expect(outputKinds()).toEqual([
      'assistant_text',
      'log',
      'assistant_text',
      'status',
      'status',
      'assistant_text',
      'assistant_text',
    ]);
    expect(connection()).toHaveAttribute('data-connection', 'live');
  });

  it('backs off exponentially while the task stays active and stops once it settled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderApp(`/tasks/${IDS.task}`);
    const first = await openStream();

    act(() => first.fail(true));
    await waitFor(() => expect(connection()).toHaveTextContent('Reconnecting in 1 s (attempt 1)'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const second = MockEventSource.latest();
    expect(MockEventSource.instances).toHaveLength(2);

    act(() => second.fail(true));
    await waitFor(() => expect(connection()).toHaveTextContent('Reconnecting in 2 s (attempt 2)'));

    detail = makeTaskDetail({ status: 'failed', finishedAt: T0, statusReason: 'claude_exit_nonzero' }, { canRetry: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    const third = MockEventSource.latest();
    expect(MockEventSource.instances).toHaveLength(3);

    act(() => third.fail(true));
    await waitFor(() => expect(connection()).toHaveAttribute('data-connection', 'stopped'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(MockEventSource.instances).toHaveLength(3);
  });

  it('closes the source on `end` and refetches the task detail', async () => {
    renderApp(`/tasks/${IDS.task}`);
    const es = await openStream();
    const before = http.calls('GET', TASK_PATH).length;

    detail = makeTaskDetail({ status: 'completed', finishedAt: T0 }, { canRetry: true });
    act(() => {
      es.emit('claude', claudeEvent(1, { text: 'done' }), '1-0');
      es.emit('end', endEvent({ status: 'completed' }), '2-0');
    });

    expect(es.closed).toBe(true);
    expect(connection()).toHaveAttribute('data-connection', 'ended');
    await waitFor(() => expect(http.calls('GET', TASK_PATH).length).toBeGreaterThan(before));
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(outputKinds()).toEqual(['assistant_text', 'end']);
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('distinguishes the named `error` event from a connection error', async () => {
    renderApp(`/tasks/${IDS.task}`);
    const es = await openStream();
    const before = http.calls('GET', TASK_PATH).length;

    act(() => es.emit('error', streamErrorEvent({ message: 'Redis stream unavailable' }), '5-0'));

    expect(screen.getByText('The live stream reported an error')).toBeInTheDocument();
    expect(screen.getByText(/Redis stream unavailable/)).toBeInTheDocument();
    expect(es.closed).toBe(false);
    expect(connection()).toHaveAttribute('data-connection', 'live');

    // transport error while the browser is still reconnecting by itself: no manual reconnect, no recheck
    act(() => es.fail(false));
    expect(connection()).toHaveAttribute('data-connection', 'reconnecting');
    expect(connection()).toHaveTextContent('Reconnecting…');
    expect(MockEventSource.instances).toHaveLength(1);
    expect(http.calls('GET', TASK_PATH)).toHaveLength(before);

    act(() => es.open());
    expect(connection()).toHaveAttribute('data-connection', 'live');
  });

  it('shows the heartbeat in the live indicator', async () => {
    renderApp(`/tasks/${IDS.task}`);
    const es = await openStream();
    expect(connection()).toHaveTextContent(/^Live$/);

    act(() => es.emit('heartbeat', heartbeatEvent('2026-11-02T10:05:00.000Z')));

    expect(connection()).toHaveAttribute('data-connection', 'live');
    expect(connection()).toHaveTextContent(/^Live · heartbeat /);
    expect(screen.getByText('Waiting for output…')).toBeInTheDocument();
  });
});
