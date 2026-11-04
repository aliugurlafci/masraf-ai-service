// Attempt pipeline (contract §5, §13): claim -> preparing_workspace -> indexing -> running -> testing ->
// reviewing -> completed, with cancellation checkpoints, deadline, superseded/fenced handling, artefact
// capture, workspace retention and infra recovery on shutdown.
import { randomBytes } from 'node:crypto';
import { mkdir, open, writeFile } from 'node:fs/promises';
import {
  ConflictError,
  PreconditionFailedError,
  cryptoIdGenerator,
  isOrcError,
  isSettledStatus,
  summarizeClaudeLine,
  systemClock,
  toIso,
} from '@orc/shared';
import type {
  ClaudeResultEvent,
  ClaudeResultSummary,
  FailureReason,
  ProjectStatus,
  RunAttemptJobData,
  SettledTaskStatus,
  TaskEventType,
  TaskStatus,
  Uuid,
  Workspace,
} from '@orc/shared';
import type { Actor, AgentRecord, AttemptRecord, ProjectRecord, TaskRecord } from '@orc/database';
import type { LaunchLease } from '@orc/shared/node';
import {
  PathEscapeError,
  PromptTooLargeError,
  ToolPolicyError,
  computeToolPolicy,
  isCommitSha,
  realpathWithin,
  resolveWithin,
} from '@orc/security';
import {
  GitRefNotFoundError,
  GitRepoInvalidError,
  InsufficientDiskSpaceError,
  WorkspaceQuotaError,
} from '@orc/git-manager';
import type { CollectedChanges, GitOpContext, WorkspaceLease, WorktreeInfo } from '@orc/git-manager';
import type { IndexScope } from '@orc/mcp-manager';
import { buildLayeredPrompt, claudeRegistryEntry, claudeProcessKey, toAbortReason } from '@orc/claude-runner';
import type {
  ClaudeOutcome,
  ClaudeRunHandlers,
  ClaudeRunRequest,
  ClaudeRunResult,
  ClaudeSessionSpec,
  PromptContinuation,
} from '@orc/claude-runner';
import { serializeError } from '@orc/logger';
import type { Logger } from '@orc/logger';
import { AbortedSignal, SettleSignal, SupersededSignal, WorkspaceBusySignal } from './errors.js';
import { createAttemptLogSink } from './log-sink.js';
import { claudeSessionStatusFor, mapAbortReason, mapClaudeOutcome, pendingTestReason } from './outcome.js';
import { createTestRunner } from './test-runner.js';
import { DbWriteAbandonedError, errorMessage, isBusyError, sleep, withDbRetry, withTimeout } from './util.js';
import type {
  AbortReason,
  ActiveAttempt,
  ActiveAttemptRegistry,
  AttemptLogSink,
  AttemptOutcome,
  AttemptPipeline,
  OrchestratorDeps,
  TestRunner,
} from './types.js';

type WorkspaceScope = Extract<IndexScope, { kind: 'workspace' }>;
type PipelineDeps = OrchestratorDeps & { active: ActiveAttemptRegistry; testRunner?: TestRunner };

const MAX_TIMER_MS = 2_147_483_647;
const BUSY_POLL_MS = 1000;
const DETAIL_MAX = 2000;
const COMMIT_TITLE_MAX = 60;
const BRANCH_KEY_RE = /^orc\/task-([0-9a-f]+)-a(\d+)$/;
const REL_PATH_RE = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\/a(\d+)$/;

/** `<WORKSPACES_ROOT>/.orc/...` and the redis heartbeat key of a worker (§7). */
export function workerHeartbeatKey(prefix: string, workerId: string): string {
  return `${prefix}:worker:${workerId}:hb`;
}

export function commitMessage(task: { id: Uuid; title: string }, attempt: { id: Uuid; attemptNumber: number }): string {
  const title = task.title.replace(/[\r\n]+/g, ' ').trim().slice(0, COMMIT_TITLE_MAX);
  return [
    `orc: ${title}`,
    '',
    `Orc-Task-Id: ${task.id}`,
    `Orc-Attempt-Id: ${attempt.id}`,
    `Orc-Attempt-Number: ${attempt.attemptNumber}`,
    '',
  ].join('\n');
}

function keyLengthOf(branchName: string): 8 | 12 | 32 {
  const m = BRANCH_KEY_RE.exec(branchName);
  const len = m?.[1]?.length;
  return len === 12 ? 12 : len === 32 ? 32 : 8;
}

function int(v: number | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

export function resultSummary(r: ClaudeResultEvent | null, outcome: ClaudeOutcome): ClaudeResultSummary {
  return {
    status: claudeSessionStatusFor(outcome),
    resultSubtype: r?.subtype ?? null,
    isError: r?.is_error ?? null,
    stopReason: r?.stop_reason ?? null,
    terminalReason: r?.terminal_reason ?? null,
    numTurns: int(r?.num_turns),
    totalCostUsd: typeof r?.total_cost_usd === 'number' ? r.total_cost_usd : null,
    inputTokens: int(r?.usage?.input_tokens),
    outputTokens: int(r?.usage?.output_tokens),
    cacheCreationInputTokens: int(r?.usage?.cache_creation_input_tokens),
    cacheReadInputTokens: int(r?.usage?.cache_read_input_tokens),
    durationMs: int(r?.duration_ms),
    durationApiMs: int(r?.duration_api_ms),
    permissionDenialsCount: r?.permission_denials ? r.permission_denials.length : null,
    permissionDenials: r?.permission_denials ?? null,
    resultText: r?.result ?? null,
  };
}

/** Reads at most `maxBytes` of a file (UTF-8, a cut multi-byte sequence is replaced). */
async function readCapped(file: string, maxBytes: number): Promise<string> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, maxBytes));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

class AttemptRun {
  private readonly d: PipelineDeps;
  private readonly cfg: PipelineDeps['config'];
  private readonly clock;
  private readonly log: Logger;
  private readonly actor: Actor;
  readonly controller = new AbortController();
  private status: TaskStatus = 'preparing_workspace';
  private task: TaskRecord;
  private attempt: AttemptRecord;
  private readonly correlationId: string | null;
  private sink: AttemptLogSink;
  private deadlineTimer: NodeJS.Timeout | null = null;
  private registered: ActiveAttempt | null = null;

  private project: ProjectRecord | null = null;
  private agent: AgentRecord | null = null;
  private workspace: Workspace | null = null;
  private wt: WorktreeInfo | null = null;
  private reused = false;
  private worktreeReal: string | null = null;
  private metaDir: string | null = null;
  private scope: WorkspaceScope | null = null;
  private claudeMd: string | null = null;
  private lock: WorkspaceLease | null = null;
  private lease: LaunchLease | null = null;
  private claudeSpawned = false;
  private reviewStored = false;
  private indexAvailable = false;
  private pendingTest: FailureReason | null = null;
  private baseBranch = '';

  constructor(d: PipelineDeps, task: TaskRecord, attempt: AttemptRecord) {
    this.d = d;
    this.cfg = d.config;
    this.clock = d.clock ?? systemClock;
    this.task = task;
    this.attempt = attempt;
    this.correlationId = attempt.correlationId ?? task.correlationId;
    this.actor = { type: 'worker', workerId: d.config.workerId };
    this.log = d.logger.child({ taskId: task.id, attemptId: attempt.id, workerId: d.config.workerId });
    this.sink = createAttemptLogSink({ taskId: task.id, attemptId: attempt.id, startSeq: 0 }, d);
  }

  // ---- guards ---------------------------------------------------------------------------------

  private get signal(): AbortSignal {
    return this.controller.signal;
  }

  private superseded(): boolean {
    return this.d.active.supersededKind(this.attempt.id) !== null;
  }

  private checkpoint(): void {
    if (this.superseded()) throw new SupersededSignal(this.d.active.supersededKind(this.attempt.id) ?? 'superseded');
    if (this.signal.aborted) throw new AbortedSignal(toAbortReason(this.signal.reason));
  }

  /** Every DB write of the pipeline: superseded => none; transient errors retried (§13.1). */
  private async write<T>(what: string, fn: () => Promise<T>): Promise<T> {
    if (this.superseded()) throw new SupersededSignal(what);
    return withDbRetry(what, fn, {
      windowMs: this.cfg.dbWriteRetryWindowMs,
      clock: this.clock,
      onRetry: (err, n) => this.log.warn({ err: serializeError(err), attempt: n, what }, 'database write failed; retrying'),
    });
  }

  private systemLine(text: string, source: 'orchestrator' | 'git' | 'mcp' = 'orchestrator'): void {
    this.sink.write('system', source, `[orc] ${text}\n`);
  }

  private async event(type: TaskEventType, data: Record<string, unknown> | null, reason: FailureReason | null = null): Promise<void> {
    if (this.superseded()) return;
    try {
      await this.d.db.repos.taskEvents.insert({
        taskId: this.task.id,
        attemptId: this.attempt.id,
        type,
        fromStatus: null,
        toStatus: null,
        actorType: 'worker',
        actorUserId: null,
        actorLabel: this.cfg.workerId,
        reason,
        data,
        correlationId: this.correlationId,
      });
    } catch (err) {
      this.log.warn({ err: serializeError(err), type }, 'task event insert failed');
    }
  }

  private gitCtx(signal: AbortSignal = this.signal): GitOpContext {
    return {
      projectId: this.task.projectId,
      taskId: this.task.id,
      attemptId: this.attempt.id,
      correlationId: this.correlationId,
      signal,
    };
  }

  private async publishStatus(task: TaskRecord, previous: TaskStatus | null): Promise<void> {
    const at = toIso(this.clock.now());
    await this.d.publisher.publish(task.id, {
      v: 1,
      type: 'status',
      taskId: task.id,
      attemptId: this.attempt.id,
      attemptNumber: this.attempt.attemptNumber,
      status: task.status,
      previousStatus: previous,
      reason: task.statusReason,
      detail: task.statusDetail,
      cancelRequested: task.cancelRequestedAt !== null,
      at,
    });
    if (isSettledStatus(task.status)) {
      await this.d.publisher.publish(task.id, {
        v: 1,
        type: 'end',
        taskId: task.id,
        attemptId: this.attempt.id,
        status: task.status,
        reason: task.statusReason,
        at,
      });
      await this.d.publisher.expireSettled(task.id);
    }
  }

  private async transition(
    to: TaskStatus,
    o: { reason?: FailureReason | null; detail?: string | null; data?: Record<string, unknown> } = {},
  ): Promise<void> {
    const from = this.status;
    let task: TaskRecord;
    try {
      task = await this.write(`transition ${from}->${to}`, () =>
        this.d.db.repos.taskState.transition({
          taskId: this.task.id,
          from,
          to,
          attemptId: this.attempt.id,
          reason: o.reason ?? null,
          detail: o.detail === undefined || o.detail === null ? null : o.detail.slice(0, DETAIL_MAX),
          actor: this.actor,
          correlationId: this.correlationId,
          ...(o.data ? { data: o.data } : {}),
        }),
      );
    } catch (err) {
      if (err instanceof ConflictError || err instanceof PreconditionFailedError) {
        this.d.active.supersede(this.attempt.id, 'superseded');
        throw new SupersededSignal(`transition ${from}->${to} lost its CAS`);
      }
      throw err;
    }
    this.task = task;
    this.status = to;
    if (this.registered) this.registered.stage = to;
    this.systemLine(`status ${from} -> ${to}${o.reason ? ` (${o.reason})` : ''}`);
    await this.publishStatus(task, from);
  }

  // ---- lifecycle ----------------------------------------------------------------------------------

  async execute(external: AbortSignal): Promise<AttemptOutcome> {
    const onExternal = (): void => {
      if (!this.signal.aborted) this.controller.abort(toAbortReason(external.reason ?? 'worker_shutdown'));
    };
    external.addEventListener('abort', onExternal, { once: true });
    if (external.aborted) onExternal();
    this.registered = {
      attemptId: this.attempt.id,
      taskId: this.task.id,
      stage: 'preparing_workspace',
      startedAt: this.clock.now(),
      controller: this.controller,
      workspacePath: null,
      hooks: {
        renew: () => this.renew(),
        measure: async () => {
          const lease = this.lease;
          const path = this.worktreeReal;
          if (lease === null || path === null) return null;
          return lease.measure(path, this.cfg.sizeScanMaxEntries);
        },
        quotaBytes: () => (this.project === null ? Number.POSITIVE_INFINITY : this.quotaBytes()),
      },
    };
    this.d.active.register(this.registered);
    if (this.attempt.deadlineAt !== null) {
      const ms = Date.parse(this.attempt.deadlineAt) - this.clock.nowMs();
      this.deadlineTimer = setTimeout(
        () => {
          if (!this.signal.aborted) this.controller.abort('timeout' satisfies AbortReason);
        },
        Math.min(Math.max(0, ms), MAX_TIMER_MS),
      );
    }
    try {
      await this.d.publisher.persist(this.task.id);
      await this.publishStatus(this.task, 'queued');
      this.systemLine(`attempt #${this.attempt.attemptNumber} claimed by ${this.cfg.workerId} (mode ${this.attempt.mode})`);
      return await this.stages();
    } catch (err) {
      return await this.handleFailure(err);
    } finally {
      if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
      external.removeEventListener('abort', onExternal);
      this.d.active.unregister(this.attempt.id);
    }
  }

  private async stages(): Promise<AttemptOutcome> {
    await this.prepare();
    await this.indexStage();
    await this.runningStage();
    if (this.project?.testCommand) await this.testingStage();
    return this.reviewingStage();
  }

  /**
   * Workspace lock and lease renewal from the heartbeat (false => ownership lost). A failed lease renewal is not an
   * ownership conflict: the runner restarted (all leases released), crashed or expired the lease, so the attempt is
   * interrupted as `worker_lost` (infra recovery, §10.11 items 3 and 5) while this worker keeps its DB ownership.
   */
  private async renew(): Promise<boolean> {
    if (this.lock !== null && !(await this.lock.renew())) return false;
    const lease = this.lease;
    if (lease !== null) {
      try {
        await lease.renew();
      } catch (err) {
        if (this.lease === lease) {
          this.log.error({ err: serializeError(err), leaseKey: lease.key }, 'attempt lease renewal failed: runner lost');
          this.d.active.markRunnerLost(this.attempt.id);
        }
      }
    }
    return true;
  }

  // ---- preparing_workspace ------------------------------------------------------------------------

  private stageError(err: unknown, status: SettledTaskStatus, reason: FailureReason): never {
    if (this.signal.aborted || this.superseded()) throw err;
    if (
      err instanceof SettleSignal ||
      err instanceof SupersededSignal ||
      err instanceof AbortedSignal ||
      err instanceof DbWriteAbandonedError ||
      err instanceof WorkspaceBusySignal
    ) {
      throw err;
    }
    throw new SettleSignal(status, reason, errorMessage(err));
  }

  private async prepare(): Promise<void> {
    const repos = this.d.db.repos;
    const project = await this.write('load project', () => repos.projects.findById(this.task.projectId));
    const unavailable: readonly ProjectStatus[] = ['invalid', 'archived', 'validating'];
    if (project === null || unavailable.includes(project.status) || project.archivedAt !== null) {
      throw new SettleSignal('blocked', 'project_unavailable', project ? `project is ${project.status}` : 'project not found');
    }
    this.project = project;
    const agent = await this.write('load agent', () => repos.agents.findById(this.task.agentId));
    if (agent === null || !agent.isActive) {
      throw new SettleSignal('failed', 'internal_error', 'agent not found or inactive');
    }
    this.agent = agent;

    this.checkpoint();
    const git = this.d.git;
    try {
      await git.assertCapacity();
      this.systemLine('syncing project mirror', 'git');
      await git.syncMirror(project.id, project.repoPath, this.gitCtx());
    } catch (err) {
      if (err instanceof InsufficientDiskSpaceError) this.stageError(err, 'blocked', 'insufficient_disk_space');
      if (err instanceof GitRepoInvalidError || err instanceof PathEscapeError) this.stageError(err, 'blocked', 'project_unavailable');
      this.stageError(err, 'failed', 'workspace_error');
    }
    this.checkpoint();

    const ref = this.attempt.baseRefOverride ?? this.task.baseRef ?? project.defaultBranch;
    this.baseBranch =
      ref !== null && !isCommitSha(ref) ? ref : (project.defaultBranch ?? ref ?? 'main');
    try {
      await this.resolveWorkspace(project, ref);
    } catch (err) {
      if (err instanceof GitRefNotFoundError) this.stageError(err, 'blocked', 'base_ref_not_found');
      if (err instanceof InsufficientDiskSpaceError) this.stageError(err, 'blocked', 'insufficient_disk_space');
      this.stageError(err, 'failed', 'workspace_error');
    }
    this.checkpoint();

    try {
      await this.prepareWorkspaceFiles();
    } catch (err) {
      this.stageError(err, 'failed', 'workspace_error');
    }
    await this.acquireLockAndLease();
    const ws = this.workspace as Workspace;
    await this.event('workspace_ready', {
      workspaceId: ws.id,
      path: ws.path,
      branchName: this.wt?.branchName ?? null,
      baseSha: this.wt?.baseSha ?? null,
      reused: this.reused,
    });
    this.systemLine(`workspace ready (${this.reused ? 'reused' : 'new'} ${ws.path})`);
  }

  private async resolveWorkspace(project: ProjectRecord, ref: string | null): Promise<void> {
    const repos = this.d.db.repos;
    const git = this.d.git;
    const ctx = this.gitCtx();
    const mode = this.attempt.mode;
    const prev =
      this.attempt.previousAttemptId !== null
        ? await this.write('load previous attempt', () => repos.attempts.findById(this.attempt.previousAttemptId as Uuid))
        : null;

    if (this.attempt.workspaceId !== null && (mode === 'resume' || mode === 'continue')) {
      const ws = await this.write('load workspace', () => repos.workspaces.findById(this.attempt.workspaceId as Uuid));
      if (ws !== null && ws.branchName !== null && ws.baseSha !== null && ws.kind === 'attempt' && ws.status !== 'removed' && ws.status !== 'removing') {
        const usable = await git.isWorktreeUsable({ projectId: project.id, relPath: ws.path, branchName: ws.branchName }, ctx);
        if (usable) {
          const W = resolveWithin(this.cfg.workspacesRoot, ...ws.path.split('/'));
          this.wt = {
            path: W,
            relPath: ws.path,
            adminDir: '',
            branchName: ws.branchName,
            baseSha: ws.baseSha,
            startSha: ws.headSha ?? ws.baseSha,
            keyLength: keyLengthOf(ws.branchName),
          };
          this.workspace = ws;
          this.reused = true;
          await this.write('workspace in_use', () => repos.workspaces.setStatus(ws.id, 'in_use'));
          await this.write('attempt workspace', () =>
            repos.attempts.setWorkspace(this.attempt.id, { workspaceId: ws.id, branchName: ws.branchName as string, baseSha: ws.baseSha as string }),
          );
          return;
        }
      }
      // §5.3: resume falls back to a new worktree from BaseSha; continue starts at the previous HeadSha.
      const baseSha = prev?.baseSha ?? ws?.baseSha ?? null;
      if (baseSha !== null) {
        const startSha = mode === 'continue' ? (ws?.headSha ?? prev?.headSha ?? baseSha) : baseSha;
        if (mode === 'resume') {
          await this.event('resume_fallback', { reason: 'worktree_unusable', previousWorkspaceId: this.attempt.workspaceId });
          this.systemLine('previous worktree is not usable; resuming in a new worktree from the base commit');
        }
        await this.createWorktree(project, baseSha, startSha);
        return;
      }
    }
    if (mode === 'continue' && prev !== null && prev.baseSha !== null) {
      await this.createWorktree(project, prev.baseSha, prev.headSha ?? prev.baseSha);
      return;
    }
    if (ref === null) throw new GitRefNotFoundError('No base ref (task, override or project default branch)');
    const baseSha = await git.resolveBase(project.id, ref, ctx);
    await this.createWorktree(project, baseSha, baseSha);
  }

  private async createWorktree(project: ProjectRecord, baseSha: string, startSha: string): Promise<void> {
    const repos = this.d.db.repos;
    this.checkpoint();
    this.systemLine(`creating worktree a${this.attempt.attemptNumber} at ${startSha.slice(0, 12)}`, 'git');
    const wt = await this.d.git.createAttemptWorktree(
      {
        projectId: project.id,
        taskId: this.task.id,
        attemptNumber: this.attempt.attemptNumber,
        baseSha,
        ...(startSha !== baseSha ? { startSha } : {}),
      },
      this.gitCtx(),
    );
    this.wt = wt;
    const quota = Math.min(this.cfg.workspaceMaxBytes, project.workspaceMaxBytes ?? Number.POSITIVE_INFINITY);
    const ws = await this.write('insert workspace', () =>
      repos.workspaces.insert({
        projectId: project.id,
        taskId: this.task.id,
        kind: 'attempt',
        createdByAttemptId: this.attempt.id,
        path: wt.relPath,
        branchName: wt.branchName,
        baseSha: wt.baseSha,
        quotaBytes: quota,
        workerId: this.cfg.workerId,
      }),
    );
    await this.write('workspace in_use', () => repos.workspaces.setStatus(ws.id, 'in_use', { headSha: wt.startSha }));
    await this.write('attempt workspace', () =>
      repos.attempts.setWorkspace(this.attempt.id, { workspaceId: ws.id, branchName: wt.branchName, baseSha: wt.baseSha }),
    );
    this.workspace = { ...ws, status: 'in_use' };
    this.reused = false;
  }

  private async prepareWorkspaceFiles(): Promise<void> {
    const ws = this.workspace as Workspace;
    const wt = this.wt as WorktreeInfo;
    const m = REL_PATH_RE.exec(wt.relPath);
    if (!m) throw new PathEscapeError('Unexpected worktree path');
    const [, projectId, taskId, n] = m as unknown as [string, string, string, string];
    this.worktreeReal = await realpathWithin(this.cfg.workspacesRoot, projectId, taskId, `a${n}`);
    if (this.registered) this.registered.workspacePath = this.worktreeReal;
    const metaDir = resolveWithin(this.cfg.workspacesRoot, projectId, taskId, `a${n}.meta`);
    await mkdir(resolveWithin(metaDir, 'tmp'), { recursive: true, mode: 0o700 });
    await mkdir(resolveWithin(metaDir, 'test-tmp'), { recursive: true, mode: 0o700 });
    this.metaDir = await realpathWithin(this.cfg.workspacesRoot, projectId, taskId, `a${n}.meta`);
    const home = resolveWithin(this.cfg.claudeHomeRoot, 'w', ws.id);
    await mkdir(resolveWithin(home, 'home'), { recursive: true, mode: 0o700 });
    await mkdir(resolveWithin(home, 'config'), { recursive: true, mode: 0o700 });
    await writeFile(resolveWithin(home, 'config', 'settings.json'), '{}\n', { mode: 0o600 });
    this.scope = {
      kind: 'workspace',
      projectId,
      workspaceId: ws.id,
      taskId,
      attemptId: this.attempt.id,
      attemptNumber: Number(n),
      path: this.worktreeReal,
      keyLength: wt.keyLength,
    };
    await mkdir(this.d.mcp.cacheDir(this.scope), { recursive: true, mode: 0o700 });
    if (this.cfg.mcpEnabled) {
      const config = this.d.mcp.claudeMcpConfig(this.scope);
      await writeFile(resolveWithin(this.metaDir, 'mcp.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    }
    // CLAUDE.md is data (never instructions); symlink escapes are rejected (§11.7).
    try {
      const file = await realpathWithin(this.worktreeReal, 'CLAUDE.md');
      this.claudeMd = await readCapped(file, 2 * this.cfg.claudeMdMaxBytes);
    } catch (err) {
      if (err instanceof PathEscapeError) {
        await this.event('warning', { warning: 'claude_md_rejected', message: errorMessage(err) });
      }
      this.claudeMd = null;
    }
  }

  private async waitBusy<T>(what: string, attemptOnce: () => Promise<T | null>): Promise<T> {
    const started = this.clock.nowMs();
    let noted = false;
    for (;;) {
      this.checkpoint();
      const got = await attemptOnce();
      if (got !== null) return got;
      if (this.clock.nowMs() - started >= this.cfg.attemptStaleMs) throw new WorkspaceBusySignal(what);
      if (!noted) {
        noted = true;
        this.systemLine(`${what} is busy; waiting`);
      }
      await sleep(BUSY_POLL_MS, this.signal);
    }
  }

  private async acquireLockAndLease(): Promise<void> {
    const ws = this.workspace as Workspace;
    const owner = `${this.cfg.workerId}:${this.attempt.id}`;
    this.lock = await this.waitBusy('workspace lock', () =>
      this.d.workspaceLock.tryAcquire(ws.id, owner, this.cfg.attemptStaleMs),
    );
    this.lease = await this.acquireLease();
  }

  private async acquireLease(): Promise<LaunchLease> {
    const ws = this.workspace as Workspace;
    const paths = [
      this.worktreeReal as string,
      this.metaDir as string,
      resolveWithin(this.cfg.claudeHomeRoot, 'w', ws.id),
      this.d.mcp.cacheDir(this.scope as WorkspaceScope),
    ];
    return this.waitBusy('attempt lease', async () => {
      try {
        return await this.d.launcher.acquire({
          key: `attempt-${this.attempt.id}`,
          attemptId: this.attempt.id,
          workerId: this.cfg.workerId,
          paths,
        });
      } catch (err) {
        if (isBusyError(err)) return null;
        throw err;
      }
    });
  }

  private async releaseLease(): Promise<void> {
    const lease = this.lease;
    this.lease = null;
    if (lease === null) return;
    try {
      const r = await lease.release();
      if (r.kill.survivors.length > 0) {
        this.log.error({ survivors: r.kill.survivors }, 'attempt lease release left surviving processes');
        await this.event('orphan_killed', { survivors: r.kill.survivors, failed: true });
      }
    } catch (err) {
      this.log.warn({ err: serializeError(err) }, 'attempt lease release failed');
    }
  }

  private async releaseLock(): Promise<void> {
    const lock = this.lock;
    this.lock = null;
    if (lock === null) return;
    try {
      await lock.release();
    } catch (err) {
      this.log.warn({ err: serializeError(err) }, 'workspace lock release failed');
    }
  }

  // ---- indexing ---------------------------------------------------------------------------------------

  private async recordSkippedIndex(why: string): Promise<void> {
    const scope = this.scope as WorkspaceScope;
    const repos = this.d.db.repos;
    const op = await this.write('task_index skipped', () =>
      repos.mcpOperations.insert({
        projectId: scope.projectId,
        taskId: this.task.id,
        attemptId: this.attempt.id,
        workspaceId: scope.workspaceId,
        kind: 'task_index',
        indexName: this.d.mcp.indexName(scope),
        mode: this.project?.indexMode ?? null,
        status: 'running',
        requestedByUserId: null,
        workerId: this.cfg.workerId,
      }),
    );
    await this.write('task_index skipped', () =>
      repos.mcpOperations.finish(op.id, {
        status: 'skipped',
        nodeCount: null,
        edgeCount: null,
        result: { reason: why },
        errorCode: null,
        errorMessage: null,
        durationMs: 0,
      }),
    );
  }

  private async reusableIndex(): Promise<boolean> {
    if (!this.reused || this.attempt.previousAttemptId === null) return false;
    const ws = this.workspace as Workspace;
    const op = await this.write('find task_index', () =>
      this.d.db.repos.mcpOperations.findLatest({
        projectId: this.task.projectId,
        kind: 'task_index',
        status: 'succeeded',
        attemptId: this.attempt.previousAttemptId as Uuid,
      }),
    );
    return op !== null && op.workspaceId === ws.id;
  }

  private async indexStage(): Promise<void> {
    this.checkpoint();
    const project = this.project as ProjectRecord;
    if (!this.cfg.mcpEnabled) {
      await this.recordSkippedIndex('mcp_disabled');
      this.indexAvailable = false;
      await this.transition('running');
      return;
    }
    if (await this.reusableIndex()) {
      await this.recordSkippedIndex('reused_workspace_index');
      this.indexAvailable = true;
      await this.transition('running');
      return;
    }
    await this.transition('indexing');
    await this.event('index_started', { mode: project.indexMode });
    this.systemLine(`indexing worktree (mode ${project.indexMode})`, 'mcp');
    const outcome = await this.d.mcp.index(this.scope as WorkspaceScope, {
      mode: project.indexMode,
      kind: 'task_index',
      lease: this.lease as LaunchLease,
      signal: this.signal,
    });
    this.checkpoint();
    if (outcome.status === 'succeeded') {
      this.indexAvailable = true;
      await this.event('index_completed', {
        operationId: outcome.operationId,
        nodeCount: outcome.nodeCount,
        edgeCount: outcome.edgeCount,
        durationMs: outcome.durationMs,
      });
    } else {
      this.indexAvailable = false;
      await this.event('index_failed', {
        operationId: outcome.operationId,
        errorCode: outcome.errorCode,
        errorMessage: outcome.errorMessage,
      });
      this.systemLine(`index failed (${outcome.errorCode ?? 'unknown'})`, 'mcp');
      if (project.requireIndex) {
        throw new SettleSignal('blocked', 'index_required_failed', outcome.errorMessage ?? outcome.errorCode);
      }
      await this.event('warning', { warning: 'index_failed', errorCode: outcome.errorCode });
    }
    await this.transition('running');
  }

  // ---- running ------------------------------------------------------------------------------------------

  private continuation(prevReason: FailureReason | null): PromptContinuation {
    const a = this.attempt;
    if (a.mode === 'resume') return { kind: 'infra_resume' };
    if (a.mode === 'continue') return { kind: 'retry_continue', additionalInstructions: a.additionalInstructions };
    if (a.trigger === 'user_retry') {
      return { kind: 'retry_fresh', additionalInstructions: a.additionalInstructions, attemptNo: a.attemptNumber, previousReason: prevReason };
    }
    return { kind: 'none' };
  }

  private async sessionSpec(): Promise<ClaudeSessionSpec> {
    const mode = this.attempt.mode;
    if (this.reused && (mode === 'resume' || mode === 'continue')) {
      const prev = await this.write('find claude session', () =>
        this.d.db.repos.claudeSessions.findLatestWithSessionId(this.task.id),
      );
      if (prev?.sessionId) return { kind: 'resume', resumeSessionId: prev.sessionId };
    }
    return { kind: 'new', sessionId: (this.d.ids ?? cryptoIdGenerator).uuid() };
  }

  private buildRequest(session: ClaudeSessionSpec): ClaudeRunRequest {
    const project = this.project as ProjectRecord;
    const agent = this.agent as AgentRecord;
    const ws = this.workspace as Workspace;
    const wt = this.wt as WorktreeInfo;
    const worktree = this.worktreeReal as string;
    const metaDir = this.metaDir as string;
    let tools;
    try {
      tools = computeToolPolicy(
        { allowedTools: agent.allowedTools, disallowedTools: agent.disallowedTools },
        {
          mcpEnabled: this.cfg.mcpEnabled,
          worktreePath: worktree,
          workspacesRoot: this.cfg.workspacesRoot,
          projectsRoot: this.cfg.projectsRoot,
          claudeHomeRoot: this.cfg.claudeHomeRoot,
          cbmCacheRoot: this.cfg.cbmCacheRoot,
        },
      );
    } catch (err) {
      if (err instanceof ToolPolicyError) throw new SettleSignal('failed', 'security_violation', errorMessage(err));
      throw new SettleSignal('failed', 'internal_error', errorMessage(err));
    }
    let prompt;
    try {
      prompt = buildLayeredPrompt({
        worktreePath: worktree,
        agent: { name: agent.name, title: agent.title, instructions: agent.instructions },
        project: {
          name: project.name,
          description: project.description,
          defaultBranch: project.defaultBranch ?? this.baseBranch,
          baseSha: wt.baseSha,
          branchName: wt.branchName,
          claudeMd: this.claudeMd,
        },
        index: {
          available: this.indexAvailable,
          indexName: this.indexAvailable ? this.d.mcp.indexName(this.scope as WorkspaceScope) : null,
        },
        task: {
          title: this.task.title,
          prompt: this.task.prompt,
          acceptanceCriteria: this.task.acceptanceCriteria,
          scope: this.task.scope,
        },
        continuation: this.continuation(this.prevReason),
        tests: { command: project.testCommand, timeoutSeconds: project.testTimeoutSeconds },
        nonce: randomBytes(8).toString('hex'),
        limits: { promptMaxBytes: this.cfg.promptMaxBytes, claudeMdMaxBytes: this.cfg.claudeMdMaxBytes },
      });
    } catch (err) {
      if (err instanceof PromptTooLargeError) throw new SettleSignal('failed', 'prompt_too_large', errorMessage(err));
      throw err;
    }
    if (prompt.claudeMdTruncated) this.systemLine('CLAUDE.md truncated for the prompt');
    return {
      attemptId: this.attempt.id,
      taskId: this.task.id,
      workspaceId: ws.id,
      cwd: worktree,
      metaDir,
      tmpDir: resolveWithin(metaDir, 'tmp'),
      lease: this.lease as LaunchLease,
      model: this.task.model,
      effort: this.task.effort,
      tools,
      mcp: this.cfg.mcpEnabled
        ? { configPath: resolveWithin(metaDir, 'mcp.json'), cacheDir: this.d.mcp.cacheDir(this.scope as WorkspaceScope) }
        : null,
      appendSystemPrompt: prompt.appendSystemPrompt,
      stdinPrompt: prompt.stdinPrompt,
      session,
      maxBudgetUsd: this.task.maxBudgetUsd,
      deadlineAt: new Date(this.attempt.deadlineAt ?? this.clock.nowMs() + this.attempt.timeoutSeconds * 1000),
      signal: this.signal,
    };
  }

  private prevReason: FailureReason | null = null;

  private handlers(session: ClaudeSessionSpec): ClaudeRunHandlers {
    const repos = this.d.db.repos;
    const local = this.d.launcher.mode === 'local';
    return {
      onSpawn: async (p) => {
        this.claudeSpawned = true;
        await this.write('attempt process', () =>
          repos.attempts.setProcess(this.attempt.id, { pid: p.pid, pgid: p.pgid, workerId: this.cfg.workerId }),
        );
        if (local) {
          await this.d.registry
            .add(
              claudeRegistryEntry({
                attemptId: this.attempt.id,
                workerId: this.cfg.workerId,
                pid: p.pid,
                pgid: p.pgid,
                startedAt: p.startedAt,
                bin: this.cfg.claudeBin,
                platform: this.cfg.platform,
              }),
            )
            .catch((err: unknown) => this.log.warn({ err: serializeError(err) }, 'claude registry add failed'));
        }
        await this.write('claude session start', () =>
          repos.claudeSessions.start({
            attemptId: this.attempt.id,
            taskId: this.task.id,
            sessionId: session.kind === 'new' ? session.sessionId : null,
            resumedFromSessionId: session.kind === 'resume' ? session.resumeSessionId : null,
            model: this.task.model,
            cliVersion: this.cfg.cliVersion ?? 'unknown',
            permissionMode: 'dontAsk',
          }),
        );
        await this.event('claude_started', {
          pid: p.pid,
          pgid: p.pgid,
          session: session.kind,
          ...(session.kind === 'resume' ? { resumedFromSessionId: session.resumeSessionId } : {}),
        });
        this.systemLine(`claude started (pid ${p.pid})`);
      },
      onInit: async (init, v) => {
        try {
          await repos.claudeSessions.recordInit(this.attempt.id, {
            sessionId: init.session_id,
            model: init.model,
            tools: init.tools,
            mcpServers: init.mcp_servers.map((s) => ({ name: s.name, status: s.status })),
            apiKeySource: init.apiKeySource ?? null,
            cliVersion: init.claude_code_version ?? null,
          });
        } catch (err) {
          this.log.warn({ err: serializeError(err) }, 'claude init record failed');
        }
        await this.event('claude_init', {
          sessionId: init.session_id,
          ok: v.ok,
          mcpConnected: v.mcpConnected,
          violations: v.violations,
        });
      },
      onLine: (p, raw, lineNo) => {
        this.sink.write('claude', 'claude', `${raw}\n`);
        try {
          const events = summarizeClaudeLine(p, {
            taskId: this.task.id,
            attemptId: this.attempt.id,
            line: lineNo,
            at: toIso(this.clock.now()),
          });
          for (const e of events) void this.d.publisher.publish(this.task.id, e);
        } catch (err) {
          this.log.debug({ err: serializeError(err) }, 'claude line summary failed');
        }
      },
      onStderr: (chunk) => {
        this.sink.write('stderr', 'claude', chunk);
      },
    };
  }

  private async afterRun(result: ClaudeRunResult): Promise<void> {
    const repos = this.d.db.repos;
    await this.write('attempt process exit', () =>
      repos.attempts.setProcessExit(this.attempt.id, { exitCode: result.exitCode, exitSignal: result.signal }),
    );
    if (this.d.launcher.mode === 'local') {
      await this.d.registry.remove(claudeProcessKey(this.attempt.id)).catch(() => undefined);
    }
    await this.event('claude_exited', {
      outcome: result.outcome,
      exitCode: result.exitCode,
      signal: result.signal,
      sessionId: result.sessionId,
      outputBytes: result.outputBytes,
      durationMs: result.durationMs,
      survivors: result.kill?.survivors ?? [],
    });
    if (result.kill !== null && result.kill.survivors.length > 0) {
      await this.event('orphan_killed', { survivors: result.kill.survivors, failed: true });
    }
    if (this.claudeSpawned) {
      try {
        await repos.claudeSessions.recordResult(this.attempt.id, resultSummary(result.result, result.outcome));
      } catch (err) {
        this.log.warn({ err: serializeError(err) }, 'claude result record failed');
      }
    }
    if (result.outcome === 'security_violation') {
      const detail = result.violation ?? { rule: 'unknown', detail: 'security violation' };
      await this.event('security_violation', { rule: detail.rule, detail: detail.detail }, 'security_violation');
      if (!this.superseded()) {
        await repos.audit
          .insert({
            action: 'security.violation',
            actor: this.actor,
            entityType: 'attempt',
            entityId: this.attempt.id,
            outcome: 'denied',
            detail: { taskId: this.task.id, rule: detail.rule, detail: detail.detail },
            correlationId: this.correlationId,
          })
          .catch((err: unknown) => this.log.warn({ err: serializeError(err) }, 'security audit failed'));
      }
    }
    this.systemLine(`claude exited (${result.outcome}, exit ${String(result.exitCode)})`);
  }

  private async runningStage(): Promise<void> {
    this.checkpoint();
    if (this.attempt.previousAttemptId !== null && this.attempt.trigger === 'user_retry') {
      const prev = await this.write('load previous attempt', () =>
        this.d.db.repos.attempts.findById(this.attempt.previousAttemptId as Uuid),
      );
      this.prevReason = prev?.failureReason ?? null;
    }
    let session = await this.sessionSpec();
    let fallback = false;
    for (;;) {
      const req = this.buildRequest(session);
      let result: ClaudeRunResult;
      try {
        result = await this.d.claude.run(req, this.handlers(session));
      } catch (err) {
        // run() rethrows handler failures after killing the tree (Phase B): infra failure.
        if (err instanceof SupersededSignal || err instanceof DbWriteAbandonedError) throw err;
        if (this.superseded()) throw new SupersededSignal('claude run');
        if (this.signal.aborted) throw new AbortedSignal(toAbortReason(this.signal.reason));
        throw new SettleSignal('failed', 'internal_error', `claude run failed: ${errorMessage(err)}`);
      }
      await this.afterRun(result);
      if (result.outcome === 'resume_failed' && !fallback && session.kind === 'resume') {
        fallback = true;
        await this.event('resume_fallback', { reason: 'resume_failed', previousSessionId: session.resumeSessionId });
        this.systemLine('claude --resume failed; one fallback run with a new session');
        session = { kind: 'new', sessionId: (this.d.ids ?? cryptoIdGenerator).uuid() };
        this.checkpoint();
        continue;
      }
      const decision = mapClaudeOutcome(result.outcome, fallback);
      if (decision.kind === 'interrupt') throw new AbortedSignal('worker_shutdown');
      if (decision.kind === 'settle') {
        if (this.signal.aborted) throw new AbortedSignal(toAbortReason(this.signal.reason));
        throw new SettleSignal(decision.status, decision.reason, `claude outcome ${result.outcome}`);
      }
      break;
    }
    this.checkpoint();
    await this.quotaCheck();
  }

  private quotaBytes(): number {
    const project = this.project as ProjectRecord;
    return Math.min(this.cfg.workspaceMaxBytes, project.workspaceMaxBytes ?? Number.POSITIVE_INFINITY);
  }

  /** After Claude exits (§11.6): over quota => failed(disk_quota_exceeded). */
  private async quotaCheck(): Promise<void> {
    const lease = this.lease;
    const ws = this.workspace as Workspace;
    if (lease === null || this.worktreeReal === null) return;
    const size = await lease.measure(this.worktreeReal, this.cfg.sizeScanMaxEntries);
    await this.d.db.repos.workspaces.recordSize(ws.id, size.bytes).catch(() => undefined);
    if (size.truncated || size.bytes > this.quotaBytes()) {
      throw new SettleSignal('failed', 'disk_quota_exceeded', `workspace size ${size.bytes} bytes exceeds the quota`);
    }
  }

  // ---- testing ---------------------------------------------------------------------------------------------

  private async testingStage(): Promise<void> {
    this.checkpoint();
    const project = this.project as ProjectRecord;
    const command = project.testCommand as string[];
    await this.transition('testing');
    await this.event('test_started', { command });
    this.systemLine(`running tests: ${command.join(' ')}`);
    const remaining = this.attempt.deadlineAt !== null ? Date.parse(this.attempt.deadlineAt) - this.clock.nowMs() : Infinity;
    const runner = this.d.testRunner ?? createTestRunner(this.d);
    let outcome;
    try {
      outcome = await runner.run({
        taskId: this.task.id,
        attemptId: this.attempt.id,
        cwd: this.worktreeReal as string,
        tmpDir: resolveWithin(this.metaDir as string, 'test-tmp'),
        command,
        timeoutMs: Math.max(0, Math.min(project.testTimeoutSeconds * 1000, remaining)),
        junitPath: project.junitReportPath,
        lease: this.lease as LaunchLease,
        signal: this.signal,
        sink: this.sink,
        // The worker reads the JUnit report only after the lease is reclaimed (§10.11 item 3: a leased path is never
        // touched by the worker; in runner mode it is 0700 sandbox-owned). Reviewing would release it next anyway.
        beforeReport: () => this.releaseLease(),
      });
    } catch (err) {
      this.stageError(err, 'failed', 'internal_error');
    }
    await this.d.publisher.publish(this.task.id, {
      v: 1,
      type: 'test',
      taskId: this.task.id,
      attemptId: this.attempt.id,
      testRunId: outcome.testRunId,
      status: outcome.status,
      ...outcome.counts,
      durationMs: outcome.durationMs,
      at: toIso(this.clock.now()),
    });
    await this.event('test_completed', { testRunId: outcome.testRunId, status: outcome.status, ...outcome.counts, exitCode: outcome.exitCode });
    this.systemLine(`tests ${outcome.status} (${outcome.counts.passed}/${outcome.counts.total} passed)`);
    this.checkpoint();
    this.pendingTest = pendingTestReason(outcome.status);
  }

  // ---- reviewing ---------------------------------------------------------------------------------------------

  private async storeChanges(wt: WorktreeInfo, ctx: GitOpContext): Promise<{ changes: CollectedChanges; patchAvailable: boolean; headSha: string; committed: boolean }> {
    const repos = this.d.db.repos;
    const git = this.d.git;
    const commit = await git.commitAll(wt, commitMessage(this.task, this.attempt), ctx);
    const changes = await git.collectChanges(wt, ctx);
    await this.write('changed files', () => repos.changedFiles.replaceForAttempt(this.attempt.id, this.task.id, changes.files));
    const patch = await git.exportPatch(wt, ctx);
    await this.write('attempt patch', () =>
      repos.patches.upsert({
        attemptId: this.attempt.id,
        byteLength: patch.byteLength,
        sha256: patch.sha256,
        content: patch.gzip,
        tooLarge: patch.tooLarge,
      }),
    );
    return { changes, patchAvailable: !patch.tooLarge && patch.gzip !== null, headSha: commit.headSha, committed: commit.committed };
  }

  private async reviewingStage(): Promise<AttemptOutcome> {
    this.checkpoint();
    await this.transition('reviewing');
    await this.releaseLease();
    const wt = this.wt as WorktreeInfo;
    const ws = this.workspace as Workspace;
    const repos = this.d.db.repos;
    const git = this.d.git;
    const ctx = this.gitCtx();
    let stored: Awaited<ReturnType<AttemptRun['storeChanges']>>;
    let commits;
    try {
      const size = await git.measureSize(this.worktreeReal as string);
      await repos.workspaces.recordSize(ws.id, size.bytes).catch(() => undefined);
      if (size.truncated || size.bytes > this.quotaBytes()) {
        throw new SettleSignal('failed', 'disk_quota_exceeded', `workspace size ${size.bytes} bytes exceeds the quota`);
      }
      this.checkpoint();
      this.systemLine('committing changes', 'git');
      stored = await this.storeChanges(wt, ctx);
      this.reviewStored = true;
      this.checkpoint();
      commits = await git.collectCommits(wt, ctx);
      this.checkpoint();
    } catch (err) {
      if (err instanceof WorkspaceQuotaError) this.stageError(err, 'failed', 'disk_quota_exceeded');
      this.stageError(err, 'failed', 'review_failed');
    }
    let merge;
    try {
      merge = await git.mergeCheck({ projectId: this.task.projectId, baseBranch: this.baseBranch, headSha: stored.headSha }, ctx);
    } catch (err) {
      if (this.signal.aborted) throw new AbortedSignal(toAbortReason(this.signal.reason));
      merge = {
        status: 'error' as const,
        baseBranch: this.baseBranch,
        latestBaseSha: null,
        headSha: stored.headSha,
        conflicts: [],
        isFastForward: false,
        error: errorMessage(err).slice(0, 1000),
        checkedAt: toIso(this.clock.now()),
      };
    }
    this.checkpoint();
    const changes = stored.changes;
    await this.write('attempt review', () =>
      repos.attempts.setReview(this.attempt.id, {
        headSha: stored.headSha,
        filesChanged: changes.filesChanged,
        additions: changes.additions,
        deletions: changes.deletions,
        commits,
        mergeCheck: merge,
      }),
    );
    await this.write('workspace head', () => repos.workspaces.setStatus(ws.id, 'in_use', { headSha: stored.headSha }));
    this.checkpoint();
    if (this.cfg.mcpEnabled && changes.filesChanged > 0) await this.reindex(wt, stored.headSha, changes);
    this.checkpoint();
    await this.event('review_completed', {
      headSha: stored.headSha,
      committed: stored.committed,
      filesChanged: changes.filesChanged,
      additions: changes.additions,
      deletions: changes.deletions,
      commits: commits.length,
      mergeCheck: merge.status,
      patchAvailable: stored.patchAvailable,
    });
    await this.d.publisher.publish(this.task.id, {
      v: 1,
      type: 'diff',
      taskId: this.task.id,
      attemptId: this.attempt.id,
      filesChanged: changes.filesChanged,
      additions: changes.additions,
      deletions: changes.deletions,
      headSha: stored.headSha,
      mergeCheck: merge.status,
      patchAvailable: stored.patchAvailable,
      at: toIso(this.clock.now()),
    });
    if (this.pendingTest !== null) {
      return this.settle('failed', this.pendingTest, 'tests did not pass');
    }
    return this.settle('completed', null, null);
  }

  /**
   * task_reindex + impact_analysis under a re-acquired lease (non-fatal, §13.2). The impact is seeded with the
   * diff the worker computed itself (`collectChanges`): the sandboxed MCP server cannot run git on the worktree,
   * whose git admin dir lives in the worker-owned mirror (ADR-0035).
   */
  private async reindex(wt: WorktreeInfo, headSha: string, changes: CollectedChanges): Promise<void> {
    const scope = this.scope as WorkspaceScope;
    let lease: LaunchLease;
    try {
      this.lease = await this.acquireLease();
      lease = this.lease;
    } catch (err) {
      if (err instanceof AbortedSignal || err instanceof SupersededSignal) throw err;
      await this.event('warning', { warning: 'reindex_skipped', message: errorMessage(err) });
      return;
    }
    try {
      this.systemLine('re-indexing changed worktree', 'mcp');
      const idx = await this.d.mcp.index(scope, { mode: 'fast', kind: 'task_reindex', lease, signal: this.signal });
      if (idx.status !== 'succeeded') {
        await this.event('warning', { warning: 'reindex_failed', errorCode: idx.errorCode, operationId: idx.operationId });
        return;
      }
      this.checkpoint();
      const impact = await this.d.mcp.detectChanges(scope, {
        baseSha: wt.baseSha,
        lease,
        signal: this.signal,
        changes: {
          headSha,
          files: changes.files,
          totalFiles: changes.filesChanged,
          truncated: changes.truncatedFileList,
        },
      });
      if (impact.status !== 'succeeded') {
        await this.event('warning', { warning: 'impact_analysis_failed', errorCode: impact.errorCode, operationId: impact.operationId });
      }
    } finally {
      await this.releaseLease();
    }
  }

  // ---- settle / failure handling ---------------------------------------------------------------------------

  private async captureArtifacts(): Promise<void> {
    const wt = this.wt;
    if (wt === null || !this.claudeSpawned || this.reviewStored) return;
    await this.releaseLease();
    try {
      const r = await withTimeout(this.cfg.artifactCaptureTimeoutMs, 'artifact capture', (signal) =>
        this.storeChanges(wt, this.gitCtx(signal)),
      );
      await this.event('artifacts_captured', {
        filesChanged: r.changes.filesChanged,
        headSha: r.headSha,
        patchAvailable: r.patchAvailable,
      });
    } catch (err) {
      if (err instanceof SupersededSignal) throw err;
      this.log.warn({ err: serializeError(err) }, 'artifact capture failed');
      await this.event('artifacts_captured', { error: errorMessage(err).slice(0, 1000) });
    }
  }

  private async retainWorkspace(status: 'retained' | 'ready'): Promise<void> {
    const ws = this.workspace;
    if (ws === null || this.superseded()) return;
    try {
      await this.d.db.repos.workspaces.setStatus(
        ws.id,
        status,
        status === 'retained'
          ? { retainUntil: new Date(this.clock.nowMs() + this.cfg.workspaceRetentionHours * 3_600_000) }
          : {},
      );
    } catch (err) {
      this.log.warn({ err: serializeError(err) }, 'workspace retention update failed');
    }
  }

  private async settle(status: SettledTaskStatus, reason: FailureReason | null, detail: string | null): Promise<AttemptOutcome> {
    if (status === 'failed' || status === 'timed_out' || status === 'cancelled') await this.captureArtifacts();
    await this.releaseLease();
    this.systemLine(`attempt finished: ${status}${reason ? ` (${reason})` : ''}`);
    await this.sink.close();
    try {
      await this.transition(status, { reason, detail });
    } finally {
      await this.retainWorkspace('retained');
      await this.releaseLock();
    }
    this.log.info({ status, reason }, 'attempt settled');
    return { status, reason };
  }

  private async interrupt(reason: 'worker_shutdown' | 'worker_lost'): Promise<AttemptOutcome> {
    await this.releaseLease();
    this.systemLine(`attempt interrupted (${reason}); handing over to infra recovery`);
    await this.sink.close();
    await this.retainWorkspace('ready');
    await this.releaseLock();
    const decision = await this.write('recover interrupted attempt', () =>
      this.d.tasks.recoverInterruptedAttempt({ attemptId: this.attempt.id, reason, workerId: this.cfg.workerId }),
    );
    this.log.info({ decision }, 'attempt interrupted');
    switch (decision.kind) {
      case 'requeued':
        return { status: 'interrupted', reason };
      case 'cancelled':
        return { status: 'cancelled', reason: 'cancelled_by_user' };
      case 'timed_out':
        return { status: 'timed_out', reason: 'timeout' };
      case 'failed':
        return { status: 'failed', reason: decision.reason };
      case 'noop':
        return { status: 'noop', reason: null };
    }
  }

  /** Superseded / fenced / DB abandoned: stop processes, release Redis ownership, no DB writes (§13.1, §13.9). */
  private async abandon(why: string): Promise<AttemptOutcome> {
    this.sink.discard();
    if (!this.signal.aborted) this.controller.abort('worker_shutdown' satisfies AbortReason);
    await this.releaseLease();
    await this.releaseLock();
    this.log.warn({ why }, 'attempt abandoned without further database writes');
    return { status: 'noop', reason: null };
  }

  private async handleFailure(err: unknown): Promise<AttemptOutcome> {
    try {
      if (err instanceof SupersededSignal || this.superseded()) {
        return await this.abandon(`superseded (${this.d.active.supersededKind(this.attempt.id) ?? 'conflict'})`);
      }
      if (err instanceof DbWriteAbandonedError) {
        this.log.error({ err: serializeError(err) }, 'database unavailable; leaving the attempt for stale recovery');
        return await this.abandon('database unavailable');
      }
      if (this.d.active.runnerLost(this.attempt.id)) {
        this.log.warn({ err: serializeError(err) }, 'runner lost during the attempt; handing it to infra recovery');
        return await this.interrupt('worker_lost');
      }
      if (err instanceof WorkspaceBusySignal) {
        this.log.warn({ err: err.message }, 'workspace busy; handing the attempt to infra recovery');
        return await this.interrupt('worker_lost');
      }
      let decision: { kind: 'settle'; status: SettledTaskStatus; reason: FailureReason; detail: string | null } | { kind: 'interrupt' };
      if (this.signal.aborted) {
        const d = mapAbortReason(toAbortReason(this.signal.reason));
        decision = d.kind === 'settle' ? { ...d, detail: null } : { kind: 'interrupt' };
      } else if (err instanceof SettleSignal) {
        decision = { kind: 'settle', status: err.status, reason: err.reason, detail: err.detail };
      } else if (err instanceof AbortedSignal) {
        const d = mapAbortReason(err.reason);
        decision = d.kind === 'settle' ? { ...d, detail: null } : { kind: 'interrupt' };
      } else {
        this.log.error({ err: serializeError(err) }, 'attempt pipeline failed');
        decision = {
          kind: 'settle',
          status: 'failed',
          reason: 'internal_error',
          detail: isOrcError(err) ? `${err.code}: ${err.message}` : errorMessage(err),
        };
      }
      if (decision.kind === 'interrupt') return await this.interrupt('worker_shutdown');
      return await this.settle(decision.status, decision.reason, decision.detail);
    } catch (inner) {
      if (inner instanceof SupersededSignal || this.superseded()) return this.abandon('superseded while settling');
      if (inner instanceof DbWriteAbandonedError) return this.abandon('database unavailable while settling');
      this.log.error({ err: serializeError(inner) }, 'attempt settle failed');
      return this.abandon('settle failed');
    }
  }
}

/** §6.4 step 3: a claim that found the attempt not queued. */
async function handleUnclaimed(deps: PipelineDeps, job: RunAttemptJobData): Promise<void> {
  const clock = deps.clock ?? systemClock;
  const attempt = await deps.db.repos.attempts.findById(job.attemptId);
  if (attempt === null || attempt.status !== 'active' || attempt.lastHeartbeatAt === null) return;
  if (clock.nowMs() - Date.parse(attempt.lastHeartbeatAt) < deps.config.attemptStaleMs) return;
  const owner = attempt.workerId;
  if (owner === null) return;
  let ownerGone: boolean;
  if (owner === deps.config.workerId) {
    ownerGone = deps.active.get(attempt.id) === undefined;
  } else {
    if (!deps.redisCommand) return;
    try {
      ownerGone = (await deps.redisCommand.exists(workerHeartbeatKey(deps.config.redisPrefix, owner))) === 0;
    } catch {
      return; // F7: Redis error => no recovery now
    }
  }
  if (!ownerGone) return;
  const decision = await deps.tasks.recoverInterruptedAttempt({
    attemptId: attempt.id,
    reason: 'worker_lost',
    workerId: deps.config.workerId,
  });
  deps.logger.info({ attemptId: attempt.id, decision }, 'recovered a stale attempt found by a redelivered job');
}

export function createAttemptPipeline(deps: OrchestratorDeps & { active: ActiveAttemptRegistry }): AttemptPipeline {
  const testRunner = createTestRunner(deps);
  const d: PipelineDeps = { ...deps, testRunner };
  return {
    async run(job, signal) {
      const claimed = await d.db.repos.taskState.claimAttempt({
        attemptId: job.attemptId,
        workerId: d.config.workerId,
        actor: { type: 'worker', workerId: d.config.workerId },
      });
      if (claimed === null) {
        await handleUnclaimed(d, job);
        return { status: 'noop', reason: null };
      }
      return new AttemptRun(d, claimed.task, claimed.attempt).execute(signal);
    },
  };
}
