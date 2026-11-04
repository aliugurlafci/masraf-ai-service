// Runner mode (contract §10.11 item 5, §5.2): an unexpected runner disconnect or a runner restart during an attempt
// interrupts the attempt as `worker_lost`; infra recovery requeues a resume attempt in the same workspace, which this
// still-healthy worker then completes. The runner is a fake (real protocol server, local-launcher backend) whose
// connections can be dropped and whose lease renewals can be rejected.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Uuid } from '@orc/shared';
import { resetDb } from '../../helpers/database/db';
import { aliveProcesses } from '../../helpers/common/process';
import { waitFor } from '../../helpers/common/wait-for';
import { makeTempDir, removeTempDir } from '../../helpers/git/fixtures';
import { createWorkerWorld, writeDirective } from '../../helpers/worker/world';
import type { WorkerWorld } from '../../helpers/worker/world';
import { startFakeRunner } from './fake-runner';
import type { FakeRunner } from './fake-runner';

/** ~12 s of fake-claude output before the result. */
const SLOW = [
  '@@fake delay-ms 400',
  ...Array.from({ length: 30 }, (_, i) => `@@fake text step ${i}`),
];

let world: WorkerWorld;
let runner: FakeRunner;
/**
 * POSIX: a short CBM_CACHE_DIR. In runner mode the leased cache is codebase-memory-mcp's runtime dir, so its
 * daemon socket path must fit AF_UNIX (worker config and hello checks); the world's temp cache dir is too long.
 */
let shortCbmCacheDir: string | null = null;

beforeAll(async () => {
  world = await createWorkerWorld();
  runner = await startFakeRunner();
  if (process.platform !== 'win32') shortCbmCacheDir = makeTempDir('orc-c-');
});

afterAll(async () => {
  await world?.dispose();
  await runner?.close();
  if (shortCbmCacheDir !== null) removeTempDir(shortCbmCacheDir);
  await resetDb();
});

function runnerEnv(): Record<string, string> {
  return {
    SANDBOX_MODE: 'runner',
    RUNNER_SOCKET_PATH: runner.socketPath,
    ...(shortCbmCacheDir !== null ? { CBM_CACHE_DIR: shortCbmCacheDir } : {}),
  };
}

async function waitClaudeRunning(attemptId: Uuid): Promise<{ pid: number; sessionId: string }> {
  return waitFor(
    async () => {
      const a = await world.db.repos.attempts.findById(attemptId);
      const s = await world.db.repos.claudeSessions.findByAttempt(attemptId);
      return a?.pid != null && s?.sessionId != null && runner.openSessions().includes('claude')
        ? { pid: a.pid, sessionId: s.sessionId }
        : null;
    },
    { timeoutMs: 60_000, intervalMs: 200, description: 'claude running through the runner' },
  );
}

async function expectRecovered(
  taskId: Uuid,
  attemptId: Uuid,
  first: { pid: number; sessionId: string },
  file: string,
) {
  const old = await waitFor(
    async () => {
      const a = await world.db.repos.attempts.findById(attemptId);
      return a?.status === 'interrupted' ? a : null;
    },
    { timeoutMs: 30_000, intervalMs: 200, description: 'attempt interrupted' },
  );
  expect(old).toMatchObject({ status: 'interrupted', failureReason: 'worker_lost' });
  await waitFor(() => aliveProcesses([first.pid]).length === 0, {
    timeoutMs: 15_000,
    description: 'claude stopped',
  });
  const task = await world.db.repos.tasks.findById(taskId);
  expect(task?.autoRecoveryCount).toBe(1);
  const next = await world.db.repos.attempts.findById(task?.currentAttemptId ?? '');
  expect(next).toMatchObject({
    trigger: 'infra_recovery',
    mode: 'resume',
    previousAttemptId: attemptId,
    workspaceId: old.workspaceId,
  });

  const settled = await world.waitSettled(taskId, 120_000);
  expect(settled.status).toBe('completed');
  const session = await world.db.repos.claudeSessions.findByAttempt(next?.id ?? '');
  expect(session?.resumedFromSessionId).toBe(first.sessionId);
  const files = await world.db.repos.changedFiles.listByAttempt({
    attemptId: next?.id ?? '',
    includePatch: false,
    limit: 10,
  });
  expect(files.map((f) => f.path)).toContain(file);
}

describe('runner lost during an attempt (§10.11 item 5)', () => {
  it('a dropped claude connection interrupts the attempt as worker_lost and the resume attempt completes', async () => {
    await world.startWorker({
      workerId: 'it-runner-drop',
      env: runnerEnv(),
    });
    const project = await world.project(world.repo());
    const { task, attempt } = await world.createTask(project, {
      directives: [writeDirective('src/dropped.js', 'export const d = 1;\n'), ...SLOW],
    });
    const first = await waitClaudeRunning(attempt.id);

    expect(runner.dropSessions('claude')).toBe(1);
    await expectRecovered(task.id, attempt.id, first, 'src/dropped.js');
  });

  it('a runner restart (lease renewal rejected) interrupts the attempt as worker_lost and the resume attempt completes', async () => {
    await world.startWorker({
      workerId: 'it-runner-restart',
      env: runnerEnv(),
    });
    const project = await world.project(world.repo());
    const { task, attempt } = await world.createTask(project, {
      directives: [writeDirective('src/restarted.js', 'export const r = 1;\n'), ...SLOW],
    });
    const first = await waitClaudeRunning(attempt.id);

    runner.rejectRenewals = true;
    try {
      await waitFor(
        async () => (await world.db.repos.attempts.findById(attempt.id))?.status === 'interrupted',
        {
          timeoutMs: 30_000,
          intervalMs: 200,
          description: 'attempt interrupted after a rejected renewal',
        },
      );
      expect(runner.renewRejections).toBeGreaterThan(0);
    } finally {
      runner.rejectRenewals = false;
    }
    await expectRecovered(task.id, attempt.id, first, 'src/restarted.js');
  });

  it.skipIf(process.platform === 'win32')(
    'refuses to start when the MCP daemon socket below CBM_CACHE_DIR does not fit the runner uid range',
    async () => {
      // 26 bytes pass the config check (4-digit uids) but not the hello check (runner uids 20000..20063).
      const base = shortCbmCacheDir ?? '';
      const tooLong = `${base}/${'x'.repeat(26 - base.length - 1)}`;
      expect(Buffer.byteLength(tooLong)).toBe(26);
      const err: unknown = await world
        .startWorker({ workerId: 'it-runner-cbm-socket', env: { ...runnerEnv(), CBM_CACHE_DIR: tooLong } })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toMatchObject({ code: 'config_invalid' });
      expect(err instanceof Error ? err.message : '').toMatch(/CBM_CACHE_DIR: .*5-digit sandbox uids.*at most 25 bytes/);
    },
  );
});
