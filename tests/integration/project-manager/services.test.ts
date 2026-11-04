// ProjectService / AgentService / TeamService against mssql-test (orc_api login) and redis-test (contract §2.10,
// ADR-0019): registration enqueues sync-project and never touches the filesystem; index requests; RowVer conflicts.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotFoundError, OrcError, PreconditionFailedError } from '@orc/shared';
import { rowVerToEtag } from '@orc/database';
import type { Database, UserRecord } from '@orc/database';
import { createQueueRegistry } from '@orc/task-manager';
import type { QueueRegistry, RedisFactory } from '@orc/task-manager';
import { createAgentService, createProjectService, createTeamService } from '@orc/project-manager';
import type { AgentService, ProjectService, TeamService } from '@orc/project-manager';
import { openDb, resetDb } from '../../helpers/database/db';
import { silentLogger } from '../../helpers/database/env';
import { createUser, seededAgent, uniq } from '../../helpers/database/fixtures';
import { requestCtx, viewerFor } from '../../helpers/task-manager/fakes';
import { cleanupPrefix, testRedisFactory, uniquePrefix } from '../../helpers/task-manager/redis';

const prefix = uniquePrefix();

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof OrcError && e.code === code);
}

describe('project-manager services (mssql-test + redis-test)', () => {
  let api: Database;
  let worker: Database;
  let factory: RedisFactory;
  let queues: QueueRegistry;
  let projects: ProjectService;
  let agents: AgentService;
  let teams: TeamService;
  let adminUser: UserRecord;
  const admin = () => viewerFor('admin', { userId: adminUser.id });

  beforeAll(async () => {
    api = await openDb('orc_api');
    worker = await openDb('orc_worker');
    factory = testRedisFactory(prefix);
    queues = createQueueRegistry(factory, { prefix, jobAttempts: 3, backoffMs: 5000 });
    const logger = silentLogger();
    projects = createProjectService({
      db: api,
      queues,
      logger,
      config: { mcpEnabled: true, maxTimeoutSeconds: 14_400 },
    });
    agents = createAgentService({
      db: api,
      logger,
      config: { allowedModels: ['sonnet', 'opus'], maxTimeoutSeconds: 14_400 },
    });
    teams = createTeamService({ db: api, logger });
    adminUser = await createUser(api, { role: 'admin' });
  });

  afterAll(async () => {
    await queues.close();
    await factory.closeAll();
    await api.close();
    await worker.close();
    await resetDb();
    expect(await cleanupPrefix(prefix)).toBe(0);
  });

  it('create stores a validating project, audits it and enqueues sync-<projectId>; no filesystem access', async () => {
    const repoPath = `never/${uniq('missing')}`;
    const project = await projects.create(
      {
        name: uniq('Proj'),
        repoPath,
        testTimeoutSeconds: 900,
        requireIndex: false,
        autoIndex: true,
        indexMode: 'moderate',
        defaultTimeoutSeconds: 3600,
      },
      admin(),
      requestCtx(),
    );
    expect(project).toMatchObject({ status: 'validating', repoPath });
    expect(existsSync(path.resolve('projects', repoPath))).toBe(false);
    const job = await queues.projects.getJob(`sync-${project.id}`);
    expect(job?.name).toBe('sync-project');
    expect(job?.data).toEqual({
      v: 1,
      kind: 'sync',
      projectId: project.id,
      requestedByUserId: adminUser.id,
      correlationId: expect.any(String) as unknown,
    });
    const audit = await api.repos.audit.list({ limit: 10, entityId: project.id });
    expect(audit.map((a) => a.action)).toContain('project.created');
    expect((await projects.requestSync(project.id, admin(), requestCtx())).deduplicated).toBe(true);

    await expectCode(
      projects.create(
        {
          name: uniq('Other'),
          repoPath,
          testTimeoutSeconds: 900,
          requireIndex: false,
          autoIndex: true,
          indexMode: 'moderate',
          defaultTimeoutSeconds: 3600,
        },
        admin(),
        requestCtx(),
      ),
      'project_repo_taken',
    );
    await expectCode(
      projects.create(
        {
          name: project.name,
          repoPath: `x/${uniq('r')}`,
          testTimeoutSeconds: 900,
          requireIndex: false,
          autoIndex: true,
          indexMode: 'moderate',
          defaultTimeoutSeconds: 3600,
        },
        admin(),
        requestCtx(),
      ),
      'project_name_taken',
    );
  });

  it('update with If-Match, stale ETag => 412; requestIndex => queued full op + job, second => index_in_progress', async () => {
    const created = await projects.create(
      {
        name: uniq('Idx'),
        repoPath: `acme/${uniq('idx')}`,
        testTimeoutSeconds: 900,
        requireIndex: false,
        autoIndex: false,
        indexMode: 'fast',
        defaultTimeoutSeconds: 3600,
      },
      admin(),
      requestCtx(),
    );
    await expectCode(
      projects.requestIndex(created.id, {}, admin(), requestCtx()),
      'project_not_ready',
    );
    await worker.repos.projects.updateSyncState(created.id, {
      status: 'ready',
      statusDetail: null,
      defaultBranch: 'main',
      headSha: 'a'.repeat(40),
      synced: true,
    });
    const current = await projects.get(created.id, admin());
    const updated = await projects.update(
      created.id,
      rowVerToEtag(current.rowVer),
      { description: 'described' },
      admin(),
      requestCtx(),
    );
    expect(updated.description).toBe('described');
    await expect(
      projects.update(
        created.id,
        rowVerToEtag(current.rowVer),
        { description: 'stale' },
        admin(),
        requestCtx(),
      ),
    ).rejects.toBeInstanceOf(PreconditionFailedError);

    const op = await projects.requestIndex(created.id, { mode: 'fast' }, admin(), requestCtx());
    expect(op).toMatchObject({
      kind: 'project_index',
      mode: 'full',
      status: 'queued',
      requestedByUserId: adminUser.id,
    });
    expect((await queues.projects.getJob(`index-${op.id}`))?.data).toMatchObject({
      kind: 'index',
      operationId: op.id,
      mode: 'full',
    });
    await expectCode(
      projects.requestIndex(created.id, {}, admin(), requestCtx()),
      'index_in_progress',
    );
    const status = await projects.indexStatus(created.id, viewerFor('operator'));
    expect(status).toMatchObject({
      mcpEnabled: true,
      activeOperation: { id: op.id },
      lastSuccessfulOperation: null,
      stale: true,
    });
    const ops = await projects.indexOperations(created.id, { limit: 10 }, viewerFor('operator'));
    expect(ops.items.map((o) => o.id)).toEqual([op.id]);
    expect((await projects.indexOperation(created.id, op.id, viewerFor('auditor'))).id).toBe(op.id);
    await expect(projects.indexOperation(created.id, adminUser.id, admin())).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const mcp = await projects.mcpStatus(viewerFor('operator'));
    expect(mcp.recentOperations.map((o) => o.id)).toContain(op.id);

    const archived = await projects.update(
      created.id,
      rowVerToEtag(updated.rowVer),
      { archived: true },
      admin(),
      requestCtx(),
    );
    expect(archived.status).toBe('archived');
    await expectCode(projects.requestSync(created.id, admin(), requestCtx()), 'project_archived');
  });

  it('team and agent CRUD with RowVer conflicts, tool-rule validation and name conflicts', async () => {
    const team = await teams.create(
      { name: uniq('Team'), description: 'integration', ownedPaths: ['packages/x'] },
      admin(),
      requestCtx(),
    );
    await expectCode(teams.create({ name: team.name }, admin(), requestCtx()), 'conflict');
    const team2 = await teams.update(
      team.id,
      rowVerToEtag(team.rowVer),
      { description: 'v2' },
      admin(),
      requestCtx(),
    );
    expect(team2.description).toBe('v2');
    await expect(
      teams.update(
        team.id,
        rowVerToEtag(team.rowVer),
        { description: 'v3' },
        admin(),
        requestCtx(),
      ),
    ).rejects.toBeInstanceOf(PreconditionFailedError);

    const base = {
      teamId: team.id,
      name: uniq('Agent'),
      title: 'Integration agent',
      isManager: false,
      model: 'sonnet',
      allowedTools: ['Read', 'Grep', 'Bash(npm test:*)'],
      disallowedTools: [],
      maxTimeoutSeconds: 3600,
      isActive: true,
    };
    await expectCode(
      agents.create({ ...base, allowedTools: ['Bash(curl:*)'] }, admin(), requestCtx()),
      'tool_not_allowed',
    );
    const agent = await agents.create(base, admin(), requestCtx());
    expect(agent).toMatchObject({ teamId: team.id, allowedTools: base.allowedTools });
    await expectCode(agents.create(base, admin(), requestCtx()), 'conflict');
    const agent2 = await agents.update(
      agent.id,
      rowVerToEtag(agent.rowVer),
      { title: 'Renamed', isActive: false },
      admin(),
      requestCtx(),
    );
    expect(agent2).toMatchObject({ title: 'Renamed', isActive: false });
    await expect(
      agents.update(
        agent.id,
        rowVerToEtag(agent.rowVer),
        { title: 'Stale' },
        admin(),
        requestCtx(),
      ),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
    expect(
      (await agents.list({ teamId: team.id }, viewerFor('operator'))).map((a) => a.id),
    ).toEqual([]);
    expect(
      (await agents.list({ teamId: team.id, includeInactive: true }, viewerFor('operator'))).map(
        (a) => a.id,
      ),
    ).toEqual([agent.id]);
    const detail = await teams.get(team.id, viewerFor('auditor'));
    expect(detail.agents.map((a) => a.id)).toEqual([agent.id]);
    const seeded = await seededAgent(api);
    expect((await agents.get(seeded.id, viewerFor('auditor'))).name).toBe(seeded.name);
    await expectCode(
      teams.create({ name: uniq('Nope') }, viewerFor('operator'), requestCtx()),
      'forbidden',
    );
  });
});
