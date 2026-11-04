import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TaskDetail } from '@orc/shared';
import { MockEventSource, installEventSource } from '../../test/eventSource';
import { CSRF_TOKEN, IDS, T0, endEvent, makeAttempt, makeMe, makeTask, makeTaskDetail } from '../../test/fixtures';
import { installFetch, json, problem } from '../../test/http';
import type { FetchMock } from '../../test/http';
import { renderApp } from '../../test/render';

const TASK_PATH = `/api/v1/tasks/${IDS.task}`;

describe('task actions (contract §20.2)', () => {
  let http: FetchMock;
  let detail: TaskDetail;
  let etag: string;

  beforeEach(() => {
    http = installFetch();
    installEventSource();
    etag = '"rv-1"';
    detail = makeTaskDetail({ status: 'running' }, { canCancel: true });
    http.on('GET', '/api/v1/auth/me', json(makeMe('operator')));
    http.on('GET', TASK_PATH, () => json(detail, 200, { ETag: etag }));
    http.on('GET', `${TASK_PATH}/attempts`, () =>
      json(
        detail.task.currentAttemptId === IDS.attempt2
          ? [makeAttempt({ status: 'failed', endedAt: T0 }), makeAttempt({ id: IDS.attempt2, attemptNumber: 2, trigger: 'user_retry' })]
          : [makeAttempt()],
      ),
    );
  });

  async function renderTask(): Promise<void> {
    renderApp(`/tasks/${IDS.task}`);
    expect(await screen.findByRole('heading', { name: 'Fix invoice rounding' })).toBeInTheDocument();
  }

  describe('visibility per actions and status', () => {
    it('renders only Cancel for an active task that can be cancelled', async () => {
      await renderTask();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    });

    it('renders only Retry for a failed task that can be retried', async () => {
      detail = makeTaskDetail({ status: 'failed', finishedAt: T0 }, { canRetry: true });
      await renderTask();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    });

    it('shows a disabled "Cancel requested" state while a cancellation is pending', async () => {
      detail = makeTaskDetail({ status: 'running', cancelRequestedAt: T0, cancelRequestedByUserId: IDS.user }, { canCancel: true });
      await renderTask();
      expect(screen.getByRole('button', { name: 'Cancel requested' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    });

    it('renders no action when the server allows none (e.g. a completed task or missing permission)', async () => {
      detail = makeTaskDetail({ status: 'completed', finishedAt: T0 });
      await renderTask();
      expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Cancel requested' })).not.toBeInTheDocument();
    });

    it('offers the continue mode only with canRetryContinue', async () => {
      detail = makeTaskDetail({ status: 'failed', finishedAt: T0 }, { canRetry: true, canRetryContinue: false });
      const { user } = renderApp(`/tasks/${IDS.task}`);
      await user.click(await screen.findByRole('button', { name: 'Retry' }));
      const dialog = screen.getByRole('dialog', { name: 'Retry task' });
      expect(within(dialog).getByRole('radio', { name: /Fresh attempt/ })).toBeChecked();
      expect(within(dialog).queryByRole('radio', { name: /Continue the previous Claude session/ })).not.toBeInTheDocument();
    });
  });

  describe('cancel', () => {
    it('sends the reason with the CSRF header and reports 202 as requested', async () => {
      http.on('POST', `${TASK_PATH}/cancel`, () => {
        detail = makeTaskDetail(
          { status: 'running', cancelRequestedAt: T0, cancelRequestedByUserId: IDS.user },
          { canCancel: true },
        );
        return json(detail.task, 202);
      });
      const { user } = renderApp(`/tasks/${IDS.task}`);

      await user.click(await screen.findByRole('button', { name: 'Cancel' }));
      const dialog = screen.getByRole('dialog', { name: 'Cancel task' });
      await user.type(within(dialog).getByLabelText('Reason (optional)'), 'wrong branch');
      await user.click(within(dialog).getByRole('button', { name: 'Cancel task' }));

      expect(await screen.findByText('Cancellation requested. The worker is stopping the task.')).toBeInTheDocument();
      const [req] = http.calls('POST', `${TASK_PATH}/cancel`);
      expect(req?.body).toEqual({ reason: 'wrong branch' });
      expect(req?.headers.get('X-CSRF-Token')).toBe(CSRF_TOKEN);
      expect(await screen.findByRole('button', { name: 'Cancel requested' })).toBeDisabled();
    });

    it('updates the status immediately on 200', async () => {
      detail = makeTaskDetail({ status: 'queued', currentAttemptId: null, startedAt: null }, { canCancel: true });
      http.on('POST', `${TASK_PATH}/cancel`, () => {
        detail = makeTaskDetail({ status: 'cancelled', currentAttemptId: null, startedAt: null, finishedAt: T0, statusReason: 'cancelled_by_user' });
        return json(detail.task, 200);
      });
      const { user } = renderApp(`/tasks/${IDS.task}`);

      await user.click(await screen.findByRole('button', { name: 'Cancel' }));
      await user.click(within(screen.getByRole('dialog', { name: 'Cancel task' })).getByRole('button', { name: 'Cancel task' }));

      expect(await screen.findByText('Task cancelled.')).toBeInTheDocument();
      expect(http.calls('POST', `${TASK_PATH}/cancel`)[0]?.body).toEqual({});
      const header = screen.getByRole('heading', { name: 'Fix invoice rounding' }).parentElement as HTMLElement;
      expect(header.querySelector(':scope > [data-status]')).toHaveAttribute('data-status', 'cancelled');
      expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    });

    it('refetches and explains 409 task_not_cancellable', async () => {
      http.on('POST', `${TASK_PATH}/cancel`, () => {
        detail = makeTaskDetail({ status: 'completed', finishedAt: T0 });
        return problem(409, 'task_not_cancellable', 'Task cannot be cancelled');
      });
      const { user } = renderApp(`/tasks/${IDS.task}`);
      await user.click(await screen.findByRole('button', { name: 'Cancel' }));
      const before = http.calls('GET', TASK_PATH).length;
      await user.click(within(screen.getByRole('dialog', { name: 'Cancel task' })).getByRole('button', { name: 'Cancel task' }));

      expect(
        await screen.findByText('The task can no longer be cancelled; it has already finished or is being cancelled.'),
      ).toBeInTheDocument();
      await waitFor(() => expect(http.calls('GET', TASK_PATH).length).toBeGreaterThan(before));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument());
    });
  });

  describe('retry', () => {
    beforeEach(() => {
      detail = makeTaskDetail({ status: 'failed', finishedAt: T0, statusReason: 'test_failed' }, { canRetry: true, canRetryContinue: true });
    });

    it('sends If-Match and CSRF, then switches to the new attempt with a new EventSource on 202', async () => {
      http.on('POST', `${TASK_PATH}/retry`, () => {
        detail = makeTaskDetail(
          { status: 'queued', currentAttemptId: IDS.attempt2, attemptCount: 2, finishedAt: null },
          { canCancel: true },
        );
        etag = '"rv-2"';
        return json(detail.task, 202, { Location: TASK_PATH });
      });
      const { user } = renderApp(`/tasks/${IDS.task}`);
      await screen.findByRole('button', { name: 'Retry' });
      await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
      const first = MockEventSource.latest();
      act(() => {
        first.open();
        first.emit('end', endEvent({ status: 'failed', reason: 'test_failed' }), '9-0');
      });
      expect(first.closed).toBe(true);

      await user.click(screen.getByRole('button', { name: 'Retry' }));
      const dialog = screen.getByRole('dialog', { name: 'Retry task' });
      await user.type(within(dialog).getByLabelText('Additional instructions (optional)'), 'Run the tests first');
      await user.type(within(dialog).getByLabelText('Base ref (optional)'), ' release/1.2 ');
      await user.click(within(dialog).getByRole('button', { name: 'Retry' }));

      expect(await screen.findByText('Retry queued as attempt 2.')).toBeInTheDocument();
      const [req] = http.calls('POST', `${TASK_PATH}/retry`);
      expect(req?.headers.get('If-Match')).toBe('"rv-1"');
      expect(req?.headers.get('X-CSRF-Token')).toBe(CSRF_TOKEN);
      expect(req?.body).toEqual({ mode: 'fresh', additionalInstructions: 'Run the tests first', baseRef: 'release/1.2' });

      await waitFor(() => expect(MockEventSource.instances).toHaveLength(2));
      expect(MockEventSource.latest().closed).toBe(false);
      expect(await screen.findByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });

    it('sends mode continue without baseRef', async () => {
      http.on('POST', `${TASK_PATH}/retry`, () => json(makeTask({ status: 'queued', attemptCount: 2 }), 202));
      const { user } = renderApp(`/tasks/${IDS.task}`);
      await user.click(await screen.findByRole('button', { name: 'Retry' }));
      const dialog = screen.getByRole('dialog', { name: 'Retry task' });
      await user.click(within(dialog).getByRole('radio', { name: /Continue the previous Claude session/ }));
      expect(within(dialog).queryByLabelText('Base ref (optional)')).not.toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Retry' }));

      await screen.findByText('Retry queued as attempt 2.');
      expect(http.calls('POST', `${TASK_PATH}/retry`)[0]?.body).toEqual({ mode: 'continue' });
    });

    it('refetches and asks again on 412 precondition_failed', async () => {
      http.on('POST', `${TASK_PATH}/retry`, problem(412, 'precondition_failed', 'Precondition failed'));
      const { user } = renderApp(`/tasks/${IDS.task}`);
      await user.click(await screen.findByRole('button', { name: 'Retry' }));
      const before = http.calls('GET', TASK_PATH).length;
      await user.click(within(screen.getByRole('dialog', { name: 'Retry task' })).getByRole('button', { name: 'Retry' }));

      expect(
        await screen.findByText('The task changed since it was loaded. Review its current state and retry again.'),
      ).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await waitFor(() => expect(http.calls('GET', TASK_PATH).length).toBeGreaterThan(before));
    });

    it.each([
      ['task_not_retryable', 'This task cannot be retried in its current state.'],
      ['retry_limit_reached', 'The retry limit for this task has been reached.'],
      ['project_not_ready', 'The project is not ready; sync or fix the project before retrying.'],
    ])('explains 409 %s', async (code, message) => {
      http.on('POST', `${TASK_PATH}/retry`, problem(409, code, 'Conflict'));
      const { user } = renderApp(`/tasks/${IDS.task}`);
      await user.click(await screen.findByRole('button', { name: 'Retry' }));
      await user.click(within(screen.getByRole('dialog', { name: 'Retry task' })).getByRole('button', { name: 'Retry' }));

      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(MockEventSource.instances).toHaveLength(1);
    });
  });
});
