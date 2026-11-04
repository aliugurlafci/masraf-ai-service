import { useQueryClient } from '@tanstack/react-query';
import { isSettledStatus } from '@orc/shared';
import type { StatusEventPayload, TaskDetail } from '@orc/shared';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useApi } from '../../api/ApiContext';
import type { ApiResponse } from '../../api/client';
import { isApiError } from '../../api/errors';
import { queryKeys } from '../../api/queryKeys';
import { ME_QUERY_KEY } from '../../auth/session';
import { TaskStreamController } from './taskStream';
import type { StreamState, TaskCheckOutcome } from './taskStream';

/**
 * Live stream for one task page. `attemptKey` (the current attempt id) re-opens the EventSource when
 * a retry created a new attempt after the previous stream ended (contract §20.2). The stream opens
 * only once the task detail loaded (`enabled`).
 */
export function useTaskStream(taskId: string, attemptKey: string | null, enabled: boolean): StreamState {
  const api = useApi();
  const queryClient = useQueryClient();

  const [controller] = useState(
    () =>
      new TaskStreamController({
        taskId,
        createSource: (url) => new EventSource(url),
        checkTask: async (): Promise<TaskCheckOutcome> => {
          try {
            const res = await api.getTask(taskId);
            queryClient.setQueryData<ApiResponse<TaskDetail>>(queryKeys.taskDetail(taskId), res);
            return isSettledStatus(res.data.task.status) ? 'settled' : 'active';
          } catch (error) {
            if (isApiError(error) && error.status === 401) return 'unauthenticated';
            if (isApiError(error) && error.status === 404) return 'not_found';
            return 'error';
          }
        },
        onStatus: (event: StatusEventPayload) => {
          const cached = queryClient.getQueryData<ApiResponse<TaskDetail>>(queryKeys.taskDetail(taskId));
          const task = cached?.data.task;
          if (!task || task.status !== event.status || (event.attemptId !== null && task.currentAttemptId !== event.attemptId)) {
            void queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) });
          }
        },
        onEnd: () => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) });
        },
        onUnauthenticated: () => {
          void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
        },
      }),
  );

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    controller.start();
    return () => controller.stop();
  }, [controller, enabled]);

  const previousAttempt = useRef(attemptKey);
  useEffect(() => {
    if (previousAttempt.current !== attemptKey) {
      previousAttempt.current = attemptKey;
      const state = controller.getSnapshot();
      if (state.connection === 'ended' || state.connection === 'stopped') {
        controller.reopen();
      }
    }
  }, [attemptKey, controller]);

  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
