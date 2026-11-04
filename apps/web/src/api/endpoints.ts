// One typed function per /api/v1 endpoint used by the web app (contract §9.5).
import {
  AgentSchema,
  ApiTokenSchema,
  AuditLogSchema,
  ChangedFileSchema,
  ClaudeSessionSchema,
  CreatedApiTokenSchema,
  DeadLetterEntrySchema,
  DiffFileSchema,
  LoginResponseSchema,
  McpIndexOperationSchema,
  McpStatusSchema,
  MergeCheckSchema,
  ProjectIndexStatusSchema,
  ProjectSchema,
  QueueStatusSchema,
  TaskAttemptSchema,
  TaskDetailSchema,
  TaskEventSchema,
  TaskLogSchema,
  TaskSchema,
  TeamDetailSchema,
  TeamSchema,
  TestResultSchema,
  TestRunSchema,
  WorkerNodeSchema,
  pageOf,
} from '@orc/shared';
import type {
  Agent,
  ApiToken,
  AuditAction,
  AuditEntityType,
  AuditLog,
  ChangePasswordRequest,
  ChangedFile,
  ClaudeSession,
  CreateAgentRequest,
  CreateApiTokenRequest,
  CreateProjectRequest,
  CreateTaskRequest,
  CreateTeamRequest,
  CreatedApiToken,
  DeadLetterEntry,
  DiffFile,
  IndexMode,
  LoginRequest,
  LoginResponse,
  LogStream,
  McpIndexOperation,
  McpStatus,
  MeResponse,
  MergeCheck,
  Page,
  Project,
  ProjectIndexStatus,
  ProjectStatus,
  QueueStatus,
  Task,
  TaskAttempt,
  TaskDetail,
  TaskEvent,
  TaskLog,
  TaskStatus,
  Team,
  TeamDetail,
  TestCaseStatus,
  TestResult,
  TestRun,
  UpdateAgentRequest,
  UpdateProjectRequest,
  UpdateTeamRequest,
  WorkerNode,
} from '@orc/shared';
import type { ApiClient, ApiResponse } from './client';
import { SyncProjectResponseSchema, arrayOf } from './schema';
import type { SyncProjectResponse } from './schema';

const ProjectPageSchema = pageOf(ProjectSchema);
const TaskPageSchema = pageOf(TaskSchema);
const TaskLogPageSchema = pageOf(TaskLogSchema);
const TaskEventPageSchema = pageOf(TaskEventSchema);
const DiffFilePageSchema = pageOf(DiffFileSchema);
const TestResultPageSchema = pageOf(TestResultSchema);
const McpOperationPageSchema = pageOf(McpIndexOperationSchema);
const AuditLogPageSchema = pageOf(AuditLogSchema);
const DeadLetterPageSchema = pageOf(DeadLetterEntrySchema);

export interface PageParams {
  limit?: number;
  cursor?: string | null;
}

export interface TaskListParams extends PageParams {
  status?: readonly TaskStatus[];
  projectId?: string;
  createdBy?: string;
}

export interface AuditLogParams extends PageParams {
  actorUserId?: string;
  action?: AuditAction;
  entityType?: AuditEntityType;
  entityId?: string;
  from?: string;
  to?: string;
}

export interface LogParams {
  attemptId?: string;
  stream?: LogStream;
  afterSeq?: number;
  limit?: number;
}

export interface RetryTaskBody {
  mode: 'fresh' | 'continue';
  additionalInstructions?: string;
  baseRef?: string;
}

const enc = encodeURIComponent;

/** Endpoint facade bound to one ApiClient (one per app / per test). */
export class Api {
  readonly client: ApiClient;

  constructor(client: ApiClient) {
    this.client = client;
  }

  // ---- auth ------------------------------------------------------------------------

  async login(body: LoginRequest): Promise<LoginResponse> {
    const res = await this.client.json(
      { method: 'POST', path: '/auth/login', body },
      LoginResponseSchema,
    );
    this.client.setCsrfToken(res.data.csrfToken);
    return res.data;
  }

  async logout(): Promise<void> {
    await this.client.empty({ method: 'POST', path: '/auth/logout' });
    this.client.setCsrfToken(null);
  }

  me(signal?: AbortSignal): Promise<MeResponse> {
    return this.client.fetchMe(signal);
  }

  async changePassword(body: ChangePasswordRequest): Promise<void> {
    await this.client.empty({ method: 'POST', path: '/auth/password', body });
  }

  async listTokens(): Promise<ApiToken[]> {
    return (await this.client.json({ path: '/auth/tokens' }, arrayOf(ApiTokenSchema))).data;
  }

  async createToken(body: CreateApiTokenRequest): Promise<CreatedApiToken> {
    return (
      await this.client.json({ method: 'POST', path: '/auth/tokens', body }, CreatedApiTokenSchema)
    ).data;
  }

  async revokeToken(tokenId: string): Promise<void> {
    await this.client.empty({ method: 'DELETE', path: `/auth/tokens/${enc(tokenId)}` });
  }

  // ---- projects -------------------------------------------------------------------

  async listProjects(params: PageParams & { status?: ProjectStatus } = {}): Promise<Page<Project>> {
    return (
      await this.client.json(
        {
          path: '/projects',
          query: { limit: params.limit, cursor: params.cursor, status: params.status },
        },
        ProjectPageSchema,
      )
    ).data;
  }

  createProject(body: CreateProjectRequest, idempotencyKey: string): Promise<ApiResponse<Project>> {
    return this.client.json(
      { method: 'POST', path: '/projects', body, idempotencyKey },
      ProjectSchema,
    );
  }

  getProject(projectId: string, signal?: AbortSignal): Promise<ApiResponse<Project>> {
    return this.client.json({ path: `/projects/${enc(projectId)}`, signal }, ProjectSchema);
  }

  updateProject(
    projectId: string,
    body: UpdateProjectRequest,
    etag: string | null,
  ): Promise<ApiResponse<Project>> {
    return this.client.json(
      { method: 'PATCH', path: `/projects/${enc(projectId)}`, body, ifMatch: etag },
      ProjectSchema,
    );
  }

  async syncProject(projectId: string): Promise<SyncProjectResponse> {
    return (
      await this.client.json(
        { method: 'POST', path: `/projects/${enc(projectId)}/sync` },
        SyncProjectResponseSchema,
      )
    ).data;
  }

  async requestIndex(projectId: string, mode?: IndexMode): Promise<McpIndexOperation> {
    return (
      await this.client.json(
        {
          method: 'POST',
          path: `/projects/${enc(projectId)}/index`,
          body: mode === undefined ? {} : { mode },
        },
        McpIndexOperationSchema,
      )
    ).data;
  }

  async indexStatus(projectId: string): Promise<ProjectIndexStatus> {
    return (
      await this.client.json(
        { path: `/projects/${enc(projectId)}/index-status` },
        ProjectIndexStatusSchema,
      )
    ).data;
  }

  async indexOperations(projectId: string, params: PageParams = {}): Promise<Page<McpIndexOperation>> {
    return (
      await this.client.json(
        {
          path: `/projects/${enc(projectId)}/index-operations`,
          query: { limit: params.limit, cursor: params.cursor },
        },
        McpOperationPageSchema,
      )
    ).data;
  }

  // ---- tasks ------------------------------------------------------------------------

  async listTasks(params: TaskListParams = {}): Promise<Page<Task>> {
    return (
      await this.client.json(
        {
          path: '/tasks',
          query: {
            limit: params.limit,
            cursor: params.cursor,
            status: params.status,
            projectId: params.projectId,
            createdBy: params.createdBy,
          },
        },
        TaskPageSchema,
      )
    ).data;
  }

  createTask(body: CreateTaskRequest, idempotencyKey: string): Promise<ApiResponse<Task>> {
    return this.client.json({ method: 'POST', path: '/tasks', body, idempotencyKey }, TaskSchema);
  }

  getTask(taskId: string, signal?: AbortSignal): Promise<ApiResponse<TaskDetail>> {
    return this.client.json({ path: `/tasks/${enc(taskId)}`, signal }, TaskDetailSchema);
  }

  cancelTask(taskId: string, reason: string | undefined): Promise<ApiResponse<Task>> {
    return this.client.json(
      {
        method: 'POST',
        path: `/tasks/${enc(taskId)}/cancel`,
        body: reason === undefined || reason.length === 0 ? {} : { reason },
      },
      TaskSchema,
    );
  }

  retryTask(taskId: string, body: RetryTaskBody, etag: string | null): Promise<ApiResponse<Task>> {
    return this.client.json(
      { method: 'POST', path: `/tasks/${enc(taskId)}/retry`, body, ifMatch: etag },
      TaskSchema,
    );
  }

  async logs(taskId: string, params: LogParams = {}): Promise<Page<TaskLog>> {
    return (
      await this.client.json(
        {
          path: `/tasks/${enc(taskId)}/logs`,
          query: {
            attemptId: params.attemptId,
            stream: params.stream,
            afterSeq: params.afterSeq,
            limit: params.limit,
          },
        },
        TaskLogPageSchema,
      )
    ).data;
  }

  async events(taskId: string, params: PageParams = {}): Promise<Page<TaskEvent>> {
    return (
      await this.client.json(
        { path: `/tasks/${enc(taskId)}/events`, query: { limit: params.limit, cursor: params.cursor } },
        TaskEventPageSchema,
      )
    ).data;
  }

  async attempts(taskId: string): Promise<TaskAttempt[]> {
    return (
      await this.client.json({ path: `/tasks/${enc(taskId)}/attempts` }, arrayOf(TaskAttemptSchema))
    ).data;
  }

  async changedFiles(taskId: string, attemptId?: string): Promise<ChangedFile[]> {
    return (
      await this.client.json(
        { path: `/tasks/${enc(taskId)}/changed-files`, query: { attemptId } },
        arrayOf(ChangedFileSchema),
      )
    ).data;
  }

  async diff(
    taskId: string,
    params: PageParams & { attemptId?: string; path?: string } = {},
  ): Promise<Page<DiffFile>> {
    return (
      await this.client.json(
        {
          path: `/tasks/${enc(taskId)}/diff`,
          query: {
            attemptId: params.attemptId,
            path: params.path,
            limit: params.limit,
            cursor: params.cursor,
          },
        },
        DiffFilePageSchema,
      )
    ).data;
  }

  async mergeCheck(taskId: string, attemptId?: string): Promise<MergeCheck> {
    return (
      await this.client.json(
        { path: `/tasks/${enc(taskId)}/merge-check`, query: { attemptId } },
        MergeCheckSchema,
      )
    ).data;
  }

  async testRuns(taskId: string, attemptId?: string): Promise<TestRun[]> {
    return (
      await this.client.json(
        { path: `/tasks/${enc(taskId)}/tests`, query: { attemptId } },
        arrayOf(TestRunSchema),
      )
    ).data;
  }

  async testResults(
    taskId: string,
    testRunId: string,
    params: PageParams & { status?: TestCaseStatus } = {},
  ): Promise<Page<TestResult>> {
    return (
      await this.client.json(
        {
          path: `/tasks/${enc(taskId)}/tests/${enc(testRunId)}/results`,
          query: { limit: params.limit, cursor: params.cursor, status: params.status },
        },
        TestResultPageSchema,
      )
    ).data;
  }

  async session(taskId: string, attemptId?: string): Promise<ClaudeSession> {
    return (
      await this.client.json(
        { path: `/tasks/${enc(taskId)}/session`, query: { attemptId } },
        ClaudeSessionSchema,
      )
    ).data;
  }

  async impact(taskId: string, attemptId?: string): Promise<McpIndexOperation> {
    return (
      await this.client.json(
        { path: `/tasks/${enc(taskId)}/impact`, query: { attemptId } },
        McpIndexOperationSchema,
      )
    ).data;
  }

  // ---- agents / teams -------------------------------------------------------------------

  async listAgents(params: { teamId?: string; includeInactive?: boolean } = {}): Promise<Agent[]> {
    return (
      await this.client.json(
        {
          path: '/agents',
          query: { teamId: params.teamId, includeInactive: params.includeInactive ? 'true' : undefined },
        },
        arrayOf(AgentSchema),
      )
    ).data;
  }

  getAgent(agentId: string): Promise<ApiResponse<Agent>> {
    return this.client.json({ path: `/agents/${enc(agentId)}` }, AgentSchema);
  }

  createAgent(body: CreateAgentRequest): Promise<ApiResponse<Agent>> {
    return this.client.json({ method: 'POST', path: '/agents', body }, AgentSchema);
  }

  updateAgent(agentId: string, body: UpdateAgentRequest, etag: string | null): Promise<ApiResponse<Agent>> {
    return this.client.json(
      { method: 'PATCH', path: `/agents/${enc(agentId)}`, body, ifMatch: etag },
      AgentSchema,
    );
  }

  async listTeams(): Promise<Team[]> {
    return (await this.client.json({ path: '/teams' }, arrayOf(TeamSchema))).data;
  }

  getTeam(teamId: string): Promise<ApiResponse<TeamDetail>> {
    return this.client.json({ path: `/teams/${enc(teamId)}` }, TeamDetailSchema);
  }

  createTeam(body: CreateTeamRequest): Promise<ApiResponse<Team>> {
    return this.client.json({ method: 'POST', path: '/teams', body }, TeamSchema);
  }

  updateTeam(teamId: string, body: UpdateTeamRequest, etag: string | null): Promise<ApiResponse<Team>> {
    return this.client.json(
      { method: 'PATCH', path: `/teams/${enc(teamId)}`, body, ifMatch: etag },
      TeamSchema,
    );
  }

  // ---- system / audit ---------------------------------------------------------------------

  async workers(): Promise<WorkerNode[]> {
    return (await this.client.json({ path: '/system/workers' }, arrayOf(WorkerNodeSchema))).data;
  }

  async queue(): Promise<QueueStatus> {
    return (await this.client.json({ path: '/system/queue' }, QueueStatusSchema)).data;
  }

  async deadLetters(params: PageParams = {}): Promise<Page<DeadLetterEntry>> {
    return (
      await this.client.json(
        { path: '/system/dlq', query: { limit: params.limit, cursor: params.cursor } },
        DeadLetterPageSchema,
      )
    ).data;
  }

  async mcp(): Promise<McpStatus> {
    return (await this.client.json({ path: '/system/mcp' }, McpStatusSchema)).data;
  }

  async auditLogs(params: AuditLogParams = {}): Promise<Page<AuditLog>> {
    return (
      await this.client.json(
        {
          path: '/audit-logs',
          query: {
            limit: params.limit,
            cursor: params.cursor,
            actorUserId: params.actorUserId,
            action: params.action,
            entityType: params.entityType,
            entityId: params.entityId,
            from: params.from,
            to: params.to,
          },
        },
        AuditLogPageSchema,
      )
    ).data;
  }
}

/** Download URL for `GET /tasks/:id/patch` (served as an attachment; plain navigation keeps cookies). */
export function patchDownloadUrl(taskId: string, attemptId?: string): string {
  const qs = attemptId ? `?attemptId=${enc(attemptId)}` : '';
  return `/api/v1/tasks/${enc(taskId)}/patch${qs}`;
}
