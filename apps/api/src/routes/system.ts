// /system (workers, queue, dlq, mcp), /audit-logs, /health and /problems (contract §9.5, §9.6).
import { z } from 'zod';
import {
  AuditLogQuerySchema,
  AuditLogSchema,
  DeadLetterEntrySchema,
  ERROR_CATALOG,
  ERROR_CODES,
  HealthSchema,
  McpStatusSchema,
  NotFoundError,
  OrcError,
  PageQuerySchema,
  QueueStatusSchema,
  WorkerNodeSchema,
  encodeCursor,
  filterHash,
  pageOf,
  systemClock,
} from '@orc/shared';
import type { AuditLog, ErrorCode, Health } from '@orc/shared';
import { EXPECTED_SCHEMA_VERSION } from '@orc/database';
import { boundRedis, getQueueStatus, keysetFromCursor } from '@orc/task-manager';
import { sendJson } from '../http.js';
import { defineRoute } from '../route.js';
import type { AnyRouteDef } from '../route.js';
import type { AppDeps } from '../types.js';

const READY_REDIS_TIMEOUT_MS = 1_500;
/** Readiness must answer within a probe timeout even while the pool is (re)connecting (DB_CONNECT_TIMEOUT_MS 15 s). */
const READY_DB_TIMEOUT_MS = 3_000;
const MEMORY_HIGH_RATIO = 0.9;

const ProblemParams = z.object({ code: z.string().min(1).max(64) });
const ErrorCatalogEntrySchema = z.object({ code: z.enum(ERROR_CODES), status: z.int(), title: z.string() });

type Check = Health['checks'][string];

/** A failed check whose message is ours and safe on this public endpoint. */
class ReadinessCheckError extends Error {}

/**
 * Runs one readiness check. /health/ready is public: driver messages (hosts, ports, logins) are logged, never
 * returned; the detail is our own message, the OrcError code, or a generic `unavailable`.
 */
async function timed(deps: AppDeps, name: string, fn: () => Promise<string | null>): Promise<Check> {
  const started = performance.now();
  try {
    const detail = await fn();
    return { status: 'ok', latencyMs: Math.round(performance.now() - started), detail };
  } catch (err) {
    deps.logger.warn({ err, check: name }, 'readiness check failed');
    return {
      status: 'fail',
      latencyMs: Math.round(performance.now() - started),
      detail: err instanceof ReadinessCheckError ? err.message : err instanceof OrcError ? err.code : 'unavailable',
    };
  }
}

async function boundDb<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  // The losing promise may still reject later: keep that rejection handled.
  p.catch(() => undefined);
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new OrcError('db_unavailable', `database check timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function memoryDetail(info: string): string | null {
  const fields = new Map<string, string>();
  for (const line of info.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0) fields.set(line.slice(0, idx), line.slice(idx + 1).trim());
  }
  const used = Number(fields.get('used_memory'));
  const max = Number(fields.get('maxmemory'));
  return Number.isFinite(used) && Number.isFinite(max) && max > 0 && used > max * MEMORY_HIGH_RATIO
    ? 'memory_high'
    : null;
}

function uptimeSeconds(deps: AppDeps): number {
  return Math.max(0, Math.round((Date.now() - deps.runtime.startedAtMs) / 1000));
}

export async function readiness(deps: AppDeps): Promise<Health> {
  const [db, redis, migrations] = await Promise.all([
    timed(deps, 'db', async () => {
      await boundDb(deps.db.ping(), READY_DB_TIMEOUT_MS);
      return null;
    }),
    timed(deps, 'redis', async () => {
      await boundRedis(deps.commandRedis.ping(), READY_REDIS_TIMEOUT_MS, 'PING');
      const info = await boundRedis(deps.commandRedis.info('memory'), READY_REDIS_TIMEOUT_MS, 'INFO');
      return memoryDetail(info);
    }),
    timed(deps, 'migrations', async () => {
      const version = await boundDb(deps.db.schemaVersion(), READY_DB_TIMEOUT_MS);
      if (version < EXPECTED_SCHEMA_VERSION) {
        throw new ReadinessCheckError(`schema version ${version} < expected ${EXPECTED_SCHEMA_VERSION}`);
      }
      return `version ${version}`;
    }),
  ]);
  const checks: Health['checks'] = {
    lifecycle: deps.runtime.ready
      ? { status: 'ok', latencyMs: null, detail: null }
      : { status: 'fail', latencyMs: null, detail: 'not ready (starting or shutting down)' },
    db,
    redis,
    migrations,
  };
  const ok = Object.values(checks).every((ch) => ch.status === 'ok');
  return { status: ok ? 'ok' : 'fail', version: deps.config.appVersion, uptimeSeconds: uptimeSeconds(deps), checks };
}

export function systemRoutes(): AnyRouteDef[] {
  return [
    defineRoute({
      method: 'get',
      path: '/system/workers',
      operationId: 'listWorkers',
      summary: 'Worker nodes',
      tag: 'system',
      auth: 'any',
      permission: ['system:read'],
      rateClass: 'read',
      responses: { 200: { description: 'Workers', schema: z.array(WorkerNodeSchema) } },
      async handler(c) {
        sendJson(c.res, 200, await c.deps.db.repos.workerNodes.list());
      },
    }),
    defineRoute({
      method: 'get',
      path: '/system/queue',
      operationId: 'getQueueStatus',
      summary: 'Queue counts, dead letters and Redis memory',
      tag: 'system',
      auth: 'any',
      permission: ['system:read'],
      rateClass: 'read',
      responses: {
        200: { description: 'Queue status', schema: QueueStatusSchema },
        503: { description: 'dependency_unavailable', headers: ['Retry-After'] },
      },
      async handler(c) {
        sendJson(c.res, 200, await getQueueStatus(c.deps.queues, c.deps.clock ?? systemClock));
      },
    }),
    defineRoute({
      method: 'get',
      path: '/system/dlq',
      operationId: 'listDeadLetters',
      summary: 'Dead-lettered jobs (newest first)',
      tag: 'system',
      auth: 'session',
      permission: ['system:manage'],
      rateClass: 'read',
      query: PageQuerySchema,
      responses: { 200: { description: 'Page of dead letters', schema: pageOf(DeadLetterEntrySchema) } },
      async handler(c) {
        sendJson(
          c.res,
          200,
          await c.deps.queues.listDeadLetters({
            limit: c.query.limit,
            ...(c.query.cursor !== undefined ? { cursor: c.query.cursor } : {}),
          }),
        );
      },
    }),
    defineRoute({
      method: 'get',
      path: '/system/mcp',
      operationId: 'getMcpStatus',
      summary: 'Code index status and recent operations',
      tag: 'system',
      auth: 'any',
      permission: ['system:read'],
      rateClass: 'read',
      responses: { 200: { description: 'MCP status', schema: McpStatusSchema } },
      async handler(c) {
        sendJson(c.res, 200, await c.deps.projects.mcpStatus(c.viewer()));
      },
    }),
    defineRoute({
      method: 'get',
      path: '/audit-logs',
      operationId: 'listAuditLogs',
      summary: 'Audit log (newest first)',
      tag: 'system',
      auth: 'any',
      permission: ['audit:read'],
      rateClass: 'read',
      query: AuditLogQuerySchema,
      responses: { 200: { description: 'Page of audit records', schema: pageOf(AuditLogSchema) } },
      async handler(c) {
        const q = c.query;
        const filters = {
          actorUserId: q.actorUserId ?? null,
          action: q.action ?? null,
          entityType: q.entityType ?? null,
          entityId: q.entityId ?? null,
          from: q.from ?? null,
          to: q.to ?? null,
        };
        const after = keysetFromCursor(q.cursor, filters);
        const rows = await c.deps.db.repos.audit.list({
          limit: q.limit,
          ...(after ? { after } : {}),
          ...(q.actorUserId !== undefined ? { actorUserId: q.actorUserId } : {}),
          ...(q.action !== undefined ? { action: q.action } : {}),
          ...(q.entityType !== undefined ? { entityType: q.entityType } : {}),
          ...(q.entityId !== undefined ? { entityId: q.entityId } : {}),
          ...(q.from !== undefined ? { from: new Date(q.from) } : {}),
          ...(q.to !== undefined ? { to: new Date(q.to) } : {}),
        });
        const items: AuditLog[] = rows.slice(0, q.limit);
        const last = items[items.length - 1];
        const nextCursor =
          rows.length > q.limit && last
            ? encodeCursor({ k: [last.occurredAt, last.id], f: filterHash(filters) })
            : null;
        sendJson(c.res, 200, { items, nextCursor });
      },
    }),
    defineRoute({
      method: 'get',
      path: '/health/live',
      operationId: 'healthLive',
      summary: 'Liveness (process only)',
      tag: 'health',
      auth: 'public',
      rateClass: null,
      responses: { 200: { description: 'Alive', schema: HealthSchema } },
      handler(c) {
        const body: Health = {
          status: 'ok',
          version: c.deps.config.appVersion,
          uptimeSeconds: uptimeSeconds(c.deps),
          checks: { process: { status: 'ok', latencyMs: null, detail: null } },
        };
        sendJson(c.res, 200, body);
        return Promise.resolve();
      },
    }),
    defineRoute({
      method: 'get',
      path: '/health/ready',
      operationId: 'healthReady',
      summary: 'Readiness (db ping, redis ping, schema version)',
      tag: 'health',
      auth: 'public',
      rateClass: null,
      responses: {
        200: { description: 'Ready', schema: HealthSchema },
        503: { description: 'Not ready', schema: HealthSchema },
      },
      async handler(c) {
        const health = await readiness(c.deps);
        if (health.status !== 'ok') c.res.setHeader('Retry-After', '5');
        sendJson(c.res, health.status === 'ok' ? 200 : 503, health);
      },
    }),
    defineRoute({
      method: 'get',
      path: '/problems/:code',
      operationId: 'getProblemType',
      summary: 'Problem type documentation entry',
      tag: 'meta',
      auth: 'public',
      rateClass: 'public',
      params: ProblemParams,
      responses: {
        200: { description: 'Error catalogue entry', schema: ErrorCatalogEntrySchema },
        404: { description: 'not_found' },
      },
      handler(c) {
        const code = c.params.code;
        if (!(ERROR_CODES as readonly string[]).includes(code)) {
          throw new NotFoundError('Unknown problem type');
        }
        sendJson(c.res, 200, ERROR_CATALOG[code as ErrorCode]);
        return Promise.resolve();
      },
    }),
  ];
}
