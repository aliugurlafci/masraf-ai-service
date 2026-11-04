// Wiring of the API dependencies (queues, stream publisher, control channel, services) shared by main.ts and tests.
import type { Clock, RateLimitClass } from '@orc/shared';
import type { ApiConfig } from '@orc/shared/node';
import type { Database } from '@orc/database';
import type { Logger } from '@orc/logger';
import {
  createControlChannel,
  createQueueRegistry,
  createTaskService,
  createTaskStreamPublisher,
} from '@orc/task-manager';
import type { RedisFactory, TaskStreamPublisher } from '@orc/task-manager';
import { createAgentService, createProjectService, createTeamService } from '@orc/project-manager';
import type { ApiRuntime, AppDeps, RateLimitRule, RedisClient } from './types.js';

/** The API never runs infra recovery itself; the value only feeds TaskServiceConfig (worker default, §16.3). */
const MAX_AUTO_RECOVERIES = 2;

const DOWN_STATUSES: ReadonlySet<string> = new Set(['reconnecting', 'close', 'end']);
const DROP_LOG_INTERVAL_MS = 10_000;

/**
 * Stream publications are best-effort (the DB is the source of truth, §7): while the publisher connection is down they
 * are dropped at once instead of waiting for the connection's per-request retries, so a Redis outage never delays a
 * request (F8). A connection that is still connecting (startup) is used normally.
 */
function failFastPublisher(conn: RedisClient, inner: TaskStreamPublisher, logger: Logger): TaskStreamPublisher {
  let lastLog = 0;
  const down = (op: string, taskId: string): boolean => {
    if (!DOWN_STATUSES.has(conn.status)) return false;
    const now = Date.now();
    if (now - lastLog >= DROP_LOG_INTERVAL_MS) {
      lastLog = now;
      logger.warn({ op, taskId, redisStatus: conn.status }, 'Redis unavailable: task stream publication dropped');
    }
    return true;
  };
  return {
    publish: (taskId, e) => (down('xadd', taskId) ? Promise.resolve('') : inner.publish(taskId, e)),
    persist: (taskId) => (down('persist', taskId) ? Promise.resolve() : inner.persist(taskId)),
    expireSettled: (taskId) => (down('expire', taskId) ? Promise.resolve() : inner.expireSettled(taskId)),
  };
}

export interface ComposeOptions {
  config: ApiConfig;
  logger: Logger;
  db: Database;
  redis: RedisFactory;
  runtime: ApiRuntime;
  clock?: Clock;
  /** Bound of one queue operation and of one control-channel PUBLISH (default REDIS_OP_TIMEOUT_MS). */
  queueOpTimeoutMs?: number;
  rateLimits?: Partial<Record<RateLimitClass, RateLimitRule>>;
  sseRedisTimeoutMs?: number;
}

export function composeDeps(o: ComposeOptions): AppDeps {
  const { config, logger, db, redis } = o;
  const prefix = config.redis.prefix;
  const commandRedis = redis.create('command', 'api-command');
  const queues = createQueueRegistry(redis, {
    prefix,
    jobAttempts: config.queueJobAttempts,
    backoffMs: config.queueBackoffMs,
    ...(o.queueOpTimeoutMs !== undefined ? { opTimeoutMs: o.queueOpTimeoutMs } : {}),
  });
  const publisherConn = redis.create('command', 'api-stream-publisher');
  const publisher = failFastPublisher(
    publisherConn,
    createTaskStreamPublisher(publisherConn, { prefix, logger }),
    logger,
  );
  const control = createControlChannel(redis, {
    prefix,
    logger,
    ...(o.queueOpTimeoutMs !== undefined ? { opTimeoutMs: o.queueOpTimeoutMs } : {}),
  });
  const clockDep = o.clock !== undefined ? { clock: o.clock } : {};
  const tasks = createTaskService({
    db,
    queues,
    publisher,
    control,
    logger,
    ...clockDep,
    config: {
      maxAttemptsPerTask: config.taskMaxAttempts,
      maxTimeoutSeconds: config.claudeMaxTimeoutSeconds,
      allowedModels: config.claudeAllowedModels,
      defaultModel: config.claudeDefaultModel,
      promptMaxChars: config.taskPromptMaxChars,
      maxAutoRecoveries: MAX_AUTO_RECOVERIES,
    },
  });
  const projects = createProjectService({
    db,
    queues,
    logger,
    ...clockDep,
    config: { mcpEnabled: config.mcpEnabled, maxTimeoutSeconds: config.claudeMaxTimeoutSeconds },
  });
  const agents = createAgentService({
    db,
    logger,
    config: { allowedModels: config.claudeAllowedModels, maxTimeoutSeconds: config.claudeMaxTimeoutSeconds },
  });
  const teams = createTeamService({ db, logger });
  return {
    config,
    logger,
    db,
    redis,
    commandRedis,
    queues,
    tasks,
    projects,
    agents,
    teams,
    runtime: o.runtime,
    ...clockDep,
    ...(o.rateLimits !== undefined ? { rateLimits: o.rateLimits } : {}),
    ...(o.sseRedisTimeoutMs !== undefined ? { sseRedisTimeoutMs: o.sseRedisTimeoutMs } : {}),
  };
}
