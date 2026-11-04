// TaskStateStore: every task-status mutation is ONE transaction:
// Tasks CAS update + TaskAttempts update + TaskEvents insert(s) + AuditLogs insert(s) (contract §2.5, §5.1-§5.2).
import {
  ACTIVE_TASK_STATUSES,
  ConflictError,
  InvalidTransitionError,
  NotFoundError,
  OrcError,
  PreconditionFailedError,
  RETRYABLE_TASK_STATUSES,
  assertTransition,
  attemptStatusForSettled,
  isActiveStatus,
  isSettledStatus,
} from '@orc/shared';
import type { AttemptStatus, TaskStatus, Uuid } from '@orc/shared';
import { utf8ByteLength } from '@orc/security';
import { T, first, run } from '../sql.js';
import type { Param, RepoContext } from '../sql.js';
import { rowVerToBuffer } from '../rowver.js';
import type { Actor, AttemptRecord, TaskRecord, TaskStateStore } from '../types.js';
import { actorColumns, auditContextOf, eventActor, insertAudit, insertEvent, maskedText } from './common.js';
import { IDEMPOTENCY_COMPLETE_SQL, completeIdempotencyParams } from './identity.js';
import { mapAttempt, mapTask } from './mappers.js';

const DETAIL_MAX_CHARS = 2000;

const TASK_EXISTS = 'SELECT Status, CancelRequestedAt FROM orc.Tasks WHERE Id = @id;';
const TASK_SELECT = 'SELECT * FROM orc.Tasks WHERE Id = @id;';

const TASK_INSERT = `INSERT INTO orc.Tasks
  (ProjectId, AgentId, CreatedByUserId, Title, Prompt, AcceptanceCriteria, Scope, BaseRef, Model, Effort,
   TimeoutSeconds, MaxBudgetUsd, Status, CorrelationId)
OUTPUT inserted.*
VALUES
  (@projectId, @agentId, @createdByUserId, @title, @prompt, @acceptanceCriteria, @scope, @baseRef, @model, @effort,
   @timeoutSeconds, @maxBudgetUsd, 'created', @correlationId);`;

const ATTEMPT_INSERT = `INSERT INTO orc.TaskAttempts
  (TaskId, AttemptNumber, TriggerKind, Mode, PreviousAttemptId, Status, AdditionalInstructions, BaseRefOverride,
   WorkspaceId, TimeoutSeconds, CorrelationId)
OUTPUT inserted.*
SELECT t.Id, ISNULL(MAX(a.AttemptNumber), 0) + 1, @trigger, @mode, @previousAttemptId, 'queued', @additionalInstructions,
  @baseRefOverride, @workspaceId, t.TimeoutSeconds, @correlationId
FROM orc.Tasks AS t
LEFT JOIN orc.TaskAttempts AS a ON a.TaskId = t.Id
WHERE t.Id = @taskId
GROUP BY t.Id, t.TimeoutSeconds;`;

const TASK_QUEUE_CREATED = `UPDATE orc.Tasks SET
  Status = 'queued', CurrentAttemptId = @attemptId, AttemptCount = 1, QueuedAt = SYSUTCDATETIME(), UpdatedAt = SYSUTCDATETIME()
OUTPUT inserted.*
WHERE Id = @taskId AND Status = 'created';`;

const TASK_TRANSITION = `UPDATE orc.Tasks SET
  Status = @to,
  StatusReason = @reason,
  StatusDetail = @detail,
  StartedAt = CASE WHEN StartedAt IS NULL AND @toActive = 1 THEN SYSUTCDATETIME() ELSE StartedAt END,
  FinishedAt = CASE WHEN @toSettled = 1 THEN SYSUTCDATETIME() ELSE FinishedAt END,
  UpdatedAt = SYSUTCDATETIME()
OUTPUT inserted.*
WHERE Id = @taskId AND Status = @from AND (@rowVer IS NULL OR RowVer = @rowVer);`;

const ATTEMPT_TRANSITION = `UPDATE orc.TaskAttempts SET
  Status = COALESCE(@attemptStatus, Status),
  Stage = CASE WHEN @toActive = 1 THEN @to ELSE Stage END,
  FailureReason = CASE WHEN @attemptStatus IS NOT NULL AND @attemptStatus <> 'succeeded' THEN @reason ELSE FailureReason END,
  FailureDetail = CASE WHEN @attemptStatus IS NOT NULL AND @attemptStatus <> 'succeeded' THEN @detail ELSE FailureDetail END,
  EndedAt = CASE WHEN @attemptStatus IS NOT NULL AND @attemptStatus NOT IN ('queued', 'active') THEN SYSUTCDATETIME() ELSE EndedAt END,
  UpdatedAt = SYSUTCDATETIME()
WHERE Id = @attemptId AND TaskId = @taskId AND Status IN ('queued', 'active');`;

const CLAIM_TASK = `UPDATE t SET
  Status = 'preparing_workspace', StartedAt = COALESCE(t.StartedAt, SYSUTCDATETIME()), UpdatedAt = SYSUTCDATETIME()
OUTPUT inserted.*
FROM orc.Tasks AS t
INNER JOIN orc.TaskAttempts AS a ON a.Id = t.CurrentAttemptId
WHERE a.Id = @attemptId AND a.Status = 'queued' AND t.Status = 'queued';`;

const CLAIM_ATTEMPT = `UPDATE orc.TaskAttempts SET
  Status = 'active', WorkerId = @workerId, StartedAt = SYSUTCDATETIME(),
  DeadlineAt = DATEADD(SECOND, TimeoutSeconds, SYSUTCDATETIME()), LastHeartbeatAt = SYSUTCDATETIME(),
  Stage = 'preparing_workspace', UpdatedAt = SYSUTCDATETIME()
OUTPUT inserted.*
WHERE Id = @attemptId AND Status = 'queued';`;

const RETRY_TASK = `UPDATE orc.Tasks SET
  Status = 'queued', StatusReason = NULL, StatusDetail = NULL, FinishedAt = NULL,
  CancelRequestedAt = NULL, CancelRequestedByUserId = NULL,
  AttemptCount = AttemptCount + 1, QueuedAt = SYSUTCDATETIME(), UpdatedAt = SYSUTCDATETIME()
OUTPUT inserted.*
WHERE Id = @taskId AND Status = @from AND (@rowVer IS NULL OR RowVer = @rowVer) AND CurrentAttemptId = @previousAttemptId;`;

// Worker path: touches only the columns of the orc_worker_role column grant (§4.3).
const RECOVER_TASK = `UPDATE orc.Tasks SET
  Status = 'queued', StatusReason = NULL, StatusDetail = NULL,
  AttemptCount = AttemptCount + 1, AutoRecoveryCount = AutoRecoveryCount + 1,
  QueuedAt = SYSUTCDATETIME(), UpdatedAt = SYSUTCDATETIME()
OUTPUT inserted.*
WHERE Id = @taskId AND Status = @from AND (@rowVer IS NULL OR RowVer = @rowVer)
  AND CurrentAttemptId = @previousAttemptId AND CancelRequestedAt IS NULL;`;

const INTERRUPT_PREVIOUS = `UPDATE orc.TaskAttempts SET
  Status = 'interrupted', FailureReason = @interruptionReason, EndedAt = SYSUTCDATETIME(), UpdatedAt = SYSUTCDATETIME()
WHERE Id = @previousAttemptId AND TaskId = @taskId AND Status IN ('queued', 'active');`;

const SET_CURRENT_ATTEMPT = `UPDATE orc.Tasks SET CurrentAttemptId = @attemptId, UpdatedAt = SYSUTCDATETIME()
OUTPUT inserted.*
WHERE Id = @taskId;`;

const CANCEL_PENDING_TASK = `UPDATE orc.Tasks SET
  Status = 'cancelled', StatusReason = 'cancelled_by_user', StatusDetail = @detail, FinishedAt = SYSUTCDATETIME(),
  CancelRequestedAt = COALESCE(CancelRequestedAt, SYSUTCDATETIME()),
  CancelRequestedByUserId = COALESCE(CancelRequestedByUserId, @actorUserId),
  UpdatedAt = SYSUTCDATETIME()
OUTPUT inserted.*
WHERE Id = @taskId AND Status = @from;`;

const CANCEL_PENDING_ATTEMPT = `UPDATE orc.TaskAttempts SET
  Status = 'cancelled', FailureReason = 'cancelled_by_user', EndedAt = SYSUTCDATETIME(), UpdatedAt = SYSUTCDATETIME()
WHERE TaskId = @taskId AND Status = 'queued';`;

const REQUEST_CANCEL_TASK = `UPDATE orc.Tasks SET
  CancelRequestedAt = SYSUTCDATETIME(), CancelRequestedByUserId = @actorUserId, UpdatedAt = SYSUTCDATETIME()
OUTPUT inserted.*
WHERE Id = @taskId AND CancelRequestedAt IS NULL
  AND Status IN ('preparing_workspace', 'indexing', 'running', 'testing', 'reviewing');`;

function rowVerParam(expected: string | undefined): Param {
  return ['rowVer', T.binary(8), expected === undefined ? null : rowVerToBuffer(expected)];
}

function taskRow(rows: readonly Readonly<Record<string, unknown>>[]): TaskRecord | null {
  const row = first(rows);
  return row ? mapTask(row) : null;
}

async function casMiss(ctx: RepoContext, taskId: Uuid, rowVerSupplied: boolean): Promise<never> {
  const row = first((await run(ctx, TASK_EXISTS, [['id', T.guid, taskId]])).rows);
  if (!row) throw new NotFoundError('Task not found');
  if (rowVerSupplied) throw new PreconditionFailedError('Task has been modified');
  throw new ConflictError('Task status changed concurrently');
}

function userIdOf(actor: Actor): Uuid | null {
  return actorColumns(actor).actorUserId;
}

export function createTaskStateStore(ctx: RepoContext): TaskStateStore {
  return {
    createTask(i) {
      return ctx.exec.atomic('taskState.createTask', async (exec) => {
        const c: RepoContext = { ...ctx, exec };
        const t = i.task;
        const created = taskRow(
          (
            await run(c, TASK_INSERT, [
              ['projectId', T.guid, t.projectId],
              ['agentId', T.guid, t.agentId],
              ['createdByUserId', T.guid, t.createdByUserId],
              ['title', T.nvarchar(200), t.title],
              ['prompt', T.nvarcharMax, t.prompt],
              ['acceptanceCriteria', T.nvarcharMax, t.acceptanceCriteria],
              ['scope', T.nvarchar(4000), t.scope],
              ['baseRef', T.nvarchar(200), t.baseRef],
              ['model', T.nvarchar(100), t.model],
              ['effort', T.varchar(8), t.effort],
              ['timeoutSeconds', T.int, t.timeoutSeconds],
              ['maxBudgetUsd', T.money, t.maxBudgetUsd],
              ['correlationId', T.varchar(128), t.correlationId],
            ])
          ).rows,
        );
        if (!created) throw new OrcError('internal_error', 'Tasks insert returned no row');
        const attemptRow = first(
          (
            await run(c, ATTEMPT_INSERT, [
              ['taskId', T.guid, created.id],
              ['trigger', T.varchar(16), 'initial'],
              ['mode', T.varchar(8), 'fresh'],
              ['previousAttemptId', T.guid, null],
              ['additionalInstructions', T.nvarcharMax, null],
              ['baseRefOverride', T.nvarchar(200), null],
              ['workspaceId', T.guid, null],
              ['correlationId', T.varchar(128), t.correlationId],
            ])
          ).rows,
        );
        if (!attemptRow) throw new OrcError('internal_error', 'TaskAttempts insert returned no row');
        const attempt = mapAttempt(attemptRow);
        const task = taskRow(
          (
            await run(c, TASK_QUEUE_CREATED, [
              ['taskId', T.guid, created.id],
              ['attemptId', T.guid, attempt.id],
            ])
          ).rows,
        );
        if (!task) throw new ConflictError('Task status changed concurrently');

        const actor = eventActor(i.actor);
        await insertEvent(c, {
          taskId: task.id,
          attemptId: null,
          type: 'task_created',
          fromStatus: null,
          toStatus: 'created',
          ...actor,
          reason: null,
          data: { title: task.title, projectId: task.projectId, agentId: task.agentId },
          correlationId: t.correlationId,
        });
        await insertEvent(c, {
          taskId: task.id,
          attemptId: attempt.id,
          type: 'attempt_created',
          fromStatus: null,
          toStatus: null,
          ...actor,
          reason: null,
          data: { attemptNumber: attempt.attemptNumber, trigger: attempt.trigger, mode: attempt.mode },
          correlationId: t.correlationId,
        });
        await insertEvent(c, {
          taskId: task.id,
          attemptId: attempt.id,
          type: 'status_changed',
          fromStatus: 'created',
          toStatus: 'queued',
          ...actor,
          reason: null,
          data: null,
          correlationId: t.correlationId,
        });
        await insertAudit(c, {
          action: 'task.created',
          actor: i.actor,
          entityType: 'task',
          entityId: task.id,
          outcome: 'success',
          after: {
            status: task.status,
            title: task.title,
            projectId: task.projectId,
            agentId: task.agentId,
            model: task.model,
            effort: task.effort,
            timeoutSeconds: task.timeoutSeconds,
            promptBytes: utf8ByteLength(task.prompt),
            attemptId: attempt.id,
          },
          ...auditContextOf(i.audit, t.correlationId),
        });
        if (i.idempotency) {
          const response = i.idempotency.responseFactory(task, attempt);
          const { rowsAffected } = await run(
            c,
            IDEMPOTENCY_COMPLETE_SQL,
            completeIdempotencyParams(i.idempotency.id, { ...response, resourceId: task.id }),
          );
          if (rowsAffected === 0) throw new ConflictError('Idempotency key no longer exists');
        }
        return { task, attempt };
      });
    },

    // async: argument validation errors surface as rejections, never as synchronous throws.
    async transition(i) {
      if (i.to === 'queued') {
        // created -> queued is createTask; any -> queued is createAttempt (§5.1).
        throw new InvalidTransitionError(i.from, i.to);
      }
      assertTransition(i.from, i.to);
      const toSettled = isSettledStatus(i.to);
      const toActive = isActiveStatus(i.to);
      let attemptStatus: AttemptStatus | null = i.attemptStatus ?? null;
      if (attemptStatus === null && isSettledStatus(i.to)) {
        attemptStatus = attemptStatusForSettled(i.to);
      }
      if (attemptStatus === 'queued' || (attemptStatus === 'active' && !toActive)) {
        throw new OrcError('validation_failed', `Attempt status ${attemptStatus} does not fit task status ${i.to}`);
      }
      if (attemptStatus !== null && i.attemptId === null) {
        throw new OrcError('validation_failed', 'attemptStatus requires attemptId');
      }
      return await ctx.exec.atomic('taskState.transition', async (exec) => {
        const c: RepoContext = { ...ctx, exec };
        const detail = maskedText(c, i.detail, DETAIL_MAX_CHARS);
        const reason = i.reason ?? null;
        const task = taskRow(
          (
            await run(c, TASK_TRANSITION, [
              ['taskId', T.guid, i.taskId],
              ['from', T.varchar(24), i.from],
              ['to', T.varchar(24), i.to],
              ['reason', T.varchar(40), reason],
              ['detail', T.nvarchar(DETAIL_MAX_CHARS), detail],
              ['toActive', T.bit, toActive],
              ['toSettled', T.bit, toSettled],
              rowVerParam(i.expectedRowVer),
            ])
          ).rows,
        );
        if (!task) return casMiss(c, i.taskId, i.expectedRowVer !== undefined);
        if (i.attemptId !== null) {
          const { rowsAffected } = await run(c, ATTEMPT_TRANSITION, [
            ['attemptId', T.guid, i.attemptId],
            ['taskId', T.guid, i.taskId],
            ['attemptStatus', T.varchar(12), attemptStatus],
            ['to', T.varchar(24), i.to],
            ['toActive', T.bit, toActive],
            ['reason', T.varchar(40), reason],
            ['detail', T.nvarchar(DETAIL_MAX_CHARS), detail],
          ]);
          if (rowsAffected === 0) throw new ConflictError('Attempt is no longer live (superseded)');
        }
        await insertEvent(c, {
          taskId: i.taskId,
          attemptId: i.attemptId,
          type: 'status_changed',
          fromStatus: i.from,
          toStatus: i.to,
          ...eventActor(i.actor),
          reason,
          data: i.data ?? null,
          correlationId: i.correlationId,
        });
        await insertAudit(c, {
          action: 'task.status_changed',
          actor: i.actor,
          entityType: 'task',
          entityId: i.taskId,
          outcome: 'success',
          before: { status: i.from },
          after: { status: i.to, reason },
          detail: { attemptId: i.attemptId, attemptStatus, detail },
          ...auditContextOf(i.audit, i.correlationId),
        });
        return task;
      });
    },

    claimAttempt(i) {
      return ctx.exec.atomic('taskState.claimAttempt', async (exec) => {
        const c: RepoContext = { ...ctx, exec };
        const claimed = taskRow((await run(c, CLAIM_TASK, [['attemptId', T.guid, i.attemptId]])).rows);
        if (!claimed) return null;
        const attemptRow = first(
          (
            await run(c, CLAIM_ATTEMPT, [
              ['attemptId', T.guid, i.attemptId],
              ['workerId', T.nvarchar(128), i.workerId],
            ])
          ).rows,
        );
        if (!attemptRow) throw new ConflictError('Attempt was claimed concurrently');
        const attempt = mapAttempt(attemptRow);
        const actor = eventActor(i.actor);
        await insertEvent(c, {
          taskId: claimed.id,
          attemptId: attempt.id,
          type: 'attempt_claimed',
          fromStatus: null,
          toStatus: null,
          ...actor,
          reason: null,
          data: { workerId: i.workerId, attemptNumber: attempt.attemptNumber },
          correlationId: attempt.correlationId ?? claimed.correlationId,
        });
        await insertEvent(c, {
          taskId: claimed.id,
          attemptId: attempt.id,
          type: 'status_changed',
          fromStatus: 'queued',
          toStatus: 'preparing_workspace',
          ...actor,
          reason: null,
          data: null,
          correlationId: attempt.correlationId ?? claimed.correlationId,
        });
        await insertAudit(c, {
          action: 'task.status_changed',
          actor: i.actor,
          entityType: 'task',
          entityId: claimed.id,
          outcome: 'success',
          before: { status: 'queued' },
          after: { status: 'preparing_workspace', reason: null },
          detail: { attemptId: attempt.id, workerId: i.workerId },
          correlationId: attempt.correlationId ?? claimed.correlationId,
        });
        return { task: claimed, attempt };
      });
    },

    // async: argument validation errors surface as rejections, never as synchronous throws.
    async createAttempt(i) {
      const isRecovery = i.trigger === 'infra_recovery';
      if (isRecovery) {
        if (!(ACTIVE_TASK_STATUSES as readonly TaskStatus[]).includes(i.from)) {
          throw new InvalidTransitionError(i.from, 'queued');
        }
        if (!i.interruptionReason) {
          throw new OrcError('validation_failed', 'infra_recovery requires interruptionReason');
        }
      } else {
        if (!(RETRYABLE_TASK_STATUSES as readonly TaskStatus[]).includes(i.from)) {
          throw new InvalidTransitionError(i.from, 'queued');
        }
        if (i.previousAttemptFinalStatus !== undefined || i.interruptionReason !== undefined) {
          throw new OrcError('validation_failed', 'previousAttemptFinalStatus/interruptionReason are only for infra_recovery');
        }
      }
      return await ctx.exec.atomic('taskState.createAttempt', async (exec) => {
        const c: RepoContext = { ...ctx, exec };
        const queued = taskRow(
          (
            await run(c, isRecovery ? RECOVER_TASK : RETRY_TASK, [
              ['taskId', T.guid, i.taskId],
              ['from', T.varchar(24), i.from],
              ['previousAttemptId', T.guid, i.previousAttemptId],
              rowVerParam(i.expectedRowVer),
            ])
          ).rows,
        );
        if (!queued) return casMiss(c, i.taskId, i.expectedRowVer !== undefined);
        if (isRecovery) {
          const { rowsAffected } = await run(c, INTERRUPT_PREVIOUS, [
            ['previousAttemptId', T.guid, i.previousAttemptId],
            ['taskId', T.guid, i.taskId],
            ['interruptionReason', T.varchar(40), i.interruptionReason ?? null],
          ]);
          if (rowsAffected === 0) throw new ConflictError('Previous attempt is no longer live');
        }
        const attemptRow = first(
          (
            await run(c, ATTEMPT_INSERT, [
              ['taskId', T.guid, i.taskId],
              ['trigger', T.varchar(16), i.trigger],
              ['mode', T.varchar(8), i.mode],
              ['previousAttemptId', T.guid, i.previousAttemptId],
              ['additionalInstructions', T.nvarcharMax, i.additionalInstructions],
              ['baseRefOverride', T.nvarchar(200), i.baseRefOverride ?? null],
              ['workspaceId', T.guid, i.workspaceId],
              ['correlationId', T.varchar(128), i.correlationId],
            ])
          ).rows,
        );
        if (!attemptRow) throw new OrcError('internal_error', 'TaskAttempts insert returned no row');
        const attempt: AttemptRecord = mapAttempt(attemptRow);
        const task = taskRow(
          (
            await run(c, SET_CURRENT_ATTEMPT, [
              ['taskId', T.guid, i.taskId],
              ['attemptId', T.guid, attempt.id],
            ])
          ).rows,
        );
        if (!task) throw new NotFoundError('Task not found');

        const actor = eventActor(i.actor);
        if (isRecovery) {
          await insertEvent(c, {
            taskId: i.taskId,
            attemptId: i.previousAttemptId,
            type: 'recovery_scheduled',
            fromStatus: i.from,
            toStatus: 'queued',
            ...actor,
            reason: i.interruptionReason ?? null,
            data: { previousAttemptId: i.previousAttemptId, newAttemptId: attempt.id, mode: i.mode },
            correlationId: i.correlationId,
          });
        }
        await insertEvent(c, {
          taskId: i.taskId,
          attemptId: attempt.id,
          type: 'attempt_created',
          fromStatus: null,
          toStatus: null,
          ...actor,
          reason: null,
          data: {
            attemptNumber: attempt.attemptNumber,
            trigger: attempt.trigger,
            mode: attempt.mode,
            previousAttemptId: i.previousAttemptId,
          },
          correlationId: i.correlationId,
        });
        await insertEvent(c, {
          taskId: i.taskId,
          attemptId: attempt.id,
          type: 'status_changed',
          fromStatus: i.from,
          toStatus: 'queued',
          ...actor,
          reason: null,
          data: null,
          correlationId: i.correlationId,
        });
        const auditCtx = auditContextOf(i.audit, i.correlationId);
        if (isRecovery) {
          await insertAudit(c, {
            action: 'task.recovered',
            actor: i.actor,
            entityType: 'attempt',
            entityId: i.previousAttemptId,
            outcome: 'success',
            detail: {
              taskId: i.taskId,
              reason: i.interruptionReason ?? null,
              newAttemptId: attempt.id,
              autoRecoveryCount: task.autoRecoveryCount,
            },
            ...auditCtx,
          });
        } else {
          await insertAudit(c, {
            action: 'task.retry_requested',
            actor: i.actor,
            entityType: 'task',
            entityId: i.taskId,
            outcome: 'success',
            before: { status: i.from },
            after: { status: 'queued', attemptNumber: attempt.attemptNumber, mode: attempt.mode },
            ...auditCtx,
          });
        }
        await insertAudit(c, {
          action: 'task.status_changed',
          actor: i.actor,
          entityType: 'task',
          entityId: i.taskId,
          outcome: 'success',
          before: { status: i.from },
          after: { status: 'queued', reason: null },
          detail: { attemptId: attempt.id, trigger: i.trigger },
          ...auditCtx,
        });
        return { task, attempt };
      });
    },

    // async: argument validation errors surface as rejections, never as synchronous throws.
    async cancelPending(i) {
      if (i.from !== 'created' && i.from !== 'queued') {
        throw new InvalidTransitionError(i.from, 'cancelled');
      }
      return await ctx.exec.atomic('taskState.cancelPending', async (exec) => {
        const c: RepoContext = { ...ctx, exec };
        const detail = maskedText(c, i.reasonText, DETAIL_MAX_CHARS);
        const task = taskRow(
          (
            await run(c, CANCEL_PENDING_TASK, [
              ['taskId', T.guid, i.taskId],
              ['from', T.varchar(24), i.from],
              ['detail', T.nvarchar(DETAIL_MAX_CHARS), detail],
              ['actorUserId', T.guid, userIdOf(i.actor)],
            ])
          ).rows,
        );
        if (!task) return casMiss(c, i.taskId, false);
        await run(c, CANCEL_PENDING_ATTEMPT, [['taskId', T.guid, i.taskId]]);
        await insertEvent(c, {
          taskId: task.id,
          attemptId: task.currentAttemptId,
          type: 'status_changed',
          fromStatus: i.from,
          toStatus: 'cancelled',
          ...eventActor(i.actor),
          reason: 'cancelled_by_user',
          data: detail === null ? null : { reasonText: detail },
          correlationId: task.correlationId,
        });
        await insertAudit(c, {
          action: 'task.status_changed',
          actor: i.actor,
          entityType: 'task',
          entityId: task.id,
          outcome: 'success',
          before: { status: i.from },
          after: { status: 'cancelled', reason: 'cancelled_by_user' },
          detail: { attemptId: task.currentAttemptId, reasonText: detail },
          ...auditContextOf(i.audit, task.correlationId),
        });
        return task;
      });
    },

    requestCancel(i) {
      return ctx.exec.atomic('taskState.requestCancel', async (exec) => {
        const c: RepoContext = { ...ctx, exec };
        const task = taskRow(
          (
            await run(c, REQUEST_CANCEL_TASK, [
              ['taskId', T.guid, i.taskId],
              ['actorUserId', T.guid, userIdOf(i.actor)],
            ])
          ).rows,
        );
        if (!task) {
          const current = taskRow((await run(c, TASK_SELECT, [['id', T.guid, i.taskId]])).rows);
          if (!current) throw new NotFoundError('Task not found');
          if (isActiveStatus(current.status) && current.cancelRequestedAt !== null) return current;
          throw new ConflictError(`Task in status ${current.status} cannot be cancelled`);
        }
        const detail = maskedText(c, i.reasonText, DETAIL_MAX_CHARS);
        await insertEvent(c, {
          taskId: task.id,
          attemptId: task.currentAttemptId,
          type: 'cancel_requested',
          fromStatus: task.status,
          toStatus: null,
          ...eventActor(i.actor),
          reason: null,
          data: detail === null ? null : { reasonText: detail },
          correlationId: task.correlationId,
        });
        await insertAudit(c, {
          action: 'task.cancel_requested',
          actor: i.actor,
          entityType: 'task',
          entityId: task.id,
          outcome: 'success',
          before: { status: task.status, cancelRequestedAt: null },
          after: { status: task.status, cancelRequestedAt: task.cancelRequestedAt },
          detail: { attemptId: task.currentAttemptId, reasonText: detail },
          ...auditContextOf(i.audit, task.correlationId),
        });
        return task;
      });
    },
  };
}
