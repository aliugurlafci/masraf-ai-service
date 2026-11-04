// AgentService and TeamService (contract §2.10, §3.3, §15.1): catalogue CRUD with RowVer/If-Match, tool-rule
// validation through @orc/security and an audit row in the same transaction as every change.
import { NotFoundError, OrcError, ValidationError } from '@orc/shared';
import type {
  Agent,
  CreateAgentRequest,
  CreateTeamRequest,
  Team,
  UpdateAgentRequest,
  UpdateTeamRequest,
  Uuid,
} from '@orc/shared';
import { validateAgentToolRules } from '@orc/security';
import { etagToRowVer } from '@orc/database';
import type { AgentInput, AgentRecord, Database, TeamInput, TeamRecord } from '@orc/database';
import type { Logger } from '@orc/logger';
import { actorOf, auditOf, requirePermission, withoutRowVer } from '@orc/task-manager';
import type { RequestContext, Viewer } from '@orc/task-manager';

export interface AgentService {
  list(q: { teamId?: Uuid; includeInactive?: boolean }, v: Viewer): Promise<Agent[]>;
  get(id: Uuid, v: Viewer): Promise<AgentRecord>;
  /** validates tool rules with validateAgentToolRules (422 tool_not_allowed) */
  create(i: CreateAgentRequest, v: Viewer, ctx: RequestContext): Promise<AgentRecord>;
  update(
    id: Uuid,
    ifMatch: string,
    i: UpdateAgentRequest,
    v: Viewer,
    ctx: RequestContext,
  ): Promise<AgentRecord>;
}

export interface TeamService {
  list(v: Viewer): Promise<Team[]>;
  get(id: Uuid, v: Viewer): Promise<{ team: TeamRecord; agents: Agent[] }>;
  create(i: CreateTeamRequest, v: Viewer, ctx: RequestContext): Promise<TeamRecord>;
  update(
    id: Uuid,
    ifMatch: string,
    i: UpdateTeamRequest,
    v: Viewer,
    ctx: RequestContext,
  ): Promise<TeamRecord>;
}

const MAX_AGENT_DEPTH = 32;

export const toAgent = (r: AgentRecord): Agent => withoutRowVer(r);
export const toTeam = (r: TeamRecord): Team => withoutRowVer(r);

function nameConflict(err: unknown, what: string): unknown {
  if (err instanceof OrcError && err.code === 'unique_violation') {
    return new OrcError('conflict', `${what} name already exists`, { cause: err });
  }
  return err;
}

/** Drops keys whose value is undefined so partial updates only touch supplied columns. */
function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

export function createAgentService(deps: {
  db: Database;
  logger: Logger;
  config: { allowedModels: readonly string[]; maxTimeoutSeconds: number };
}): AgentService {
  const { db, config } = deps;
  const repos = db.repos;

  function assertModel(model: string): void {
    if (!config.allowedModels.includes(model))
      throw new OrcError('model_not_allowed', `Model ${model} is not allowed`);
  }

  function assertTimeout(seconds: number): void {
    if (seconds > config.maxTimeoutSeconds) {
      throw new ValidationError(
        [
          {
            path: 'body.maxTimeoutSeconds',
            message: `maxTimeoutSeconds must be <= ${config.maxTimeoutSeconds}`,
            code: 'too_big',
          },
        ],
        'Invalid body',
      );
    }
  }

  async function assertRefs(
    teamId: Uuid | undefined,
    parentAgentId: Uuid | null | undefined,
    selfId?: Uuid,
  ): Promise<void> {
    if (teamId !== undefined && !(await repos.teams.findById(teamId)))
      throw new NotFoundError('Team not found');
    if (parentAgentId !== undefined && parentAgentId !== null) {
      if (parentAgentId === selfId)
        throw new OrcError('conflict', 'An agent cannot be its own parent');
      if (!(await repos.agents.findById(parentAgentId)))
        throw new NotFoundError('Parent agent not found');
      if (selfId !== undefined) await assertNoParentCycle(parentAgentId, selfId);
    }
  }

  /** Walks the new parent's ancestors: reaching `selfId` (or an existing loop) would create a hierarchy cycle. */
  async function assertNoParentCycle(parentAgentId: Uuid, selfId: Uuid): Promise<void> {
    const seen = new Set<Uuid>([selfId]);
    let cursor: Uuid | null = parentAgentId;
    for (let depth = 0; cursor !== null && depth < MAX_AGENT_DEPTH; depth += 1) {
      if (seen.has(cursor)) throw new OrcError('conflict', 'Agent hierarchy would contain a cycle');
      seen.add(cursor);
      cursor = (await repos.agents.findById(cursor))?.parentAgentId ?? null;
    }
    if (cursor !== null) throw new OrcError('conflict', 'Agent hierarchy is too deep');
  }

  async function load(id: Uuid): Promise<AgentRecord> {
    const agent = await repos.agents.findById(id);
    if (!agent) throw new NotFoundError('Agent not found');
    return agent;
  }

  return {
    async list(q, v) {
      requirePermission(v, 'agent:read');
      const rows = await repos.agents.list({
        ...(q.teamId !== undefined ? { teamId: q.teamId } : {}),
        activeOnly: q.includeInactive !== true,
      });
      return rows.map(toAgent);
    },

    async get(id, v) {
      requirePermission(v, 'agent:read');
      return load(id);
    },

    async create(i, v, ctx) {
      requirePermission(v, 'agent:manage', { write: true });
      assertModel(i.model);
      assertTimeout(i.maxTimeoutSeconds);
      validateAgentToolRules({ allowedTools: i.allowedTools, disallowedTools: i.disallowedTools });
      await assertRefs(i.teamId, i.parentAgentId);
      const input: AgentInput = {
        teamId: i.teamId,
        parentAgentId: i.parentAgentId ?? null,
        name: i.name,
        title: i.title,
        description: i.description ?? null,
        isManager: i.isManager,
        model: i.model,
        effort: i.effort ?? null,
        allowedTools: i.allowedTools,
        disallowedTools: i.disallowedTools,
        instructions: i.instructions ?? null,
        maxTimeoutSeconds: i.maxTimeoutSeconds,
        maxBudgetUsd: i.maxBudgetUsd ?? null,
        isActive: i.isActive,
      };
      try {
        return await db.transaction(
          async (t) => {
            const created = await t.repos.agents.insert(input);
            await t.repos.audit.insert({
              action: 'agent.created',
              actor: actorOf(v),
              entityType: 'agent',
              entityId: created.id,
              outcome: 'success',
              after: {
                ...input,
                instructions:
                  input.instructions === null ? null : { chars: input.instructions.length },
              },
              ...auditOf(ctx),
            });
            return created;
          },
          { name: 'agent.create' },
        );
      } catch (err) {
        throw nameConflict(err, 'Agent');
      }
    },

    async update(id, ifMatch, i, v, ctx) {
      requirePermission(v, 'agent:manage', { write: true });
      const expectedRowVer = etagToRowVer(ifMatch);
      const current = await load(id);
      if (i.model !== undefined) assertModel(i.model);
      if (i.maxTimeoutSeconds !== undefined) assertTimeout(i.maxTimeoutSeconds);
      if (i.allowedTools !== undefined || i.disallowedTools !== undefined) {
        validateAgentToolRules({
          allowedTools: i.allowedTools ?? current.allowedTools,
          disallowedTools: i.disallowedTools ?? current.disallowedTools,
        });
      }
      await assertRefs(i.teamId, i.parentAgentId, id);
      const patch = defined<Partial<AgentInput>>({
        teamId: i.teamId,
        parentAgentId: i.parentAgentId,
        name: i.name,
        title: i.title,
        description: i.description,
        isManager: i.isManager,
        model: i.model,
        effort: i.effort,
        allowedTools: i.allowedTools,
        disallowedTools: i.disallowedTools,
        instructions: i.instructions,
        maxTimeoutSeconds: i.maxTimeoutSeconds,
        maxBudgetUsd: i.maxBudgetUsd,
        isActive: i.isActive,
      });
      try {
        return await db.transaction(
          async (t) => {
            const updated = await t.repos.agents.update(id, expectedRowVer, patch);
            await t.repos.audit.insert({
              action: 'agent.updated',
              actor: actorOf(v),
              entityType: 'agent',
              entityId: id,
              outcome: 'success',
              before: { rowVer: current.rowVer },
              after: {
                ...patch,
                ...(typeof patch.instructions === 'string'
                  ? { instructions: { chars: patch.instructions.length } }
                  : {}),
              },
              ...auditOf(ctx),
            });
            return updated;
          },
          { name: 'agent.update' },
        );
      } catch (err) {
        throw nameConflict(err, 'Agent');
      }
    },
  };
}

export function createTeamService(deps: { db: Database; logger: Logger }): TeamService {
  const { db } = deps;
  const repos = db.repos;

  async function load(id: Uuid): Promise<TeamRecord> {
    const team = await repos.teams.findById(id);
    if (!team) throw new NotFoundError('Team not found');
    return team;
  }

  async function assertManager(managerAgentId: Uuid | null | undefined): Promise<void> {
    if (
      managerAgentId !== undefined &&
      managerAgentId !== null &&
      !(await repos.agents.findById(managerAgentId))
    ) {
      throw new NotFoundError('Manager agent not found');
    }
  }

  return {
    async list(v) {
      requirePermission(v, 'team:read');
      return (await repos.teams.list()).map(toTeam);
    },

    async get(id, v) {
      requirePermission(v, 'team:read');
      const team = await load(id);
      const agents = await repos.agents.list({ teamId: id });
      return { team, agents: agents.map(toAgent) };
    },

    async create(i, v, ctx) {
      requirePermission(v, 'team:manage', { write: true });
      await assertManager(i.managerAgentId);
      const input: TeamInput = {
        name: i.name,
        description: i.description ?? null,
        managerAgentId: i.managerAgentId ?? null,
        ownedPaths: i.ownedPaths ?? [],
      };
      try {
        return await db.transaction(
          async (t) => {
            const created = await t.repos.teams.insert(input);
            await t.repos.audit.insert({
              action: 'team.created',
              actor: actorOf(v),
              entityType: 'team',
              entityId: created.id,
              outcome: 'success',
              after: input,
              ...auditOf(ctx),
            });
            return created;
          },
          { name: 'team.create' },
        );
      } catch (err) {
        throw nameConflict(err, 'Team');
      }
    },

    async update(id, ifMatch, i, v, ctx) {
      requirePermission(v, 'team:manage', { write: true });
      const expectedRowVer = etagToRowVer(ifMatch);
      const current = await load(id);
      await assertManager(i.managerAgentId);
      const patch = defined<Partial<TeamInput>>({
        name: i.name,
        description: i.description,
        managerAgentId: i.managerAgentId,
        ownedPaths: i.ownedPaths,
      });
      try {
        return await db.transaction(
          async (t) => {
            const updated = await t.repos.teams.update(id, expectedRowVer, patch);
            await t.repos.audit.insert({
              action: 'team.updated',
              actor: actorOf(v),
              entityType: 'team',
              entityId: id,
              outcome: 'success',
              before: { rowVer: current.rowVer },
              after: patch,
              ...auditOf(ctx),
            });
            return updated;
          },
          { name: 'team.update' },
        );
      } catch (err) {
        throw nameConflict(err, 'Team');
      }
    },
  };
}
