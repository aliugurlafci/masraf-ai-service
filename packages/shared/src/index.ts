// @orc/shared — browser-safe main entry (contract §2.1, §3, §6, §7, §8, §9).
// MUST NOT import node:*, Buffer or process. Node-only helpers live in "@orc/shared/node".

export type { Uuid, BigId, IsoDateTime, Clock, IdGenerator } from './primitives';
export { GUID_REGEX, systemClock, cryptoIdGenerator, shortKey, toIso } from './primitives';

export * from './constants';

export type { ErrorCode, ErrorCatalogEntry, FieldIssue, PublicErrorMapping } from './errors';
export {
  ERROR_CODES,
  ERROR_CATALOG,
  problemTypeUri,
  toPublicError,
  OrcError,
  ValidationError,
  NotFoundError,
  ConflictError,
  PreconditionFailedError,
  InvalidTransitionError,
  isOrcError,
} from './errors';

export {
  TASK_TRANSITIONS,
  canTransition,
  assertTransition,
  isActiveStatus,
  isSettledStatus,
  attemptStatusForSettled,
} from './state-machine';

export { ROLE_PERMISSIONS, hasPermission } from './rbac';

export type { Page, KeysetCursor } from './pagination';
export { encodeCursor, decodeCursor, filterHash } from './pagination';

export { parseClaudeLine, summarizeClaudeLine } from './claude-stream';

export { IdSchema, BigIdSchema, IsoDateTimeSchema } from './schemas/common';
export * from './schemas/domain';
export * from './schemas/requests';
export * from './schemas/claude';
export * from './schemas/queue';
export * from './schemas/stream';
