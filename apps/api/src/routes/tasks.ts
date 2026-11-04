// /tasks delegating to TaskService (contract §2.9, §9.5). Every /tasks/:taskId/** read enforces visibility in the
// service (findVisible => 404, never 403). Creation only records + enqueues: the API never executes work (ADR-0019).
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  AttemptQuerySchema,
  CancelTaskRequestSchema,
  ChangedFileSchema,
  ClaudeSessionSchema,
  CreateTaskRequestSchema,
  DiffFileSchema,
  DiffQuerySchema,
  IdSchema,
  LogQuerySchema,
  McpIndexOperationSchema,
  MergeCheckSchema,
  PageQuerySchema,
  RetryTaskRequestSchema,
  TaskAttemptSchema,
  TaskDetailSchema,
  TaskEventSchema,
  TaskListQuerySchema,
  TaskLogSchema,
  TaskSchema,
  TestResultQuerySchema,
  TestResultSchema,
  TestRunSchema,
  pageOf,
} from '@orc/shared';
import type { Permission } from '@orc/shared';
import { withIdempotency } from '../idempotency.js';
import { optionalIfMatch, sendEntity, sendJson, setLocation } from '../http.js';
import { defineRoute } from '../route.js';
import type { AnyRouteDef } from '../route.js';
import { streamTask } from '../sse/stream.js';

const gunzipAsync = promisify(gunzip);

const TaskParams = z.object({ taskId: IdSchema });
const AttemptParams = z.object({ taskId: IdSchema, attemptId: IdSchema });
const TestRunParams = z.object({ taskId: IdSchema, testRunId: IdSchema });
const StreamQuerySchema = z.object({ lastEventId: z.string().max(64).optional() });

const READ: readonly Permission[] = ['task:read:own', 'task:read:any'];
const CANCEL: readonly Permission[] = ['task:cancel:own', 'task:cancel:any'];
const RETRY: readonly Permission[] = ['task:retry:own', 'task:retry:any'];
const NOT_FOUND = { 404: { description: 'not_found' } } as const;

export function taskRoutes(): AnyRouteDef[] {
  return [
    defineRoute({
      method: 'get',
      path: '/tasks',
      operationId: 'listTasks',
      summary: 'List tasks (own tasks only without task:read:any)',
      tag: 'tasks',
      auth: 'any',
      permission: READ,
      rateClass: 'read',
      query: TaskListQuerySchema,
      responses: {
        200: { description: 'Page of tasks', schema: pageOf(TaskSchema) },
        403: { description: 'forbidden (createdBy without task:read:any)' },
      },
      async handler(c) {
        sendJson(c.res, 200, await c.deps.tasks.list(c.query, c.viewer()));
      },
    }),
    defineRoute({
      method: 'post',
      path: '/tasks',
      operationId: 'createTask',
      summary: 'Create a task (recorded and enqueued; executed by a worker)',
      tag: 'tasks',
      auth: 'any',
      permission: ['task:create'],
      rateClass: 'task_create',
      body: CreateTaskRequestSchema,
      headers: [{ name: 'Idempotency-Key', required: false, description: 'Replay-safe creation (§9.3)' }],
      responses: {
        202: { description: 'Task accepted', schema: TaskSchema, headers: ['Location', 'Idempotent-Replayed'] },
        404: { description: 'not_found (project / agent)' },
        409: { description: 'project_not_ready | agent_inactive | idempotency_key_in_use' },
        422: { description: 'model_not_allowed | prompt_too_large | idempotency_key_mismatch' },
      },
      async handler(c) {
        const viewer = c.viewer();
        await withIdempotency(c.deps, c.req, c.res, viewer, 'POST /api/v1/tasks', async (idem) => {
          const { task } = await c.deps.tasks.create(c.body, viewer, c.ctx, idem);
          setLocation(c.res, `/tasks/${task.id}`);
          sendJson(c.res, 202, task);
        });
      },
    }),
    defineRoute({
      method: 'get',
      path: '/tasks/:taskId',
      operationId: 'getTask',
      summary: 'Task detail',
      tag: 'tasks',
      auth: 'any',
      permission: READ,
      rateClass: 'read',
      params: TaskParams,
      headers: [{ name: 'If-None-Match', required: false, description: 'ETag of a cached copy (304)' }],
      responses: {
        200: { description: 'Task detail', schema: TaskDetailSchema, headers: ['ETag'] },
        304: { description: 'Not modified' },
        ...NOT_FOUND,
      },
      async handler(c) {
        const { task, detail } = await c.deps.tasks.get(c.params.taskId, c.viewer());
        sendEntity(c.req, c.res, 200, detail, task.rowVer);
      },
    }),
    defineRoute({
      method: 'post',
      path: '/tasks/:taskId/cancel',
      operationId: 'cancelTask',
      summary: 'Cancel a task (200 immediate, 202 requested for an active task)',
      tag: 'tasks',
      auth: 'any',
      permission: CANCEL,
      rateClass: 'write',
      params: TaskParams,
      body: CancelTaskRequestSchema,
      bodyOptional: true,
      responses: {
        200: { description: 'Cancelled', schema: TaskSchema },
        202: { description: 'Cancellation requested', schema: TaskSchema },
        ...NOT_FOUND,
        409: { description: 'task_not_cancellable' },
      },
      async handler(c) {
        const { task, immediate } = await c.deps.tasks.cancel(c.params.taskId, c.body, c.viewer(), c.ctx);
        sendJson(c.res, immediate ? 200 : 202, task);
      },
    }),
    defineRoute({
      method: 'post',
      path: '/tasks/:taskId/retry',
      operationId: 'retryTask',
      summary: 'Retry a settled task with a new attempt',
      tag: 'tasks',
      auth: 'any',
      permission: RETRY,
      rateClass: 'task_create',
      params: TaskParams,
      body: RetryTaskRequestSchema,
      bodyOptional: true,
      headers: [{ name: 'If-Match', required: false, description: 'ETag of the task (412 on mismatch)' }],
      responses: {
        202: { description: 'Retry accepted', schema: TaskSchema, headers: ['Location'] },
        ...NOT_FOUND,
        409: { description: 'task_not_retryable | retry_limit_reached | project_not_ready' },
        412: { description: 'precondition_failed' },
      },
      async handler(c) {
        const { task } = await c.deps.tasks.retry(
          c.params.taskId,
          c.body,
          c.viewer(),
          c.ctx,
          optionalIfMatch(c.req),
        );
        setLocation(c.res, `/tasks/${task.id}`);
        sendJson(c.res, 202, task);
      },
    }),
    defineRoute({
      method: 'get',
      path: '/tasks/:taskId/stream',
      operationId: 'streamTask',
      summary: 'Live task events (Server-Sent Events, §8)',
      tag: 'tasks',
      auth: 'any',
      permission: READ,
      rateClass: 'stream',
      params: TaskParams,
      query: StreamQuerySchema,
      headers: [{ name: 'Last-Event-ID', required: false, description: 'Resume point (r-<id> | d-<id> | d-end)' }],
      responses: {
        200: { description: 'Event stream', contentType: 'text/event-stream', schema: z.string() },
        204: { description: 'Settled and nothing after the resume point' },
        ...NOT_FOUND,
        429: { description: 'sse_connection_limit', headers: ['Retry-After'] },
        503: { description: 'service_unavailable', headers: ['Retry-After'] },
      },
      async handler(c) {
        await streamTask(c, c.params.taskId, c.query.lastEventId);
      },
    }),
    defineRoute({
      method: 'get',
      path: '/tasks/:taskId/logs',
      operationId: 'listTaskLogs',
      summary: 'Task logs of an attempt (format=text => concatenated stream)',
      tag: 'tasks',
      auth: 'any',
      permission: READ,
      rateClass: 'read',
      params: TaskParams,
      query: LogQuerySchema,
      responses: {
        200: { description: 'Page of logs (cursor = last seq) or text/plain', schema: pageOf(TaskLogSchema) },
        ...NOT_FOUND,
      },
      async handler(c) {
        const page = await c.deps.tasks.logs(c.params.taskId, c.query, c.viewer());
        if (c.query.format === 'text') {
          c.res.status(200);
          c.res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          c.res.send(page.items.map((l) => l.content).join(''));
          return;
        }
        sendJson(c.res, 200, page);
      },
    }),
    defineRoute({
      method: 'get',
      path: '/tasks/:taskId/events',
      operationId: 'listTaskEvents',
      summary: 'Task state events',
      tag: 'tasks',
      auth: 'any',
      permission: READ,
      rateClass: 'read',
      params: TaskParams,
      query: PageQuerySchema,
      responses: { 200: { description: 'Page of events', schema: pageOf(TaskEventSchema) }, ...NOT_FOUND },
      async handler(c) {
        sendJson(c.res, 200, await c.deps.tasks.events(c.params.taskId, c.query, c.viewer()));
      },
    }),
    defineRoute({
      method: 'get',
      path: '/tasks/:taskId/attempts',
      operationId: 'listTaskAttempts',
      summary: 'Attempts of a task',
      tag: 'tasks',
      auth: 'any',
      permission: READ,
      rateClass: 'read',
      params: TaskParams,
      responses: { 200: { description: 'Attempts', schema: z.array(TaskAttemptSchema) }, ...NOT_FOUND },
      async handler(c) {
        sendJson(c.res, 200, await c.deps.tasks.attempts(c.params.taskId, c.viewer()));
      },
    }),
    defineRoute({
      method: 'get',
      path: '/tasks/:taskId/attempts/:attemptId',
      operationId: 'getTaskAttempt',
      summary: 'One attempt of a task',
      tag: 'tasks',
      auth: 'any',
      permission: READ,
      rateClass: 'read',
      params: AttemptParams,
      responses: { 200: { description: 'Attempt', schema: TaskAttemptSchema }, ...NOT_FOUND },
      async handler(c) {
        sendJson(c.res, 200, await c.deps.tasks.attempt(c.params.taskId, c.params.attemptId, c.viewer()));
      },
    }),
    defineRoute({
      method: 'get',
      path: '/tasks/:taskId/tests',
      operationId: 'listTaskTestRuns',
      summary: 'Test runs of an attempt',
      tag: 'tasks',
      auth: 'any',
      permission: READ,
      rateClass: 'read',
      params: TaskParams,
      query: AttemptQuerySchema,
      responses: { 200: { description: 'Test runs', schema: z.array(TestRunSchema) }, ...NOT_FOUND },
      async handler(c) {
        sendJson(c.res, 200, await c.deps.tasks.tests(c.params.taskId, c.query, c.viewer()));
      },
    }),
    defineRoute({
      method: 'get',
      path: '/tasks/:taskId/tests/:testRunId/results',
      operationId: 'listTestResults',
      summary: 'Test case results of a test run',
      tag: 'tasks',
      auth: 'any',
      permission: READ,
      rateClass: 'read',
      params: TestRunParams,
      query: TestResultQuerySchema,
      responses: { 200: { description: 'Page of results', schema: pageOf(TestResultSchema) }, ...NOT_FOUND },
      async handler(c) {
        sendJson(
          c.res,
          200,
          await c.deps.tasks.testResults(c.params.taskId, c.params.testRunId, c.query, c.viewer()),
        );
      },
    }),
    defineRoute({
      method: 'get',
      path: '/tasks/:taskId/changed-files',
      operationId: 'listChangedFiles',
      summary: 'Files changed by an attempt',
      tag: 'tasks',
      auth: 'any',
      permission: READ,
      rateClass: 'read',
      params: TaskParams,
      query: AttemptQuerySchema,
      responses: { 200: { description: 'Changed files', schema: z.array(ChangedFileSchema) }, ...NOT_FOUND },
      async handler(c) {
        sendJson(c.res, 200, await c.deps.tasks.changedFiles(c.params.taskId, c.query, c.viewer()));
      },
    }),
    defineRoute({
      method: 'get',
      path: '/tasks/:taskId/diff',
      operationId: 'getTaskDiff',
      summary: 'Per-file diff (Accept: text/x-diff => concatenated unified diff)',
      tag: 'tasks',
      auth: 'any',
      permission: READ,
      rateClass: 'read',
      params: TaskParams,
      query: DiffQuerySchema,
      headers: [{ name: 'Accept', required: false, description: 'text/x-diff for a plain unified diff' }],
      responses: { 200: { description: 'Page of diff files', schema: pageOf(DiffFileSchema) }, ...NOT_FOUND },
      async handler(c) {
        const page = await c.deps.tasks.diff(c.params.taskId, c.query, c.viewer());
        if (c.req.accepts(['application/json', 'text/x-diff']) === 'text/x-diff') {
          c.res.status(200);
          c.res.setHeader('Content-Type', 'text/x-diff; charset=utf-8');
          c.res.send(
            page.items
              .map((f) => f.patch ?? '')
              .filter((p) => p !== '')
              .map((p) => (p.endsWith('\n') ? p : `${p}\n`))
              .join(''),
          );
          return;
        }
        sendJson(c.res, 200, page);
      },
    }),
    defineRoute({
      method: 'get',
      path: '/tasks/:taskId/patch',
      operationId: 'getTaskPatch',
      summary: 'Unified patch of an attempt (attachment)',
      tag: 'tasks',
      auth: 'any',
      permission: READ,
      rateClass: 'read',
      params: TaskParams,
      query: AttemptQuerySchema,
      responses: {
        200: { description: 'Patch file', contentType: 'application/x-patch', schema: z.string() },
        404: { description: 'not_found | patch_unavailable' },
      },
      async handler(c) {
        const p = await c.deps.tasks.patch(c.params.taskId, c.query, c.viewer());
        c.res.status(200);
        c.res.setHeader('Content-Type', 'application/x-patch');
        c.res.setHeader('Content-Disposition', `attachment; filename="${p.fileName}"`);
        c.res.setHeader('Vary', 'Accept-Encoding');
        if (c.req.acceptsEncodings('gzip', 'identity') === 'gzip') {
          c.res.setHeader('Content-Encoding', 'gzip');
          c.res.send(p.gzip);
          return;
        }
        c.res.send(await gunzipAsync(p.gzip));
      },
    }),
    defineRoute({
      method: 'get',
      path: '/tasks/:taskId/merge-check',
      operationId: 'getMergeCheck',
      summary: 'Merge check result of an attempt',
      tag: 'tasks',
      auth: 'any',
      permission: READ,
      rateClass: 'read',
      params: TaskParams,
      query: AttemptQuerySchema,
      responses: {
        200: { description: 'Merge check', schema: MergeCheckSchema },
        404: { description: 'not_found | merge_check_unavailable' },
      },
      async handler(c) {
        sendJson(c.res, 200, await c.deps.tasks.mergeCheck(c.params.taskId, c.query, c.viewer()));
      },
    }),
    defineRoute({
      method: 'get',
      path: '/tasks/:taskId/session',
      operationId: 'getClaudeSession',
      summary: 'Claude session of an attempt',
      tag: 'tasks',
      auth: 'any',
      permission: READ,
      rateClass: 'read',
      params: TaskParams,
      query: AttemptQuerySchema,
      responses: { 200: { description: 'Claude session', schema: ClaudeSessionSchema }, ...NOT_FOUND },
      async handler(c) {
        sendJson(c.res, 200, await c.deps.tasks.session(c.params.taskId, c.query, c.viewer()));
      },
    }),
    defineRoute({
      method: 'get',
      path: '/tasks/:taskId/impact',
      operationId: 'getTaskImpact',
      summary: 'Impact analysis operation of an attempt',
      tag: 'tasks',
      auth: 'any',
      permission: READ,
      rateClass: 'read',
      params: TaskParams,
      query: AttemptQuerySchema,
      responses: { 200: { description: 'Impact analysis', schema: McpIndexOperationSchema }, ...NOT_FOUND },
      async handler(c) {
        sendJson(c.res, 200, await c.deps.tasks.impact(c.params.taskId, c.query, c.viewer()));
      },
    }),
  ];
}
