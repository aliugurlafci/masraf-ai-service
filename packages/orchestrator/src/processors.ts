// BullMQ processors (contract §6.4) and the QueueEvents dead-letter handler.
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import {
  GUID_REGEX,
  JOB_NAMES,
  ProjectJobDataSchema,
  RunAttemptJobDataSchema,
  isOrcError,
  systemClock,
  toIso,
} from '@orc/shared';
import type { ProjectJobData, Uuid } from '@orc/shared';
import type { Actor, ProjectRecord } from '@orc/database';
import { PathEscapeError } from '@orc/security';
import { GitRefNotFoundError, GitRepoInvalidError } from '@orc/git-manager';
import { runWithLogContext, serializeError } from '@orc/logger';
import { classifyJobFailure } from './outcome.js';
import { errorMessage } from './util.js';
import type {
  ActiveAttemptRegistry,
  AttemptOutcome,
  AttemptPipeline,
  OrchestratorDeps,
} from './types.js';

const FAILED_REASON_MAX = 2000;
const DETAIL_MAX = 1000;

function zodSummary(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 5)
    .map((i) => `${i.path.map((p) => String(p)).join('.') || '(root)'}: ${i.message}`)
    .join('; ')
    .slice(0, 500);
}

/** `run-attempt` processor (§6.4). */
export function createRunAttemptProcessor(
  deps: OrchestratorDeps & { active: ActiveAttemptRegistry; pipeline: AttemptPipeline },
): (job: Job<unknown>) => Promise<AttemptOutcome> {
  return async (job) => {
    if (job.name !== JOB_NAMES.runAttempt) {
      throw new UnrecoverableError(`invalid:unexpected job name ${job.name}`);
    }
    const parsed = RunAttemptJobDataSchema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError(`invalid:${zodSummary(parsed.error.issues)}`);
    const data = parsed.data;
    const outcome = await runWithLogContext(
      {
        taskId: data.taskId,
        attemptId: data.attemptId,
        jobId: job.id ?? data.attemptId,
        queue: 'orc-tasks',
        workerId: deps.config.workerId,
        ...(data.correlationId !== null ? { correlationId: data.correlationId } : {}),
      },
      () => deps.pipeline.run(data, new AbortController().signal),
    );
    if (outcome.status === 'failed' || outcome.status === 'timed_out' || outcome.status === 'blocked') {
      throw new UnrecoverableError(`business:${outcome.reason ?? outcome.status}`);
    }
    return outcome;
  };
}

const PROJECT_ACTOR = (workerId: string): Actor => ({ type: 'worker', workerId });

function isSourceInvalid(err: unknown): boolean {
  if (err instanceof GitRepoInvalidError || err instanceof GitRefNotFoundError || err instanceof PathEscapeError) return true;
  return isOrcError(err) && (err.code === 'validation_failed' || err.code === 'unsafe_argument');
}

/** Sync mirror + base snapshot (+ base workspace row). Returns the snapshot head. */
async function syncProject(deps: OrchestratorDeps, project: ProjectRecord, correlationId: string | null): Promise<{ defaultBranch: string; headSha: string; path: string }> {
  const ctx = { projectId: project.id, taskId: null, attemptId: null, correlationId };
  const info = await deps.git.validateSource(project.repoPath, ctx);
  await deps.git.syncMirror(project.id, project.repoPath, ctx);
  const defaultBranch = project.defaultBranch ?? info.defaultBranch;
  const headSha = await deps.git.resolveBase(project.id, defaultBranch, ctx);
  const snap = await deps.git.refreshBaseSnapshot(project.id, headSha, ctx);
  const repos = deps.db.repos;
  let base = await repos.workspaces.findBase(project.id);
  if (base === null) {
    base = await repos.workspaces.insert({
      projectId: project.id,
      taskId: null,
      kind: 'base',
      createdByAttemptId: null,
      path: `${project.id}/_base`,
      branchName: null,
      baseSha: snap.sha,
      quotaBytes: deps.config.workspaceMaxBytes,
      workerId: deps.config.workerId,
    });
  }
  await repos.workspaces.setStatus(base.id, 'ready', { headSha: snap.sha });
  return { defaultBranch, headSha: snap.sha, path: snap.path };
}

async function runProjectIndex(
  deps: OrchestratorDeps,
  project: ProjectRecord,
  snapshot: { headSha: string; path: string },
  o: { existingOperationId?: Uuid; correlationId: string | null },
): Promise<void> {
  const repos = deps.db.repos;
  const actor = PROJECT_ACTOR(deps.config.workerId);
  const recorder = deps.mcpRecorder;
  recorder?.setProjectHead(project.id, snapshot.headSha);
  const outcome = await deps.mcp.index(
    { kind: 'project', projectId: project.id, path: snapshot.path },
    {
      mode: 'full', // ADR-0030: project_index always full (+ doc_candidates)
      kind: 'project_index',
      ...(o.existingOperationId !== undefined ? { existingOperationId: o.existingOperationId } : {}),
    },
  );
  if (outcome.status === 'succeeded') {
    await repos.projects.updateIndexState(project.id, { lastIndexOperationId: outcome.operationId, indexedAt: true });
  }
  await repos.audit.insert({
    action: outcome.status === 'succeeded' ? 'project.indexed' : 'project.index_failed',
    actor,
    entityType: 'project',
    entityId: project.id,
    outcome: outcome.status === 'succeeded' ? 'success' : 'failure',
    detail: {
      operationId: outcome.operationId,
      nodeCount: outcome.nodeCount,
      edgeCount: outcome.edgeCount,
      errorCode: outcome.errorCode,
      headSha: snapshot.headSha,
    },
    correlationId: o.correlationId,
  });
}

/** `sync-project` / `index-project` processor (§6.4 project processor). */
export function createProjectJobProcessor(deps: OrchestratorDeps): (job: Job<unknown>) => Promise<void> {
  const repos = deps.db.repos;
  const actor = PROJECT_ACTOR(deps.config.workerId);

  const sync = async (d: Extract<ProjectJobData, { kind: 'sync' }>): Promise<void> => {
    const project = await repos.projects.findById(d.projectId);
    if (project === null || project.status === 'archived' || project.archivedAt !== null) return;
    let snap: Awaited<ReturnType<typeof syncProject>>;
    try {
      snap = await syncProject(deps, project, d.correlationId);
    } catch (err) {
      if (!isSourceInvalid(err)) throw err;
      const detail = errorMessage(err).slice(0, DETAIL_MAX);
      await repos.projects.updateSyncState(project.id, { status: 'invalid', statusDetail: detail, synced: false });
      await repos.audit.insert({
        action: 'project.sync_failed',
        actor,
        entityType: 'project',
        entityId: project.id,
        outcome: 'failure',
        detail: { reason: detail },
        correlationId: d.correlationId,
      });
      return;
    }
    await repos.projects.updateSyncState(project.id, {
      status: 'ready',
      statusDetail: null,
      defaultBranch: snap.defaultBranch,
      headSha: snap.headSha,
      synced: true,
    });
    await repos.audit.insert({
      action: 'project.synced',
      actor,
      entityType: 'project',
      entityId: project.id,
      outcome: 'success',
      detail: { defaultBranch: snap.defaultBranch, headSha: snap.headSha },
      correlationId: d.correlationId,
    });
    if (project.autoIndex && deps.config.mcpEnabled) {
      if ((await repos.mcpOperations.findActiveProjectOp(project.id)) !== null) return;
      try {
        await runProjectIndex(deps, project, snap, { correlationId: d.correlationId });
      } catch (err) {
        if (isOrcError(err) && (err.code === 'unique_violation' || err.code === 'index_in_progress')) return;
        throw err;
      }
    }
  };

  const index = async (d: Extract<ProjectJobData, { kind: 'index' }>, attemptsMade: number): Promise<void> => {
    if (!(await repos.mcpOperations.markRunning(d.operationId, deps.config.workerId))) {
      // A BullMQ retry of this job finds the row still `running` from the failed previous try (markRunning accepts
      // only `queued`): adopt it, otherwise the retry would complete silently and leave the row running.
      if (attemptsMade === 0) return;
      const op = await repos.mcpOperations.findById(d.operationId);
      if (op === null || op.status !== 'running') return;
    }
    const project = await repos.projects.findById(d.projectId);
    if (project === null || project.status !== 'ready' || !deps.config.mcpEnabled) {
      await repos.mcpOperations.finish(d.operationId, {
        status: deps.config.mcpEnabled ? 'failed' : 'skipped',
        nodeCount: null,
        edgeCount: null,
        result: null,
        errorCode: deps.config.mcpEnabled ? 'mcp_unavailable' : null,
        errorMessage: project === null ? 'project not found' : deps.config.mcpEnabled ? `project is ${project.status}` : 'MCP disabled',
        durationMs: 0,
      });
      return;
    }
    const snap = await syncProject(deps, project, d.correlationId);
    await runProjectIndex(deps, project, snap, { existingOperationId: d.operationId, correlationId: d.correlationId });
  };

  return async (job) => {
    const parsed = ProjectJobDataSchema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError(`invalid:${zodSummary(parsed.error.issues)}`);
    const d = parsed.data;
    await runWithLogContext(
      {
        projectId: d.projectId,
        jobId: job.id ?? '',
        queue: 'orc-projects',
        workerId: deps.config.workerId,
        ...(d.correlationId !== null ? { correlationId: d.correlationId } : {}),
      },
      () => (d.kind === 'sync' ? sync(d) : index(d, job.attemptsMade)),
    );
  };
}

/** QueueEvents 'failed' listener for orc-tasks and orc-projects (§6.4 step 6, T-m1). */
export function createDeadLetterHandler(
  deps: OrchestratorDeps,
): (e: { queue: 'orc-tasks' | 'orc-projects'; jobId: string; failedReason: string }) => Promise<void> {
  const clock = deps.clock ?? systemClock;
  const repos = deps.db.repos;
  const actor: Actor = { type: 'worker', workerId: deps.config.workerId };

  const tasksFailed = async (jobId: string, failedReason: string): Promise<void> => {
    const job = await deps.queues.tasks.getJob(jobId);
    const decision = classifyJobFailure({
      failedReason,
      attemptsMade: job ? job.attemptsMade : null,
      attempts: job ? (job.opts.attempts ?? 1) : null,
      jobMissing: !job,
    });
    if (decision === 'ignore') return;
    if (decision === 'retry') {
      deps.logger.warn({ jobId, failedReason: failedReason.slice(0, 500) }, 'run-attempt job failed; BullMQ will retry');
      return;
    }
    const invalid = failedReason.startsWith('invalid:');
    const parsed = RunAttemptJobDataSchema.safeParse(job?.data);
    const attemptId = parsed.success ? parsed.data.attemptId : GUID_REGEX.test(jobId) ? jobId : null;
    await deps.queues.deadLetter({
      v: 1,
      sourceQueue: 'orc-tasks',
      jobName: job?.name ?? 'run-attempt',
      jobId,
      data: job?.data ?? null,
      failedReason: failedReason.slice(0, FAILED_REASON_MAX),
      attemptsMade: job?.attemptsMade ?? 0,
      failedAt: toIso(clock.now()),
    });
    let failed = false;
    if (attemptId !== null) {
      failed = await deps.tasks.failUnclaimedAttempt({
        attemptId,
        reason: invalid ? 'invalid_job' : 'queue_exhausted',
        detail: failedReason.slice(0, DETAIL_MAX),
      });
    }
    await repos.audit.insert({
      action: 'queue.job_dead_lettered',
      actor,
      entityType: attemptId !== null ? 'attempt' : 'system',
      entityId: attemptId ?? jobId,
      outcome: 'failure',
      detail: { queue: 'orc-tasks', jobId, failedReason: failedReason.slice(0, DETAIL_MAX), attemptFailed: failed },
    });
    deps.logger.error({ jobId, attemptId, failedReason: failedReason.slice(0, 500) }, 'run-attempt job dead-lettered');
  };

  const projectsFailed = async (jobId: string, failedReason: string): Promise<void> => {
    const job = await deps.queues.projects.getJob(jobId);
    const decision = classifyJobFailure({
      failedReason,
      attemptsMade: job ? job.attemptsMade : null,
      attempts: job ? (job.opts.attempts ?? 1) : null,
      jobMissing: !job,
    });
    if (decision === 'ignore') return;
    if (decision === 'retry') {
      deps.logger.warn({ jobId, failedReason: failedReason.slice(0, 500) }, 'project job failed; BullMQ will retry');
      return;
    }
    const reason = failedReason.slice(0, DETAIL_MAX);
    if (jobId.startsWith('sync-')) {
      const projectId = jobId.slice('sync-'.length);
      if (!GUID_REGEX.test(projectId)) return;
      const project = await repos.projects.findById(projectId);
      if (project === null || project.status === 'archived') return;
      await repos.projects.updateSyncState(projectId, { status: 'invalid', statusDetail: `sync failed: ${reason}`, synced: false });
      await repos.audit.insert({
        action: 'project.sync_failed',
        actor,
        entityType: 'project',
        entityId: projectId,
        outcome: 'failure',
        detail: { jobId, reason },
      });
    } else if (jobId.startsWith('index-')) {
      const operationId = jobId.slice('index-'.length);
      if (!GUID_REGEX.test(operationId)) return;
      const op = await repos.mcpOperations.findById(operationId);
      if (op === null || (op.status !== 'queued' && op.status !== 'running')) return;
      await repos.mcpOperations.finish(operationId, {
        status: 'failed',
        nodeCount: null,
        edgeCount: null,
        result: null,
        errorCode: 'mcp_unavailable',
        errorMessage: `index job failed: ${reason}`,
        durationMs: 0,
      });
      await repos.audit.insert({
        action: 'project.index_failed',
        actor,
        entityType: 'index_operation',
        entityId: operationId,
        outcome: 'failure',
        detail: { jobId, reason, projectId: op.projectId },
      });
    }
  };

  return async (e) => {
    try {
      if (e.queue === 'orc-tasks') await tasksFailed(e.jobId, e.failedReason);
      else await projectsFailed(e.jobId, e.failedReason);
    } catch (err) {
      deps.logger.error({ err: serializeError(err), queue: e.queue, jobId: e.jobId }, 'dead-letter handling failed');
    }
  };
}
