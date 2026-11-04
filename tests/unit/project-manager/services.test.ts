// ProjectService / AgentService / TeamService rules with in-memory fakes (contract §2.10, §3.3, §9.5, F3, ADR-0019).
import { beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError, OrcError, PreconditionFailedError } from '@orc/shared';
import type { CreateAgentRequest, CreateProjectRequest } from '@orc/shared';
import {
  createAgentService,
  createProjectService,
  createTeamService,
  redactOperation,
} from '@orc/project-manager';
import type { AgentService, ProjectService, TeamService } from '@orc/project-manager';
import {
  createFakeQueues,
  createFakeWorld,
  etagOf,
  makeAgent,
  makeProject,
  makeTeam,
  makeUser,
  requestCtx,
  silentLogger,
  viewerFor,
} from '../../helpers/task-manager/fakes';
import type { FakeQueues, FakeWorld } from '../../helpers/task-manager/fakes';

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof OrcError && e.code === code);
}

const admin = viewerFor('admin');

describe('ProjectService (unit)', () => {
  let w: FakeWorld;
  let queues: FakeQueues;
  let svc: ProjectService;

  beforeEach(() => {
    w = createFakeWorld();
    queues = createFakeQueues();
    svc = createProjectService({
      db: w.db,
      queues,
      logger: silentLogger(),
      config: { maxTimeoutSeconds: 3600 },
    });
  });

  const req = (o: Partial<CreateProjectRequest> = {}): CreateProjectRequest => ({
    name: 'Acme Service',
    repoPath: 'acme/service',
    testTimeoutSeconds: 900,
    requireIndex: false,
    autoIndex: true,
    indexMode: 'moderate',
    defaultTimeoutSeconds: 3600,
    ...o,
  });

  it('create stores the normalized relative path as validating, audits and enqueues one sync job', async () => {
    const project = await svc.create(
      req({ testCommand: ['npm', 'test'], junitReportPath: 'reports/junit.xml' }),
      admin,
      requestCtx(),
    );
    expect(project).toMatchObject({
      status: 'validating',
      repoPath: 'acme/service',
      testCommand: ['npm', 'test'],
    });
    expect('rowVer' in project).toBe(false);
    expect(queues.projectJobs).toEqual([
      {
        v: 1,
        kind: 'sync',
        projectId: project.id,
        requestedByUserId: admin.userId,
        correlationId: expect.any(String) as unknown,
      },
    ]);
    expect(w.audits.map((a) => a.action)).toContain('project.created');
  });

  it('create validates paths/refs/commands and maps unique violations', async () => {
    await expectCode(
      svc.create(req({ repoPath: '../etc' }), admin, requestCtx()),
      'validation_failed',
    );
    await expectCode(
      svc.create(req({ repoPath: '/abs/path' }), admin, requestCtx()),
      'validation_failed',
    );
    await expectCode(
      svc.create(req({ defaultBranch: 'bad..ref' }), admin, requestCtx()),
      'validation_failed',
    );
    await expectCode(
      svc.create(req({ testCommand: ['npm test; rm -rf /'] }), admin, requestCtx()),
      'validation_failed',
    );
    await expectCode(
      svc.create(req({ junitReportPath: '../x.xml' }), admin, requestCtx()),
      'validation_failed',
    );
    await expectCode(
      svc.create(req({ defaultTimeoutSeconds: 7200 }), admin, requestCtx()),
      'validation_failed',
    );
    await expect(
      svc.create(req({ defaultAgentId: makeAgent().id }), admin, requestCtx()),
    ).rejects.toBeInstanceOf(NotFoundError);
    const dup = new OrcError('unique_violation', 'Duplicate value', {
      details: { constraint: 'UQ_Projects_RepoPath' },
    });
    w.failNextInsert.set('projects', dup);
    await expectCode(svc.create(req(), admin, requestCtx()), 'project_repo_taken');
    w.failNextInsert.set(
      'projects',
      new OrcError('unique_violation', 'Duplicate value', {
        details: { constraint: 'UQ_Projects_Name' },
      }),
    );
    await expectCode(svc.create(req(), admin, requestCtx()), 'project_name_taken');
    expect(queues.projectJobs).toHaveLength(0);
  });

  it('only admins (project:create) may register; read-only tokens never', async () => {
    await expectCode(svc.create(req(), viewerFor('operator'), requestCtx()), 'forbidden');
    await expectCode(
      svc.create(req(), viewerFor('admin', { readOnly: true }), requestCtx()),
      'forbidden',
    );
  });

  it('a sync enqueue failure does not fail registration (reconciler repairs it)', async () => {
    queues.failEnqueue = true;
    expect((await svc.create(req(), admin, requestCtx())).status).toBe('validating');
  });

  it('update needs a matching If-Match, refuses archived projects, archives via archived:true', async () => {
    const p = makeProject();
    w.projects.set(p.id, p);
    await expect(
      svc.update(p.id, '"AAAAAAAAAAE"', { description: 'x' }, admin, requestCtx()),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
    const updated = await svc.update(p.id, etagOf(p), { description: 'new' }, admin, requestCtx());
    expect(updated.description).toBe('new');
    const archived = await svc.update(
      p.id,
      etagOf(updated),
      { archived: true },
      admin,
      requestCtx(),
    );
    expect(archived.status).toBe('archived');
    await expectCode(
      svc.update(p.id, etagOf(archived), { description: 'y' }, admin, requestCtx()),
      'project_archived',
    );
    await expectCode(svc.requestSync(p.id, admin, requestCtx()), 'project_archived');
  });

  it('requestSync deduplicates while the sync job is waiting', async () => {
    const p = makeProject();
    w.projects.set(p.id, p);
    expect(await svc.requestSync(p.id, admin, requestCtx())).toEqual({
      jobId: `sync-${p.id}`,
      deduplicated: false,
    });
    expect(await svc.requestSync(p.id, admin, requestCtx())).toEqual({
      jobId: `sync-${p.id}`,
      deduplicated: true,
    });
  });

  it('requestIndex: mcp_disabled, project_not_ready, full mode op + index job, enqueue failure fails the op', async () => {
    const p = makeProject();
    w.projects.set(p.id, p);
    const disabled = createProjectService({
      db: w.db,
      queues,
      logger: silentLogger(),
      config: { mcpEnabled: false },
    });
    await expectCode(disabled.requestIndex(p.id, {}, admin, requestCtx()), 'mcp_disabled');
    const notReady = makeProject({ status: 'validating' });
    w.projects.set(notReady.id, notReady);
    await expectCode(svc.requestIndex(notReady.id, {}, admin, requestCtx()), 'project_not_ready');

    const op = await svc.requestIndex(p.id, { mode: 'fast' }, admin, requestCtx());
    expect(op).toMatchObject({
      kind: 'project_index',
      mode: 'full',
      status: 'queued',
      indexName: expect.stringMatching(/^orc-p-[0-9a-f]{8}$/) as unknown,
    });
    expect(queues.projectJobs.at(-1)).toMatchObject({
      kind: 'index',
      operationId: op.id,
      mode: 'full',
    });

    queues.failEnqueue = true;
    const other = makeProject();
    w.projects.set(other.id, other);
    await expect(svc.requestIndex(other.id, {}, admin, requestCtx())).rejects.toThrow();
    const failed = [...w.mcpOps.values()].find((o) => o.projectId === other.id);
    expect(failed?.status).toBe('failed');
  });

  it('index operation visibility (F3): foreign task-scoped ops are 404 for operators; result always null', async () => {
    const p = makeProject();
    w.projects.set(p.id, p);
    const owner = makeUser();
    const agent = makeAgent();
    const { task } = w.addTask({ owner, project: p, agent });
    const op = await w.db.repos.mcpOperations.insert({
      projectId: p.id,
      taskId: task.id,
      attemptId: null,
      workspaceId: null,
      kind: 'impact_analysis',
      indexName: 'i',
      mode: null,
      status: 'running',
      requestedByUserId: null,
      workerId: null,
    });
    w.mcpOps.set(op.id, { ...op, result: { changed: ['a.ts'] } });
    await expect(svc.indexOperation(p.id, op.id, viewerFor('operator'))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(
      (await svc.indexOperation(p.id, op.id, viewerFor('operator', { userId: owner.id }))).result,
    ).toBeNull();
    expect((await svc.indexOperation(p.id, op.id, admin)).result).toBeNull();
    await expect(svc.indexOperation(makeProject().id, op.id, admin)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(
      redactOperation({ ...op, kind: 'project_index', result: { headSha: 'x' } }).result,
    ).toEqual({ headSha: 'x' });
  });
});

describe('AgentService / TeamService (unit)', () => {
  let w: FakeWorld;
  let agents: AgentService;
  let teams: TeamService;

  beforeEach(() => {
    w = createFakeWorld();
    agents = createAgentService({
      db: w.db,
      logger: silentLogger(),
      config: { allowedModels: ['sonnet'], maxTimeoutSeconds: 7200 },
    });
    teams = createTeamService({ db: w.db, logger: silentLogger() });
  });

  const agentReq = (teamId: string, o: Partial<CreateAgentRequest> = {}): CreateAgentRequest => ({
    teamId,
    name: 'Reviewer',
    title: 'Code reviewer',
    isManager: false,
    model: 'sonnet',
    allowedTools: ['Read', 'Grep', 'Bash(npm test:*)'],
    disallowedTools: ['Bash(rm:*)'],
    maxTimeoutSeconds: 3600,
    isActive: true,
    ...o,
  });

  it('agent create validates tool rules, model, timeout and team; audits', async () => {
    const team = makeTeam();
    w.teams.set(team.id, team);
    const created = await agents.create(agentReq(team.id), admin, requestCtx());
    expect(created).toMatchObject({ name: 'Reviewer', teamId: team.id });
    expect(w.audits.map((a) => a.action)).toContain('agent.created');
    await expectCode(
      agents.create(agentReq(team.id, { allowedTools: ['Bash'] }), admin, requestCtx()),
      'tool_not_allowed',
    );
    await expectCode(
      agents.create(agentReq(team.id, { allowedTools: ['WebFetch'] }), admin, requestCtx()),
      'tool_not_allowed',
    );
    await expectCode(
      agents.create(agentReq(team.id, { model: 'opus' }), admin, requestCtx()),
      'model_not_allowed',
    );
    await expectCode(
      agents.create(agentReq(team.id, { maxTimeoutSeconds: 9000 }), admin, requestCtx()),
      'validation_failed',
    );
    await expect(
      agents.create(agentReq(makeTeam().id), admin, requestCtx()),
    ).rejects.toBeInstanceOf(NotFoundError);
    w.failNextInsert.set('agents', new OrcError('unique_violation', 'Duplicate value'));
    await expectCode(agents.create(agentReq(team.id), admin, requestCtx()), 'conflict');
    await expectCode(
      agents.create(agentReq(team.id), viewerFor('operator'), requestCtx()),
      'forbidden',
    );
  });

  it('agent update: RowVer conflict => 412, tool rules re-validated against the merged profile', async () => {
    const agent = makeAgent();
    w.agents.set(agent.id, agent);
    await expect(
      agents.update(agent.id, '"AAAAAAAAAAE"', { title: 'x' }, admin, requestCtx()),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
    await expectCode(
      agents.update(agent.id, etagOf(agent), { allowedTools: ['Task'] }, admin, requestCtx()),
      'tool_not_allowed',
    );
    const updated = await agents.update(
      agent.id,
      etagOf(agent),
      { title: 'Lead', isActive: false },
      admin,
      requestCtx(),
    );
    expect(updated).toMatchObject({ title: 'Lead', isActive: false });
    // parent cycles are refused (self and indirect)
    const child = makeAgent({ parentAgentId: agent.id });
    w.agents.set(child.id, child);
    await expectCode(
      agents.update(agent.id, etagOf(updated), { parentAgentId: agent.id }, admin, requestCtx()),
      'conflict',
    );
    await expectCode(
      agents.update(agent.id, etagOf(updated), { parentAgentId: child.id }, admin, requestCtx()),
      'conflict',
    );
    expect(
      (await agents.list({}, viewerFor('auditor'))).find((a) => a.id === agent.id),
    ).toBeUndefined();
    expect(
      (await agents.list({ includeInactive: true }, viewerFor('auditor'))).find(
        (a) => a.id === agent.id,
      ),
    ).toBeDefined();
  });

  it('team CRUD with RowVer and manager validation', async () => {
    const team = await teams.create(
      { name: 'Platform', ownedPaths: ['docker/'] },
      admin,
      requestCtx(),
    );
    expect(team.ownedPaths).toEqual(['docker/']);
    await expect(
      teams.create({ name: 'X', managerAgentId: makeAgent().id }, admin, requestCtx()),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      teams.update(team.id, '"AAAAAAAAAAE"', { description: 'd' }, admin, requestCtx()),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
    const updated = await teams.update(
      team.id,
      etagOf(team),
      { description: 'd' },
      admin,
      requestCtx(),
    );
    expect(updated.description).toBe('d');
    expect((await teams.get(team.id, viewerFor('operator'))).agents).toEqual([]);
    await expectCode(teams.create({ name: 'Y' }, viewerFor('operator'), requestCtx()), 'forbidden');
  });
});
