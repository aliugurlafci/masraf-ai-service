// Security gate "Timeout leaves no orphan" (contract §18.5) at worker pipeline level, for both process-spawning
// stages: the Claude stage (SIGTERM ignored + grandchild) and the testing stage (F19: test command with a detached
// grandchild). The orchestrator clock runs ahead so the attempt deadline expires seconds after the claim.
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

const OFFSET_MS = 100_000;
const TIMEOUT_SECONDS = 120; // budget after the claim: 20 s of real time

let world: WorkerWorld;
let worker: WorkerRuntime;

beforeAll(async () => {
  world = await createWorkerWorld({ env: { ATTEMPT_STALE_MS: '60000' } });
  worker = await world.startWorker({
    workerId: 'it-timeout-orphans',
    overrides: {
      clock: { now: () => new Date(Date.now() + OFFSET_MS), nowMs: () => Date.now() + OFFSET_MS },
    },
  });
});

afterAll(async () => {
  await world?.dispose();
  await resetDb();
});

describe('timeout leaves no orphan (worker pipeline)', () => {
  it('Claude stage: ignored SIGTERM + grandchild => timed_out, CLI and grandchild are gone', async () => {
    const project = await world.project(world.repo());
    const { task, attempt } = await world.createTask(project, {
      timeoutSeconds: TIMEOUT_SECONDS,
      directives: [
        '@@fake ignore-sigterm',
        grandchildDirective(),
        '@@fake text started',
        '@@fake hang',
      ],
    });
    const settled = await world.waitSettled(task.id, 90_000);
    expect(settled).toMatchObject({ status: 'timed_out', statusReason: 'timeout' });
    const a = await world.db.repos.attempts.findById(attempt.id);
    expect(a).toMatchObject({ status: 'timed_out', workerId: 'it-timeout-orphans' });
    const pids = [...(await fakeClaudePids(world, attempt.id)), ...(a?.pid ? [a.pid] : [])];
    expect(pids.length).toBeGreaterThan(1);
    await expectNoSurvivors(pids);
    await waitFor(() => worker.active.size() === 0, {
      timeoutMs: 10_000,
      description: 'pipeline unregistered',
    });
  });

  it('testing stage: running test command with a detached grandchild => timed_out, both are gone', async () => {
    const repo = world.repo(orphanFixtureFiles());
    const project = await world.project(repo, {
      testCommand: [...ORPHAN_TEST_COMMAND],
      junitReportPath: null,
      testTimeoutSeconds: 3600,
    });
    const { task, attempt } = await world.createTask(project, {
      timeoutSeconds: TIMEOUT_SECONDS,
      directives: ['@@fake text nothing to change'],
    });
    const pids = await waitForFixturePids(world, attempt.id);
    const settled = await world.waitSettled(task.id, 90_000);
    expect(settled).toMatchObject({ status: 'timed_out', statusReason: 'timeout' });
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
