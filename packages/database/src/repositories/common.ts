// Shared repository helpers: CAS miss classification, actor columns, audit + task event inserts.
import { NotFoundError, OrcError, PreconditionFailedError } from '@orc/shared';
import type { FailureReason, TaskEventType, TaskStatus, Uuid } from '@orc/shared';
import { maskObject, maskText } from '@orc/security';
import { T, run, truncateChars } from '../sql.js';
import type { Param, RepoContext, Row } from '../sql.js';
import type { Actor, AuditContext, AuditInsert } from '../types.js';
import { mapTaskEvent } from './mappers.js';
import type { TaskEvent } from '@orc/shared';

/** Runs a constant `SELECT 1 ... WHERE Id = @id` and throws NotFoundError or PreconditionFailedError. */
export async function throwCasMiss(ctx: RepoContext, existsSql: string, id: Uuid, entity: string): Promise<never> {
  const { rows } = await run(ctx, existsSql, [['id', T.guid, id]]);
  if (rows.length === 0) throw new NotFoundError(`${entity} not found`);
  throw new PreconditionFailedError(`${entity} has been modified`);
}

export interface ActorColumns {
  actorType: Actor['type'];
  actorUserId: Uuid | null;
  actorTokenId: Uuid | null;
  actorLabel: string;
}

export function actorColumns(actor: Actor): ActorColumns {
  switch (actor.type) {
    case 'user':
      return { actorType: 'user', actorUserId: actor.userId, actorTokenId: null, actorLabel: actor.label };
    case 'token':
      return { actorType: 'token', actorUserId: actor.userId, actorTokenId: actor.tokenId, actorLabel: actor.label };
    case 'worker':
      return { actorType: 'worker', actorUserId: null, actorTokenId: null, actorLabel: actor.workerId };
    case 'system':
      return { actorType: 'system', actorUserId: null, actorTokenId: null, actorLabel: actor.label };
  }
}

/** Masked JSON for audit/event columns; scalars are wrapped as {"value": x} so ISJSON(col) = 1 always holds. */
export function maskedJson(ctx: RepoContext, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const masked = maskObject(value, ctx.secrets);
  const wrapped: unknown = typeof masked === 'object' && masked !== null ? masked : { value: masked };
  return JSON.stringify(wrapped);
}

/** Masks free text with the secret registry and caps it to `maxChars`. */
export function maskedText(ctx: RepoContext, value: string | null | undefined, maxChars: number): string | null {
  if (value === undefined || value === null) return null;
  return truncateChars(maskText(value, ctx.secrets), maxChars);
}

/** AuditLogs.ActorLabel / TaskEvents.ActorLabel are NVARCHAR(200); a long label must never abort the audited operation. */
const ACTOR_LABEL_MAX_CHARS = 200;

function capped(value: string | null | undefined, maxChars: number): string | null {
  return value === undefined || value === null ? null : truncateChars(value, maxChars);
}

const INSERT_AUDIT_SQL = `INSERT INTO orc.AuditLogs
  (Action, Outcome, ActorType, ActorUserId, ActorTokenId, ActorLabel, EntityType, EntityId,
   BeforeJson, AfterJson, DetailJson, Ip, UserAgent, RequestId, CorrelationId)
VALUES
  (@action, @outcome, @actorType, @actorUserId, @actorTokenId, @actorLabel, @entityType, @entityId,
   @beforeJson, @afterJson, @detailJson, @ip, @userAgent, @requestId, @correlationId);`;

export async function insertAudit(ctx: RepoContext, a: AuditInsert): Promise<void> {
  const actor = actorColumns(a.actor);
  const params: Param[] = [
    ['action', T.varchar(64), a.action],
    ['outcome', T.varchar(8), a.outcome],
    ['actorType', T.varchar(8), actor.actorType],
    ['actorUserId', T.guid, actor.actorUserId],
    ['actorTokenId', T.guid, actor.actorTokenId],
    ['actorLabel', T.nvarchar(ACTOR_LABEL_MAX_CHARS), capped(actor.actorLabel, ACTOR_LABEL_MAX_CHARS)],
    ['entityType', T.varchar(24), a.entityType],
    ['entityId', T.nvarchar(64), a.entityId],
    ['beforeJson', T.nvarcharMax, maskedJson(ctx, a.before)],
    ['afterJson', T.nvarcharMax, maskedJson(ctx, a.after)],
    ['detailJson', T.nvarcharMax, maskedJson(ctx, a.detail)],
    ['ip', T.varchar(45), capped(a.ip, 45)],
    ['userAgent', T.nvarchar(400), capped(a.userAgent, 400)],
    ['requestId', T.varchar(128), capped(a.requestId, 128)],
    ['correlationId', T.varchar(128), capped(a.correlationId, 128)],
  ];
  await run(ctx, INSERT_AUDIT_SQL, params);
}

export interface EventInput {
  taskId: Uuid;
  attemptId: Uuid | null;
  type: TaskEventType;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus | null;
  actorType: Actor['type'];
  actorUserId: Uuid | null;
  actorLabel: string | null;
  reason: FailureReason | null;
  data: Record<string, unknown> | null;
  correlationId: string | null;
}

const INSERT_EVENT_SQL = `INSERT INTO orc.TaskEvents
  (TaskId, AttemptId, EventType, FromStatus, ToStatus, ActorType, ActorUserId, ActorLabel, Reason, DataJson, CorrelationId)
OUTPUT inserted.*
VALUES
  (@taskId, @attemptId, @eventType, @fromStatus, @toStatus, @actorType, @actorUserId, @actorLabel, @reason, @dataJson, @correlationId);`;

export async function insertEvent(ctx: RepoContext, e: EventInput): Promise<TaskEvent> {
  const params: Param[] = [
    ['taskId', T.guid, e.taskId],
    ['attemptId', T.guid, e.attemptId],
    ['eventType', T.varchar(32), e.type],
    ['fromStatus', T.varchar(24), e.fromStatus],
    ['toStatus', T.varchar(24), e.toStatus],
    ['actorType', T.varchar(8), e.actorType],
    ['actorUserId', T.guid, e.actorUserId],
    ['actorLabel', T.nvarchar(ACTOR_LABEL_MAX_CHARS), capped(e.actorLabel, ACTOR_LABEL_MAX_CHARS)],
    ['reason', T.varchar(40), e.reason],
    ['dataJson', T.nvarcharMax, e.data === null ? null : JSON.stringify(maskObject(e.data, ctx.secrets))],
    ['correlationId', T.varchar(128), capped(e.correlationId, 128)],
  ];
  const { rows } = await run(ctx, INSERT_EVENT_SQL, params);
  const row: Row | undefined = rows[0];
  if (!row) throw new OrcError('internal_error', 'TaskEvents insert returned no row');
  return mapTaskEvent(row);
}

/** Event actor fields derived from an Actor. */
export function eventActor(actor: Actor): Pick<EventInput, 'actorType' | 'actorUserId' | 'actorLabel'> {
  const a = actorColumns(actor);
  return { actorType: a.actorType, actorUserId: a.actorUserId, actorLabel: a.actorLabel };
}

export function auditContextOf(audit: AuditContext | undefined, correlationId: string | null): AuditContext {
  return {
    requestId: audit?.requestId ?? null,
    correlationId: audit?.correlationId ?? correlationId,
    ip: audit?.ip ?? null,
    userAgent: audit?.userAgent ?? null,
  };
}
