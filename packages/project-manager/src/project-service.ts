// ProjectService (contract §2.10, §6.2, §12.5, ADR-0019). The API never touches repositories on disk: registration
// stores the relative repo path and enqueues `sync-project`; the worker validates, mirrors and (AutoIndex) indexes.
import {
  NotFoundError,
  OrcError,
  TASK_SCOPED_MCP_OPERATION_KINDS,
  ValidationError,
  shortKey,
} from '@orc/shared';
import type {
  Clock,
  CreateProjectRequest,
  McpIndexOperation,
  McpOperationKind,
  McpStatus,
  Page,
  PageQuery,
  Project,
  ProjectIndexStatus,
  ProjectListQuery,
  RequestIndexRequest,
  UpdateProjectRequest,
  Uuid,
} from '@orc/shared';
import {
  isSafeRefName,
  normalizeRepoRelativePath,
  normalizeWorktreeRelativePath,
  validateTestCommand,
} from '@orc/security';
import { etagToRowVer, rowVerToEtag } from '@orc/database';
import type { Database, ProjectPatch, ProjectRecord } from '@orc/database';
import type { Logger } from '@orc/logger';
import {
  actorOf,
  auditOf,
  hasPerm,
  keysetFromCursor,
  keysetPage,
  requirePermission,
  withoutRowVer,
} from '@orc/task-manager';
import type { QueueRegistry, RequestContext, Viewer } from '@orc/task-manager';

export interface ProjectService {
  /** + enqueue sync-project */
  create(
    i: CreateProjectRequest,
    v: Viewer,
    ctx: RequestContext,
    idem?: { id: string },
  ): Promise<Project>;
  list(q: ProjectListQuery, v: Viewer): Promise<Page<Project>>;
  get(id: Uuid, v: Viewer): Promise<ProjectRecord>;
  update(
    id: Uuid,
    ifMatch: string,
    i: UpdateProjectRequest,
    v: Viewer,
    ctx: RequestContext,
  ): Promise<ProjectRecord>;
  requestSync(
    id: Uuid,
    v: Viewer,
    ctx: RequestContext,
  ): Promise<{ jobId: string; deduplicated: boolean }>;
  /** 409 index_in_progress / project_not_ready; 503 mcp_disabled. */
  requestIndex(
    id: Uuid,
    i: RequestIndexRequest,
    v: Viewer,
    ctx: RequestContext,
  ): Promise<McpIndexOperation>;
  indexStatus(id: Uuid, v: Viewer): Promise<ProjectIndexStatus>;
  /** F3: without task:read:any only project_index/index_delete plus the viewer's own task-scoped ops; `result` is null
   *  for every task-scoped op on these routes (served only by GET /tasks/:id/impact). */
  indexOperations(id: Uuid, q: PageQuery, v: Viewer): Promise<Page<McpIndexOperation>>;
  /** Same visibility; invisible => NotFoundError. */
  indexOperation(id: Uuid, operationId: Uuid, v: Viewer): Promise<McpIndexOperation>;
  /** GET /system/mcp; recentOperations via findRecent, same rules. */
  mcpStatus(v: Viewer): Promise<McpStatus>;
}

export interface ProjectServiceConfig {
  /** MCP_ENABLED (default true). */
  mcpEnabled?: boolean;
  /** CLAUDE_MAX_TIMEOUT_SECONDS: upper bound of defaultTimeoutSeconds. */
  maxTimeoutSeconds?: number;
  /** WORKSPACE_MAX_BYTES: upper bound of workspaceMaxBytes. */
  workspaceMaxBytes?: number;
}

export interface ProjectServiceDeps {
  db: Database;
  queues: QueueRegistry;
  logger: Logger;
  clock?: Clock;
  config?: ProjectServiceConfig;
}

const RECENT_OPERATIONS = 20;
const TASK_SCOPED: ReadonlySet<McpOperationKind> = new Set(TASK_SCOPED_MCP_OPERATION_KINDS);

export const projectIndexName = (projectId: Uuid): string => `orc-p-${shortKey(projectId, 8)}`;
export const toProject = (r: ProjectRecord): Project => withoutRowVer(r);

/** Task-scoped operations never expose `result` on project/system routes (F3). */
export function redactOperation(op: McpIndexOperation): McpIndexOperation {
  return TASK_SCOPED.has(op.kind) ? { ...op, result: null } : op;
}

function fieldError(path: string, message: string): ValidationError {
  return new ValidationError([{ path, message, code: 'custom' }], 'Invalid body');
}

function headShaOf(op: McpIndexOperation | null): string | null {
  const result = op?.result;
  if (result !== null && typeof result === 'object' && 'headSha' in result) {
    const head = (result as { headSha?: unknown }).headSha;
    return typeof head === 'string' ? head : null;
  }
  return null;
}

type ProjectFields = Omit<UpdateProjectRequest, 'archived'>;

export function createProjectService(deps: ProjectServiceDeps): ProjectService {
  const { db, queues, logger } = deps;
  const repos = db.repos;
  const mcpEnabled = deps.config?.mcpEnabled ?? true;
  const maxTimeoutSeconds = deps.config?.maxTimeoutSeconds ?? 86_400;
  const workspaceMaxBytes = deps.config?.workspaceMaxBytes ?? Number.MAX_SAFE_INTEGER;

  /** Applies the @orc/security validators and config limits the request schemas leave to the service (§3.3). */
  async function normalizeFields(i: ProjectFields): Promise<ProjectPatch> {
    const out: ProjectPatch = {};
    if (i.name !== undefined) out.name = i.name;
    if (i.description !== undefined) out.description = i.description;
    if (i.defaultBranch !== undefined) {
      if (i.defaultBranch !== null && !isSafeRefName(i.defaultBranch))
        throw fieldError('body.defaultBranch', 'Invalid branch name');
      out.defaultBranch = i.defaultBranch;
    }
    if (i.testCommand !== undefined) {
      out.testCommand = i.testCommand === null ? null : [...validateTestCommand(i.testCommand)];
    }
    if (i.testTimeoutSeconds !== undefined) out.testTimeoutSeconds = i.testTimeoutSeconds;
    if (i.junitReportPath !== undefined) {
      out.junitReportPath =
        i.junitReportPath === null ? null : normalizeWorktreeRelativePath(i.junitReportPath);
    }
    if (i.requireIndex !== undefined) out.requireIndex = i.requireIndex;
    if (i.autoIndex !== undefined) out.autoIndex = i.autoIndex;
    if (i.indexMode !== undefined) out.indexMode = i.indexMode;
    if (i.defaultAgentId !== undefined) {
      if (i.defaultAgentId !== null && !(await repos.agents.findById(i.defaultAgentId))) {
        throw new NotFoundError('Default agent not found');
      }
      out.defaultAgentId = i.defaultAgentId;
    }
    if (i.defaultTimeoutSeconds !== undefined) {
      if (i.defaultTimeoutSeconds > maxTimeoutSeconds) {
        throw fieldError(
          'body.defaultTimeoutSeconds',
          `defaultTimeoutSeconds must be <= ${maxTimeoutSeconds}`,
        );
      }
      out.defaultTimeoutSeconds = i.defaultTimeoutSeconds;
    }
    if (i.workspaceMaxBytes !== undefined) {
      if (i.workspaceMaxBytes !== null && i.workspaceMaxBytes > workspaceMaxBytes) {
        throw fieldError(
          'body.workspaceMaxBytes',
          `workspaceMaxBytes must be <= ${workspaceMaxBytes}`,
        );
      }
      out.workspaceMaxBytes = i.workspaceMaxBytes;
    }
    return out;
  }

  function mapUnique(err: unknown): unknown {
    if (err instanceof OrcError && err.code === 'unique_violation') {
      const raw = err.details?.['constraint'];
      const constraint = typeof raw === 'string' ? raw : '';
      if (constraint.includes('RepoPath'))
        return new OrcError('project_repo_taken', 'Repository already registered', { cause: err });
      return new OrcError('project_name_taken', 'Project name already exists', { cause: err });
    }
    return err;
  }

  async function loadProject(id: Uuid): Promise<ProjectRecord> {
    const project = await repos.projects.findById(id);
    if (!project) throw new NotFoundError('Project not found');
    return project;
  }

  async function enqueueSync(project: ProjectRecord, v: Viewer, ctx: RequestContext) {
    return queues.enqueueProjectJob({
      v: 1,
      kind: 'sync',
      projectId: project.id,
      requestedByUserId: v.userId,
      correlationId: ctx.correlationId,
    });
  }

  async function visibleOperation(
    projectId: Uuid,
    op: McpIndexOperation | null,
    v: Viewer,
  ): Promise<McpIndexOperation> {
    if (!op || op.projectId !== projectId) throw new NotFoundError('Index operation not found');
    if (TASK_SCOPED.has(op.kind) && !hasPerm(v, 'task:read:any')) {
      const task = op.taskId === null ? null : await repos.tasks.findById(op.taskId);
      if (!task || task.createdByUserId !== v.userId)
        throw new NotFoundError('Index operation not found');
    }
    return redactOperation(op);
  }

  const mcpViewer = (v: Viewer) => ({ userId: v.userId, canReadAny: hasPerm(v, 'task:read:any') });

  return {
    async create(i, v, ctx, idem) {
      requirePermission(v, 'project:create', { write: true });
      const repoPath = normalizeRepoRelativePath(i.repoPath);
      const fields = await normalizeFields(i);
      const actor = actorOf(v);
      const audit = auditOf(ctx);
      let project: ProjectRecord;
      try {
        project = await db.transaction(
          async (t) => {
            const created = await t.repos.projects.insert({
              name: i.name,
              description: fields.description ?? null,
              repoPath,
              defaultBranch: fields.defaultBranch ?? null,
              testCommand: fields.testCommand ?? null,
              testTimeoutSeconds: i.testTimeoutSeconds,
              junitReportPath: fields.junitReportPath ?? null,
              requireIndex: i.requireIndex,
              autoIndex: i.autoIndex,
              indexMode: i.indexMode,
              defaultAgentId: fields.defaultAgentId ?? null,
              defaultTimeoutSeconds: i.defaultTimeoutSeconds,
              workspaceMaxBytes: fields.workspaceMaxBytes ?? null,
              createdByUserId: v.userId,
            });
            await t.repos.audit.insert({
              action: 'project.created',
              actor,
              entityType: 'project',
              entityId: created.id,
              outcome: 'success',
              after: { name: created.name, repoPath: created.repoPath, status: created.status },
              ...audit,
            });
            if (idem) {
              await t.repos.idempotency.complete(idem.id, {
                status: 201,
                headers: {
                  'Content-Type': 'application/json; charset=utf-8',
                  Location: `/api/v1/projects/${created.id}`,
                  ETag: rowVerToEtag(created.rowVer),
                },
                body: JSON.stringify(toProject(created)),
                resourceId: created.id,
              });
            }
            return created;
          },
          { name: 'project.create' },
        );
      } catch (err) {
        throw mapUnique(err);
      }
      try {
        await enqueueSync(project, v, ctx);
      } catch (err) {
        logger.warn(
          { err, projectId: project.id },
          'sync-project enqueue failed; the queued reconciler re-adds it',
        );
      }
      return toProject(project);
    },

    async list(q, v) {
      requirePermission(v, 'project:read');
      const filters = { status: q.status ?? null };
      const after = keysetFromCursor(q.cursor, filters);
      const rows = await repos.projects.list({
        limit: q.limit,
        ...(after ? { after } : {}),
        ...(q.status !== undefined ? { status: q.status } : {}),
      });
      return keysetPage(rows, q.limit, filters, toProject);
    },

    async get(id, v) {
      requirePermission(v, 'project:read');
      return loadProject(id);
    },

    async update(id, ifMatch, i, v, ctx) {
      requirePermission(v, 'project:update', { write: true });
      const expectedRowVer = etagToRowVer(ifMatch);
      const current = await loadProject(id);
      if (current.status === 'archived')
        throw new OrcError('project_archived', 'Project is archived');
      const { archived, ...rest } = i;
      const patch = await normalizeFields(rest);
      if (archived === true) patch.archived = true;
      let updated: ProjectRecord;
      try {
        updated = await db.transaction(
          async (t) => {
            const row = await t.repos.projects.update(id, expectedRowVer, patch);
            await t.repos.audit.insert({
              action: archived === true ? 'project.archived' : 'project.updated',
              actor: actorOf(v),
              entityType: 'project',
              entityId: id,
              outcome: 'success',
              before: { rowVer: current.rowVer, status: current.status },
              after: { ...patch, status: row.status },
              ...auditOf(ctx),
            });
            return row;
          },
          { name: 'project.update' },
        );
      } catch (err) {
        throw mapUnique(err);
      }
      return updated;
    },

    async requestSync(id, v, ctx) {
      requirePermission(v, 'project:index', { write: true });
      const project = await loadProject(id);
      if (project.status === 'archived')
        throw new OrcError('project_archived', 'Project is archived');
      const res = await enqueueSync(project, v, ctx);
      await repos.audit.insert({
        action: 'project.sync_requested',
        actor: actorOf(v),
        entityType: 'project',
        entityId: id,
        outcome: 'success',
        detail: { jobId: res.jobId, deduplicated: res.deduplicated },
        ...auditOf(ctx),
      });
      return res;
    },

    async requestIndex(id, _i, v, ctx) {
      requirePermission(v, 'project:index', { write: true });
      if (!mcpEnabled) throw new OrcError('mcp_disabled', 'Code index is disabled');
      const project = await loadProject(id);
      if (project.status !== 'ready')
        throw new OrcError('project_not_ready', `Project is ${project.status}`);
      // ADR-0030: project_index always runs (and records) mode full; the requested mode is accepted and ignored.
      const op = await db.transaction(
        async (t) => {
          const created = await t.repos.mcpOperations.insert({
            projectId: id,
            taskId: null,
            attemptId: null,
            workspaceId: null,
            kind: 'project_index',
            indexName: projectIndexName(id),
            mode: 'full',
            status: 'queued',
            requestedByUserId: v.userId,
            workerId: null,
          });
          await t.repos.audit.insert({
            action: 'project.index_requested',
            actor: actorOf(v),
            entityType: 'index_operation',
            entityId: created.id,
            outcome: 'success',
            detail: { projectId: id, mode: 'full' },
            ...auditOf(ctx),
          });
          return created;
        },
        { name: 'project.requestIndex' },
      );
      try {
        await queues.enqueueProjectJob({
          v: 1,
          kind: 'index',
          projectId: id,
          operationId: op.id,
          mode: 'full',
          requestedByUserId: v.userId,
          correlationId: ctx.correlationId,
        });
      } catch (err) {
        // A queued op without a job would block every later request (UX_..._ActiveProjectIndex): fail it.
        await repos.mcpOperations
          .finish(op.id, {
            status: 'failed',
            nodeCount: null,
            edgeCount: null,
            result: null,
            errorCode: 'redis_unavailable',
            errorMessage: 'index-project job could not be enqueued',
            durationMs: 0,
          })
          .catch((finishErr: unknown) =>
            logger.error({ err: finishErr, operationId: op.id }, 'index op cleanup failed'),
          );
        throw err;
      }
      return op;
    },

    async indexStatus(id, v) {
      requirePermission(v, 'project:read');
      const project = await loadProject(id);
      const [active, last, lastOk] = await Promise.all([
        repos.mcpOperations.findActiveProjectOp(id),
        repos.mcpOperations.findLatest({ projectId: id, kind: 'project_index' }),
        repos.mcpOperations.findLatest({
          projectId: id,
          kind: 'project_index',
          status: 'succeeded',
        }),
      ]);
      const indexedHead = headShaOf(lastOk);
      return {
        projectId: id,
        indexName: projectIndexName(id),
        mcpEnabled,
        activeOperation: active,
        lastOperation: last,
        lastSuccessfulOperation: lastOk,
        nodeCount: lastOk?.nodeCount ?? null,
        edgeCount: lastOk?.edgeCount ?? null,
        indexedAt: project.lastIndexedAt ?? lastOk?.endedAt ?? null,
        projectHeadSha: project.headSha,
        stale: lastOk === null ? project.headSha !== null : indexedHead !== project.headSha,
      };
    },

    async indexOperations(id, q, v) {
      requirePermission(v, 'project:read');
      await loadProject(id);
      const filters = { projectId: id };
      const after = keysetFromCursor(q.cursor, filters);
      const rows = await repos.mcpOperations.listByProject({
        projectId: id,
        viewer: mcpViewer(v),
        limit: q.limit,
        ...(after ? { after } : {}),
      });
      return keysetPage(rows, q.limit, filters, redactOperation);
    },

    async indexOperation(id, operationId, v) {
      requirePermission(v, 'project:read');
      await loadProject(id);
      return visibleOperation(id, await repos.mcpOperations.findById(operationId), v);
    },

    async mcpStatus(v) {
      requirePermission(v, 'system:read');
      const [workers, recent] = await Promise.all([
        repos.workerNodes.list(),
        repos.mcpOperations.findRecent({ limit: RECENT_OPERATIONS, viewer: mcpViewer(v) }),
      ]);
      return {
        mcpEnabled,
        workers: workers.map((w) => ({
          workerId: w.id,
          status: w.status,
          mcpVersion: w.mcpVersion,
          cliVersion: w.cliVersion,
          lastHeartbeatAt: w.lastHeartbeatAt,
        })),
        recentOperations: recent.map(redactOperation),
      };
    },
  };
}
