// Worker runtime end to end against mssql-test + redis-test with fake-claude and fake-cbm through the local
// launcher (contract §13, §14): happy path artefacts, failure mappings, timeout/cancel without surviving processes,
// output limit, requireIndex => blocked, and the real source repository left untouched.
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sql from 'mssql';
import type { Uuid } from '@orc/shared';
import { resetDb } from '../../helpers/database/db';
import { hashTree } from '../../helpers/git/fixtures';
import { aliveProcesses } from '../../helpers/common/process';
import { waitFor } from '../../helpers/common/wait-for';
import { SAMPLE_FILES, createWorkerWorld, writeDirective } from '../../helpers/worker/world';
import type { WorkerWorld } from '../../helpers/worker/world';
import type { WorkerRuntime } from '../../../apps/worker/src/runtime';

let world: WorkerWorld;
let worker: WorkerRuntime;

beforeAll(async () => {
  // ATTEMPT_STALE_MS 30 s: masking a 64 KiB single-token line blocks the event loop for seconds (see report).
  world = await createWorkerWorld({ env: { CLAUDE_MAX_OUTPUT_BYTES: '100000', ATTEMPT_STALE_MS: '30000' } });
  worker = await world.startWorker({ workerId: 'it-pipeline-1' });
});

afterAll(async () => {
  await world?.dispose();
  await resetDb();
});

async function fakePids(attemptId: Uuid): Promise<number[]> {
  const logs = await world.db.repos.taskLogs.listByAttempt({ attemptId, stream: 'claude', limit: 1000 });
  const pids: number[] = [];
  for (const line of logs.map((l) => l.content).join('').split('\n')) {
    const m = /"subtype":"fake_pid","pid":(\d+)/.exec(line);
    if (m?.[1]) pids.push(Number(m[1]));
  }
  return pids;
}

describe('worker pipeline (integration)', () => {
  it('runs a task to completed with changed files, patch, JUnit results, ordered logs, stream events and a session', async () => {
    const repo = world.repo();
    const before = hashTree(repo.dir);
    const project = await world.project(repo);
    const { task, attempt } = await world.createTask(project, {
      directives: [
        writeDirective('src/feature.js', 'export const mul = (a, b) => a * b;\n'),
        '@@fake text implemented the feature',
      ],
    });
    const settled = await world.waitSettled(task.id);
    expect(settled.status).toBe('completed');
    expect(settled.statusReason).toBeNull();

    const a = await world.db.repos.attempts.findById(attempt.id);
    expect(a).toMatchObject({ status: 'succeeded', workerId: 'it-pipeline-1', filesChanged: 1 });
    expect(a?.pid).not.toBeNull();
    expect(a?.headSha).not.toBe(a?.baseSha);
    expect(a?.mergeCheck?.status).toBe('clean');
    expect(a?.commits.length).toBe(1);

    const files = await world.db.repos.changedFiles.listByAttempt({ attemptId: attempt.id, includePatch: true, limit: 100 });
    expect(files.map((f) => f.path)).toEqual(['src/feature.js']);
    expect(files[0]?.changeType).toBe('A');
    expect(files[0]?.patch).toContain('+export const mul');
    const patch = await world.db.repos.patches.getMeta(attempt.id);
    expect(patch).toMatchObject({ tooLarge: false, purged: false });

    const runs = await world.db.repos.testRuns.listByAttempt(attempt.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'passed', total: 2, passed: 2, failed: 0, reportParsed: true, exitCode: 0 });
    const results = await world.db.repos.testRuns.listResults({ testRunId: runs[0]?.id ?? '', limit: 100 });
    expect(results.map((r) => r.name).sort()).toEqual(['adds', 'multiplies']);

    const logs = await world.db.repos.taskLogs.listByAttempt({ attemptId: attempt.id, limit: 5000 });
    expect(logs.map((l) => l.seq)).toEqual(logs.map((_, i) => i));
    expect(logs.every((l) => l.content.length <= 4000)).toBe(true);
    expect(logs.some((l) => l.stream === 'claude' && l.content.includes('"type":"system"'))).toBe(true);
    expect(logs.some((l) => l.stream === 'stdout' && l.source === 'test' && l.content.includes('2 tests passed'))).toBe(true);
    expect(logs.some((l) => l.stream === 'system' && l.content.includes('attempt finished: completed'))).toBe(true);
    expect(logs.map((l) => l.content).join('')).not.toContain('sk-ant-api03');

    const session = await world.db.repos.claudeSessions.findByAttempt(attempt.id);
    expect(session).toMatchObject({ status: 'completed', model: 'sonnet', permissionMode: 'dontAsk', resultSubtype: 'success' });
    expect(session?.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    const ops = await world.sql<{ Kind: string; Status: string }>(
      'SELECT Kind, Status FROM orc.McpIndexOperations WHERE AttemptId = @a ORDER BY CreatedAt',
      [['a', sql.UniqueIdentifier, attempt.id]],
    );
    expect(ops.map((o) => `${o.Kind}:${o.Status}`)).toEqual(['task_index:succeeded', 'task_reindex:succeeded', 'impact_analysis:succeeded']);

    const events = await world.streamEvents(task.id);
    const statuses = events.flatMap((e) => (e.type === 'status' ? [e.status] : []));
    expect(statuses).toEqual(['preparing_workspace', 'indexing', 'running', 'testing', 'reviewing', 'completed']);
    const types = new Set(events.map((e) => e.type));
    for (const t of ['status', 'log', 'claude', 'test', 'diff', 'end'] as const) expect(types.has(t)).toBe(true);
    expect(events.at(-1)?.type).toBe('end');
    const ttl = await world.redis.ttl(`${world.prefix}:task:${task.id}:events`);
    expect(ttl).toBeGreaterThan(0);

    const ws = a?.workspaceId ? await world.db.repos.workspaces.findById(a.workspaceId) : null;
    expect(ws?.status).toBe('retained');
    expect(ws?.retainUntil).not.toBeNull();

    // the real repository was never written (§11.1)
    expect(hashTree(repo.dir)).toEqual(before);
  });

  it('maps a non-zero Claude exit to failed(claude_exit_nonzero) and captures artefacts', async () => {
    const project = await world.project(world.repo());
    const { task, attempt } = await world.createTask(project, {
      directives: [writeDirective('src/partial.js', 'export {};\n'), '@@fake no-result', '@@fake exit 3'],
    });
    const settled = await world.waitSettled(task.id);
    expect(settled).toMatchObject({ status: 'failed', statusReason: 'claude_exit_nonzero' });
    const a = await world.db.repos.attempts.findById(attempt.id);
    expect(a).toMatchObject({ status: 'failed', failureReason: 'claude_exit_nonzero', exitCode: 3 });
    const files = await world.db.repos.changedFiles.listByAttempt({ attemptId: attempt.id, includePatch: false, limit: 10 });
    expect(files.map((f) => f.path)).toEqual(['src/partial.js']);
    const events = await world.db.repos.taskEvents.listByTask({ taskId: task.id, limit: 200 });
    expect(events.some((e) => e.type === 'artifacts_captured')).toBe(true);
    const session = await world.db.repos.claudeSessions.findByAttempt(attempt.id);
    expect(session?.status).toBe('failed');
  });

  it('maps exceeding CLAUDE_MAX_OUTPUT_BYTES to failed(output_limit_exceeded)', async () => {
    const project = await world.project(world.repo());
    const { task, attempt } = await world.createTask(project, { directives: ['@@fake huge-output 300000'] });
    const settled = await world.waitSettled(task.id);
    expect(settled).toMatchObject({ status: 'failed', statusReason: 'output_limit_exceeded' });
    expect((await world.db.repos.claudeSessions.findByAttempt(attempt.id))?.status).toBe('killed');
  });

  it('blocks a RequireIndex project whose MCP index fails', async () => {
    const repo = world.repo({ ...SAMPLE_FILES, '.fake-cbm.json': '{"mode":"error:index_repository"}' });
    const project = await world.project(repo, { requireIndex: true });
    const { task, attempt } = await world.createTask(project);
    const settled = await world.waitSettled(task.id);
    expect(settled).toMatchObject({ status: 'blocked', statusReason: 'index_required_failed' });
    expect((await world.db.repos.attempts.findById(attempt.id))?.status).toBe('blocked');
    expect(await world.db.repos.claudeSessions.findByAttempt(attempt.id)).toBeNull();
  });

  it('cancels a running task: cancelled, no surviving processes', async () => {
    const project = await world.project(world.repo());
    const { task, attempt } = await world.createTask(project, {
      directives: ['@@fake spawn-grandchild', '@@fake delay-ms 200', '@@fake text working', '@@fake hang'],
    });
    await world.waitStatus(task.id, ['running']);
    const pids = await waitFor(async () => {
      const p = await fakePids(attempt.id);
      return p.length > 0 ? p : null;
    }, { timeoutMs: 30_000, intervalMs: 200, description: 'fake grandchild pid' });
    const running = await world.db.repos.tasks.findById(task.id);
    if (!running) throw new Error('task missing');
    await world.requestCancel(running);
    const settled = await world.waitSettled(task.id, 60_000);
    expect(settled).toMatchObject({ status: 'cancelled', statusReason: 'cancelled_by_user' });
    const a = await world.db.repos.attempts.findById(attempt.id);
    expect(a?.status).toBe('cancelled');
    const all = [...pids, ...(a?.pid ? [a.pid] : [])];
    await waitFor(() => aliveProcesses(all).length === 0, { timeoutMs: 15_000, description: 'no surviving processes' });
    // the task row settles before the pipeline's finally (lock release, unregister) has run
    await waitFor(() => worker.active.size() === 0, { timeoutMs: 10_000, description: 'pipeline unregistered' });
  });
});

// ADR-0037: a pre-created, group/world-readable `orc-cbm-rt-<uid>` in a private TMPDIR makes
// ensureClaudeMcpRuntime fail with path_escape (set after the startup probe) (POSIX only: win32 has no uid and no ownership check).
describe.skipIf(process.platform === 'win32')('worker pipeline MCP runtime precheck (ADR-0037)', () => {
  let mcpWorld: WorkerWorld;
  let tmpRoot: string;
  const prevTmpdir = process.env['TMPDIR'];

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'orc-rt-tmp-'));
    chmodSync(tmpRoot, 0o700);
    process.env['TMPDIR'] = tmpRoot;
    mcpWorld = await createWorkerWorld({ env: { ATTEMPT_STALE_MS: '30000' } });
  });

  /** After the worker's own startup probe (which needs a valid runtime dir) the dir becomes group/world-readable. */
  function loosenRuntimeParent(): void {
    const parent = join(tmpRoot, `orc-cbm-rt-${(process.getuid as () => number)()}`);
    mkdirSync(parent, { recursive: true, mode: 0o755 });
    chmodSync(parent, 0o755);
  }

  afterAll(async () => {
    if (prevTmpdir === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = prevTmpdir;
    await mcpWorld?.dispose();
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('MCP_REQUIRED=true: fails closed as failed(security_violation) without starting Claude', async () => {
    const w = await mcpWorld.startWorker({ workerId: 'it-mcp-required', env: { MCP_REQUIRED: 'true' } });
    loosenRuntimeParent();
    const project = await mcpWorld.project(mcpWorld.repo());
    const { task, attempt } = await mcpWorld.createTask(project);
    const settled = await mcpWorld.waitSettled(task.id);
    expect(settled).toMatchObject({ status: 'failed', statusReason: 'security_violation' });
    expect((await mcpWorld.db.repos.attempts.findById(attempt.id))?.failureReason).toBe('security_violation');
    expect(await mcpWorld.db.repos.claudeSessions.findByAttempt(attempt.id)).toBeNull();
    await w.stop(); // the next case must be consumed by the MCP_REQUIRED=false worker only
  });

  it('MCP_REQUIRED=false: completes without --mcp-config and publishes the mcp_runtime_rejected warning', async () => {
    await mcpWorld.startWorker({ workerId: 'it-mcp-optional', env: { MCP_REQUIRED: 'false' } });
    loosenRuntimeParent();
    const project = await mcpWorld.project(mcpWorld.repo());
    const { task, attempt } = await mcpWorld.createTask(project, {
      directives: ['@@fake echo-argv', '@@fake text done'],
    });
    const settled = await mcpWorld.waitSettled(task.id);
    expect(settled.status).toBe('completed');
    const events = await mcpWorld.db.repos.taskEvents.listByTask({ taskId: task.id, limit: 500 });
    expect(
      events.some((e) => e.type === 'warning' && e.data?.['warning'] === 'mcp_runtime_rejected' && e.data?.['errorCode'] === 'path_escape'),
    ).toBe(true);
    const logs = await mcpWorld.db.repos.taskLogs.listByAttempt({ attemptId: attempt.id, stream: 'claude', limit: 1000 });
    const text = logs.map((l) => l.content).join('');
    expect(text).toContain('"subtype":"fake_argv"');
    expect(text).toContain('--strict-mcp-config');
    expect(text).not.toContain('--mcp-config');
  });
});

describe('worker pipeline timeout (integration)', () => {
  it('times out at the attempt deadline: timed_out and no surviving processes', async () => {
    // The orchestrator clock runs 48 s ahead, so the 60 s attempt budget expires about 12 s after the claim.
    const offset = 48_000;
    const rt = await world.startWorker({
      workerId: 'it-pipeline-timeout',
      overrides: {
        clock: { now: () => new Date(Date.now() + offset), nowMs: () => Date.now() + offset },
      },
    });
    await worker.stop();
    const project = await world.project(world.repo());
    const { task, attempt } = await world.createTask(project, {
      timeoutSeconds: 60,
      directives: ['@@fake spawn-grandchild', '@@fake text started', '@@fake hang'],
    });
    const settled = await world.waitSettled(task.id, 60_000);
    expect(settled).toMatchObject({ status: 'timed_out', statusReason: 'timeout' });
    const a = await world.db.repos.attempts.findById(attempt.id);
    expect(a).toMatchObject({ status: 'timed_out', workerId: 'it-pipeline-timeout' });
    const pids = [...(await fakePids(attempt.id)), ...(a?.pid ? [a.pid] : [])];
    expect(pids.length).toBeGreaterThan(0);
    await waitFor(() => aliveProcesses(pids).length === 0, { timeoutMs: 15_000, description: 'no surviving processes' });
    // the task row settles before the pipeline's finally (lock release, unregister) has run
    await waitFor(() => rt.active.size() === 0, { timeoutMs: 10_000, description: 'pipeline unregistered' });
  });
});
