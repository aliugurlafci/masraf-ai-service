// TaskService (contract §2.9, §5): API-side create/cancel/retry + read models with viewer-scoped visibility,
// and the worker-side recovery/reconcile/DLQ operations. Every state change goes through TaskStateStore (one DB
// transaction each); Redis publication and enqueueing happen strictly after commit and never fail the request.
import {
  ConflictError,
  NotFoundError,
  OrcError,
  RETRYABLE_TASK_STATUSES,
  TASK_TEXT_MAX_BYTES,
  ValidationError,
  isActiveStatus,
  isSettledStatus,
  shortKey,
  systemClock,
  toIso,
} from '@orc/shared';
import type {
  AttemptMode,
  AttemptQuery,
  CancelTaskRequest,
  ChangedFile,
  ClaudeSession,
  Clock,
  CreateTaskRequest,
  DiffFile,
  DiffQuery,
  FailureReason,
  LogQuery,
  McpIndexOperation,
  MergeCheck,
  Page,
  PageQuery,
  RetryTaskRequest,
  Task,
  TaskAttempt,
  TaskDetail,
  TaskEvent,
  TaskListQuery,
  TaskLog,
  TaskStatus,
  TestResult,
  TestResultQuery,
  TestRun,
  Uuid,
  Workspace,
} from '@orc/shared';
import { PromptTooLargeError, isCommitSha, isSafeRefName, utf8ByteLength } from '@orc/security';
import { etagToRowVer } from '@orc/database';
import type { Actor, AttemptRecord, Database, TaskRecord } from '@orc/database';
import type { Logger } from '@orc/logger';
import type { ControlChannel } from './control.js';
import type { QueueRegistry } from './queues.js';
import type { TaskStreamPublisher } from './stream.js';
import {
  actorOf,
  auditOf,
  bigIdFromCursor,
  bigIdPage,
  canReadTasks,
  hasPerm,
  keysetFromCursor,
  keysetPage,
  requirePermission,
  taskViewer,
  withoutRowVer,
} from './viewer.js';
import type { RequestContext, Viewer } from './viewer.js';

export interface TaskServiceConfig {
  maxAttemptsPerTask: number;
  maxTimeoutSeconds: number;
  allowedModels: readonly string[];
  defaultModel: string;
  promptMaxChars: number;
  maxAutoRecoveries: number;
  /** WORKSPACE_RETENTION_HOURS (72): RetainUntil of the workspace when the recovery path settles a task. */
  workspaceRetentionHours?: number;
}

export type RecoveryDecision =
  | { kind: 'requeued'; newAttemptId: Uuid }
  | { kind: 'cancelled' }
  | { kind: 'timed_out' }
  | { kind: 'failed'; reason: 'recovery_limit_reached' }
  | { kind: 'noop' };

export interface TaskService {
  create(
    i: CreateTaskRequest,
    v: Viewer,
    ctx: RequestContext,
    idem?: { id: string },
  ): Promise<{ task: Task; attempt: TaskAttempt; enqueued: boolean }>;
  /** NotFoundError if not visible. */
  get(taskId: Uuid, v: Viewer): Promise<{ task: TaskRecord; detail: TaskDetail }>;
  list(q: TaskListQuery, v: Viewer): Promise<Page<Task>>;
  /** created|queued => cancelPending; its ConflictError (worker claimed first) => reload: active => requestCancel
   *  (immediate:false), settled => OrcError('task_not_cancellable') (§5.4, F16). */
  cancel(
    taskId: Uuid,
    i: CancelTaskRequest,
    v: Viewer,
    ctx: RequestContext,
  ): Promise<{ task: Task; immediate: boolean }>;
  /** ifMatch => expectedRowVer (412). */
  retry(
    taskId: Uuid,
    i: RetryTaskRequest,
    v: Viewer,
    ctx: RequestContext,
    ifMatch?: string,
  ): Promise<{ task: Task; attempt: TaskAttempt; enqueued: boolean }>;
  attempts(taskId: Uuid, v: Viewer): Promise<TaskAttempt[]>;
  /** NotFoundError when invisible or not of this task. */
  attempt(taskId: Uuid, attemptId: Uuid, v: Viewer): Promise<TaskAttempt>;
  logs(taskId: Uuid, q: LogQuery, v: Viewer): Promise<Page<TaskLog>>;
  events(taskId: Uuid, q: PageQuery, v: Viewer): Promise<Page<TaskEvent>>;
  tests(taskId: Uuid, q: AttemptQuery, v: Viewer): Promise<TestRun[]>;
  testResults(
    taskId: Uuid,
    testRunId: Uuid,
    q: TestResultQuery,
    v: Viewer,
  ): Promise<Page<TestResult>>;
  changedFiles(taskId: Uuid, q: AttemptQuery, v: Viewer): Promise<ChangedFile[]>;
  diff(taskId: Uuid, q: DiffQuery, v: Viewer): Promise<Page<DiffFile>>;
  patch(
    taskId: Uuid,
    q: AttemptQuery,
    v: Viewer,
  ): Promise<{ gzip: Buffer; byteLength: number; sha256: string; fileName: string }>;
  mergeCheck(taskId: Uuid, q: AttemptQuery, v: Viewer): Promise<MergeCheck>;
  session(taskId: Uuid, q: AttemptQuery, v: Viewer): Promise<ClaudeSession>;
  impact(taskId: Uuid, q: AttemptQuery, v: Viewer): Promise<McpIndexOperation>;
  recoverInterruptedAttempt(i: {
    attemptId: Uuid;
    reason: 'worker_shutdown' | 'worker_lost';
    workerId: string;
  }): Promise<RecoveryDecision>;
  /** queued-reconciler (§6.5): re-adds lost run-attempt jobs, fails exhausted ones, re-adds lost sync jobs. Returns repairs made. */
  reconcileQueued(o: { minAgeMs: number; limit: number }): Promise<number>;
  failUnclaimedAttempt(i: {
    attemptId: Uuid;
    reason: 'queue_exhausted' | 'invalid_job';
    detail: string;
  }): Promise<boolean>;
}

export interface TaskServiceDeps {
  db: Database;
  queues: QueueRegistry;
  publisher: TaskStreamPublisher;
  control: ControlChannel;
  logger: Logger;
  clock?: Clock;
  config: TaskServiceConfig;
}

const DEFAULT_WORKSPACE_RETENTION_HOURS = 72;
const STALE_VALIDATING_PROJECT_MS = 10 * 60_000;
const CHANGED_FILES_MAX = 10_000;
const QUEUE_ACTOR: Actor = { type: 'system', label: 'queue' };

export const toTask = (r: TaskRecord): Task => withoutRowVer(r);
export const toAttempt = (r: AttemptRecord): TaskAttempt => withoutRowVer(r);

function fieldError(path: string, message: string, code = 'custom'): ValidationError {
  return new ValidationError([{ path, message, code }], 'Invalid body');
}

function isRetryable(s: TaskStatus): boolean {
  return (RETRYABLE_TASK_STATUSES as readonly TaskStatus[]).includes(s);
}

/** §5.3 continue mode: reuse a ready/retained workspace, else a new worktree on the kept branch, else impossible. */
export function continueTarget(ws: Workspace | null): { workspaceId: Uuid | null } | null {
  if (!ws) return null;
  if (ws.status === 'ready' || ws.status === 'retained') return { workspaceId: ws.id };
  if (ws.branchName !== null && ws.branchDeletedAt === null && ws.status !== 'error')
    return { workspaceId: null };
  return null;
}

export function createTaskService(deps: TaskServiceDeps): TaskService {
  const { db, queues, publisher, control, logger, config } = deps;
  const clock = deps.clock ?? systemClock;
  const repos = db.repos;
  const retentionHours = config.workspaceRetentionHours ?? DEFAULT_WORKSPACE_RETENTION_HOURS;

  // ---- visibility / authorization -------------------------------------------------------------

  async function visibleTask(taskId: Uuid, v: Viewer): Promise<TaskRecord> {
    if (!canReadTasks(v)) throw new NotFoundError('Task not found');
    const task = await repos.tasks.findVisible(taskId, taskViewer(v));
    if (!task) throw new NotFoundError('Task not found');
    return task;
  }

  function mayAct(v: Viewer, task: TaskRecord, action: 'cancel' | 'retry'): boolean {
    if (v.readOnly) return false;
    if (hasPerm(v, `task:${action}:any`)) return true;
    return task.createdByUserId === v.userId && hasPerm(v, `task:${action}:own`);
  }

  function assertMayAct(v: Viewer, task: TaskRecord, action: 'cancel' | 'retry'): void {
    if (!mayAct(v, task, action))
      throw new OrcError('forbidden', `Not allowed to ${action} this task`);
  }

  async function resolveAttempt(
    task: TaskRecord,
    attemptId: Uuid | undefined,
  ): Promise<AttemptRecord> {
    const id = attemptId ?? task.currentAttemptId;
    if (id === null) throw new NotFoundError('Attempt not found');
    const attempt = await repos.attempts.findById(id);
    if (!attempt || attempt.taskId !== task.id) throw new NotFoundError('Attempt not found');
    return attempt;
  }

  async function reload(taskId: Uuid): Promise<TaskRecord> {
    const task = await repos.tasks.findById(taskId);
    if (!task) throw new NotFoundError('Task not found');
    return task;
  }

  // ---- after-commit side effects (never fail the caller) ---------------------------------------

  async function publishStatus(
    task: TaskRecord,
    previousStatus: TaskStatus | null,
    attemptNumber: number | null,
  ): Promise<void> {
    await publisher.publish(task.id, {
      v: 1,
      type: 'status',
      taskId: task.id,
      attemptId: task.currentAttemptId,
      attemptNumber,
      status: task.status,
      previousStatus,
      reason: task.statusReason,
      detail: task.statusDetail,
      cancelRequested: task.cancelRequestedAt !== null,
      at: toIso(clock.now()),
    });
  }

  async function publishTransition(
    task: TaskRecord,
    previousStatus: TaskStatus | null,
    attemptNumber: number | null,
  ): Promise<void> {
    await publishStatus(task, previousStatus, attemptNumber);
    if (isSettledStatus(task.status)) {
      await publisher.publish(task.id, {
        v: 1,
        type: 'end',
        taskId: task.id,
        attemptId: task.currentAttemptId,
        status: task.status,
        reason: task.statusReason,
        at: toIso(clock.now()),
      });
      await publisher.expireSettled(task.id);
    }
  }

  async function enqueue(task: TaskRecord, attempt: AttemptRecord): Promise<boolean> {
    try {
      await queues.enqueueAttempt({
        v: 1,
        taskId: task.id,
        attemptId: attempt.id,
        attemptNumber: attempt.attemptNumber,
        correlationId: attempt.correlationId ?? task.correlationId,
      });
      return true;
    } catch (err) {
      logger.warn(
        { err, taskId: task.id, attemptId: attempt.id },
        'enqueue failed; the queued reconciler re-adds the job',
      );
      return false;
    }
  }

  async function startedAttempt(
    task: TaskRecord,
    attempt: AttemptRecord,
    previousStatus: TaskStatus,
  ): Promise<boolean> {
    await publisher.persist(task.id);
    await publishStatus(task, previousStatus, attempt.attemptNumber);
    return enqueue(task, attempt);
  }

  async function retainWorkspace(workspaceId: Uuid | null): Promise<void> {
    if (workspaceId === null) return;
    try {
      await repos.workspaces.setStatus(workspaceId, 'retained', {
        retainUntil: new Date(clock.nowMs() + retentionHours * 3_600_000),
      });
    } catch (err) {
      logger.warn({ err, workspaceId }, 'workspace retention update failed');
    }
  }

  // ---- create validation (§3.3 config-dependent rules) -------------------------------------------

  function resolveModel(requested: string | undefined, agentModel: string): string {
    if (requested !== undefined) {
      if (!config.allowedModels.includes(requested))
        throw new OrcError('model_not_allowed', `Model ${requested} is not allowed`);
      return requested;
    }
    if (config.allowedModels.includes(agentModel)) return agentModel;
    if (config.allowedModels.includes(config.defaultModel)) return config.defaultModel;
    throw new OrcError('model_not_allowed', `Model ${agentModel} is not allowed`);
  }

  function assertBaseRef(ref: string | null | undefined, path: string): void {
    if (ref === null || ref === undefined) return;
    if (!isSafeRefName(ref) && !isCommitSha(ref))
      throw fieldError(path, 'Not a valid branch name or commit SHA');
  }

  // ---- cancel helpers ---------------------------------------------------------------------------

  async function requestCancelActive(
    current: TaskRecord,
    v: Viewer,
    actor: Actor,
    ctx: RequestContext,
    reasonText: string | null,
  ): Promise<{ task: Task; immediate: boolean } | 'reload'> {
    if (current.cancelRequestedAt !== null) return { task: toTask(current), immediate: false };
    let updated: TaskRecord;
    try {
      updated = await repos.taskState.requestCancel({
        taskId: current.id,
        actor,
        audit: auditOf(ctx),
        reasonText,
      });
    } catch (err) {
      if (err instanceof ConflictError) return 'reload';
      throw err;
    }
    const attemptId = updated.currentAttemptId;
    if (attemptId !== null && updated.cancelRequestedAt !== null) {
      try {
        await control.publishCancel({
          taskId: updated.id,
          attemptId,
          requestedByUserId: v.userId,
          requestedAt: updated.cancelRequestedAt,
          correlationId: ctx.correlationId,
        });
      } catch (err) {
        logger.warn(
          { err, taskId: updated.id },
          'cancel control publish failed; worker heartbeat poll will observe it',
        );
      }
    }
    await publishStatus(updated, updated.status, null);
    return { task: toTask(updated), immediate: false };
  }

  async function failUnclaimed(i: {
    attemptId: Uuid;
    reason: 'queue_exhausted' | 'invalid_job';
    detail: string;
  }): Promise<boolean> {
    const attempt = await repos.attempts.findById(i.attemptId);
    if (!attempt || attempt.status !== 'queued') return false;
    const task = await repos.tasks.findById(attempt.taskId);
    if (!task || task.status !== 'queued' || task.currentAttemptId !== attempt.id) return false;
    let failed: TaskRecord;
    try {
      failed = await repos.taskState.transition({
        taskId: task.id,
        from: 'queued',
        to: 'failed',
        attemptId: attempt.id,
        attemptStatus: 'failed',
        reason: i.reason,
        detail: i.detail,
        actor: QUEUE_ACTOR,
        correlationId: attempt.correlationId ?? task.correlationId,
      });
    } catch (err) {
      if (err instanceof ConflictError) return false; // claimed or cancelled meanwhile
      throw err;
    }
    await publishTransition(failed, 'queued', attempt.attemptNumber);
    return true;
  }

  // ---- service ----------------------------------------------------------------------------------

  return {
    async create(i, v, ctx, idem) {
      requirePermission(v, 'task:create', { write: true });
      const project = await repos.projects.findById(i.projectId);
      if (!project) throw new NotFoundError('Project not found');
      if (project.status !== 'ready')
        throw new OrcError('project_not_ready', `Project is ${project.status}`);
      const agentId = i.agentId ?? project.defaultAgentId;
      if (agentId === null)
        throw fieldError(
          'body.agentId',
          'agentId is required when the project has no default agent',
        );
      const agent = await repos.agents.findById(agentId);
      if (!agent) throw new NotFoundError('Agent not found');
      if (!agent.isActive) throw new OrcError('agent_inactive', 'Agent is inactive');

      const model = resolveModel(i.model, agent.model);
      if (i.prompt.length > config.promptMaxChars) {
        throw fieldError(
          'body.prompt',
          `Prompt must be at most ${config.promptMaxChars} characters`,
          'too_big',
        );
      }
      const acceptanceCriteria = i.acceptanceCriteria ?? null;
      const scope = i.scope ?? null;
      const textBytes =
        utf8ByteLength(i.title) +
        utf8ByteLength(i.prompt) +
        utf8ByteLength(acceptanceCriteria ?? '') +
        utf8ByteLength(scope ?? '');
      if (textBytes > TASK_TEXT_MAX_BYTES) {
        throw new PromptTooLargeError(
          `Task text is ${textBytes} UTF-8 bytes (max ${TASK_TEXT_MAX_BYTES})`,
        );
      }
      const baseRef = i.baseRef ?? null;
      assertBaseRef(baseRef, 'body.baseRef');
      const maxTimeout = Math.min(config.maxTimeoutSeconds, agent.maxTimeoutSeconds);
      let timeoutSeconds: number;
      if (i.timeoutSeconds !== undefined) {
        if (i.timeoutSeconds < 60 || i.timeoutSeconds > maxTimeout) {
          throw fieldError(
            'body.timeoutSeconds',
            `timeoutSeconds must be 60..${maxTimeout}`,
            'too_big',
          );
        }
        timeoutSeconds = i.timeoutSeconds;
      } else {
        timeoutSeconds = Math.max(60, Math.min(project.defaultTimeoutSeconds, maxTimeout));
      }
      let maxBudgetUsd = i.maxBudgetUsd ?? null;
      if (
        maxBudgetUsd !== null &&
        agent.maxBudgetUsd !== null &&
        maxBudgetUsd > agent.maxBudgetUsd
      ) {
        throw fieldError(
          'body.maxBudgetUsd',
          `maxBudgetUsd must be <= ${agent.maxBudgetUsd}`,
          'too_big',
        );
      }
      maxBudgetUsd ??= agent.maxBudgetUsd;

      const { task, attempt } = await repos.taskState.createTask({
        task: {
          projectId: project.id,
          agentId: agent.id,
          createdByUserId: v.userId,
          title: i.title,
          prompt: i.prompt,
          acceptanceCriteria,
          scope,
          baseRef,
          model,
          effort: i.effort ?? agent.effort,
          timeoutSeconds,
          maxBudgetUsd,
          correlationId: ctx.correlationId,
        },
        actor: actorOf(v),
        audit: auditOf(ctx),
        ...(idem
          ? {
              idempotency: {
                id: idem.id,
                responseFactory: (t: TaskRecord) => ({
                  status: 202,
                  headers: {
                    'Content-Type': 'application/json; charset=utf-8',
                    Location: `/api/v1/tasks/${t.id}`,
                  },
                  body: JSON.stringify(toTask(t)),
                }),
              },
            }
          : {}),
      });
      const enqueued = await startedAttempt(task, attempt, 'created');
      return { task: toTask(task), attempt: toAttempt(attempt), enqueued };
    },

    async get(taskId, v) {
      const task = await visibleTask(taskId, v);
      const [attempt, project, agent, creator] = await Promise.all([
        task.currentAttemptId === null
          ? Promise.resolve(null)
          : repos.attempts.findById(task.currentAttemptId),
        repos.projects.findById(task.projectId),
        repos.agents.findById(task.agentId),
        repos.users.findById(task.createdByUserId),
      ]);
      if (!project || !agent || !creator)
        throw new OrcError('internal_error', 'Task references a missing row');
      const workspace = attempt?.workspaceId
        ? await repos.workspaces.findById(attempt.workspaceId)
        : null;
      const canCancel =
        mayAct(v, task, 'cancel') &&
        (task.status === 'created' ||
          task.status === 'queued' ||
          (isActiveStatus(task.status) && task.cancelRequestedAt === null));
      const canRetry =
        mayAct(v, task, 'retry') &&
        isRetryable(task.status) &&
        task.attemptCount < config.maxAttemptsPerTask &&
        project.status === 'ready';
      const detail: TaskDetail = {
        task: toTask(task),
        currentAttempt: attempt ? toAttempt(attempt) : null,
        project: { id: project.id, name: project.name, status: project.status },
        agent: { id: agent.id, name: agent.name, title: agent.title },
        createdBy: { id: creator.id, username: creator.username, displayName: creator.displayName },
        actions: {
          canCancel,
          canRetry,
          canRetryContinue: canRetry && continueTarget(workspace) !== null,
        },
      };
      return { task, detail };
    },

    async list(q, v) {
      if (!canReadTasks(v)) throw new OrcError('forbidden', 'Missing permission task:read:own');
      const canReadAny = hasPerm(v, 'task:read:any');
      if (q.createdBy !== undefined && !canReadAny) {
        throw new OrcError('forbidden', 'Filtering by createdBy requires task:read:any');
      }
      const owner = canReadAny ? q.createdBy : v.userId;
      const filters = {
        projectId: q.projectId ?? null,
        status: q.status ?? null,
        owner: owner ?? null,
      };
      const after = keysetFromCursor(q.cursor, filters);
      const rows = await repos.tasks.list({
        limit: q.limit,
        ...(after ? { after } : {}),
        ...(owner !== undefined ? { ownerUserId: owner } : {}),
        ...(q.projectId !== undefined ? { projectId: q.projectId } : {}),
        ...(q.status !== undefined ? { statuses: q.status } : {}),
      });
      return keysetPage(rows, q.limit, filters, toTask);
    },

    async cancel(taskId, i, v, ctx) {
      let current = await visibleTask(taskId, v);
      assertMayAct(v, current, 'cancel');
      const actor = actorOf(v);
      const reasonText = i.reason !== undefined && i.reason !== '' ? i.reason : null;
      for (let round = 0; round < 4; round += 1) {
        const from = current.status;
        if (from === 'created' || from === 'queued') {
          let cancelled: TaskRecord;
          try {
            cancelled = await repos.taskState.cancelPending({
              taskId,
              from,
              actor,
              audit: auditOf(ctx),
              reasonText,
            });
          } catch (err) {
            if (!(err instanceof ConflictError)) throw err;
            current = await reload(taskId); // the worker claimed first (F16)
            continue;
          }
          if (cancelled.currentAttemptId !== null) {
            try {
              await queues.removePendingAttempt(cancelled.currentAttemptId);
            } catch (err) {
              logger.warn(
                { err, taskId },
                'queued job removal failed; the claim no-ops on a cancelled attempt',
              );
            }
          }
          await publishTransition(cancelled, from, null);
          return { task: toTask(cancelled), immediate: true };
        }
        if (isActiveStatus(from)) {
          const result = await requestCancelActive(current, v, actor, ctx, reasonText);
          if (result !== 'reload') return result;
          current = await reload(taskId);
          continue;
        }
        throw new OrcError('task_not_cancellable', `Task is ${from}`);
      }
      throw new ConflictError('Task status keeps changing; try again');
    },

    async retry(taskId, i, v, ctx, ifMatch) {
      const task = await visibleTask(taskId, v);
      assertMayAct(v, task, 'retry');
      const expectedRowVer = ifMatch === undefined ? undefined : etagToRowVer(ifMatch);
      if (!isRetryable(task.status))
        throw new OrcError('task_not_retryable', `Task is ${task.status}`);
      if (task.attemptCount >= config.maxAttemptsPerTask) {
        throw new OrcError('retry_limit_reached', `Task already has ${task.attemptCount} attempts`);
      }
      if (task.currentAttemptId === null)
        throw new OrcError('task_not_retryable', 'Task has no attempt');
      const project = await repos.projects.findById(task.projectId);
      if (!project || project.status !== 'ready')
        throw new OrcError('project_not_ready', 'Project is not ready');
      const mode: AttemptMode = i.mode;
      let workspaceId: Uuid | null = null;
      let baseRefOverride: string | null = null;
      if (mode === 'continue') {
        if (i.baseRef !== undefined)
          throw fieldError('body.baseRef', 'baseRef is only allowed with mode fresh');
        const previous = await repos.attempts.findById(task.currentAttemptId);
        const ws = previous?.workspaceId
          ? await repos.workspaces.findById(previous.workspaceId)
          : null;
        const target = continueTarget(ws);
        if (!target)
          throw new OrcError(
            'task_not_retryable',
            'The previous attempt left no workspace or branch to continue',
          );
        workspaceId = target.workspaceId;
      } else {
        baseRefOverride = i.baseRef ?? null;
        assertBaseRef(baseRefOverride, 'body.baseRef');
      }
      let created: { task: TaskRecord; attempt: AttemptRecord };
      try {
        created = await repos.taskState.createAttempt({
          taskId,
          from: task.status,
          ...(expectedRowVer !== undefined ? { expectedRowVer } : {}),
          trigger: 'user_retry',
          mode,
          previousAttemptId: task.currentAttemptId,
          workspaceId,
          baseRefOverride,
          additionalInstructions: i.additionalInstructions ?? null,
          actor: actorOf(v),
          audit: auditOf(ctx),
          correlationId: ctx.correlationId,
        });
      } catch (err) {
        if (err instanceof ConflictError) {
          const now = await reload(taskId);
          if (!isRetryable(now.status))
            throw new OrcError('task_not_retryable', `Task is ${now.status}`, { cause: err });
        }
        throw err;
      }
      const enqueued = await startedAttempt(created.task, created.attempt, task.status);
      return { task: toTask(created.task), attempt: toAttempt(created.attempt), enqueued };
    },

    async attempts(taskId, v) {
      const task = await visibleTask(taskId, v);
      return (await repos.attempts.listByTask(task.id)).map(toAttempt);
    },

    async attempt(taskId, attemptId, v) {
      const task = await visibleTask(taskId, v);
      return toAttempt(await resolveAttempt(task, attemptId));
    },

    async logs(taskId, q, v) {
      const task = await visibleTask(taskId, v);
      const attempt = await resolveAttempt(task, q.attemptId);
      const rows = await repos.taskLogs.listByAttempt({
        attemptId: attempt.id,
        ...(q.stream !== undefined ? { stream: q.stream } : {}),
        ...(q.afterSeq >= 0 ? { afterSeq: q.afterSeq } : {}),
        limit: q.limit + 1,
      });
      const items = rows.slice(0, q.limit);
      const last = items[items.length - 1];
      return { items, nextCursor: rows.length > q.limit && last ? String(last.seq) : null };
    },

    async events(taskId, q, v) {
      const task = await visibleTask(taskId, v);
      const filters = { taskId: task.id };
      const afterId = bigIdFromCursor(q.cursor, filters);
      const rows = await repos.taskEvents.listByTask({
        taskId: task.id,
        ...(afterId !== undefined ? { afterId } : {}),
        limit: q.limit + 1,
      });
      return bigIdPage(rows, q.limit, filters, (e) => e);
    },

    async tests(taskId, q, v) {
      const task = await visibleTask(taskId, v);
      const attempt = await resolveAttempt(task, q.attemptId);
      return repos.testRuns.listByAttempt(attempt.id);
    },

    async testResults(taskId, testRunId, q, v) {
      const task = await visibleTask(taskId, v);
      const attempts = await repos.attempts.listByTask(task.id);
      const runs = await Promise.all(attempts.map((a) => repos.testRuns.listByAttempt(a.id)));
      if (!runs.some((list) => list.some((r) => r.id === testRunId)))
        throw new NotFoundError('Test run not found');
      const filters = { testRunId, status: q.status ?? null };
      const afterId = bigIdFromCursor(q.cursor, filters);
      const rows = await repos.testRuns.listResults({
        testRunId,
        ...(q.status !== undefined ? { status: q.status } : {}),
        ...(afterId !== undefined ? { afterId } : {}),
        limit: q.limit + 1,
      });
      return bigIdPage(rows, q.limit, filters, (r) => r);
    },

    async changedFiles(taskId, q, v) {
      const task = await visibleTask(taskId, v);
      const attempt = await resolveAttempt(task, q.attemptId);
      const rows = await repos.changedFiles.listByAttempt({
        attemptId: attempt.id,
        includePatch: false,
        limit: CHANGED_FILES_MAX,
      });
      return rows.map(({ patch: _patch, ...file }) => file);
    },

    async diff(taskId, q, v) {
      const task = await visibleTask(taskId, v);
      const attempt = await resolveAttempt(task, q.attemptId);
      const toDiff = (row: ChangedFile & { patch?: string | null }): DiffFile => ({
        ...row,
        patch: row.patch ?? null,
      });
      if (q.path !== undefined) {
        const all = await repos.changedFiles.listByAttempt({
          attemptId: attempt.id,
          includePatch: false,
          limit: CHANGED_FILES_MAX,
        });
        const match = all.find((f) => f.path === q.path);
        if (!match) return { items: [], nextCursor: null };
        const before = BigInt(match.id) - 1n;
        const rows = await repos.changedFiles.listByAttempt({
          attemptId: attempt.id,
          includePatch: true,
          ...(before > 0n ? { afterId: before.toString() } : {}),
          limit: 1,
        });
        return { items: rows.filter((r) => r.id === match.id).map(toDiff), nextCursor: null };
      }
      const filters = { attemptId: attempt.id };
      const afterId = bigIdFromCursor(q.cursor, filters);
      const rows = await repos.changedFiles.listByAttempt({
        attemptId: attempt.id,
        includePatch: true,
        ...(afterId !== undefined ? { afterId } : {}),
        limit: q.limit + 1,
      });
      return bigIdPage(rows, q.limit, filters, toDiff);
    },

    async patch(taskId, q, v) {
      const task = await visibleTask(taskId, v);
      const attempt = await resolveAttempt(task, q.attemptId);
      const meta = await repos.patches.getMeta(attempt.id);
      if (!meta || meta.tooLarge || meta.purged)
        throw new OrcError('patch_unavailable', 'Patch not available');
      const gzip = await repos.patches.getContent(attempt.id);
      if (!gzip) throw new OrcError('patch_unavailable', 'Patch not available');
      return {
        gzip,
        byteLength: meta.byteLength,
        sha256: meta.sha256,
        fileName: `task-${shortKey(task.id, 8)}-a${attempt.attemptNumber}.patch`,
      };
    },

    async mergeCheck(taskId, q, v) {
      const task = await visibleTask(taskId, v);
      const attempt = await resolveAttempt(task, q.attemptId);
      if (!attempt.mergeCheck)
        throw new OrcError('merge_check_unavailable', 'Merge check not available');
      return attempt.mergeCheck;
    },

    async session(taskId, q, v) {
      const task = await visibleTask(taskId, v);
      const attempt = await resolveAttempt(task, q.attemptId);
      const session = await repos.claudeSessions.findByAttempt(attempt.id);
      if (!session) throw new NotFoundError('Claude session not found');
      return session;
    },

    async impact(taskId, q, v) {
      const task = await visibleTask(taskId, v);
      const attempt = await resolveAttempt(task, q.attemptId);
      const op = await repos.mcpOperations.findLatest({
        projectId: task.projectId,
        kind: 'impact_analysis',
        attemptId: attempt.id,
      });
      if (!op) throw new NotFoundError('Impact analysis not found');
      return op;
    },

    // ---- worker-side operations ---------------------------------------------------------------

    async recoverInterruptedAttempt(i) {
      const attempt = await repos.attempts.findById(i.attemptId);
      if (!attempt || (attempt.status !== 'active' && attempt.status !== 'queued'))
        return { kind: 'noop' };
      const task = await repos.tasks.findById(attempt.taskId);
      if (!task || task.currentAttemptId !== attempt.id || !isActiveStatus(task.status))
        return { kind: 'noop' };
      const actor: Actor = { type: 'worker', workerId: i.workerId };
      const correlationId = attempt.correlationId ?? task.correlationId;
      const from = task.status;

      let settle: {
        to: 'cancelled' | 'timed_out' | 'failed';
        reason: FailureReason;
        decision: RecoveryDecision;
      } | null = null;
      if (task.cancelRequestedAt !== null) {
        settle = { to: 'cancelled', reason: 'cancelled_by_user', decision: { kind: 'cancelled' } };
      } else if (attempt.deadlineAt !== null && clock.nowMs() >= Date.parse(attempt.deadlineAt)) {
        settle = { to: 'timed_out', reason: 'timeout', decision: { kind: 'timed_out' } };
      } else if (task.autoRecoveryCount >= config.maxAutoRecoveries) {
        settle = {
          to: 'failed',
          reason: 'recovery_limit_reached',
          decision: { kind: 'failed', reason: 'recovery_limit_reached' },
        };
      }

      try {
        if (settle) {
          const s = settle;
          // The settle and its `task.recovered` audit row (§15.6: every infra recovery decision) commit together.
          const settled = await db.transaction(
            async (t) => {
              const row = await t.repos.taskState.transition({
                taskId: task.id,
                from,
                to: s.to,
                attemptId: attempt.id,
                attemptStatus: 'interrupted',
                reason: s.reason,
                detail: `attempt interrupted (${i.reason})`,
                actor,
                correlationId,
                data: { interruption: i.reason, workerId: i.workerId },
              });
              await t.repos.audit.insert({
                action: 'task.recovered',
                actor,
                entityType: 'attempt',
                entityId: attempt.id,
                outcome: 'success',
                detail: {
                  taskId: task.id,
                  reason: i.reason,
                  decision: s.decision.kind,
                  status: s.to,
                  autoRecoveryCount: task.autoRecoveryCount,
                },
                correlationId,
              });
              return row;
            },
            { name: 'task.recoverSettle' },
          );
          await retainWorkspace(attempt.workspaceId);
          await publishTransition(settled, from, attempt.attemptNumber);
          return settle.decision;
        }
        const created = await repos.taskState.createAttempt({
          taskId: task.id,
          from,
          trigger: 'infra_recovery',
          mode: 'resume',
          previousAttemptId: attempt.id,
          previousAttemptFinalStatus: 'interrupted',
          interruptionReason: i.reason,
          workspaceId: attempt.workspaceId,
          baseRefOverride: attempt.baseRefOverride,
          additionalInstructions: attempt.additionalInstructions,
          actor,
          audit: { correlationId },
          correlationId,
        });
        await startedAttempt(created.task, created.attempt, from);
        return { kind: 'requeued', newAttemptId: created.attempt.id };
      } catch (err) {
        // The pipeline or another recoverer settled/requeued the task first.
        if (err instanceof ConflictError) return { kind: 'noop' };
        throw err;
      }
    },

    async reconcileQueued(o) {
      let repaired = 0;
      const rows = await repos.tasks.findQueuedForReconcile(o.minAgeMs, o.limit);
      for (const row of rows) {
        try {
          const state = await queues.jobState(row.attemptId);
          if (state === 'unknown') {
            await queues.enqueueAttempt({
              v: 1,
              taskId: row.taskId,
              attemptId: row.attemptId,
              attemptNumber: row.attemptNumber,
              correlationId: row.correlationId,
            });
            repaired += 1;
          } else if (state === 'completed' || state === 'failed') {
            const failed = await failUnclaimed({
              attemptId: row.attemptId,
              reason: 'queue_exhausted',
              detail: `run-attempt job is ${state} while the attempt is still queued`,
            });
            if (failed) repaired += 1;
          }
        } catch (err) {
          logger.warn(
            { err, taskId: row.taskId, attemptId: row.attemptId },
            'queued reconcile failed for attempt',
          );
        }
      }
      const staleBefore = clock.nowMs() - STALE_VALIDATING_PROJECT_MS;
      const validating = await repos.projects.list({ limit: o.limit, status: 'validating' });
      for (const project of validating) {
        if (Date.parse(project.updatedAt) >= staleBefore) continue;
        try {
          if ((await queues.projectJobState(`sync-${project.id}`)) !== 'unknown') continue;
          const res = await queues.enqueueProjectJob({
            v: 1,
            kind: 'sync',
            projectId: project.id,
            requestedByUserId: null,
            correlationId: null,
          });
          if (!res.deduplicated) repaired += 1;
        } catch (err) {
          logger.warn({ err, projectId: project.id }, 'queued reconcile failed for project sync');
        }
      }
      return repaired;
    },

    failUnclaimedAttempt: failUnclaimed,
  };
}
