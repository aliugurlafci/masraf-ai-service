// Security gate "Cancel leaves no orphan" (contract §18.5) at worker pipeline level, for both process-spawning stages:
// the Claude stage (SIGTERM ignored + grandchild) and the testing stage (F19: test command with a detached grandchild).
// Standard fakes only (fake-claude, fake-cbm); process liveness via tests/helpers/common/process.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDb } from '../../helpers/database/db';
import { waitFor } from '../../helpers/common/wait-for';
import { createWorkerWorld } from '../../helpers/worker/world';
import type { WorkerWorld } from '../../helpers/worker/world';
import {
  ORPHAN_TEST_COMMAND,
  expectNoSurvivors,
  fakeClaudePids,
  grandchildDirective,
  orphanFixtureFiles,
  waitForFixturePids,
} from '../../helpers/worker/orphans';
import type { WorkerRuntime } from '../../../apps/worker/src/runtime';

let world: WorkerWorld;
let worker: WorkerRuntime;

beforeAll(async () => {
  world = await createWorkerWorld({ env: { ATTEMPT_STALE_MS: '30000' } });
  worker = await world.startWorker({ workerId: 'it-cancel-orphans' });
});

afterAll(async () => {
  await world?.dispose();
  await resetDb();
});

async function cancelNow(taskId: Parameters<WorkerWorld['waitSettled']>[0]): Promise<void> {
  const running = await world.db.repos.tasks.findById(taskId);
  if (!running) throw new Error('task missing');
  await world.requestCancel(running);
}

describe('cancel leaves no orphan (worker pipeline)', () => {
  it('Claude stage: ignored SIGTERM + grandchild => cancelled, CLI and grandchild are gone', async () => {
    const project = await world.project(world.repo());
    const { task, attempt } = await world.createTask(project, {
      directives: [
        '@@fake ignore-sigterm',
        grandchildDirective(),
        '@@fake text started',
        '@@fake hang',
      ],
    });
    await world.waitStatus(task.id, ['running']);
    const grandchildren = await waitFor(
      async () => {
        const p = await fakeClaudePids(world, attempt.id);
        return p.length > 0 ? p : null;
      },
      { timeoutMs: 30_000, intervalMs: 200, description: 'fake grandchild pid' },
    );
    const running = await world.db.repos.attempts.findById(attempt.id);
    expect(running?.pid).not.toBeNull();
    await cancelNow(task.id);
    const settled = await world.waitSettled(task.id, 60_000);
    expect(settled).toMatchObject({ status: 'cancelled', statusReason: 'cancelled_by_user' });
    const a = await world.db.repos.attempts.findById(attempt.id);
    expect(a?.status).toBe('cancelled');
    const all = [...grandchildren, ...(running?.pid ? [running.pid] : [])];
    expect(all.length).toBeGreaterThan(1);
    await expectNoSurvivors(all);
    await waitFor(() => worker.active.size() === 0, {
      timeoutMs: 10_000,
      description: 'pipeline unregistered',
    });
  });

  it('testing stage: running test command with a detached grandchild => cancelled, both are gone', async () => {
    const repo = world.repo(orphanFixtureFiles());
    const project = await world.project(repo, {
      testCommand: [...ORPHAN_TEST_COMMAND],
      junitReportPath: null,
      testTimeoutSeconds: 120,
    });
    const { task, attempt } = await world.createTask(project, {
      directives: ['@@fake text nothing to change'],
    });
    const pids = await waitForFixturePids(world, attempt.id);
    expect((await world.db.repos.tasks.findById(task.id))?.status).toBe('testing');
    await cancelNow(task.id);
    const settled = await world.waitSettled(task.id, 60_000);
    expect(settled).toMatchObject({ status: 'cancelled', statusReason: 'cancelled_by_user' });
    const runs = await world.db.repos.testRuns.listByAttempt(attempt.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('cancelled');
    await expectNoSurvivors([pids.test, pids.grandchild]);
    await waitFor(() => worker.active.size() === 0, {
      timeoutMs: 10_000,
      description: 'pipeline unregistered',
    });
  });
});
