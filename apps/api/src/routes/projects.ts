// /projects (+ sync, index, index-status, index-operations) delegating to ProjectService (contract §2.10, §9.5).
import { z } from 'zod';
import {
  CreateProjectRequestSchema,
  IdSchema,
  McpIndexOperationSchema,
  PageQuerySchema,
  ProjectIndexStatusSchema,
  ProjectListQuerySchema,
  ProjectSchema,
  RequestIndexRequestSchema,
  UpdateProjectRequestSchema,
  pageOf,
} from '@orc/shared';
import { toProject } from '@orc/project-manager';
import { withIdempotency } from '../idempotency.js';
import { requireIfMatch, sendEntity, sendJson, setLocation } from '../http.js';
import { defineRoute } from '../route.js';
import type { AnyRouteDef } from '../route.js';

const ProjectParams = z.object({ projectId: IdSchema });
const OperationParams = z.object({ projectId: IdSchema, operationId: IdSchema });
const SyncResponseSchema = z.object({ jobId: z.string(), deduplicated: z.boolean() });

export function projectRoutes(): AnyRouteDef[] {
  return [
    defineRoute({
      method: 'get',
      path: '/projects',
      operationId: 'listProjects',
      summary: 'List projects',
      tag: 'projects',
      auth: 'any',
      permission: ['project:read'],
      rateClass: 'read',
      query: ProjectListQuerySchema,
      responses: { 200: { description: 'Page of projects', schema: pageOf(ProjectSchema) } },
      async handler(c) {
        sendJson(c.res, 200, await c.deps.projects.list(c.query, c.viewer()));
      },
    }),
    defineRoute({
      method: 'post',
      path: '/projects',
      operationId: 'createProject',
      summary: 'Register a project (status validating; a sync job is enqueued)',
      tag: 'projects',
      auth: 'any',
      permission: ['project:create'],
      rateClass: 'write',
      body: CreateProjectRequestSchema,
      headers: [{ name: 'Idempotency-Key', required: false, description: 'Replay-safe creation (§9.3)' }],
      responses: {
        201: { description: 'Created project', schema: ProjectSchema, headers: ['Location', 'Idempotent-Replayed'] },
        404: { description: 'not_found (defaultAgentId)' },
        409: { description: 'project_name_taken | project_repo_taken | idempotency_key_in_use' },
        422: { description: 'idempotency_key_mismatch' },
      },
      async handler(c) {
        const viewer = c.viewer();
        await withIdempotency(c.deps, c.req, c.res, viewer, 'POST /api/v1/projects', async (idem) => {
          const project = await c.deps.projects.create(c.body, viewer, c.ctx, idem);
          setLocation(c.res, `/projects/${project.id}`);
          sendJson(c.res, 201, project);
        });
      },
    }),
    defineRoute({
      method: 'get',
      path: '/projects/:projectId',
      operationId: 'getProject',
      summary: 'Get a project',
      tag: 'projects',
      auth: 'any',
      permission: ['project:read'],
      rateClass: 'read',
      params: ProjectParams,
      headers: [{ name: 'If-None-Match', required: false, description: 'ETag of a cached copy (304)' }],
      responses: {
        200: { description: 'Project', schema: ProjectSchema, headers: ['ETag'] },
        304: { description: 'Not modified' },
        404: { description: 'not_found' },
      },
      async handler(c) {
        const record = await c.deps.projects.get(c.params.projectId, c.viewer());
        sendEntity(c.req, c.res, 200, toProject(record), record.rowVer);
      },
    }),
    defineRoute({
      method: 'patch',
      path: '/projects/:projectId',
      operationId: 'updateProject',
      summary: 'Update or archive a project',
      tag: 'projects',
      auth: 'any',
      permission: ['project:update'],
      rateClass: 'write',
      params: ProjectParams,
      body: UpdateProjectRequestSchema,
      headers: [{ name: 'If-Match', required: true, description: 'ETag of the project' }],
      responses: {
        200: { description: 'Updated project', schema: ProjectSchema, headers: ['ETag'] },
        404: { description: 'not_found' },
        409: { description: 'project_archived' },
        412: { description: 'precondition_failed' },
        428: { description: 'precondition_required' },
      },
      async handler(c) {
        const ifMatch = requireIfMatch(c.req);
        const record = await c.deps.projects.update(c.params.projectId, ifMatch, c.body, c.viewer(), c.ctx);
        sendEntity(c.req, c.res, 200, toProject(record), record.rowVer);
      },
    }),
    defineRoute({
      method: 'post',
      path: '/projects/:projectId/sync',
      operationId: 'syncProject',
      summary: 'Enqueue a repository sync',
      tag: 'projects',
      auth: 'any',
      permission: ['project:index'],
      rateClass: 'write',
      params: ProjectParams,
      responses: {
        202: { description: 'Sync job enqueued', schema: SyncResponseSchema },
        404: { description: 'not_found' },
        409: { description: 'project_archived' },
      },
      async handler(c) {
        sendJson(c.res, 202, await c.deps.projects.requestSync(c.params.projectId, c.viewer(), c.ctx));
      },
    }),
    defineRoute({
      method: 'post',
      path: '/projects/:projectId/index',
      operationId: 'indexProject',
      summary: 'Request a code index operation (always mode full, ADR-0030)',
      tag: 'projects',
      auth: 'any',
      permission: ['project:index'],
      rateClass: 'write',
      params: ProjectParams,
      body: RequestIndexRequestSchema,
      bodyOptional: true,
      responses: {
        202: { description: 'Index operation queued', schema: McpIndexOperationSchema, headers: ['Location'] },
        404: { description: 'not_found' },
        409: { description: 'project_not_ready | index_in_progress' },
        503: { description: 'mcp_disabled' },
      },
      async handler(c) {
        const op = await c.deps.projects.requestIndex(c.params.projectId, c.body, c.viewer(), c.ctx);
        setLocation(c.res, `/projects/${c.params.projectId}/index-operations/${op.id}`);
        sendJson(c.res, 202, op);
      },
    }),
    defineRoute({
      method: 'get',
      path: '/projects/:projectId/index-status',
      operationId: 'getProjectIndexStatus',
      summary: 'Code index status of a project',
      tag: 'projects',
      auth: 'any',
      permission: ['project:read'],
      rateClass: 'read',
      params: ProjectParams,
      responses: {
        200: { description: 'Index status', schema: ProjectIndexStatusSchema },
        404: { description: 'not_found' },
      },
      async handler(c) {
        sendJson(c.res, 200, await c.deps.projects.indexStatus(c.params.projectId, c.viewer()));
      },
    }),
    defineRoute({
      method: 'get',
      path: '/projects/:projectId/index-operations',
      operationId: 'listIndexOperations',
      summary: 'List index operations (task-scoped ops only for own tasks without task:read:any)',
      tag: 'projects',
      auth: 'any',
      permission: ['project:read'],
      rateClass: 'read',
      params: ProjectParams,
      query: PageQuerySchema,
      responses: {
        200: { description: 'Page of index operations', schema: pageOf(McpIndexOperationSchema) },
        404: { description: 'not_found' },
      },
      async handler(c) {
        sendJson(c.res, 200, await c.deps.projects.indexOperations(c.params.projectId, c.query, c.viewer()));
      },
    }),
    defineRoute({
      method: 'get',
      path: '/projects/:projectId/index-operations/:operationId',
      operationId: 'getIndexOperation',
      summary: 'Get one index operation',
      tag: 'projects',
      auth: 'any',
      permission: ['project:read'],
      rateClass: 'read',
      params: OperationParams,
      responses: {
        200: { description: 'Index operation', schema: McpIndexOperationSchema },
        404: { description: 'not_found' },
      },
      async handler(c) {
        sendJson(
          c.res,
          200,
          await c.deps.projects.indexOperation(c.params.projectId, c.params.operationId, c.viewer()),
        );
      },
    }),
  ];
}
