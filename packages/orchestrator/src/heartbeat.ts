// Worker heartbeat (contract §13.1 self-fencing, §14.3).
import type { Redis } from 'ioredis';
import { systemClock, toIso } from '@orc/shared';
import type { Uuid, WorkerHeartbeat } from '@orc/shared';
import { serializeError } from '@orc/logger';
import { workerHeartbeatKey } from './pipeline.js';
import type { ActiveAttemptRegistry, Heartbeat, OrchestratorDeps, WorkerNodeInfo } from './types.js';

/** Three consecutive DB failures => readiness `fail` (§14.3). */
export const DB_FAILURES_UNHEALTHY = 3;

export interface HeartbeatDeps extends OrchestratorDeps {
  active: ActiveAttemptRegistry;
  redisCommand: Redis;
  workerInfo: () => Omit<WorkerHeartbeat, 'v' | 'at'>;
  /** WorkerNodes columns not carried by WorkerHeartbeat (additive). */
  nodeInfo?: () => WorkerNodeInfo;
  /** Called when the DB health of the heartbeat changes (3 failures => false; next success => true). */
  onDbHealth?: (healthy: boolean) => void;
}

export function createHeartbeat(deps: HeartbeatDeps): Heartbeat {
  const clock = deps.clock ?? systemClock;
  const cfg = deps.config;
  const { db, active, logger } = deps;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let ticks = 0;
  let consecutiveDbFailures = 0;
  let lastDbOkMs = clock.nowMs();
  let quotaChecks = true;
  let healthy = true;
  const startedAt = clock.now();

  const setHealth = (ok: boolean): void => {
    if (ok !== healthy) {
      healthy = ok;
      deps.onDbHealth?.(ok);
    }
  };

  const dbOk = (): void => {
    consecutiveDbFailures = 0;
    lastDbOkMs = clock.nowMs();
    setHealth(true);
  };

  const dbFailed = (err: unknown, what: string): void => {
    consecutiveDbFailures += 1;
    logger.warn({ err: serializeError(err), what, consecutiveDbFailures }, 'heartbeat database write failed');
    if (consecutiveDbFailures >= DB_FAILURES_UNHEALTHY) setHealth(false);
  };

  const live = () => active.list().filter((a) => active.supersededKind(a.attemptId) === null);

  const tickOnce = async (): Promise<void> => {
    ticks += 1;
    const info = deps.workerInfo();
    const node = deps.nodeInfo?.() ?? {
      appVersion: '0.0.0',
      cliVersion: cfg.cliVersion,
      mcpVersion: null,
      startedAt,
    };
    let dbAlive = false;
    try {
      let diskFreeBytes: number | null = null;
      try {
        diskFreeBytes = await deps.git.freeBytes();
      } catch {
        diskFreeBytes = null;
      }
      await db.repos.workerNodes.upsertHeartbeat({
        id: cfg.workerId,
        hostname: info.hostname,
        pid: info.pid,
        appVersion: node.appVersion,
        cliVersion: node.cliVersion,
        mcpVersion: node.mcpVersion,
        concurrency: info.concurrency,
        activeJobs: active.size(),
        status: info.status,
        diskFreeBytes,
        startedAt: node.startedAt,
      });
      dbAlive = true;
    } catch (err) {
      dbFailed(err, 'workerNodes.upsertHeartbeat');
    }

    if (dbAlive) {
      // The hb key is written only after a successful DB heartbeat: a worker that lost its DB lets it expire (F7).
      const hb: WorkerHeartbeat = { v: 1, ...info, at: toIso(clock.now()) };
      try {
        await deps.redisCommand.set(
          workerHeartbeatKey(cfg.redisPrefix, cfg.workerId),
          JSON.stringify(hb),
          'PX',
          3 * cfg.heartbeatIntervalMs,
        );
      } catch (err) {
        logger.warn({ err: serializeError(err) }, 'heartbeat key write failed');
      }
    }

    const attempts = live();
    if (attempts.length > 0 && dbAlive) {
      const ids = attempts.map((a) => a.attemptId);
      try {
        const owned = new Set<Uuid>(await db.repos.attempts.heartbeat(ids, cfg.workerId));
        dbOk();
        for (const id of ids) {
          if (!owned.has(id)) {
            logger.warn({ attemptId: id }, 'attempt missing from heartbeat result: superseded');
            active.supersede(id, 'superseded');
          }
        }
      } catch (err) {
        dbFailed(err, 'attempts.heartbeat');
      }
    } else if (dbAlive) {
      dbOk();
    }

    // Cancellation fallback poll (§5.4).
    const current = live();
    if (current.length > 0 && dbAlive) {
      try {
        const byTask = new Map(current.map((a) => [a.taskId, a.attemptId]));
        const requested = await db.repos.tasks.findCancelRequested([...byTask.keys()]);
        for (const r of requested) {
          const attemptId = byTask.get(r.id);
          if (attemptId !== undefined && active.abort(attemptId, 'cancel')) {
            logger.info({ attemptId }, 'cancel request found by heartbeat poll');
          }
        }
      } catch (err) {
        logger.warn({ err: serializeError(err) }, 'cancel poll failed');
      }
    }

    // Lock / lease renewal (a failed renew => superseded).
    for (const a of live()) {
      if (!a.hooks) continue;
      try {
        if (!(await a.hooks.renew())) {
          logger.warn({ attemptId: a.attemptId }, 'workspace lock or lease lost: superseded');
          active.supersede(a.attemptId, 'superseded');
        }
      } catch (err) {
        logger.warn({ err: serializeError(err), attemptId: a.attemptId }, 'lock/lease renewal failed: superseded');
        active.supersede(a.attemptId, 'superseded');
      }
    }

    // Quota checks every Nth tick for running/testing attempts (§11.6).
    if (quotaChecks && ticks % Math.max(1, cfg.quotaCheckEveryNthHeartbeat) === 0) {
      for (const a of live()) {
        if ((a.stage !== 'running' && a.stage !== 'testing') || !a.hooks) continue;
        try {
          const size = await a.hooks.measure();
          if (size !== null && (size.truncated || size.bytes > a.hooks.quotaBytes())) {
            logger.warn({ attemptId: a.attemptId, bytes: size.bytes }, 'workspace over quota: aborting');
            active.abort(a.attemptId, 'quota');
          }
        } catch (err) {
          logger.warn({ err: serializeError(err), attemptId: a.attemptId }, 'quota measurement failed');
        }
      }
    }

    evaluateFence();
  };

  // Self-fencing (F7): no successful DB heartbeat for selfFenceAfterMs => stop everything, no further writes.
  // Evaluated on every interval even while a previous tick is still blocked on a hung DB/Redis call.
  const evaluateFence = (): void => {
    if (clock.nowMs() - lastDbOkMs <= cfg.selfFenceAfterMs) return;
    for (const a of live()) {
      logger.error({ attemptId: a.attemptId }, 'self-fencing: database heartbeat lost');
      active.supersede(a.attemptId, 'fenced');
    }
  };

  const tick = (): Promise<void> => {
    if (running !== null) evaluateFence();
    running ??= tickOnce()
      .catch((err: unknown) => {
        logger.error({ err: serializeError(err) }, 'heartbeat tick failed');
      })
      .finally(() => {
        running = null;
      });
    return running;
  };

  return {
    start() {
      if (timer !== null) return;
      lastDbOkMs = clock.nowMs();
      void tick();
      timer = setInterval(() => {
        void tick();
      }, cfg.heartbeatIntervalMs);
      timer.unref?.();
    },
    async stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (running !== null) await running;
    },
    tick,
    get consecutiveDbFailures() {
      return consecutiveDbFailures;
    },
    disableQuotaChecks() {
      quotaChecks = false;
    },
  };
}
