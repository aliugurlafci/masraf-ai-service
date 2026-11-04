// Worker shutdown, crash recovery and reconciliation (contract §5.2, §5.3, §6.5, §13.1, §14.2, §14.5) against
// mssql-test + redis-test: graceful shutdown requeues the interrupted attempt (resumed by another worker with
// --resume), a killed worker process is recovered by stale-attempt-recovery and resumed, and the queued reconciler
// re-enqueues a queued task whose job was lost.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sql from 'mssql';
import { JOB_NAMES } from '@orc/shared';
import type { Uuid } from '@orc/shared';
import { workerHeartbeatKey } from '@orc/orchestrator';
import { resetDb } from '../../helpers/database/db';
import { aliveProcesses, isProcessAlive } from '../../helpers/common/process';
import { waitFor } from '../../helpers/common/wait-for';
import { IS_WIN32, createWorkerWorld, writeDirective } from '../../helpers/worker/world';
import type { WorkerWorld } from '../../helpers/worker/world';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORKER_MAIN = fileURLToPath(new URL('../../../apps/worker/src/main.ts', import.meta.url));

/** ~12 s of fake-claude output before the result. */
const SLOW = ['@@fake delay-ms 400', ...Array.from({ length: 30 }, (_, i) => `@@fake text step ${i}`)];

let world: WorkerWorld;
const children: ChildProcess[] = [];

beforeAll(async () => {
  world = await createWorkerWorld();
});

afterAll(async () => {
  for (const c of children) if (c.pid !== undefined && isProcessAlive(c.pid)) c.kill('SIGKILL');
  await world?.dispose();
  await resetDb();
});

async function waitClaudeRunning(attemptId: Uuid): Promise<{ pid: number; sessionId: string }> {
  return waitFor(
    async () => {
      const a = await world.db.repos.attempts.findById(attemptId);
      const s = await world.db.repos.claudeSessions.findByAttempt(attemptId);
      return a?.pid != null && s?.sessionId != null ? { pid: a.pid, sessionId: s.sessionId } : null;
    },
    { timeoutMs: 60_000, intervalMs: 200, description: 'claude running with a session' },
  );
}

async function killTree(pid: number): Promise<void> {
  if (IS_WIN32) {
    await new Promise<void>((resolve) => {
      const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      k.once('exit', () => resolve());
      k.once('error', () => resolve());
    });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

describe('graceful shutdown (§14.5)', () => {
  it('interrupts the running attempt, requeues a resume attempt and another worker completes it with --resume', async () => {
    const a = await world.startWorker({ workerId: 'it-shutdown-a' });
    const project = await world.project(world.repo());
    const { task, attempt } = await world.createTask(project, {
      directives: [writeDirective('src/resumed.js', 'export const x = 1;\n'), ...SLOW],
    });
    const first = await waitClaudeRunning(attempt.id);

    await expect(a.stop()).resolves.toBe(0);
    expect(aliveProcesses([first.pid])).toEqual([]);
    const old = await world.db.repos.attempts.findById(attempt.id);
    expect(old).toMatchObject({ status: 'interrupted', failureReason: 'worker_shutdown' });
    const queued = await world.db.repos.tasks.findById(task.id);
    expect(queued?.status).toBe('queued');
    expect(queued?.autoRecoveryCount).toBe(1);
    const next = await world.db.repos.attempts.findById(queued?.currentAttemptId ?? '');
    expect(next).toMatchObject({ trigger: 'infra_recovery', mode: 'resume', previousAttemptId: attempt.id, workspaceId: old?.workspaceId });
    expect(await world.queues.jobState(next?.id ?? '')).not.toBe('unknown');
    const node = (await world.db.repos.workerNodes.list()).find((n) => n.id === 'it-shutdown-a');
    expect(node?.status).toBe('offline');

    const b = await world.startWorker({ workerId: 'it-shutdown-b' });
    const settled = await world.waitSettled(task.id);
    expect(settled.status).toBe('completed');
    const session = await world.db.repos.claudeSessions.findByAttempt(next?.id ?? '');
    expect(session?.resumedFromSessionId).toBe(first.sessionId);
    const files = await world.db.repos.changedFiles.listByAttempt({ attemptId: next?.id ?? '', includePatch: false, limit: 10 });
    expect(files.map((f) => f.path)).toContain('src/resumed.js');
    await b.stop();
  });
});

describe('crash recovery (§6.5 stale-attempt-recovery, F7)', () => {
  it('recovers the attempt of a killed worker process and resumes it in the same workspace', async () => {
    const port = await world.freePort();
    const env = { ...process.env, ...world.workerEnv({ workerId: 'it-killed', env: { WORKER_HEALTH_PORT: String(port) } }) };
    const child = spawn(process.execPath, ['--import', 'tsx', WORKER_MAIN], {
      cwd: REPO_ROOT,
      env,
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    children.push(child);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health/ready`).catch(() => null))?.status === 200, {
      timeoutMs: 60_000,
      intervalMs: 300,
      description: 'child worker ready',
    });

    const project = await world.project(world.repo());
    const { task, attempt } = await world.createTask(project, {
      directives: [writeDirective('src/crash.js', 'export const y = 2;\n'), ...SLOW],
    });
    const first = await waitClaudeRunning(attempt.id);
    const claimed = await world.db.repos.attempts.findById(attempt.id);
    expect(claimed?.workerId).toBe('it-killed');

    await killTree(child.pid ?? 0);
    if (!IS_WIN32) await killTree(first.pid); // detached process group: the runner lease TTL would kill it (§10.11)
    await waitFor(() => aliveProcesses([child.pid ?? 0, first.pid]).length === 0, { timeoutMs: 15_000, description: 'worker tree gone' });

    const rescuer = await world.startWorker({ workerId: 'it-rescuer' });
    // the dead owner's hb key expires (PX 3 x heartbeat) and its LastHeartbeatAt goes stale (ATTEMPT_STALE_MS)
    await waitFor(async () => (await world.redis.exists(workerHeartbeatKey(world.prefix, 'it-killed'))) === 0, {
      timeoutMs: 20_000,
      intervalMs: 250,
      description: 'hb key of the killed worker to expire',
    });
    await waitFor(
      async () => {
        await world.queues.maintenance.add(JOB_NAMES.staleAttemptRecovery, { v: 1 });
        const t = await world.db.repos.tasks.findById(task.id);
        return t !== null && t.currentAttemptId !== attempt.id ? t : null;
      },
      { timeoutMs: 30_000, intervalMs: 1500, description: 'stale recovery to requeue the attempt' },
    );
    const settled = await world.waitSettled(task.id);
    expect(settled.status).toBe('completed');
    const old = await world.db.repos.attempts.findById(attempt.id);
    expect(old).toMatchObject({ status: 'interrupted', failureReason: 'worker_lost' });
    const next = await world.db.repos.attempts.findById(settled.currentAttemptId ?? '');
    expect(next).toMatchObject({ mode: 'resume', trigger: 'infra_recovery', status: 'succeeded', workerId: 'it-rescuer', workspaceId: old?.workspaceId });
    const session = await world.db.repos.claudeSessions.findByAttempt(next?.id ?? '');
    expect(session?.resumedFromSessionId).toBe(first.sessionId);
    // the task row settles before the pipeline's finally (lock release, unregister) has run
    await waitFor(() => rescuer.active.size() === 0, { timeoutMs: 10_000, description: 'pipeline unregistered' });
    await rescuer.stop();
  });
});

describe('queued reconciler (§6.5)', () => {
  it('re-enqueues a queued task whose run-attempt job is missing', async () => {
    await world.startWorker({ workerId: 'it-reconciler' });
    const project = await world.project(world.repo());
    const { task, attempt } = await world.createTask(project, { enqueue: false });
    expect(await world.queues.jobState(attempt.id)).toBe('unknown');
    await world.sql('UPDATE orc.Tasks SET QueuedAt = DATEADD(MINUTE, -5, SYSUTCDATETIME()) WHERE Id = @id', [
      ['id', sql.UniqueIdentifier, task.id],
    ]);
    await world.queues.maintenance.add(JOB_NAMES.queuedReconciler, { v: 1 });
    const settled = await world.waitSettled(task.id);
    expect(settled.status).toBe('completed');
    expect((await world.db.repos.attempts.findById(attempt.id))?.status).toBe('succeeded');
  });
});
