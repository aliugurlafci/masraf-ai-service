// E2E timeout (contract §13.1 deadline, §13.4 `timeout` => timed_out(timeout), §18.2 "Processes"): a task whose
// Claude run hangs reaches its attempt deadline => timed_out over HTTP and SSE, and no process survives.
// The worker's orchestrator clock runs 48 s ahead, so the minimum API budget (60 s) expires about 12 s after claim.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskEventSchema, pageOf } from '@orc/shared';
import { resetDb } from '../helpers/database/db';
import { createE2eSystem } from '../helpers/e2e/system';
import type { E2eSession, E2eSystem } from '../helpers/e2e/system';

const CLOCK_OFFSET_MS = 48_000;

let sys: E2eSystem;
let admin: E2eSession;
let op: E2eSession;

beforeAll(async () => {
  sys = await createE2eSystem({ workerEnv: { ATTEMPT_STALE_MS: '30000' } });
  [admin, op] = await Promise.all([sys.user('admin'), sys.user('operator')]);
});

afterAll(async () => {
  await sys?.dispose();
  await resetDb();
});

describe('e2e timeout', () => {
  it('times out a hanging run at the attempt deadline: timed_out, stream ends, no orphan processes', async () => {
    const worker = await sys.startWorker({
      workerId: 'e2e-timeout',
      overrides: {
        clock: { now: () => new Date(Date.now() + CLOCK_OFFSET_MS), nowMs: () => Date.now() + CLOCK_OFFSET_MS },
      },
    });
    const { project } = await sys.registerProject(admin);
    const task = await sys.createTask(op, project.id, ['@@fake spawn-grandchild', '@@fake text started', '@@fake hang'], {
      timeoutSeconds: 60,
    });
    const stream = await sys.stream(op, task.id);
    expect(stream.status).toBe(200);
    const events = await stream.waitEnd(90_000);
    expect(events.some((e) => e.event === 'claude')).toBe(true);
    expect(events.at(-1)).toMatchObject({ event: 'end', data: { status: 'timed_out', reason: 'timeout' } });

    const detail = await sys.waitSettled(op, task.id, 60_000);
    expect(detail.task).toMatchObject({ status: 'timed_out', statusReason: 'timeout' });
    expect(detail.currentAttempt).toMatchObject({ status: 'timed_out', workerId: 'e2e-timeout' });
    const session = await sys.http('GET', `/tasks/${task.id}/session`, op);
    expect(session.body).toMatchObject({ status: 'killed' });
    const taskEvents = await sys.http('GET', `/tasks/${task.id}/events?limit=100`, op);
    expect(pageOf(TaskEventSchema).parse(taskEvents.body).items.map((e) => e.type)).toContain('claude_exited');

    const attemptId = task.currentAttemptId ?? '';
    const pids = await sys.attemptPids([attemptId]);
    // fake-claude itself plus the grandchild it reported
    expect(pids.length).toBeGreaterThanOrEqual(2);
    await sys.assertNoOrphans([attemptId], [worker]);
  });
});
