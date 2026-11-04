// E2E concurrency (contract §6.2, §14.1, §18.5 F19): two worker runtimes x WORKER_CONCURRENCY 2 and six tasks
// submitted over HTTP by two operators. Every attempt is claimed exactly once, runs in its own worktree on its own
// branch, both workers execute work at the same time, no worker exceeds its concurrency and all tasks complete.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ChangedFileSchema, TaskAttemptSchema, TaskEventSchema, pageOf } from '@orc/shared';
import type { TaskAttempt } from '@orc/shared';
import { resetDb } from '../helpers/database/db';
import { createE2eSystem, writeDirective } from '../helpers/e2e/system';
import type { E2eSession, E2eSystem } from '../helpers/e2e/system';

const TASKS = 6;
const SLOW = ['@@fake delay-ms 200', ...Array.from({ length: 12 }, (_, i) => `@@fake text step ${i}`)];

let sys: E2eSystem;
let admin: E2eSession;
let opA: E2eSession;
let opB: E2eSession;

beforeAll(async () => {
  sys = await createE2eSystem({ workerEnv: { WORKER_CONCURRENCY: '2', ATTEMPT_STALE_MS: '30000' } });
  [admin, opA, opB] = await Promise.all([sys.user('admin'), sys.user('operator'), sys.user('operator')]);
});

afterAll(async () => {
  await sys?.dispose();
  await resetDb();
});

function maxOverlap(intervals: readonly [number, number][]): number {
  const points = intervals.flatMap(([s, e]) => [[s, 1] as const, [e, -1] as const]);
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of points) {
    cur += d;
    max = Math.max(max, cur);
  }
  return max;
}

const intervalOf = (a: TaskAttempt): [number, number] => [Date.parse(a.startedAt ?? ''), Date.parse(a.endedAt ?? '')];

describe('e2e concurrency', () => {
  it('two worker runtimes run six tasks concurrently: unique claims, distinct worktrees and branches, all completed', async () => {
    const w1 = await sys.startWorker({ workerId: 'e2e-conc-1' });
    const w2 = await sys.startWorker({ workerId: 'e2e-conc-2' });
    const { project } = await sys.registerProject(admin);
    const owners = Array.from({ length: TASKS }, (_, i) => (i % 2 === 0 ? opA : opB));
    const tasks = await Promise.all(
      owners.map((owner, i) => sys.createTask(owner, project.id, [writeDirective(`src/t${i}.js`, `export const t${i} = ${i};\n`), ...SLOW])),
    );
    const settled = await Promise.all(tasks.map((t, i) => sys.waitSettled(owners[i] ?? opA, t.id, 240_000)));
    expect(settled.map((d) => d.task.status)).toEqual(Array.from({ length: TASKS }, () => 'completed'));

    const attempts: TaskAttempt[] = [];
    for (const [i, t] of tasks.entries()) {
      const owner = owners[i] ?? opA;
      const list = z.array(TaskAttemptSchema).parse((await sys.http('GET', `/tasks/${t.id}/attempts`, owner)).body);
      expect(list).toHaveLength(1);
      const a = list[0];
      if (!a) throw new Error('attempt missing');
      attempts.push(a);
      // claimed exactly once
      const events = pageOf(TaskEventSchema).parse((await sys.http('GET', `/tasks/${t.id}/events?limit=100`, owner)).body);
      expect(events.items.filter((e) => e.type === 'attempt_claimed')).toHaveLength(1);
      const files = z.array(ChangedFileSchema).parse((await sys.http('GET', `/tasks/${t.id}/changed-files`, owner)).body);
      expect(files.map((f) => f.path)).toEqual([`src/t${i}.js`]);
    }
    expect(new Set(attempts.map((a) => a.workspaceId)).size).toBe(TASKS);
    expect(new Set(attempts.map((a) => a.branchName)).size).toBe(TASKS);
    expect(attempts.every((a) => a.status === 'succeeded' && a.branchName !== null)).toBe(true);

    const byWorker = new Map<string, [number, number][]>();
    for (const a of attempts) {
      const list = byWorker.get(a.workerId ?? '') ?? [];
      list.push(intervalOf(a));
      byWorker.set(a.workerId ?? '', list);
    }
    expect([...byWorker.keys()].sort()).toEqual(['e2e-conc-1', 'e2e-conc-2']);
    for (const intervals of byWorker.values()) expect(maxOverlap(intervals)).toBeLessThanOrEqual(2);
    // the two runtimes executed work at the same time
    expect(maxOverlap(attempts.map(intervalOf))).toBeGreaterThanOrEqual(2);
    const one = byWorker.get('e2e-conc-1') ?? [];
    const two = byWorker.get('e2e-conc-2') ?? [];
    expect(one.some(([s1, e1]) => two.some(([s2, e2]) => Math.max(s1, s2) < Math.min(e1, e2)))).toBe(true);

    // operators only see their own tasks
    const listed = pageOf(z.object({ id: z.string() })).parse((await sys.http('GET', '/tasks?limit=100', opB)).body);
    expect(listed.items.map((t) => t.id).sort()).toEqual(tasks.filter((_, i) => owners[i] === opB).map((t) => t.id).sort());

    await sys.assertNoOrphans(attempts.map((a) => a.id), [w1, w2]);
  });
});
