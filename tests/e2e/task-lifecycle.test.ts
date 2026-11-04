// E2E task lifecycle (contract §18.1 e2e, §18.5 "submit -> live output -> completed with diff/tests", §8, §9.5):
// the real API over HTTP + an in-process worker runtime (SANDBOX_MODE=local, fake-claude, fake-cbm) on mssql-test
// and redis-test. login -> register project (worker sync => ready) -> POST /tasks (202, nothing executed in the
// request) -> SSE consumed over HTTP with live events before completion and a Last-Event-ID resume after a forced
// disconnect -> completed -> read models (changed files, diff, patch, JUnit tests, logs, events, session, impact)
// -> operator isolation. No orphan process, registry entry or temp directory survives.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ChangedFileSchema,
  ClaudeSessionSchema,
  DiffFileSchema,
  McpIndexOperationSchema,
  TaskAttemptSchema,
  TaskEventSchema,
  TaskLogSchema,
  TaskSchema,
  TestResultSchema,
  TestRunSchema,
  pageOf,
} from '@orc/shared';
import type { Project, Task } from '@orc/shared';
import { z } from 'zod';
import { resetDb } from '../helpers/database/db';
import { hashTree } from '../helpers/git/fixtures';
import { compareStreamIds, createE2eSystem, idsOf, writeDirective } from '../helpers/e2e/system';
import type { E2eSession, E2eSystem, SseClient, SseEvent } from '../helpers/e2e/system';
import type { WorkerRuntime } from '../../apps/worker/src/runtime';

/** About 6 s of Claude output after the edit, so the stream is consumed while the task is still running. */
const SLOW_TEXT = ['@@fake delay-ms 250', ...Array.from({ length: 24 }, (_, i) => `@@fake text progress ${i}`)];

let sys: E2eSystem;
let admin: E2eSession;
let opA: E2eSession;
let opB: E2eSession;
let project: Project;
let repoDir: string;
let repoHashBefore: Map<string, string>;
let syncWorker: WorkerRuntime;
let worker: WorkerRuntime | null = null;
let task: Task;
let first: SseClient;
let second: SseClient;
let firstEvents: SseEvent[] = [];
let resumeFrom = '';

beforeAll(async () => {
  sys = await createE2eSystem({ workerEnv: { ATTEMPT_STALE_MS: '30000' } });
  [admin, opA, opB] = await Promise.all([sys.user('admin'), sys.user('operator'), sys.user('operator')]);
  syncWorker = await sys.startWorker({ workerId: 'e2e-sync' });
});

afterAll(async () => {
  await sys?.dispose();
  await resetDb();
});

describe('e2e task lifecycle over HTTP', () => {
  it('registers a project through the API; the worker sync makes it ready (mirror + index)', async () => {
    const registered = await sys.registerProject(admin);
    project = registered.project;
    repoDir = registered.repoDir;
    repoHashBefore = hashTree(repoDir);
    expect(project).toMatchObject({ status: 'ready', defaultBranch: 'main' });
    expect(project.headSha).toMatch(/^[0-9a-f]{40}$/);
    const listed = await sys.http('GET', '/projects', opA);
    expect(listed.status).toBe(200);
    expect(pageOf(z.object({ id: z.string() })).parse(listed.body).items.map((p) => p.id)).toContain(project.id);
  });

  it('POST /tasks only records and enqueues: 202 + queued, nothing claimed or executed without a worker', async () => {
    // no worker is consuming the task queue: whatever happens now happened inside the HTTP request
    await syncWorker.stop();
    const started = Date.now();
    task = await sys.createTask(opA, project.id, [
      writeDirective('src/feature.js', 'export const mul = (a, b) => a * b;\n'),
      '@@fake text implemented the feature',
      ...SLOW_TEXT,
    ]);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(task).toMatchObject({ status: 'queued', createdByUserId: opA.userId, attemptCount: 1 });
    expect(task.startedAt).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const detail = await sys.detail(opA, task.id);
    expect(detail.task.status).toBe('queued');
    expect(detail.currentAttempt).toMatchObject({ status: 'queued', workerId: null, pid: null, workspaceId: null, startedAt: null });
    const logs = await sys.http('GET', `/tasks/${task.id}/logs`, opA);
    expect(pageOf(TaskLogSchema).parse(logs.body).items).toEqual([]);
    expect(await sys.world.queues.jobState(task.currentAttemptId ?? '')).toBe('waiting');
  });

  it('streams live claude/log events over SSE before the task completes', async () => {
    first = await sys.stream(opA, task.id);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(first.headers.get('cache-control')).toBe('no-cache, no-transform');
    await first.until((ev) => ev.length >= 1);
    expect(first.retry).toBe(3000);
    expect(first.events[0]).toMatchObject({ id: null, event: 'status', data: { snapshot: true, status: 'queued' } });

    worker = await sys.startWorker({ workerId: 'e2e-lifecycle' });
    await first.until((ev) => ev.filter((e) => e.event === 'claude').length >= 3, 60_000);
    // the live output arrived while the task was still executing
    const during = await sys.detail(opA, task.id);
    expect(during.task.status).toBe('running');
    const live = [...first.events];
    expect(live.some((e) => e.event === 'log')).toBe(true);
    expect(live.filter((e) => e.event === 'status').map((e) => (e.data as { status: string }).status)).toEqual(
      expect.arrayContaining(['preparing_workspace', 'running']),
    );
    for (const e of live.filter((x) => x.event !== 'status' || (x.data as { snapshot?: boolean }).snapshot !== true)) {
      expect(e.id).toMatch(/^r-\d+-\d+$/);
    }

    // forced disconnect in the middle of the run
    firstEvents = live;
    resumeFrom = idsOf(live).at(-1) ?? '';
    expect(resumeFrom).not.toBe('');
    first.close();
  });

  it('resumes with Last-Event-ID without loss or duplicates and ends with completed', async () => {
    // let the worker publish more events while no client is connected
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    second = await sys.stream(opA, task.id, resumeFrom);
    expect(second.status).toBe(200);
    const events = await second.waitEnd(120_000);
    expect(events[0]).toMatchObject({ id: null, event: 'status', data: { snapshot: true } });
    const resumedIds = idsOf(events);
    expect(resumedIds.length).toBeGreaterThan(0);
    for (const id of resumedIds) expect(compareStreamIds(id, resumeFrom)).toBeGreaterThan(0);
    const allIds = [...idsOf(firstEvents), ...resumedIds];
    expect(new Set(allIds).size).toBe(allIds.length);
    const end = events.at(-1);
    expect(end?.event).toBe('end');
    expect(end?.data).toMatchObject({ type: 'end', taskId: task.id, status: 'completed', reason: null });
    // the two connections together delivered every entry of the Redis stream exactly once
    const stored = await sys.world.streamEvents(task.id);
    expect(allIds.length).toBe(stored.length);
    const received = [...firstEvents, ...events].filter((e) => e.id !== null);
    expect(received.map((e) => e.event)).toEqual(stored.map((e) => e.type));
    for (const type of ['status', 'log', 'claude', 'test', 'diff', 'end']) {
      expect(received.some((e) => e.event === type)).toBe(true);
    }
    const testEvent = received.find((e) => e.event === 'test' && (e.data as { status: string }).status !== 'running');
    expect(testEvent?.data).toMatchObject({ status: 'passed', total: 2, passed: 2 });
    expect(received.find((e) => e.event === 'diff')?.data).toMatchObject({ filesChanged: 1, mergeCheck: 'clean', patchAvailable: true });

    // resuming from the final `end` entry => 204 (EventSource stops reconnecting)
    const after = await sys.stream(opA, task.id, end?.id ?? '');
    expect(after.status).toBe(204);
    after.close();
  });

  it('exposes the completed task with changed files, diff, patch, JUnit tests, logs, events, session and impact', async () => {
    const detail = await sys.waitSettled(opA, task.id);
    expect(detail.task).toMatchObject({ status: 'completed', statusReason: null });
    expect(detail.currentAttempt).toMatchObject({ status: 'succeeded', workerId: 'e2e-lifecycle', filesChanged: 1 });
    expect(detail.currentAttempt?.mergeCheck?.status).toBe('clean');
    expect(detail.currentAttempt?.headSha).not.toBe(detail.currentAttempt?.baseSha);
    const attemptId = detail.currentAttempt?.id ?? '';

    const changed = await sys.http('GET', `/tasks/${task.id}/changed-files`, opA);
    expect(changed.status).toBe(200);
    const files = z.array(ChangedFileSchema).parse(changed.body);
    expect(files.map((f) => [f.path, f.changeType])).toEqual([['src/feature.js', 'A']]);

    const diff = await sys.http('GET', `/tasks/${task.id}/diff`, opA);
    expect(diff.status).toBe(200);
    expect(pageOf(DiffFileSchema).parse(diff.body).items[0]?.patch).toContain('+export const mul');
    const unified = await sys.http('GET', `/tasks/${task.id}/diff`, opA, undefined, { Accept: 'text/x-diff' });
    expect(unified.status).toBe(200);
    expect(unified.text).toContain('src/feature.js');
    expect(unified.text).toContain('+export const mul');

    const patch = await sys.http('GET', `/tasks/${task.id}/patch`, opA, undefined, { Accept: 'application/x-patch' });
    expect(patch.status).toBe(200);
    expect(patch.headers.get('content-type')).toContain('application/x-patch');
    expect(patch.headers.get('content-disposition')).toMatch(/^attachment; filename="task-[0-9a-f]+-a1\.patch"$/);
    expect(patch.text).toContain('+export const mul');

    const tests = await sys.http('GET', `/tasks/${task.id}/tests`, opA);
    const runs = z.array(TestRunSchema).parse(tests.body);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'passed', total: 2, passed: 2, failed: 0, reportParsed: true, exitCode: 0 });
    const results = await sys.http('GET', `/tasks/${task.id}/tests/${runs[0]?.id ?? ''}/results?limit=100`, opA);
    expect(pageOf(TestResultSchema).parse(results.body).items.map((r) => r.name).sort()).toEqual(['adds', 'multiplies']);

    const logs = await sys.http('GET', `/tasks/${task.id}/logs?limit=1000`, opA);
    const logItems = pageOf(TaskLogSchema).parse(logs.body).items;
    expect(logItems.map((l) => l.seq)).toEqual(logItems.map((_, i) => i));
    expect(logItems.some((l) => l.stream === 'stdout' && l.source === 'test' && l.content.includes('2 tests passed'))).toBe(true);
    const claudeText = await sys.http('GET', `/tasks/${task.id}/logs?stream=claude&format=text`, opA);
    expect(claudeText.status).toBe(200);
    expect(claudeText.headers.get('content-type')).toContain('text/plain');
    expect(claudeText.text).toContain('"type":"system"');
    expect(claudeText.text).toContain('progress 23');
    expect(claudeText.text).not.toContain('sk-ant-api03');

    const events = await sys.http('GET', `/tasks/${task.id}/events?limit=100`, opA);
    const types = pageOf(TaskEventSchema).parse(events.body).items.map((e) => e.type);
    for (const t of ['task_created', 'attempt_claimed', 'workspace_ready', 'claude_started', 'claude_exited', 'test_completed', 'review_completed'] as const) {
      expect(types).toContain(t);
    }

    const session = await sys.http('GET', `/tasks/${task.id}/session`, opA);
    expect(ClaudeSessionSchema.parse(session.body)).toMatchObject({ attemptId, status: 'completed', model: 'sonnet', resultSubtype: 'success' });

    const impact = await sys.http('GET', `/tasks/${task.id}/impact`, opA);
    expect(impact.status).toBe(200);
    expect(McpIndexOperationSchema.parse(impact.body)).toMatchObject({ kind: 'impact_analysis', status: 'succeeded', attemptId });

    const attempts = await sys.http('GET', `/tasks/${task.id}/attempts`, opA);
    expect(z.array(TaskAttemptSchema).parse(attempts.body).map((a) => a.status)).toEqual(['succeeded']);

    // the registered source repository was never written (§11.1)
    expect(hashTree(repoDir)).toEqual(repoHashBefore);
    await sys.assertNoOrphans([attemptId], worker ? [worker] : []);
  });

  it('operator B can neither see nor stream nor act on operator A task (404, never 403)', async () => {
    const own = await sys.http('GET', '/tasks', opA);
    expect(pageOf(TaskSchema).parse(own.body).items.map((t) => t.id)).toContain(task.id);
    const others = await sys.http('GET', '/tasks', opB);
    expect(others.status).toBe(200);
    expect(pageOf(TaskSchema).parse(others.body).items.map((t) => t.id)).not.toContain(task.id);

    for (const sub of ['', '/logs', '/events', '/attempts', '/changed-files', '/diff', '/patch', '/tests', '/session', '/impact']) {
      const r = await sys.http('GET', `/tasks/${task.id}${sub}`, opB);
      expect(r.status, `GET /tasks/:id${sub}`).toBe(404);
      expect(r.body).toMatchObject({ code: 'not_found' });
    }
    const stream = await sys.stream(opB, task.id);
    expect(stream.status).toBe(404);
    expect(stream.headers.get('content-type')).toContain('application/problem+json');
    expect(await stream.json()).toMatchObject({ code: 'not_found' });
    const cancel = await sys.http('POST', `/tasks/${task.id}/cancel`, opB, {});
    expect(cancel.status).toBe(404);
    const retry = await sys.http('POST', `/tasks/${task.id}/retry`, opB, { mode: 'fresh' });
    expect(retry.status).toBe(404);
  });
});
