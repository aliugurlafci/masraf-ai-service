// Project jobs (contract §6.4 project processor, §12.5, ADR-0030) and workspace cleanup (§11.6) through a worker
// runtime: sync => mirror + base snapshot + `ready` + inline project_index (mode full, ResultJson.headSha);
// invalid source => `invalid`; manual index job adopts the queued operation; retained workspaces are removed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sql from 'mssql';
import { JOB_NAMES } from '@orc/shared';
import type { ProjectRecord } from '@orc/database';
import { resetDb } from '../../helpers/database/db';
import { uniq } from '../../helpers/database/fixtures';
import { waitFor } from '../../helpers/common/wait-for';
import { readFakeCalls } from '../../helpers/mcp/support';
import { createWorkerWorld, writeDirective } from '../../helpers/worker/world';
import type { WorkerWorld } from '../../helpers/worker/world';

let world: WorkerWorld;

beforeAll(async () => {
  world = await createWorkerWorld({ env: { ATTEMPT_STALE_MS: '30000' } });
  await world.startWorker({ workerId: 'it-projects' });
});

afterAll(async () => {
  await world?.dispose();
  await resetDb();
});

async function validatingProject(repoPath: string, autoIndex: boolean): Promise<ProjectRecord> {
  return world.db.repos.projects.insert({
    name: uniq('proj'),
    description: null,
    repoPath,
    testCommand: null,
    testTimeoutSeconds: 60,
    junitReportPath: null,
    requireIndex: false,
    autoIndex,
    indexMode: 'fast',
    defaultAgentId: world.agent.id,
    defaultTimeoutSeconds: 600,
    workspaceMaxBytes: null,
    createdByUserId: world.user.id,
    defaultBranch: null,
  });
}

async function waitProject(id: string, pred: (p: ProjectRecord) => boolean): Promise<ProjectRecord> {
  return waitFor(
    async () => {
      const p = await world.db.repos.projects.findById(id);
      return p !== null && pred(p) ? p : null;
    },
    { timeoutMs: 60_000, intervalMs: 250, description: `project ${id}` },
  );
}

describe('project jobs', () => {
  it('sync => ready with base snapshot and an inline full project_index recording the indexed head', async () => {
    const repo = world.repo();
    const project = await validatingProject(repo.repoPath, true);
    await world.queues.enqueueProjectJob({ v: 1, kind: 'sync', projectId: project.id, requestedByUserId: null, correlationId: null });
    const ready = await waitProject(project.id, (p) => p.status === 'ready' && p.lastIndexOperationId !== null);
    expect(ready).toMatchObject({ defaultBranch: 'main', headSha: repo.sha });
    const op = await world.db.repos.mcpOperations.findById(ready.lastIndexOperationId ?? '');
    expect(op).toMatchObject({ kind: 'project_index', status: 'succeeded' });
    expect((op?.result as { headSha?: string } | null)?.headSha).toBe(repo.sha);
    const base = await world.db.repos.workspaces.findBase(project.id);
    expect(base).toMatchObject({ kind: 'base', status: 'ready', headSha: repo.sha });
    expect(existsSync(path.join(world.workspacesRoot, project.id, '_base', 'src', 'math.js'))).toBe(true);
  });

  it('marks a project with an invalid source as invalid', async () => {
    const project = await validatingProject(`acme/${uniq('missing')}`, false);
    await world.queues.enqueueProjectJob({ v: 1, kind: 'sync', projectId: project.id, requestedByUserId: null, correlationId: null });
    const invalid = await waitProject(project.id, (p) => p.status === 'invalid');
    expect(invalid.statusDetail).not.toBeNull();
  });

  it('runs a queued manual index operation in mode full (ADR-0030)', async () => {
    const repo = world.repo();
    const project = await world.project(repo);
    const op = await world.db.repos.mcpOperations.insert({
      projectId: project.id,
      taskId: null,
      attemptId: null,
      workspaceId: null,
      kind: 'project_index',
      indexName: `orc-p-${project.id.replaceAll('-', '').slice(0, 8)}`,
      mode: 'full',
      status: 'queued',
      requestedByUserId: world.user.id,
      workerId: null,
    });
    await world.queues.enqueueProjectJob({ v: 1, kind: 'index', projectId: project.id, operationId: op.id, mode: 'fast', requestedByUserId: world.user.id, correlationId: null });
    const done = await waitFor(
      async () => {
        const o = await world.db.repos.mcpOperations.findById(op.id);
        return o !== null && (o.status === 'succeeded' || o.status === 'failed') ? o : null;
      },
      { timeoutMs: 60_000, intervalMs: 250, description: 'index operation finished' },
    );
    expect(done.status).toBe('succeeded');
    const calls = await readFakeCalls(path.join(world.cbmCacheDir, 'p', project.id));
    const indexCall = calls.find((c) => c.tool === 'index_repository');
    expect(indexCall?.args).toMatchObject({ mode: 'full', doc_candidates: true });
    expect((await world.db.repos.projects.findById(project.id))?.lastIndexOperationId).toBe(op.id);
  });
});

describe('workspace-cleanup maintenance', () => {
  it('removes retained workspaces whose retention expired (worktree, meta dir, index cache, claude home)', async () => {
    const project = await world.project(world.repo());
    const { task, attempt } = await world.createTask(project, { directives: [writeDirective('src/c.js', 'export {};\n')] });
    expect((await world.waitSettled(task.id)).status).toBe('completed');
    const a = await world.db.repos.attempts.findById(attempt.id);
    const ws = await world.db.repos.workspaces.findById(a?.workspaceId ?? '');
    expect(ws?.status).toBe('retained');
    const worktree = path.join(world.workspacesRoot, ...(ws?.path ?? '').split('/'));
    expect(existsSync(worktree)).toBe(true);
    await world.sql('UPDATE orc.Workspaces SET RetainUntil = DATEADD(HOUR, -1, SYSUTCDATETIME()) WHERE Id = @id', [
      ['id', sql.UniqueIdentifier, ws?.id ?? ''],
    ]);
    await world.queues.maintenance.add(JOB_NAMES.workspaceCleanup, { v: 1 });
    const removed = await waitFor(
      async () => {
        const w = await world.db.repos.workspaces.findById(ws?.id ?? '');
        return w?.status === 'removed' || w?.status === 'error' ? w : null;
      },
      { timeoutMs: 60_000, intervalMs: 250, description: 'workspace removed' },
    );
    expect(removed.errorDetail).toBeNull();
    expect(removed.status).toBe('removed');
    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(`${worktree}.meta`)).toBe(false);
    expect(existsSync(path.join(world.cbmCacheDir, 'w', ws?.id ?? ''))).toBe(false);
    expect(existsSync(path.join(world.claudeHomeRoot, 'w', ws?.id ?? ''))).toBe(false);
  });
});
