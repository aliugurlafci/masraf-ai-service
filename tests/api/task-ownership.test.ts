// Index operations of other users' tasks are hidden on /projects/:id/index-operations[/:opId] and /system/mcp (F3,
// contract §2.5, §2.10, §9.5, §18.5). Task-scoped `result` is never serialized on these routes, for any viewer.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database, ProjectRecord, UserRecord } from '@orc/database';
import { openDb, resetDb } from '../helpers/database/db';
import { WORKER_ID, createReadyProject, seededAgent } from '../helpers/database/fixtures';
import { cleanupPrefix } from '../helpers/task-manager/redis';
import { call, createApiHarness, createLoginUser, login } from '../helpers/api/harness';
import type { ApiHarness, SessionAuth } from '../helpers/api/harness';

interface OpBody {
  id: string;
  kind: string;
  taskId: string | null;
  result: unknown;
}

const TASK_RESULT_MARKER = 'foreign-task-result-marker';

describe('index operations hide other users tasks (F3)', () => {
  let h: ApiHarness;
  let worker: Database;
  let project: ProjectRecord;
  let opA: UserRecord;
  let opB: UserRecord;
  let auditor: UserRecord;
  let sA: SessionAuth;
  let sB: SessionAuth;
  let sAuditor: SessionAuth;
  let taskId: string;
  let taskOpId: string;
  let projectOpId: string;

  const items = (body: unknown): OpBody[] => (body as { items: OpBody[] }).items;
  const listPath = () => `/api/v1/projects/${project.id}/index-operations`;

  async function seedOp(
    kind: 'task_index' | 'project_index',
    task: string | null,
    result: unknown,
  ): Promise<string> {
    const op = await worker.repos.mcpOperations.insert({
      projectId: project.id,
      taskId: task,
      attemptId: null,
      workspaceId: null,
      kind,
      indexName: kind === 'task_index' ? 'orc-t-own' : 'orc-p-own',
      mode: null,
      status: 'running',
      requestedByUserId: null,
      workerId: WORKER_ID,
    });
    await worker.repos.mcpOperations.finish(op.id, {
      status: 'succeeded',
      nodeCount: 1,
      edgeCount: 1,
      result,
      errorCode: null,
      errorMessage: null,
      durationMs: 5,
    });
    return op.id;
  }

  beforeAll(async () => {
    h = await createApiHarness();
    worker = await openDb('orc_worker');
    opA = await createLoginUser(h.db, { role: 'operator' });
    opB = await createLoginUser(h.db, { role: 'operator' });
    auditor = await createLoginUser(h.db, { role: 'auditor' });
    const admin = await createLoginUser(h.db, { role: 'admin' });
    project = await createReadyProject(h.db, admin, await seededAgent(h.db));
    [sA, sB, sAuditor] = await Promise.all([
      login(h.app, opA.username),
      login(h.app, opB.username),
      login(h.app, auditor.username),
    ]);
    const created = await call(h.app, 'post', '/api/v1/tasks', sA).send({
      projectId: project.id,
      title: 'Operator A private task',
      prompt: 'Only A may see this.',
    });
    expect(created.status).toBe(202);
    taskId = (created.body as { id: string }).id;
    taskOpId = await seedOp('task_index', taskId, { marker: TASK_RESULT_MARKER });
    projectOpId = await seedOp('project_index', null, { headSha: 'a'.repeat(40) });
  });

  afterAll(async () => {
    await h.close();
    await worker.close();
    expect(await cleanupPrefix(h.prefix)).toBe(0);
    await resetDb();
  });

  it('operator B: list shows the project_index operation only, with no foreign taskId or task result', async () => {
    const res = await call(h.app, 'get', listPath(), sB);
    expect(res.status).toBe(200);
    expect(items(res.body).map((o) => o.id)).toEqual([projectOpId]);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(taskId);
    expect(raw).not.toContain(TASK_RESULT_MARKER);
  });

  it('operator B: get of the foreign task operation is 404; project_index is visible', async () => {
    const hidden = await call(h.app, 'get', `${listPath()}/${taskOpId}`, sB);
    expect(hidden.status).toBe(404);
    expect(JSON.stringify(hidden.body)).not.toContain(taskId);
    expect((await call(h.app, 'get', `${listPath()}/${projectOpId}`, sB)).status).toBe(200);
  });

  it('operator B: /system/mcp recentOperations carry no foreign taskId or task result', async () => {
    const res = await call(h.app, 'get', '/api/v1/system/mcp', sB);
    expect(res.status).toBe(200);
    const recent = (res.body as { recentOperations: OpBody[] }).recentOperations;
    expect(recent.map((o) => o.id)).toContain(projectOpId);
    expect(recent.map((o) => o.id)).not.toContain(taskOpId);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(taskId);
    expect(raw).not.toContain(TASK_RESULT_MARKER);
  });

  it('owner A sees the task operation, but its result is null on these routes', async () => {
    const list = await call(h.app, 'get', listPath(), sA);
    const own = items(list.body).find((o) => o.id === taskOpId);
    expect(own).toMatchObject({ kind: 'task_index', taskId, result: null });
    const one = await call(h.app, 'get', `${listPath()}/${taskOpId}`, sA);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ taskId, result: null });
    const mcp = await call(h.app, 'get', '/api/v1/system/mcp', sA);
    const recent = (mcp.body as { recentOperations: OpBody[] }).recentOperations;
    expect(recent.find((o) => o.id === taskOpId)).toMatchObject({ taskId, result: null });
    expect(JSON.stringify([list.body, one.body, mcp.body])).not.toContain(TASK_RESULT_MARKER);
  });

  it('auditor (task:read:any) sees the task operation, with result still null', async () => {
    const list = await call(h.app, 'get', listPath(), sAuditor);
    expect(items(list.body).find((o) => o.id === taskOpId)).toMatchObject({ taskId, result: null });
    const one = await call(h.app, 'get', `${listPath()}/${taskOpId}`, sAuditor);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ taskId, result: null });
    const mcp = await call(h.app, 'get', '/api/v1/system/mcp', sAuditor);
    const recent = (mcp.body as { recentOperations: OpBody[] }).recentOperations;
    expect(recent.find((o) => o.id === taskOpId)).toMatchObject({ taskId, result: null });
    expect(JSON.stringify([list.body, one.body, mcp.body])).not.toContain(TASK_RESULT_MARKER);
  });
});
