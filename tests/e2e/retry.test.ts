// E2E retry (contract §9.5 POST /tasks/:id/retry, §5.3, §13.4): attempt 1 ends failed(claude_result_error); a
// fresh retry over HTTP (202 + Location) creates attempt 2 whose additional instructions (appended after the task
// description, §10.10) make fake-claude succeed => completed, the stream carries both attempts and the read models
// default to the current attempt while attempt 1 stays addressable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ChangedFileSchema, TaskAttemptSchema, TaskSchema } from '@orc/shared';
import { resetDb } from '../helpers/database/db';
import { createE2eSystem, writeDirective } from '../helpers/e2e/system';
import type { E2eSession, E2eSystem } from '../helpers/e2e/system';
import type { WorkerRuntime } from '../../apps/worker/src/runtime';

let sys: E2eSystem;
let admin: E2eSession;
let op: E2eSession;
let worker: WorkerRuntime;

beforeAll(async () => {
  sys = await createE2eSystem({ workerEnv: { ATTEMPT_STALE_MS: '30000' } });
  [admin, op] = await Promise.all([sys.user('admin'), sys.user('operator')]);
  worker = await sys.startWorker({ workerId: 'e2e-retry' });
});

afterAll(async () => {
  await sys?.dispose();
  await resetDb();
});

describe('e2e retry', () => {
  it('failed attempt => retry over HTTP => new attempt completes', async () => {
    const { project } = await sys.registerProject(admin);
    const task = await sys.createTask(op, project.id, [
      writeDirective('src/retry.js', 'export const retried = true;\n'),
      '@@fake result error_during_execution',
    ]);
    const failed = await sys.waitSettled(op, task.id);
    expect(failed.task).toMatchObject({ status: 'failed', statusReason: 'claude_result_error' });
    expect(failed.actions.canRetry).toBe(true);
    const firstAttemptId = failed.currentAttempt?.id ?? '';
    await sys.assertNoOrphans([firstAttemptId], [worker]);

    const res = await sys.http('POST', `/tasks/${task.id}/retry`, op, {
      mode: 'fresh',
      additionalInstructions: '@@fake result success',
    });
    expect(res.status).toBe(202);
    expect(res.headers.get('location')).toBe(`/api/v1/tasks/${task.id}`);
    const retried = TaskSchema.parse(res.body);
    expect(retried).toMatchObject({ status: 'queued', attemptCount: 2, statusReason: null });
    expect(retried.currentAttemptId).not.toBe(firstAttemptId);

    // A replay from the start closes on attempt 1's `end` entry (§8.3.5); the client then reconnects with that
    // entry as Last-Event-ID (§8.4) and follows attempt 2 until its own `end`.
    const stream = await sys.stream(op, task.id);
    expect(stream.status).toBe(200);
    const firstPass = await stream.waitEnd(60_000);
    const firstEnd = firstPass.at(-1);
    expect(firstEnd).toMatchObject({ event: 'end', data: { attemptId: firstAttemptId, status: 'failed' } });
    const resumed = await sys.stream(op, task.id, firstEnd?.id ?? '');
    expect(resumed.status).toBe(200);
    const events = await resumed.waitEnd(120_000);
    expect(events.some((e) => e.event === 'status' && (e.data as { attemptId: string | null }).attemptId === retried.currentAttemptId)).toBe(true);
    const ends = events.filter((e) => e.event === 'end').map((e) => e.data as { attemptId: string; status: string });
    expect(ends).toEqual([expect.objectContaining({ attemptId: retried.currentAttemptId, status: 'completed' })]);

    const done = await sys.waitSettled(op, task.id);
    expect(done.task).toMatchObject({ status: 'completed', statusReason: null, attemptCount: 2 });
    expect(done.currentAttempt).toMatchObject({ attemptNumber: 2, trigger: 'user_retry', mode: 'fresh', status: 'succeeded' });
    expect(done.currentAttempt?.additionalInstructions).toBe('@@fake result success');

    const attempts = z.array(TaskAttemptSchema).parse((await sys.http('GET', `/tasks/${task.id}/attempts`, op)).body);
    expect(attempts.map((a) => [a.attemptNumber, a.status, a.failureReason])).toEqual([
      [1, 'failed', 'claude_result_error'],
      [2, 'succeeded', null],
    ]);
    expect(attempts[1]?.workspaceId).not.toBe(attempts[0]?.workspaceId);

    const current = z.array(ChangedFileSchema).parse((await sys.http('GET', `/tasks/${task.id}/changed-files`, op)).body);
    expect(current.map((f) => f.path)).toEqual(['src/retry.js']);
    expect(current.every((f) => f.attemptId === retried.currentAttemptId)).toBe(true);
    const old = await sys.http('GET', `/tasks/${task.id}/changed-files?attemptId=${firstAttemptId}`, op);
    expect(z.array(ChangedFileSchema).parse(old.body).map((f) => f.attemptId)).toEqual([firstAttemptId]);
    const oldSession = await sys.http('GET', `/tasks/${task.id}/session?attemptId=${firstAttemptId}`, op);
    expect(oldSession.body).toMatchObject({ status: 'failed', resultSubtype: 'error_during_execution' });

    await sys.assertNoOrphans([firstAttemptId, retried.currentAttemptId ?? ''], [worker]);
    const again = await sys.http('POST', `/tasks/${task.id}/retry`, op, { mode: 'fresh' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'task_not_retryable' });
  });
});
