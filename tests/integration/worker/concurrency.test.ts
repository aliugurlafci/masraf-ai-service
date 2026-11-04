// Two worker runtimes (WORKER_CONCURRENCY 1 each) process two tasks at the same time (contract §6.2, §14.1).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDb } from '../../helpers/database/db';
import { createWorkerWorld, writeDirective } from '../../helpers/worker/world';
import type { WorkerWorld } from '../../helpers/worker/world';

let world: WorkerWorld;

beforeAll(async () => {
  world = await createWorkerWorld({ env: { WORKER_CONCURRENCY: '1', ATTEMPT_STALE_MS: '30000' } });
});

afterAll(async () => {
  await world?.dispose();
  await resetDb();
});

describe('two workers', () => {
  it('run two tasks concurrently, one on each worker', async () => {
    await world.startWorker({ workerId: 'it-conc-1' });
    await world.startWorker({ workerId: 'it-conc-2' });
    const slow = ['@@fake delay-ms 300', ...Array.from({ length: 20 }, (_, i) => `@@fake text step ${i}`)];
    const p1 = await world.project(world.repo());
    const p2 = await world.project(world.repo());
    const t1 = await world.createTask(p1, { directives: [writeDirective('src/one.js', 'export const one = 1;\n'), ...slow] });
    const t2 = await world.createTask(p2, { directives: [writeDirective('src/two.js', 'export const two = 2;\n'), ...slow] });
    const [s1, s2] = await Promise.all([world.waitSettled(t1.task.id), world.waitSettled(t2.task.id)]);
    expect(s1.status).toBe('completed');
    expect(s2.status).toBe('completed');
    const a1 = await world.db.repos.attempts.findById(t1.attempt.id);
    const a2 = await world.db.repos.attempts.findById(t2.attempt.id);
    expect(new Set([a1?.workerId, a2?.workerId])).toEqual(new Set(['it-conc-1', 'it-conc-2']));
    const start1 = Date.parse(a1?.processStartedAt ?? '');
    const start2 = Date.parse(a2?.processStartedAt ?? '');
    const end1 = Date.parse(a1?.processEndedAt ?? a1?.endedAt ?? '');
    const end2 = Date.parse(a2?.processEndedAt ?? a2?.endedAt ?? '');
    // the two Claude processes overlapped in time
    expect(Math.max(start1, start2)).toBeLessThan(Math.min(end1, end2));
    const files1 = await world.db.repos.changedFiles.listByAttempt({ attemptId: t1.attempt.id, includePatch: false, limit: 10 });
    const files2 = await world.db.repos.changedFiles.listByAttempt({ attemptId: t2.attempt.id, includePatch: false, limit: 10 });
    expect(files1.map((f) => f.path)).toEqual(['src/one.js']);
    expect(files2.map((f) => f.path)).toEqual(['src/two.js']);
  });
});
