// In-memory fakes for @orc/task-manager / @orc/project-manager unit tests. The fake TaskStateStore mirrors the CAS
// semantics of the real one (status mismatch => ConflictError, stale RowVer => PreconditionFailedError) so the
// service rules can be exercised without MSSQL or Redis.
import { randomUUID } from 'node:crypto';
import {
  ConflictError,
  NotFoundError,
  PreconditionFailedError,
  ROLE_PERMISSIONS,
  isSettledStatus,
} from '@orc/shared';
import type {
  ControlMessage,
  McpIndexOperation,
  Permission,
  ProjectJobData,
  Role,
  RunAttemptJobData,
  TaskStatus,
  TaskStreamEvent,
  Uuid,
  Workspace,
} from '@orc/shared';
import type {
  AgentRecord,
  AttemptRecord,
  Database,
  ProjectRecord,
  TaskRecord,
  TaskStateStore,
  TeamRecord,
  UserRecord,
} from '@orc/database';
import { createLogger } from '@orc/logger';
import type { Logger } from '@orc/logger';
import type {
  ControlChannel,
  JobStateName,
  QueueRegistry,
  RequestContext,
  TaskStreamPublisher,
  Viewer,
} from '@orc/task-manager';

export function silentLogger(): Logger {
  return createLogger({ service: 'test', level: 'silent', version: 'test', env: 'test' });
}

let rowVerSeq = 1n;
export function nextRowVer(): string {
  const buf = Buffer.alloc(8);
  rowVerSeq += 1n;
  buf.writeBigUInt64BE(rowVerSeq);
  return buf.toString('base64url');
}

export function etagOf(r: { rowVer: string }): string {
  return `"${r.rowVer}"`;
}

const NOW = '2026-11-03T10:00:00.000Z';

export function viewerFor(
  role: Role,
  o: { userId?: Uuid; readOnly?: boolean; tokenId?: Uuid | null } = {},
): Viewer {
  return {
    userId: o.userId ?? randomUUID(),
    role,
    permissions: new Set<Permission>(ROLE_PERMISSIONS[role]),
    tokenId: o.tokenId ?? null,
    readOnly: o.readOnly ?? false,
    username: `${role}-user`,
  };
}

export function requestCtx(): RequestContext {
  return {
    requestId: `req-${randomUUID()}`,
    correlationId: randomUUID(),
    ip: '127.0.0.1',
    userAgent: 'vitest',
  };
}

export function makeUser(o: Partial<UserRecord> = {}): UserRecord {
  return {
    id: randomUUID(),
    username: `user-${randomUUID().slice(0, 8)}`,
    displayName: 'Test User',
    email: null,
    role: 'operator',
    isActive: true,
    lockedUntil: null,
    lastLoginAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    rowVer: nextRowVer(),
    passwordHash: 'x',
    failedLoginCount: 0,
    ...o,
  };
}

export function makeTeam(o: Partial<TeamRecord> = {}): TeamRecord {
  return {
    id: randomUUID(),
    name: `team-${randomUUID().slice(0, 8)}`,
    description: null,
    managerAgentId: null,
    ownedPaths: [],
    createdAt: NOW,
    updatedAt: NOW,
    rowVer: nextRowVer(),
    ...o,
  };
}

export function makeAgent(o: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: randomUUID(),
    teamId: randomUUID(),
    parentAgentId: null,
    name: `agent-${randomUUID().slice(0, 8)}`,
    title: 'Agent',
    description: null,
    isManager: false,
    model: 'sonnet',
    effort: null,
    allowedTools: ['Read'],
    disallowedTools: [],
    instructions: null,
    maxTimeoutSeconds: 7200,
    maxBudgetUsd: null,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    rowVer: nextRowVer(),
    ...o,
  };
}

export function makeProject(o: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: randomUUID(),
    name: `proj-${randomUUID().slice(0, 8)}`,
    description: null,
    repoPath: `acme/${randomUUID().slice(0, 8)}`,
    defaultBranch: 'main',
    status: 'ready',
    statusDetail: null,
    testCommand: null,
    testTimeoutSeconds: 900,
    junitReportPath: null,
    requireIndex: false,
    autoIndex: true,
    indexMode: 'moderate',
    defaultAgentId: null,
    defaultTimeoutSeconds: 3600,
    workspaceMaxBytes: null,
    headSha: 'a'.repeat(40),
    lastSyncedAt: NOW,
    lastIndexedAt: null,
    lastIndexOperationId: null,
    createdByUserId: randomUUID(),
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    rowVer: nextRowVer(),
    ...o,
  };
}

export function makeWorkspace(o: Partial<Workspace> = {}): Workspace {
  return {
    id: randomUUID(),
    projectId: randomUUID(),
    taskId: null,
    kind: 'attempt',
    createdByAttemptId: null,
    path: '/srv/ws/x',
    branchName: 'orc/t-x-a1',
    baseSha: 'b'.repeat(40),
    headSha: 'c'.repeat(40),
    status: 'retained',
    workerId: 'w1',
    quotaBytes: 1,
    sizeBytes: null,
    sizeCheckedAt: null,
    retainUntil: null,
    errorDetail: null,
    removedAt: null,
    branchDeletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...o,
  };
}

function newAttempt(task: TaskRecord, n: number, o: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: randomUUID(),
    taskId: task.id,
    attemptNumber: n,
    trigger: 'initial',
    mode: 'fresh',
    previousAttemptId: null,
    status: 'queued',
    stage: null,
    failureReason: null,
    failureDetail: null,
    additionalInstructions: null,
    baseRefOverride: null,
    workspaceId: null,
    branchName: null,
    baseSha: null,
    headSha: null,
    workerId: null,
    pid: null,
    pgid: null,
    processStartedAt: null,
    processEndedAt: null,
    exitCode: null,
    exitSignal: null,
    timeoutSeconds: task.timeoutSeconds,
    deadlineAt: null,
    queuedAt: NOW,
    startedAt: null,
    endedAt: null,
    lastHeartbeatAt: null,
    filesChanged: null,
    additions: null,
    deletions: null,
    commits: [],
    mergeCheck: null,
    correlationId: task.correlationId,
    createdAt: NOW,
    updatedAt: NOW,
    rowVer: nextRowVer(),
    ...o,
  };
}

export interface FakeWorld {
  db: Database;
  users: Map<Uuid, UserRecord>;
  teams: Map<Uuid, TeamRecord>;
  agents: Map<Uuid, AgentRecord>;
  projects: Map<Uuid, ProjectRecord>;
  tasks: Map<Uuid, TaskRecord>;
  attempts: Map<Uuid, AttemptRecord>;
  workspaces: Map<Uuid, Workspace>;
  mcpOps: Map<Uuid, McpIndexOperation>;
  audits: { action: string; entityId: string | null }[];
  retained: Uuid[];
  /** Runs right before cancelPending's CAS (simulates the worker claim winning the race). */
  beforeCancelPending: ((taskId: Uuid) => void) | null;
  /** Errors thrown by the next insert of the named repo (unique violations etc.). */
  failNextInsert: Map<string, Error>;
  /** Moves a queued task to preparing_workspace exactly like claimAttempt. */
  claim(taskId: Uuid): void;
  /** Forces a task (and its current attempt) into a status, e.g. settled for retry tests. */
  setStatus(taskId: Uuid, status: TaskStatus, o?: { cancelRequested?: boolean }): TaskRecord;
  addTask(o: {
    owner: UserRecord;
    project: ProjectRecord;
    agent: AgentRecord;
    status?: TaskStatus;
  }): {
    task: TaskRecord;
    attempt: AttemptRecord;
  };
}

function bump<T extends { rowVer: string }>(r: T, patch: Partial<T>): T {
  return { ...r, ...patch, rowVer: nextRowVer() };
}

export function createFakeWorld(): FakeWorld {
  const users = new Map<Uuid, UserRecord>();
  const teams = new Map<Uuid, TeamRecord>();
  const agents = new Map<Uuid, AgentRecord>();
  const projects = new Map<Uuid, ProjectRecord>();
  const tasks = new Map<Uuid, TaskRecord>();
  const attempts = new Map<Uuid, AttemptRecord>();
  const workspaces = new Map<Uuid, Workspace>();
  const mcpOps = new Map<Uuid, McpIndexOperation>();
  const audits: { action: string; entityId: string | null }[] = [];
  const retained: Uuid[] = [];
  const failNextInsert = new Map<string, Error>();

  const mustTask = (id: Uuid): TaskRecord => {
    const t = tasks.get(id);
    if (!t) throw new NotFoundError('Task not found');
    return t;
  };
  const failIfArmed = (repo: string): void => {
    const err = failNextInsert.get(repo);
    if (err) {
      failNextInsert.delete(repo);
      throw err;
    }
  };
  const setAttempt = (id: Uuid | null, patch: Partial<AttemptRecord>): void => {
    if (id === null) return;
    const a = attempts.get(id);
    if (a) attempts.set(id, bump(a, patch));
  };

  const world: FakeWorld = {
    db: undefined as unknown as Database,
    users,
    teams,
    agents,
    projects,
    tasks,
    attempts,
    workspaces,
    mcpOps,
    audits,
    retained,
    beforeCancelPending: null,
    failNextInsert,
    claim(taskId) {
      const t = mustTask(taskId);
      if (t.status !== 'queued') throw new ConflictError('not queued');
      tasks.set(taskId, bump(t, { status: 'preparing_workspace' }));
      setAttempt(t.currentAttemptId, {
        status: 'active',
        stage: 'preparing_workspace',
        workerId: 'w1',
      });
    },
    setStatus(taskId, status, o = {}) {
      const t = mustTask(taskId);
      const settled = isSettledStatus(status);
      const next = bump(t, {
        status,
        cancelRequestedAt: o.cancelRequested ? NOW : t.cancelRequestedAt,
        finishedAt: settled ? NOW : null,
      });
      tasks.set(taskId, next);
      setAttempt(t.currentAttemptId, {
        status: settled
          ? status === 'completed'
            ? 'succeeded'
            : status
          : status === 'queued'
            ? 'queued'
            : 'active',
      });
      return next;
    },
    addTask({ owner, project, agent, status = 'queued' }) {
      const task: TaskRecord = {
        id: randomUUID(),
        projectId: project.id,
        agentId: agent.id,
        createdByUserId: owner.id,
        title: 't',
        prompt: 'p',
        acceptanceCriteria: null,
        scope: null,
        baseRef: null,
        model: 'sonnet',
        effort: null,
        timeoutSeconds: 600,
        maxBudgetUsd: null,
        status: 'queued',
        statusReason: null,
        statusDetail: null,
        currentAttemptId: null,
        attemptCount: 1,
        autoRecoveryCount: 0,
        cancelRequestedAt: null,
        cancelRequestedByUserId: null,
        correlationId: randomUUID(),
        queuedAt: NOW,
        startedAt: null,
        finishedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        rowVer: nextRowVer(),
      };
      const attempt = newAttempt(task, 1);
      tasks.set(task.id, { ...task, currentAttemptId: attempt.id });
      attempts.set(attempt.id, attempt);
      if (status !== 'queued') world.setStatus(task.id, status);
      return { task: mustTask(task.id), attempt: attempts.get(attempt.id) ?? attempt };
    },
  };

  const taskState: TaskStateStore = {
    createTask(i) {
      const base = world.addTask({
        owner: users.get(i.task.createdByUserId) ?? makeUser({ id: i.task.createdByUserId }),
        project: projects.get(i.task.projectId) ?? makeProject({ id: i.task.projectId }),
        agent: agents.get(i.task.agentId) ?? makeAgent({ id: i.task.agentId }),
      });
      const task = bump(base.task, { ...i.task });
      tasks.set(task.id, task);
      const attempt = { ...base.attempt, correlationId: i.task.correlationId };
      attempts.set(attempt.id, attempt);
      audits.push({ action: 'task.created', entityId: task.id });
      if (i.idempotency) i.idempotency.responseFactory(task, attempt);
      return Promise.resolve({ task, attempt });
    },
    transition(i) {
      const t = mustTask(i.taskId);
      if (i.expectedRowVer !== undefined && i.expectedRowVer !== t.rowVer) {
        return Promise.reject(new PreconditionFailedError('Task has been modified'));
      }
      if (t.status !== i.from)
        return Promise.reject(new ConflictError('Task status changed concurrently'));
      const settled = isSettledStatus(i.to);
      const next = bump(t, {
        status: i.to,
        statusReason: i.reason ?? null,
        statusDetail: i.detail ?? null,
        finishedAt: settled ? NOW : t.finishedAt,
      });
      tasks.set(t.id, next);
      if (i.attemptStatus)
        setAttempt(i.attemptId, { status: i.attemptStatus, failureReason: i.reason ?? null });
      audits.push({ action: 'task.status_changed', entityId: t.id });
      return Promise.resolve(next);
    },
    claimAttempt() {
      return Promise.resolve(null);
    },
    createAttempt(i) {
      const t = mustTask(i.taskId);
      if (i.expectedRowVer !== undefined && i.expectedRowVer !== t.rowVer) {
        return Promise.reject(new PreconditionFailedError('Task has been modified'));
      }
      if (t.status !== i.from || t.currentAttemptId !== i.previousAttemptId) {
        return Promise.reject(new ConflictError('Task status changed concurrently'));
      }
      if (i.trigger === 'infra_recovery' && t.cancelRequestedAt !== null) {
        return Promise.reject(new ConflictError('cancel requested'));
      }
      if (i.trigger === 'infra_recovery')
        setAttempt(i.previousAttemptId, { status: 'interrupted' });
      const attempt = newAttempt(t, t.attemptCount + 1, {
        trigger: i.trigger,
        mode: i.mode,
        previousAttemptId: i.previousAttemptId,
        workspaceId: i.workspaceId,
        baseRefOverride: i.baseRefOverride ?? null,
        additionalInstructions: i.additionalInstructions,
      });
      attempts.set(attempt.id, attempt);
      const next = bump(t, {
        status: 'queued',
        currentAttemptId: attempt.id,
        attemptCount: t.attemptCount + 1,
        autoRecoveryCount: t.autoRecoveryCount + (i.trigger === 'infra_recovery' ? 1 : 0),
        statusReason: null,
        statusDetail: null,
        finishedAt: null,
        cancelRequestedAt: i.trigger === 'user_retry' ? null : t.cancelRequestedAt,
      });
      tasks.set(t.id, next);
      audits.push({
        action: i.trigger === 'user_retry' ? 'task.retry_requested' : 'task.recovered',
        entityId: t.id,
      });
      return Promise.resolve({ task: next, attempt });
    },
    cancelPending(i) {
      world.beforeCancelPending?.(i.taskId);
      const t = mustTask(i.taskId);
      if (t.status !== i.from)
        return Promise.reject(new ConflictError('Task status changed concurrently'));
      const next = bump(t, {
        status: 'cancelled',
        statusReason: 'cancelled_by_user',
        finishedAt: NOW,
        cancelRequestedAt: NOW,
      });
      tasks.set(t.id, next);
      setAttempt(t.currentAttemptId, { status: 'cancelled' });
      return Promise.resolve(next);
    },
    requestCancel(i) {
      const t = mustTask(i.taskId);
      const active = [
        'preparing_workspace',
        'indexing',
        'running',
        'testing',
        'reviewing',
      ].includes(t.status);
      if (!active)
        return Promise.reject(new ConflictError(`Task in status ${t.status} cannot be cancelled`));
      if (t.cancelRequestedAt !== null) return Promise.resolve(t);
      const next = bump(t, {
        cancelRequestedAt: NOW,
        cancelRequestedByUserId:
          i.actor.type === 'user' || i.actor.type === 'token' ? i.actor.userId : null,
      });
      tasks.set(t.id, next);
      audits.push({ action: 'task.cancel_requested', entityId: t.id });
      return Promise.resolve(next);
    },
  };

  const repos = {
    users: { findById: (id: Uuid) => Promise.resolve(users.get(id) ?? null) },
    teams: {
      findById: (id: Uuid) => Promise.resolve(teams.get(id) ?? null),
      list: () => Promise.resolve([...teams.values()]),
      insert: (t: Omit<TeamRecord, 'id' | 'createdAt' | 'updatedAt' | 'rowVer'>) => {
        failIfArmed('teams');
        const row = makeTeam(t);
        teams.set(row.id, row);
        return Promise.resolve(row);
      },
      update: (id: Uuid, rowVer: string, patch: Partial<TeamRecord>) => {
        const cur = teams.get(id);
        if (!cur) return Promise.reject(new NotFoundError('Team not found'));
        if (cur.rowVer !== rowVer)
          return Promise.reject(new PreconditionFailedError('Team has been modified'));
        const next = bump(cur, patch);
        teams.set(id, next);
        return Promise.resolve(next);
      },
    },
    agents: {
      findById: (id: Uuid) => Promise.resolve(agents.get(id) ?? null),
      list: (f: { teamId?: Uuid; activeOnly?: boolean }) =>
        Promise.resolve(
          [...agents.values()].filter(
            (a) =>
              (f.teamId === undefined || a.teamId === f.teamId) &&
              (f.activeOnly !== true || a.isActive),
          ),
        ),
      insert: (a: Omit<AgentRecord, 'id' | 'createdAt' | 'updatedAt' | 'rowVer'>) => {
        failIfArmed('agents');
        const row = makeAgent(a);
        agents.set(row.id, row);
        return Promise.resolve(row);
      },
      update: (id: Uuid, rowVer: string, patch: Partial<AgentRecord>) => {
        const cur = agents.get(id);
        if (!cur) return Promise.reject(new NotFoundError('Agent not found'));
        if (cur.rowVer !== rowVer)
          return Promise.reject(new PreconditionFailedError('Agent has been modified'));
        const next = bump(cur, patch);
        agents.set(id, next);
        return Promise.resolve(next);
      },
    },
    projects: {
      findById: (id: Uuid) => Promise.resolve(projects.get(id) ?? null),
      list: (o: { status?: string }) =>
        Promise.resolve(
          [...projects.values()].filter((p) => o.status === undefined || p.status === o.status),
        ),
      insert: (p: Partial<ProjectRecord>) => {
        failIfArmed('projects');
        const row = makeProject({ ...p, status: 'validating', headSha: null });
        projects.set(row.id, row);
        return Promise.resolve(row);
      },
      update: (
        id: Uuid,
        rowVer: string,
        patch: Partial<ProjectRecord> & { archived?: boolean },
      ) => {
        const cur = projects.get(id);
        if (!cur) return Promise.reject(new NotFoundError('Project not found'));
        if (cur.rowVer !== rowVer)
          return Promise.reject(new PreconditionFailedError('Project has been modified'));
        const { archived, ...rest } = patch;
        const next = bump(cur, {
          ...rest,
          ...(archived === true ? { status: 'archived' as const, archivedAt: NOW } : {}),
        });
        projects.set(id, next);
        return Promise.resolve(next);
      },
    },
    tasks: {
      findById: (id: Uuid) => Promise.resolve(tasks.get(id) ?? null),
      findVisible: (id: Uuid, v: { userId: Uuid; canReadAny: boolean }) => {
        const t = tasks.get(id);
        return Promise.resolve(t && (v.canReadAny || t.createdByUserId === v.userId) ? t : null);
      },
      list: (o: { limit: number; ownerUserId?: Uuid }) =>
        Promise.resolve(
          [...tasks.values()]
            .filter((t) => o.ownerUserId === undefined || t.createdByUserId === o.ownerUserId)
            .slice(0, o.limit + 1),
        ),
      findQueuedForReconcile: () =>
        Promise.resolve(
          [...tasks.values()]
            .filter((t) => t.status === 'queued' && t.currentAttemptId !== null)
            .map((t) => ({
              taskId: t.id,
              attemptId: t.currentAttemptId ?? '',
              attemptNumber: attempts.get(t.currentAttemptId ?? '')?.attemptNumber ?? 1,
              correlationId: t.correlationId,
            })),
        ),
    },
    attempts: {
      findById: (id: Uuid) => Promise.resolve(attempts.get(id) ?? null),
      listByTask: (taskId: Uuid) =>
        Promise.resolve(
          [...attempts.values()]
            .filter((a) => a.taskId === taskId)
            .sort((a, b) => a.attemptNumber - b.attemptNumber),
        ),
    },
    workspaces: {
      findById: (id: Uuid) => Promise.resolve(workspaces.get(id) ?? null),
      setStatus: (id: Uuid) => {
        retained.push(id);
        return Promise.resolve();
      },
    },
    mcpOperations: {
      findById: (id: Uuid) => Promise.resolve(mcpOps.get(id) ?? null),
      insert: (o: Partial<McpIndexOperation>) => {
        failIfArmed('mcpOperations');
        const op: McpIndexOperation = {
          id: randomUUID(),
          projectId: o.projectId ?? randomUUID(),
          taskId: o.taskId ?? null,
          attemptId: o.attemptId ?? null,
          workspaceId: o.workspaceId ?? null,
          kind: o.kind ?? 'project_index',
          indexName: o.indexName ?? 'idx',
          mode: o.mode ?? null,
          status: o.status ?? 'queued',
          requestedByUserId: o.requestedByUserId ?? null,
          workerId: null,
          startedAt: null,
          endedAt: null,
          durationMs: null,
          nodeCount: null,
          edgeCount: null,
          result: null,
          errorCode: null,
          errorMessage: null,
          createdAt: NOW,
          updatedAt: NOW,
        };
        mcpOps.set(op.id, op);
        return Promise.resolve(op);
      },
      finish: (id: Uuid, r: { status: McpIndexOperation['status']; errorCode: string | null }) => {
        const op = mcpOps.get(id);
        if (op) mcpOps.set(id, { ...op, status: r.status, errorCode: r.errorCode });
        return Promise.resolve();
      },
      findActiveProjectOp: (projectId: Uuid) =>
        Promise.resolve(
          [...mcpOps.values()].find(
            (o) =>
              o.projectId === projectId &&
              o.kind === 'project_index' &&
              (o.status === 'queued' || o.status === 'running'),
          ) ?? null,
        ),
      findLatest: () => Promise.resolve(null),
    },
    audit: {
      insert: (a: { action: string; entityId: string | null }) => {
        audits.push({ action: a.action, entityId: a.entityId });
        return Promise.resolve();
      },
    },
    idempotency: { complete: () => Promise.resolve() },
    taskState,
  };

  const db = {
    repos,
    transaction: <T>(fn: (t: { repos: typeof repos; tx: never }) => Promise<T>) =>
      fn({ repos, tx: undefined as never }),
  };
  world.db = db as unknown as Database;
  return world;
}

// ---- queue / stream / control fakes ---------------------------------------------------------------

export interface FakeQueues extends QueueRegistry {
  enqueued: RunAttemptJobData[];
  projectJobs: ProjectJobData[];
  removed: Uuid[];
  states: Map<string, JobStateName>;
  removeResult: 'removed' | 'absent' | 'active';
  failEnqueue: boolean;
}

export function createFakeQueues(): FakeQueues {
  const q = {
    enqueued: [] as RunAttemptJobData[],
    projectJobs: [] as ProjectJobData[],
    removed: [] as Uuid[],
    states: new Map<string, JobStateName>(),
    removeResult: 'removed' as 'removed' | 'absent' | 'active',
    failEnqueue: false,
    enqueueAttempt(d: RunAttemptJobData) {
      if (q.failEnqueue) return Promise.reject(new Error('redis down'));
      q.enqueued.push(d);
      q.states.set(d.attemptId, 'waiting');
      return Promise.resolve();
    },
    removePendingAttempt(attemptId: Uuid) {
      q.removed.push(attemptId);
      return Promise.resolve(q.removeResult);
    },
    enqueueProjectJob(d: ProjectJobData) {
      if (q.failEnqueue) return Promise.reject(new Error('redis down'));
      const jobId = d.kind === 'sync' ? `sync-${d.projectId}` : `index-${d.operationId}`;
      const deduplicated = q.states.get(jobId) === 'waiting';
      if (!deduplicated) q.projectJobs.push(d);
      q.states.set(jobId, 'waiting');
      return Promise.resolve({ jobId, deduplicated });
    },
    jobState(attemptId: Uuid) {
      return Promise.resolve(q.states.get(attemptId) ?? 'unknown');
    },
    projectJobState(jobId: string) {
      return Promise.resolve(q.states.get(jobId) ?? 'unknown');
    },
  };
  return q as unknown as FakeQueues;
}

export interface FakePublisher extends TaskStreamPublisher {
  events: { taskId: Uuid; event: TaskStreamEvent }[];
  persisted: Uuid[];
  expired: Uuid[];
}

export function createFakePublisher(): FakePublisher {
  const p: FakePublisher = {
    events: [],
    persisted: [],
    expired: [],
    publish(taskId, event) {
      p.events.push({ taskId, event });
      return Promise.resolve(`${p.events.length}-0`);
    },
    persist(taskId) {
      p.persisted.push(taskId);
      return Promise.resolve();
    },
    expireSettled(taskId) {
      p.expired.push(taskId);
      return Promise.resolve();
    },
  };
  return p;
}

export interface FakeControl extends ControlChannel {
  published: ControlMessage[];
}

export function createFakeControl(): FakeControl {
  const c: FakeControl = {
    published: [],
    publishCancel(m) {
      c.published.push({ v: 1, type: 'cancel', ...m });
      return Promise.resolve();
    },
    subscribe() {
      return Promise.resolve(() => Promise.resolve());
    },
  };
  return c;
}
