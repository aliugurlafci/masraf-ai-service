// E2E crash recovery (contract §6.5 stale-attempt-recovery, §5.3 resume, §13.1 F7, §18.5): a worker running as a
// separate OS process (apps/worker/src/main.ts) is killed while Claude runs a task submitted over HTTP. Another
// in-process worker recovers the stale attempt and resumes it in the same workspace; the API shows the interrupted
// attempt (worker_lost) followed by a resumed, succeeded attempt and the SSE stream ends with completed.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ChangedFileSchema, JOB_NAMES, TaskAttemptSchema } from '@orc/shared';
import { workerHeartbeatKey } from '@orc/orchestrator';
import { resetDb } from '../helpers/database/db';
import { aliveProcesses, isProcessAlive } from '../helpers/common/process';
import { waitFor } from '../helpers/common/wait-for';
import { createE2eSystem, writeDirective } from '../helpers/e2e/system';
import type { E2eSession, E2eSystem } from '../helpers/e2e/system';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WORKER_MAIN = fileURLToPath(new URL('../../apps/worker/src/main.ts', import.meta.url));
const IS_WIN32 = process.platform === 'win32';
/** ~12 s of fake-claude output before the result. */
const SLOW = ['@@fake delay-ms 400', ...Array.from({ length: 30 }, (_, i) => `@@fake text step ${i}`)];

let sys: E2eSystem;
let admin: E2eSession;
let op: E2eSession;
let child: ChildProcess | null = null;

async function killTree(pid: number): Promise<void> {
  if (IS_WIN32) {
    await new Promise<void>((resolve) => {
      const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      k.once('exit', () => resolve());
      k.once('error', () => resolve());
    });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

beforeAll(async () => {
  // ATTEMPT_STALE_MS stays at the world default (3 s) so the killed worker's attempt goes stale quickly
  sys = await createE2eSystem();
  [admin, op] = await Promise.all([sys.user('admin'), sys.user('operator')]);
});

afterAll(async () => {
  if (child?.pid !== undefined && isProcessAlive(child.pid)) await killTree(child.pid);
  await sys?.dispose();
  await resetDb();
});

describe('e2e crash recovery', () => {
  it('recovers the attempt of a killed worker process and completes the task with a resumed attempt', async () => {
    const port = await sys.world.freePort();
    child = spawn(process.execPath, ['--import', 'tsx', WORKER_MAIN], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...sys.world.workerEnv({ workerId: 'e2e-killed', env: { WORKER_HEALTH_PORT: String(port) } }) },
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health/ready`).catch(() => null))?.status === 200, {
      timeoutMs: 90_000,
      intervalMs: 300,
      description: 'child worker ready',
    });
    // the out-of-process worker syncs the project registered over HTTP
    const { project } = await sys.registerProject(admin);
    const task = await sys.createTask(op, project.id, [writeDirective('src/crash.js', 'export const y = 2;\n'), ...SLOW]);
    const firstAttemptId = task.currentAttemptId ?? '';

    const stream = await sys.stream(op, task.id);
    expect(stream.status).toBe(200);
    await stream.until((ev) => ev.some((e) => e.event === 'claude'), 90_000);
    const running = await sys.detail(op, task.id);
    expect(running.currentAttempt).toMatchObject({ id: firstAttemptId, workerId: 'e2e-killed', status: 'active' });
    const claudePid = running.currentAttempt?.pid ?? 0;
    expect(claudePid).toBeGreaterThan(0);

    await killTree(child.pid ?? 0);
    if (!IS_WIN32) await killTree(claudePid); // detached process group: the runner lease TTL would kill it (§10.11)
    await waitFor(() => aliveProcesses([child?.pid ?? 0, claudePid]).length === 0, { timeoutMs: 15_000, description: 'worker tree gone' });

    const rescuer = await sys.startWorker({ workerId: 'e2e-rescuer' });
    await waitFor(async () => (await sys.world.redis.exists(workerHeartbeatKey(sys.world.prefix, 'e2e-killed'))) === 0, {
      timeoutMs: 20_000,
      intervalMs: 250,
      description: 'hb key of the killed worker to expire',
    });
    await waitFor(
      async () => {
        await sys.world.queues.maintenance.add(JOB_NAMES.staleAttemptRecovery, { v: 1 });
        const d = await sys.detail(op, task.id);
        return d.task.currentAttemptId !== firstAttemptId ? d : null;
      },
      { timeoutMs: 45_000, intervalMs: 1500, description: 'stale recovery to requeue the attempt' },
    );

    const events = await stream.waitEnd(120_000);
    expect(events.at(-1)).toMatchObject({ event: 'end', data: { status: 'completed' } });
    const done = await sys.waitSettled(op, task.id);
    expect(done.task).toMatchObject({ status: 'completed', autoRecoveryCount: 1 });

    const attempts = z.array(TaskAttemptSchema).parse((await sys.http('GET', `/tasks/${task.id}/attempts`, op)).body);
    expect(attempts).toHaveLength(2);
    const [old, next] = attempts;
    expect(old).toMatchObject({ id: firstAttemptId, status: 'interrupted', failureReason: 'worker_lost' });
    expect(next).toMatchObject({
      mode: 'resume',
      trigger: 'infra_recovery',
      status: 'succeeded',
      workerId: 'e2e-rescuer',
      previousAttemptId: firstAttemptId,
      workspaceId: old?.workspaceId,
    });
    const files = z.array(ChangedFileSchema).parse((await sys.http('GET', `/tasks/${task.id}/changed-files`, op)).body);
    expect(files.map((f) => f.path)).toContain('src/crash.js');

    await sys.assertNoOrphans([firstAttemptId, next?.id ?? ''], [rescuer]);
    await rescuer.stop();
  });
});
