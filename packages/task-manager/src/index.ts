// @orc/task-manager public API (contract §2.9).
export {
  REDIS_OP_TIMEOUT_MS,
  boundRedis,
  createRedisFactory,
  closeRedis,
  isRedisTransportError,
  redisOptionsFor,
  toRedisError,
} from './redis.js';
export type { RedisConfig, RedisFactory, RedisRole } from './redis.js';
export {
  MAINTENANCE_JOB_OPTIONS,
  createQueueRegistry,
  getQueueStatus,
  projectJobId,
  safeJobId,
} from './queues.js';
export type { JobStateName, QueueRegistry, QueueRegistryConfig } from './queues.js';
export {
  SETTLED_STREAM_TTL_SECONDS,
  STREAM_MAXLEN,
  createTaskStreamPublisher,
  createTaskStreamReader,
  taskStreamKey,
} from './stream.js';
export type { StreamEntry, TaskStreamPublisher, TaskStreamReader } from './stream.js';
export { controlChannelName, createControlChannel } from './control.js';
export type { ControlChannel } from './control.js';
export {
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
export type { RequestContext, Viewer } from './viewer.js';
export { continueTarget, createTaskService, toAttempt, toTask } from './task-service.js';
export type {
  RecoveryDecision,
  TaskService,
  TaskServiceConfig,
  TaskServiceDeps,
} from './task-service.js';
