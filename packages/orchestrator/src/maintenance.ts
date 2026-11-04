// Maintenance processors, job schedulers, orphan sweep and startup recovery (contract §6.5, §10.8, §11.6, §14.2).
import { rm } from 'node:fs/promises';
import { JOB_NAMES, MaintenanceJobDataSchema, systemClock } from '@orc/shared';
import type { MaintenanceReport, Uuid } from '@orc/shared';
import { sweepOrphans } from '@orc/shared/node';
import type { LeaseInfo, ProcessRegistry, SweepReport } from '@orc/shared/node';
import type { Actor, ListOpts, ProjectRecord } from '@orc/database';
import { MAINTENANCE_JOB_OPTIONS } from '@orc/task-manager';
import type { QueueRegistry } from '@orc/task-manager';
import { resolveWithin } from '@orc/security';
import { serializeError } from '@orc/logger';
import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { workerHeartbeatKey } from './pipeline.js';
import { testProcessKey } from './test-runner.js';
import { errorMessage, sleep } from './util.js';
import type { ActiveAttemptRegistry, OrchestratorDeps } from './types.js';

const RETENTION_MAX_RUN_MS = 60_000;
const RETENTION_PAUSE_MS = 100;
const DLQ_RETENTION_MS = 30 * 86_400_000;
const OFFLINE_WORKER_RETENTION_MS = 7 * 86_400_000;
const STALE_WORKER_MS = 60_000;
const CLEANUP_LIMIT = 100;
const RECOVERY_LIMIT = 100;
const PAGE = 200;
const DAY_MS = 86_400_000;
const REL_PATH_RE = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\/a(\d+)$/;
const BRANCH_KEY_RE = /^orc\/task-([0-9a-f]+)-a(\d+)$/;

/** §6.5 schedulers (worker side; `auth-cleanup` belongs to the API). */
export const WORKER_JOB_SCHEDULERS: readonly { id: string; every: number }[] = [
  { id: JOB_NAMES.retention, every: 3_600_000 },
  { id: JOB_NAMES.workspaceCleanup, every: 900_000 },
  { id: JOB_NAMES.staleAttemptRecovery, every: 30_000 },
  { id: JOB_NAMES.queuedReconciler, every: 60_000 },
  { id: JOB_NAMES.staleWorkers, every: 60_000 },
  { id: JOB_NAMES.mirrorGc, every: 86_400_000 },
];

export async function registerJobSchedulers(queues: QueueRegistry): Promise<void> {
  for (const s of WORKER_JOB_SCHEDULERS) {
    await queues.maintenance.upsertJobScheduler(
      s.id,
      { every: s.every },
      { name: s.id, data: { v: 1 }, opts: { ...MAINTENANCE_JOB_OPTIONS } },
    );
  }
}

interface ReleasableLauncher {
  releaseLease(id: string): Promise<unknown>;
}

function canRelease(l: unknown): l is ReleasableLauncher {
  return typeof l === 'object' && l !== null && typeof (l as { releaseLease?: unknown }).releaseLease === 'function';
}

/** Registry view without git processes of live (or unattributed) operations: safe for periodic sweeps. */
function periodicView(registry: ProcessRegistry, active: ReadonlySet<Uuid>): ProcessRegistry {
  return {
    add: (e) => registry.add(e),
    remove: (k) => registry.remove(k),
    list: async () =>
      (await registry.list()).filter((e) => e.kind !== 'git' || (e.attemptId !== null && !active.has(e.attemptId))),
  };
}

/**
 * Orphan sweep (§10.8): local mode = registry entries + marker scan; runner mode = release this worker's leases whose
 * attempt is not active. Every kill => TaskEvent `orphan_killed` + audit `security.orphan_killed`.
 */
export async function sweepWorkerOrphans(
  deps: OrchestratorDeps & { active: ActiveAttemptRegistry },
  o: { startup: boolean } = { startup: false },
): Promise<SweepReport> {
  const cfg = deps.config;
  const activeIds = new Set(deps.active.list().map((a) => a.attemptId));
  let report: SweepReport;
  if (deps.launcher.mode === 'local') {
    const activeKeys = new Set<string>();
    for (const id of activeIds) {
      activeKeys.add(`claude-${id}`);
      activeKeys.add(testProcessKey(id));
    }
    report = await sweepOrphans({
      registry: o.startup ? deps.registry : periodicView(deps.registry, activeIds),
      activeKeys,
      activeAttemptIds: activeIds,
      platform: cfg.platform,
      markerEnv: 'ORC_ATTEMPT_ID',
      ...(deps.spawn ? { spawn: deps.spawn } : {}),
    });
  } else {
    report = { checked: 0, killed: [], errors: [] };
    let leases: LeaseInfo[] = [];
    try {
      leases = await deps.launcher.listLeases();
    } catch (err) {
      report.errors.push(`listLeases: ${errorMessage(err)}`);
    }
    for (const lease of leases) {
      if (lease.workerId !== cfg.workerId) continue;
      report.checked += 1;
      if (lease.attemptId !== null && activeIds.has(lease.attemptId)) continue;
      if (lease.attemptId === null && !o.startup) continue;
      if (!canRelease(deps.launcher)) {
        report.errors.push('launcher cannot release leases by id');
        break;
      }
      try {
        await deps.launcher.releaseLease(lease.id);
        for (const pid of lease.pids) report.killed.push({ pid, key: lease.key, via: 'registry' });
      } catch (err) {
        report.errors.push(`release ${lease.key}: ${errorMessage(err)}`);
      }
    }
  }
  await recordOrphanKills(deps, report);
  return report;
}

async function recordOrphanKills(deps: OrchestratorDeps, report: SweepReport): Promise<void> {
  const repos = deps.db.repos;
  const actor: Actor = { type: 'worker', workerId: deps.config.workerId };
  for (const k of report.killed) {
    const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(k.key);
    const attemptId = m?.[1] ?? null;
    try {
      const attempt = attemptId !== null ? await repos.attempts.findById(attemptId) : null;
      if (attempt !== null) {
        await repos.taskEvents.insert({
          taskId: attempt.taskId,
          attemptId: attempt.id,
          type: 'orphan_killed',
          fromStatus: null,
          toStatus: null,
          actorType: 'worker',
          actorUserId: null,
          actorLabel: deps.config.workerId,
          reason: null,
          data: { pid: k.pid, key: k.key, via: k.via },
          correlationId: attempt.correlationId,
        });
      }
      await repos.audit.insert({
        action: 'security.orphan_killed',
        actor,
        entityType: attempt !== null ? 'attempt' : 'worker',
        entityId: attempt?.id ?? deps.config.workerId,
        outcome: 'success',
        detail: { pid: k.pid, key: k.key, via: k.via },
      });
    } catch (err) {
      deps.logger.warn({ err: serializeError(err), key: k.key }, 'orphan kill record failed');
    }
  }
  if (report.killed.length > 0) deps.logger.warn({ killed: report.killed }, 'orphan processes killed');
}

/** §14.2 step 5: sweep orphans, then recover every active attempt still owned by this worker id. */
export async function recoverOnStartup(
  deps: OrchestratorDeps & { active: ActiveAttemptRegistry },
): Promise<{ swept: SweepReport; recovered: number }> {
  const swept = await sweepWorkerOrphans(deps, { startup: true });
  let recovered = 0;
  for (const a of await deps.db.repos.attempts.findActiveByWorker(deps.config.workerId)) {
    if (deps.active.get(a.id) !== undefined) continue;
    const decision = await deps.tasks.recoverInterruptedAttempt({
      attemptId: a.id,
      reason: 'worker_lost',
      workerId: deps.config.workerId,
    });
    if (decision.kind !== 'noop') recovered += 1;
    deps.logger.info({ attemptId: a.id, decision }, 'startup recovery of an attempt of this worker');
  }
  return { swept, recovered };
}

async function* allProjects(deps: OrchestratorDeps, status?: ProjectRecord['status']): AsyncGenerator<ProjectRecord> {
  let after: ListOpts['after'];
  for (;;) {
    const rows = await deps.db.repos.projects.list({ limit: PAGE, ...(after ? { after } : {}), ...(status ? { status } : {}) });
    const page = rows.slice(0, PAGE);
    for (const p of page) yield p;
    if (rows.length <= PAGE) return;
    const last = page[page.length - 1] as ProjectRecord;
    after = { createdAt: last.createdAt, id: last.id };
  }
}

/** `orc-maintenance` processor (§6.5). */
export function createMaintenanceProcessor(
  deps: OrchestratorDeps & { active: ActiveAttemptRegistry },
): (job: Job<unknown>) => Promise<MaintenanceReport> {
  const clock = deps.clock ?? systemClock;
  const cfg = deps.config;
  const repos = deps.db.repos;
  const actor: Actor = { type: 'worker', workerId: cfg.workerId };

  const retention = async (counts: Record<string, number>, errors: string[]): Promise<void> => {
    const startedMs = clock.nowMs();
    const now = clock.nowMs();
    const batch = cfg.retention.batchSize;
    const batched = async (name: string, fn: () => Promise<number>): Promise<void> => {
      let total = 0;
      try {
        for (;;) {
          if (clock.nowMs() - startedMs > RETENTION_MAX_RUN_MS) break;
          const n = await fn();
          total += n;
          if (n < batch) break;
          await sleep(RETENTION_PAUSE_MS);
        }
      } catch (err) {
        errors.push(`${name}: ${errorMessage(err)}`);
      }
      counts[name] = total;
    };
    await batched('taskLogs', () => repos.taskLogs.deleteOlderThan(new Date(now - cfg.retention.logDays * DAY_MS), batch));
    await batched('gitOperations', () => repos.gitOperations.deleteOlderThan(new Date(now - cfg.retention.gitOpsDays * DAY_MS), batch));
    await batched('mcpOperations', () => repos.mcpOperations.deleteOlderThan(new Date(now - cfg.retention.mcpOpsDays * DAY_MS), batch));
    await batched('changedFilePatches', () => repos.changedFiles.purgePatchesOlderThan(new Date(now - cfg.retention.patchDays * DAY_MS), batch));
    await batched('attemptPatches', () => repos.patches.purgeOlderThan(new Date(now - cfg.retention.patchDays * DAY_MS), batch));
    try {
      counts.workerNodes = await repos.workerNodes.deleteOfflineOlderThan(new Date(now - OFFLINE_WORKER_RETENTION_MS));
    } catch (err) {
      errors.push(`workerNodes: ${errorMessage(err)}`);
    }
    try {
      counts.deadLetters = (await deps.queues.tasksDlq.clean(DLQ_RETENTION_MS, batch, 'wait')).length;
    } catch (err) {
      errors.push(`deadLetters: ${errorMessage(err)}`);
    }
    await repos.audit.insert({
      action: 'maintenance.retention_run',
      actor,
      entityType: 'system',
      entityId: null,
      outcome: errors.length === 0 ? 'success' : 'failure',
      detail: { counts, errors },
    });
  };

  const releaseStaleLeases = async (attemptIds: ReadonlySet<Uuid>): Promise<void> => {
    if (attemptIds.size === 0 || !canRelease(deps.launcher)) return;
    const launcher = deps.launcher;
    let leases: LeaseInfo[];
    try {
      leases = await deps.launcher.listLeases();
    } catch {
      return;
    }
    for (const l of leases) {
      if (l.attemptId !== null && attemptIds.has(l.attemptId) && !deps.active.get(l.attemptId)) {
        await launcher.releaseLease(l.id);
      }
    }
  };

  const workspaceCleanup = async (counts: Record<string, number>, errors: string[]): Promise<void> => {
    counts.workspacesRemoved = 0;
    counts.branchesDeleted = 0;
    counts.baseSnapshotsRemoved = 0;
    for (const ws of await repos.workspaces.findForCleanup(CLEANUP_LIMIT)) {
      const ctx = { projectId: ws.projectId, taskId: ws.taskId, attemptId: null, correlationId: null };
      try {
        const m = REL_PATH_RE.exec(ws.path);
        if (!m || ws.taskId === null) throw new Error(`unexpected workspace path ${ws.path}`);
        const [, projectId, taskId, n] = m as unknown as [string, string, string, string];
        const attempts = await repos.attempts.listByTask(ws.taskId);
        await releaseStaleLeases(new Set(attempts.filter((a) => a.workspaceId === ws.id).map((a) => a.id)));
        await repos.workspaces.setStatus(ws.id, 'removing');
        await deps.git.removeWorktree({ projectId: ws.projectId, relPath: ws.path }, ctx);
        if (cfg.mcpEnabled && ws.createdByAttemptId !== null) {
          const keyMatch = ws.branchName !== null ? BRANCH_KEY_RE.exec(ws.branchName) : null;
          const k = keyMatch?.[1]?.length;
          await deps.mcp.deleteIndex({
            kind: 'workspace',
            projectId,
            workspaceId: ws.id,
            taskId,
            attemptId: ws.createdByAttemptId,
            attemptNumber: Number(n),
            path: resolveWithin(cfg.workspacesRoot, projectId, taskId, `a${n}`),
            keyLength: k === 12 ? 12 : k === 32 ? 32 : 8,
          });
        } else {
          await rm(resolveWithin(cfg.cbmCacheRoot, 'w', ws.id), { recursive: true, force: true });
        }
        await rm(resolveWithin(cfg.workspacesRoot, projectId, taskId, `a${n}.meta`), { recursive: true, force: true, maxRetries: 3 });
        await rm(resolveWithin(cfg.claudeHomeRoot, 'w', ws.id), { recursive: true, force: true, maxRetries: 3 });
        await repos.workspaces.setStatus(ws.id, 'removed');
        await repos.audit.insert({
          action: 'maintenance.workspace_removed',
          actor,
          entityType: 'project',
          entityId: ws.projectId,
          outcome: 'success',
          detail: { workspaceId: ws.id, path: ws.path, taskId: ws.taskId },
        });
        counts.workspacesRemoved += 1;
      } catch (err) {
        errors.push(`workspace ${ws.id}: ${errorMessage(err)}`);
        await repos.workspaces
          .setStatus(ws.id, 'error', { errorDetail: errorMessage(err).slice(0, 2000) })
          .catch(() => undefined);
      }
    }
    for (const ws of await repos.workspaces.findBranchesForDeletion(cfg.branchRetentionDays, CLEANUP_LIMIT)) {
      if (ws.branchName === null) continue;
      try {
        await deps.git.deleteBranch({ projectId: ws.projectId, branchName: ws.branchName }, { projectId: ws.projectId });
        await repos.workspaces.markBranchDeleted(ws.id);
        counts.branchesDeleted += 1;
      } catch (err) {
        errors.push(`branch ${ws.branchName}: ${errorMessage(err)}`);
      }
    }
    for await (const p of allProjects(deps, 'archived')) {
      try {
        const base = await repos.workspaces.findBase(p.id);
        if (base === null) continue;
        await repos.workspaces.setStatus(base.id, 'removing');
        await deps.git.removeWorktree({ projectId: p.id, relPath: `${p.id}/_base` }, { projectId: p.id });
        if (cfg.mcpEnabled) {
          await deps.mcp.deleteIndex({ kind: 'project', projectId: p.id, path: resolveWithin(cfg.workspacesRoot, p.id, '_base') });
        }
        await repos.workspaces.setStatus(base.id, 'removed');
        counts.baseSnapshotsRemoved += 1;
      } catch (err) {
        errors.push(`archived project ${p.id}: ${errorMessage(err)}`);
      }
    }
  };

  const staleAttemptRecovery = async (counts: Record<string, number>, errors: string[]): Promise<void> => {
    counts.recovered = 0;
    const rows = await repos.attempts.findStaleActive(cfg.attemptStaleMs, RECOVERY_LIMIT);
    for (const a of rows) {
      if (a.workerId === null) continue;
      let ownerGone: boolean;
      if (a.workerId === cfg.workerId) {
        // Own attempt that this process no longer runs (left after a DB outage): nobody else will hold it.
        ownerGone = deps.active.get(a.id) === undefined;
      } else {
        if (!deps.redisCommand) {
          errors.push('no redis command connection: skipped');
          break;
        }
        try {
          ownerGone = (await deps.redisCommand.exists(workerHeartbeatKey(cfg.redisPrefix, a.workerId))) === 0;
        } catch (err) {
          errors.push(`redis: ${errorMessage(err)}; skipped this run`);
          break; // F7: Redis error => skip this run
        }
      }
      if (!ownerGone) continue;
      try {
        const decision = await deps.tasks.recoverInterruptedAttempt({ attemptId: a.id, reason: 'worker_lost', workerId: cfg.workerId });
        if (decision.kind !== 'noop') counts.recovered += 1;
      } catch (err) {
        errors.push(`attempt ${a.id}: ${errorMessage(err)}`);
      }
    }
    counts.mcpOperationsFailed = await repos.mcpOperations.failStaleRunning(2 * cfg.mcpIndexTimeoutMs);
  };

  const mirrorGc = async (counts: Record<string, number>, errors: string[]): Promise<void> => {
    counts.mirrors = 0;
    for await (const p of allProjects(deps)) {
      if (p.status === 'archived' || p.status === 'validating') continue;
      try {
        await deps.git.gcMirror(p.id, { projectId: p.id });
        counts.mirrors += 1;
      } catch (err) {
        errors.push(`mirror ${p.id}: ${errorMessage(err)}`);
      }
    }
  };

  return async (job) => {
    const parsed = MaintenanceJobDataSchema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError('invalid:maintenance job data');
    const startedMs = clock.nowMs();
    const counts: Record<string, number> = {};
    const errors: string[] = [];
    switch (job.name) {
      case JOB_NAMES.retention:
        await retention(counts, errors);
        break;
      case JOB_NAMES.workspaceCleanup:
        await workspaceCleanup(counts, errors);
        break;
      case JOB_NAMES.staleAttemptRecovery:
        await staleAttemptRecovery(counts, errors);
        break;
      case JOB_NAMES.queuedReconciler:
        counts.repaired = await deps.tasks.reconcileQueued({ minAgeMs: 30_000, limit: 200 });
        break;
      case JOB_NAMES.staleWorkers:
        counts.markedOffline = await repos.workerNodes.markStaleOffline(STALE_WORKER_MS);
        break;
      case JOB_NAMES.mirrorGc:
        await mirrorGc(counts, errors);
        break;
      default:
        throw new UnrecoverableError(`invalid:unknown maintenance job ${job.name}`);
    }
    const report: MaintenanceReport = { job: job.name, durationMs: Math.max(0, clock.nowMs() - startedMs), counts, errors };
    if (errors.length > 0) deps.logger.warn({ report }, 'maintenance job finished with errors');
    else deps.logger.debug({ report }, 'maintenance job finished');
    return report;
  };
}
