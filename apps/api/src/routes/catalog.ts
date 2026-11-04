// /agents and /teams delegating to AgentService / TeamService (contract §2.10, §9.5).
import { z } from 'zod';
import {
  AgentSchema,
  CreateAgentRequestSchema,
  CreateTeamRequestSchema,
  IdSchema,
  TeamDetailSchema,
  TeamSchema,
  UpdateAgentRequestSchema,
  UpdateTeamRequestSchema,
} from '@orc/shared';
import { toAgent, toTeam } from '@orc/project-manager';
import { requireIfMatch, sendEntity, sendJson, setLocation } from '../http.js';
import { defineRoute } from '../route.js';
import type { AnyRouteDef } from '../route.js';

const AgentParams = z.object({ agentId: IdSchema });
const TeamParams = z.object({ teamId: IdSchema });
const queryBool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');
const AgentListQuerySchema = z.object({
  teamId: IdSchema.optional(),
  includeInactive: queryBool.optional(),
});

export function catalogRoutes(): AnyRouteDef[] {
  return [
    defineRoute({
      method: 'get',
      path: '/agents',
      operationId: 'listAgents',
      summary: 'List agents',
      tag: 'agents',
      auth: 'any',
      permission: ['agent:read'],
      rateClass: 'read',
      query: AgentListQuerySchema,
      responses: { 200: { description: 'Agents', schema: z.array(AgentSchema) } },
      async handler(c) {
        const q = {
          ...(c.query.teamId !== undefined ? { teamId: c.query.teamId } : {}),
          ...(c.query.includeInactive !== undefined ? { includeInactive: c.query.includeInactive } : {}),
        };
        sendJson(c.res, 200, await c.deps.agents.list(q, c.viewer()));
      },
    }),
    defineRoute({
      method: 'get',
      path: '/agents/:agentId',
      operationId: 'getAgent',
      summary: 'Get an agent',
      tag: 'agents',
      auth: 'any',
      permission: ['agent:read'],
      rateClass: 'read',
      params: AgentParams,
      headers: [{ name: 'If-None-Match', required: false, description: 'ETag of a cached copy (304)' }],
      responses: {
        200: { description: 'Agent', schema: AgentSchema, headers: ['ETag'] },
        304: { description: 'Not modified' },
        404: { description: 'not_found' },
      },
      async handler(c) {
        const record = await c.deps.agents.get(c.params.agentId, c.viewer());
        sendEntity(c.req, c.res, 200, toAgent(record), record.rowVer);
      },
    }),
    defineRoute({
      method: 'post',
      path: '/agents',
      operationId: 'createAgent',
      summary: 'Create an agent',
      tag: 'agents',
      auth: 'session',
      permission: ['agent:manage'],
      rateClass: 'write',
      body: CreateAgentRequestSchema,
      responses: {
        201: { description: 'Created agent', schema: AgentSchema, headers: ['Location', 'ETag'] },
        409: { description: 'conflict' },
        422: { description: 'tool_not_allowed | model_not_allowed' },
      },
      async handler(c) {
        const record = await c.deps.agents.create(c.body, c.viewer(), c.ctx);
        setLocation(c.res, `/agents/${record.id}`);
        sendEntity(c.req, c.res, 201, toAgent(record), record.rowVer);
      },
    }),
    defineRoute({
      method: 'patch',
      path: '/agents/:agentId',
      operationId: 'updateAgent',
      summary: 'Update an agent',
      tag: 'agents',
      auth: 'session',
      permission: ['agent:manage'],
      rateClass: 'write',
      params: AgentParams,
      body: UpdateAgentRequestSchema,
      headers: [{ name: 'If-Match', required: true, description: 'ETag of the agent' }],
      responses: {
        200: { description: 'Updated agent', schema: AgentSchema, headers: ['ETag'] },
        404: { description: 'not_found' },
        412: { description: 'precondition_failed' },
        422: { description: 'tool_not_allowed | model_not_allowed' },
        428: { description: 'precondition_required' },
      },
      async handler(c) {
        const ifMatch = requireIfMatch(c.req);
        const record = await c.deps.agents.update(c.params.agentId, ifMatch, c.body, c.viewer(), c.ctx);
        sendEntity(c.req, c.res, 200, toAgent(record), record.rowVer);
      },
    }),
    defineRoute({
      method: 'get',
      path: '/teams',
      operationId: 'listTeams',
      summary: 'List teams',
      tag: 'teams',
      auth: 'any',
      permission: ['team:read'],
      rateClass: 'read',
      responses: { 200: { description: 'Teams', schema: z.array(TeamSchema) } },
      async handler(c) {
        sendJson(c.res, 200, await c.deps.teams.list(c.viewer()));
      },
    }),
    defineRoute({
      method: 'get',
      path: '/teams/:teamId',
      operationId: 'getTeam',
      summary: 'Get a team with its agents',
      tag: 'teams',
      auth: 'any',
      permission: ['team:read'],
      rateClass: 'read',
      params: TeamParams,
      headers: [{ name: 'If-None-Match', required: false, description: 'ETag of a cached copy (304)' }],
      responses: {
        200: { description: 'Team detail', schema: TeamDetailSchema, headers: ['ETag'] },
        304: { description: 'Not modified' },
        404: { description: 'not_found' },
      },
      async handler(c) {
        const { team, agents } = await c.deps.teams.get(c.params.teamId, c.viewer());
        sendEntity(c.req, c.res, 200, { ...toTeam(team), agents }, team.rowVer);
      },
    }),
    defineRoute({
      method: 'post',
      path: '/teams',
      operationId: 'createTeam',
      summary: 'Create a team',
      tag: 'teams',
      auth: 'session',
      permission: ['team:manage'],
      rateClass: 'write',
      body: CreateTeamRequestSchema,
      responses: {
        201: { description: 'Created team', schema: TeamSchema, headers: ['Location', 'ETag'] },
        409: { description: 'conflict' },
      },
      async handler(c) {
        const record = await c.deps.teams.create(c.body, c.viewer(), c.ctx);
        setLocation(c.res, `/teams/${record.id}`);
        sendEntity(c.req, c.res, 201, toTeam(record), record.rowVer);
      },
    }),
    defineRoute({
      method: 'patch',
      path: '/teams/:teamId',
      operationId: 'updateTeam',
      summary: 'Update a team',
      tag: 'teams',
      auth: 'session',
      permission: ['team:manage'],
      rateClass: 'write',
      params: TeamParams,
      body: UpdateTeamRequestSchema,
      headers: [{ name: 'If-Match', required: true, description: 'ETag of the team' }],
      responses: {
        200: { description: 'Updated team', schema: TeamSchema, headers: ['ETag'] },
        404: { description: 'not_found' },
        412: { description: 'precondition_failed' },
        428: { description: 'precondition_required' },
      },
      async handler(c) {
        const ifMatch = requireIfMatch(c.req);
        const record = await c.deps.teams.update(c.params.teamId, ifMatch, c.body, c.viewer(), c.ctx);
        sendEntity(c.req, c.res, 200, toTeam(record), record.rowVer);
      },
    }),
  ];
}
