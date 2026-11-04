// E2E cancellation (contract §5.4, §9.5 POST /tasks/:id/cancel, §13.6, §18.2 "Processes"): a running task with a
// fake-claude grandchild is cancelled over HTTP => cancelled(cancelled_by_user), the SSE stream ends with
// `cancelled`, best-effort artefacts are captured and no process, registry entry or active pipeline survives.
// A task cancelled while still queued settles immediately (200) and is never executed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskEventSchema, TaskSchema, pageOf } from '@orc/shared';
import { resetDb } from '../helpers/database/db';
import { waitFor } from '../helpers/common/wait-for';
import { createE2eSystem, writeDirective } from '../helpers/e2e/system';
import type { E2eSession, E2eSystem } from '../helpers/e2e/system';
import type { Project } from '@orc/shared';
import type { WorkerRuntime } from '../../apps/worker/src/runtime';

let sys: E2eSystem;
let admin: E2eSession;
let op: E2eSession;
let project: Project;
let worker: WorkerRuntime;

beforeAll(async () => {
  sys = await createE2eSystem({ workerEnv: { ATTEMPT_STALE_MS: '30000' } });
  [admin, op] = await Promise.all([sys.user('admin'), sys.user('operator')]);
  worker = await sys.startWorker({ workerId: 'e2e-cancel' });
  project = (await sys.registerProject(admin)).project;
});

afterAll(async () => {
  await sys?.dispose();
  await resetDb();
});

describe('e2e cancel', () => {
  it('cancels a running task over HTTP: cancelled, stream ends, no orphan processes', async () => {
    const task = await sys.createTask(op, project.id, [
      writeDirective('src/partial.js', 'export const partial = true;\n'),
      '@@fake spawn-grandchild',
      '@@fake delay-ms 200',
      '@@fake text working',
      '@@fake hang',
    ]);
    const stream = await sys.stream(op, task.id);
    expect(stream.status).toBe(200);
    await sys.waitStatus(op, task.id, ['running'], 60_000);
    const attemptId = task.currentAttemptId ?? '';
    // the grandchild exists before the cancel is requested
    const before = await waitFor(
      async () => {
        const pids = await sys.attemptPids([attemptId]);
        return pids.length >= 2 ? pids : null;
      },
      { timeoutMs: 30_000, intervalMs: 200, description: 'fake-claude and grandchild pids' },
    );
    expect(before.length).toBeGreaterThanOrEqual(2);

    const res = await sys.http('POST', `/tasks/${task.id}/cancel`, op, { reason: 'e2e cancel' });
    expect(res.status).toBe(202);
    expect(TaskSchema.parse(res.body).cancelRequestedAt).not.toBeNull();

    const events = await stream.waitEnd(60_000);
    expect(events.at(-1)).toMatchObject({ event: 'end', data: { status: 'cancelled', reason: 'cancelled_by_user' } });
    const detail = await sys.waitSettled(op, task.id, 60_000);
    expect(detail.task).toMatchObject({ status: 'cancelled', statusReason: 'cancelled_by_user' });
    expect(detail.currentAttempt?.status).toBe('cancelled');
    expect(detail.actions.canCancel).toBe(false);

    const taskEvents = await sys.http('GET', `/tasks/${task.id}/events?limit=100`, op);
    const types = pageOf(TaskEventSchema).parse(taskEvents.body).items.map((e) => e.type);
    expect(types).toContain('cancel_requested');
    expect(types).toContain('artifacts_captured');
    const files = await sys.http('GET', `/tasks/${task.id}/changed-files`, op);
    expect((files.body as { path: string }[]).map((f) => f.path)).toEqual(['src/partial.js']);

    await sys.assertNoOrphans([attemptId], [worker]);
    const again = await sys.http('POST', `/tasks/${task.id}/cancel`, op, {});
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'task_not_cancellable' });
  });

  it('cancels a queued task immediately (200) and it is never executed', async () => {
    await worker.stop();
    const task = await sys.createTask(op, project.id, ['@@fake text must never run']);
    const res = await sys.http('POST', `/tasks/${task.id}/cancel`, op, {});
    expect(res.status).toBe(200);
    expect(TaskSchema.parse(res.body)).toMatchObject({ status: 'cancelled', statusReason: 'cancelled_by_user' });
    const next = await sys.startWorker({ workerId: 'e2e-cancel-2' });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const detail = await sys.detail(op, task.id);
    expect(detail.task.status).toBe('cancelled');
    expect(detail.currentAttempt).toMatchObject({ status: 'cancelled', workerId: null, pid: null });
    const session = await sys.http('GET', `/tasks/${task.id}/session`, op);
    expect(session.status).toBe(404);
    await sys.assertNoOrphans([task.currentAttemptId ?? ''], [next]);
  });
});
