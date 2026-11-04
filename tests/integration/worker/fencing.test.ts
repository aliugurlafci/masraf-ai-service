// Self-fencing / single writer (contract §13.1, §14.3, F7) against mssql-test + redis-test: one worker runtime loses
// its database while Claude runs. Its processes are stopped within selfFenceAfterMs (+ kill grace), its hb key expires,
// the workspace lock is released, another worker recovers the attempt only after that and completes it with --resume,
// and the fenced worker writes nothing for the old attempt even after its database comes back.
//
// Both runtimes live in this one process (SANDBOX_MODE=local, same uid, same PID namespace). The Linux orphan sweep
// (§10.8: startup + every ORPHAN_SWEEP_INTERVAL_MS) SIGKILLs every same-uid process whose ORC_ATTEMPT_ID is not an
// active attempt of the sweeping worker, i.e. it assumes one local-mode worker per uid/PID namespace (production:
// runner mode, sweep scoped to the worker's own leases; compose: one container per worker). So the rescuer starts
// only once the fenced worker's processes are gone, and neither runtime runs the periodic sweep; otherwise a sweep,
// not the fence, would stop Claude and the still-connected fenced worker would settle `failed(claude_exit_nonzero)`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sql from 'mssql';
import { JOB_NAMES } from '@orc/shared';
import type { Uuid } from '@orc/shared';
import { workerHeartbeatKey } from '@orc/orchestrator';
import { resetDb } from '../../helpers/database/db';
import { aliveProcesses } from '../../helpers/common/process';
import { waitFor } from '../../helpers/common/wait-for';
import { createWorkerWorld, writeDirective } from '../../helpers/worker/world';
import type { WorkerWorld } from '../../helpers/worker/world';
import { startTcpProxy } from '../../helpers/worker/tcp-proxy';
import type { TcpProxy } from '../../helpers/worker/tcp-proxy';

/** HEARTBEAT 1000 => selfFenceAfterMs = 6000 - 2 x 1000 = 4000; both workers share the fencing settings. */
const FENCE_ENV = { HEARTBEAT_INTERVAL_MS: '1000', ATTEMPT_STALE_MS: '6000' };
/** ~30 s of fake-claude output before the result. */
const SLOW = ['@@fake delay-ms 400', ...Array.from({ length: 75 }, (_, i) => `@@fake text step ${i}`)];

let world: WorkerWorld;
let proxy: TcpProxy;

beforeAll(async () => {
  world = await createWorkerWorld({ env: FENCE_ENV });
  const env = world.workerEnv();
  proxy = await startTcpProxy({ host: env['DB_HOST'] ?? '127.0.0.1', port: Number(env['DB_PORT'] ?? '14331') });
});

afterAll(async () => {
  await proxy?.restore().catch(() => undefined);
  await world?.dispose();
  await proxy?.close();
  await resetDb();
});

async function countsByFencedWorker(attemptId: Uuid): Promise<{ events: number; logs: number }> {
  const [row] = await world.sql<{ Events: number; Logs: number }>(
    `SELECT
       (SELECT COUNT(*) FROM orc.TaskEvents WHERE AttemptId = @a AND ActorLabel = 'it-fenced') AS Events,
       (SELECT COUNT(*) FROM orc.TaskLogs WHERE AttemptId = @a) AS Logs`,
    [['a', sql.UniqueIdentifier, attemptId]],
  );
  return { events: row?.Events ?? -1, logs: row?.Logs ?? -1 };
}

describe('self-fencing (F7)', () => {
  it('stops the processes of a worker that lost its database; recovery starts only after hb key expiry and lock release', async () => {
    const fenced = await world.startWorker({
      workerId: 'it-fenced',
      env: { DB_HOST: '127.0.0.1', DB_PORT: String(proxy.port) },
      overrides: { orphanSweep: false },
    });
    const project = await world.project(world.repo());
    const { task, attempt } = await world.createTask(project, {
      directives: [writeDirective('src/fenced.js', 'export const z = 3;\n'), ...SLOW],
    });
    const running = await waitFor(
      async () => {
        const a = await world.db.repos.attempts.findById(attempt.id);
        const s = await world.db.repos.claudeSessions.findByAttempt(attempt.id);
        return a?.pid != null && a.workspaceId !== null && s?.sessionId != null ? { pid: a.pid, workspaceId: a.workspaceId } : null;
      },
      { timeoutMs: 60_000, intervalMs: 200, description: 'claude running on the fenced worker' },
    );
    expect((await world.db.repos.attempts.findById(attempt.id))?.workerId).toBe('it-fenced');

    const cutAt = Date.now();
    await proxy.cut();

    // Processes stopped and the attempt abandoned within selfFenceAfterMs + heartbeat + kill grace (+ margin).
    await waitFor(() => aliveProcesses([running.pid]).length === 0 && fenced.active.size() === 0, {
      timeoutMs: 20_000,
      intervalMs: 200,
      description: 'fenced worker to stop its processes',
    });
    expect(Date.now() - cutAt).toBeLessThan(20_000);

    // The rescuer starts now: it cannot have claimed the original job, and its startup orphan sweep (§14.2 step 5)
    // must find nothing of the fenced attempt left running.
    const rescuer = await world.startWorker({ workerId: 'it-rescuer-f', overrides: { orphanSweep: false } });
    const [swept] = await world.sql<{ Killed: number }>(
      `SELECT COUNT(*) AS Killed FROM orc.TaskEvents WHERE AttemptId = @a AND EventType = 'orphan_killed'`,
      [['a', sql.UniqueIdentifier, attempt.id]],
    );
    expect(swept?.Killed).toBe(0);
    await waitFor(async () => (await world.redis.exists(workerHeartbeatKey(world.prefix, 'it-fenced'))) === 0, {
      timeoutMs: 10_000,
      intervalMs: 200,
      description: 'hb key of the fenced worker to expire',
    });
    expect(await world.redis.exists(`${world.prefix}:lock:workspace:${running.workspaceId}`)).toBe(0);
    // Still owned by the fenced worker in the database: nobody recovered it before the hb key expired.
    expect((await world.db.repos.attempts.findById(attempt.id))?.status).toBe('active');
    const before = await countsByFencedWorker(attempt.id);

    await waitFor(
      async () => {
        await world.queues.maintenance.add(JOB_NAMES.staleAttemptRecovery, { v: 1 });
        const t = await world.db.repos.tasks.findById(task.id);
        return t !== null && t.currentAttemptId !== attempt.id ? t : null;
      },
      { timeoutMs: 40_000, intervalMs: 1500, description: 'stale recovery of the fenced attempt' },
    );
    const old = await world.db.repos.attempts.findById(attempt.id);
    expect(old).toMatchObject({ status: 'interrupted', failureReason: 'worker_lost' });

    // The database comes back: the fenced worker must not write anything more for the old attempt.
    await proxy.restore();
    const settled = await world.waitSettled(task.id, 120_000);
    expect(settled.status).toBe('completed');
    const next = await world.db.repos.attempts.findById(settled.currentAttemptId ?? '');
    expect(next).toMatchObject({ mode: 'resume', trigger: 'infra_recovery', status: 'succeeded', workspaceId: running.workspaceId });
    expect(await countsByFencedWorker(attempt.id)).toEqual(before);
    // the task row settles before the pipeline's finally (lock release, unregister) has run
    await waitFor(() => rescuer.active.size() === 0, { timeoutMs: 10_000, description: 'pipeline unregistered' });
  });
});
