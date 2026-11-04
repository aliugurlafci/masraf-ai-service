import { useMutation, useQueryClient } from '@tanstack/react-query';
import { isSettledStatus } from '@orc/shared';
import type { Task, TaskDetail } from '@orc/shared';
import { useState } from 'react';
import { useApi } from '../../api/ApiContext';
import type { ApiResponse } from '../../api/client';
import { isApiError } from '../../api/errors';
import type { RetryTaskBody } from '../../api/endpoints';
import { queryKeys } from '../../api/queryKeys';
import { Dialog } from '../../components/Dialog';
import { ProblemMessage } from '../../components/ErrorView';
import { Field } from '../../components/ui';
import { utf8Length } from '../../lib/format';

export const CANCEL_REASON_MAX = 500;
export const RETRY_INSTRUCTIONS_MAX_CHARS = 8000;
export const RETRY_INSTRUCTIONS_MAX_BYTES = 24_576;

const RETRY_CONFLICTS: Readonly<Record<string, string>> = {
  task_not_retryable: 'This task cannot be retried in its current state.',
  retry_limit_reached: 'The retry limit for this task has been reached.',
  project_not_ready: 'The project is not ready; sync or fix the project before retrying.',
};

function useDetailUpdater(taskId: string) {
  const queryClient = useQueryClient();
  return (task: Task) => {
    queryClient.setQueryData<ApiResponse<TaskDetail>>(queryKeys.taskDetail(taskId), (prev) =>
      prev ? { ...prev, data: { ...prev.data, task } } : prev,
    );
  };
}

function CancelDialog({
  detail,
  onClose,
  onMessage,
}: {
  detail: TaskDetail;
  onClose: () => void;
  onMessage: (message: string) => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const setTask = useDetailUpdater(detail.task.id);
  const [reason, setReason] = useState('');
  const cancel = useMutation({
    mutationFn: () => api.cancelTask(detail.task.id, reason.trim() || undefined),
    onSuccess: (res) => {
      setTask(res.data);
      onMessage(res.status === 202 ? 'Cancellation requested. The worker is stopping the task.' : 'Task cancelled.');
      void queryClient.invalidateQueries({ queryKey: queryKeys.task(detail.task.id) });
      onClose();
    },
    onError: (error) => {
      if (isApiError(error) && error.code === 'task_not_cancellable') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.task(detail.task.id) });
        onMessage('The task can no longer be cancelled; it has already finished or is being cancelled.');
        onClose();
      }
    },
  });
  return (
    <Dialog title="Cancel task" onClose={onClose} busy={cancel.isPending}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          cancel.mutate();
        }}
      >
        <p>
          Stop <strong>{detail.task.title}</strong>? Running work is terminated and the workspace is kept for inspection.
        </p>
        {isApiError(cancel.error) && cancel.error.code !== 'task_not_cancellable' ? (
          <ProblemMessage error={cancel.error} />
        ) : null}
        <Field label="Reason (optional)" hint={`${reason.length} / ${CANCEL_REASON_MAX}`}>
          {(p) => (
            <textarea {...p} rows={3} maxLength={CANCEL_REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} />
          )}
        </Field>
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={cancel.isPending}>
            Keep running
          </button>
          <button type="submit" className="btn btn-danger" disabled={cancel.isPending}>
            {cancel.isPending ? 'Cancelling…' : 'Cancel task'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function RetryDialog({
  detail,
  etag,
  onClose,
  onMessage,
  onRetried,
}: {
  detail: TaskDetail;
  etag: string | null;
  onClose: () => void;
  onMessage: (message: string) => void;
  onRetried: (task: Task) => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'fresh' | 'continue'>('fresh');
  const [instructions, setInstructions] = useState('');
  const [baseRef, setBaseRef] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const retry = useMutation({
    mutationFn: (body: RetryTaskBody) => api.retryTask(detail.task.id, body, etag),
    onSuccess: (res) => {
      onMessage(`Retry queued as attempt ${res.data.attemptCount}.`);
      onRetried(res.data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.task(detail.task.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
      onClose();
    },
    onError: (error) => {
      if (!isApiError(error)) return;
      if (error.code === 'precondition_failed') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.task(detail.task.id) });
        onMessage('The task changed since it was loaded. Review its current state and retry again.');
        onClose();
        return;
      }
      const message = RETRY_CONFLICTS[error.code];
      if (message !== undefined) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.task(detail.task.id) });
        onMessage(message);
        onClose();
      }
    },
  });

  const bytes = utf8Length(instructions);
  const submit = () => {
    if (instructions.length > RETRY_INSTRUCTIONS_MAX_CHARS || bytes > RETRY_INSTRUCTIONS_MAX_BYTES) {
      setLocalError(
        `Additional instructions are limited to ${RETRY_INSTRUCTIONS_MAX_CHARS} characters and ${RETRY_INSTRUCTIONS_MAX_BYTES} bytes.`,
      );
      return;
    }
    setLocalError(null);
    const body: RetryTaskBody = { mode };
    if (instructions.trim().length > 0) body.additionalInstructions = instructions;
    if (mode === 'fresh' && baseRef.trim().length > 0) body.baseRef = baseRef.trim();
    retry.mutate(body);
  };

  const canContinue = detail.actions.canRetryContinue;
  const problem =
    isApiError(retry.error) && retry.error.code !== 'precondition_failed' && RETRY_CONFLICTS[retry.error.code] === undefined
      ? retry.error
      : null;

  return (
    <Dialog title="Retry task" onClose={onClose} busy={retry.isPending}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {problem ? <ProblemMessage error={problem} /> : null}
        <fieldset className="radio-row">
          <legend>Mode</legend>
          <label>
            <input type="radio" name="retry-mode" value="fresh" checked={mode === 'fresh'} onChange={() => setMode('fresh')} /> Fresh
            attempt (new worktree)
          </label>
          {canContinue ? (
            <label>
              <input
                type="radio"
                name="retry-mode"
                value="continue"
                checked={mode === 'continue'}
                onChange={() => setMode('continue')}
              />{' '}
              Continue the previous Claude session
            </label>
          ) : null}
        </fieldset>
        <Field
          label="Additional instructions (optional)"
          error={localError}
          hint={`${instructions.length} / ${RETRY_INSTRUCTIONS_MAX_CHARS} characters · ${bytes} / ${RETRY_INSTRUCTIONS_MAX_BYTES} bytes`}
        >
          {(p) => (
            <textarea
              {...p}
              rows={5}
              maxLength={RETRY_INSTRUCTIONS_MAX_CHARS}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          )}
        </Field>
        {mode === 'fresh' ? (
          <Field label="Base ref (optional)" hint="Branch, tag or commit; default is the task's base ref.">
            {(p) => <input {...p} value={baseRef} maxLength={200} onChange={(e) => setBaseRef(e.target.value)} />}
          </Field>
        ) : null}
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={retry.isPending}>
            Close
          </button>
          <button type="submit" className="btn btn-primary" disabled={retry.isPending}>
            {retry.isPending ? 'Submitting…' : 'Retry'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Cancel / retry controls driven by the server-computed `TaskDetail.actions` (contract §20.2). */
export function TaskActions({
  detail,
  etag,
  onRetried,
}: {
  detail: TaskDetail;
  etag: string | null;
  onRetried: (task: Task) => void;
}) {
  const [dialog, setDialog] = useState<'cancel' | 'retry' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { task, actions } = detail;
  const cancelRequested = task.cancelRequestedAt !== null && !isSettledStatus(task.status);

  return (
    <div className="task-actions">
      {cancelRequested ? (
        <button type="button" className="btn" disabled>
          Cancel requested
        </button>
      ) : actions.canCancel ? (
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            setMessage(null);
            setDialog('cancel');
          }}
        >
          Cancel
        </button>
      ) : null}
      {actions.canRetry ? (
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setMessage(null);
            setDialog('retry');
          }}
        >
          Retry
        </button>
      ) : null}
      <span className="task-actions-message" role="status" aria-live="polite">
        {message}
      </span>
      {dialog === 'cancel' ? (
        <CancelDialog detail={detail} onClose={() => setDialog(null)} onMessage={setMessage} />
      ) : null}
      {dialog === 'retry' ? (
        <RetryDialog detail={detail} etag={etag} onClose={() => setDialog(null)} onMessage={setMessage} onRetried={onRetried} />
      ) : null}
    </div>
  );
}
