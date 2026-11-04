// ActiveAttemptRegistry (§13.1, §13.9) and the heartbeat (§14.3): superseded detection, cancel poll, lock/lease
// renewal loss, quota abort, self-fencing and the DB-health callback.
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import type { Database } from '@orc/database';
import type { GitManager } from '@orc/git-manager';
import type { Uuid } from '@orc/shared';
import { createActiveAttemptRegistry, createHeartbeat } from '@orc/orchestrator';
import type { ActiveAttempt, ActiveAttemptRegistry, OrchestratorDeps } from '@orc/orchestrator';
import { manualClock, orchestratorTestConfig, silentLogger } from '../../helpers/worker/fakes';

const A1 = '0b6f6f1e-0000-4000-8000-0000000000a1';
const A2 = '0b6f6f1e-0000-4000-8000-0000000000a2';
const T1 = '0b6f6f1e-0000-4000-8000-0000000000b1';
const T2 = '0b6f6f1e-0000-4000-8000-0000000000b2';

function attempt(attemptId: Uuid, taskId: Uuid, o: Partial<ActiveAttempt> = {}): ActiveAttempt {
  return {
    attemptId,
    taskId,
    stage: 'running',
    startedAt: new Date(),
    controller: new AbortController(),
    workspacePath: '/srv/ws/x',
    ...o,
  };
}

describe('createActiveAttemptRegistry', () => {
  it('aborts once per attempt and counts abortAll', () => {
    const r = createActiveAttemptRegistry();
    const a = attempt(A1, T1);
    r.register(a);
    r.register(attempt(A2, T2));
    expect(r.abort(A1, 'cancel')).toBe(true);
    expect(r.abort(A1, 'timeout')).toBe(false);
    expect(a.controller.signal.reason).toBe('cancel');
    expect(r.abortAll('worker_shutdown')).toBe(1);
    expect(r.size()).toBe(2);
    r.unregister(A1);
    expect(r.list().map((x) => x.attemptId)).toEqual([A2]);
  });

  it('supersede marks the attempt and aborts with worker_shutdown semantics', () => {
    const r = createActiveAttemptRegistry();
    const a = attempt(A1, T1);
    r.register(a);
    expect(r.supersededKind(A1)).toBeNull();
    expect(r.supersede(A1, 'fenced')).toBe(true);
    expect(r.supersededKind(A1)).toBe('fenced');
    expect(a.controller.signal.reason).toBe('worker_shutdown');
    expect(r.supersede('0b6f6f1e-0000-4000-8000-0000000000ff', 'superseded')).toBe(false);
  });

  it('markRunnerLost flags the attempt (not superseded) and aborts it; re-registration clears the flag', () => {
    const r = createActiveAttemptRegistry();
    const a = attempt(A1, T1);
    r.register(a);
    expect(r.runnerLost(A1)).toBe(false);
    expect(r.markRunnerLost(A1)).toBe(true);
    expect(r.runnerLost(A1)).toBe(true);
    expect(r.supersededKind(A1)).toBeNull();
    expect(a.controller.signal.reason).toBe('worker_shutdown');
    expect(r.markRunnerLost('0b6f6f1e-0000-4000-8000-0000000000ff')).toBe(false);
    r.unregister(A1);
    expect(r.runnerLost(A1)).toBe(false);
  });
});

interface FakeState {
  owned: Set<Uuid>;
  cancelRequested: Set<Uuid>;
  failDb: boolean;
  upserts: number;
  hbKeys: string[];
  hangDb?: boolean;
}

function heartbeatWorld(active: ActiveAttemptRegistry, state: FakeState) {
  const clock = manualClock();
  const dbHealth: boolean[] = [];
  const fail = (): Promise<never> => Promise.reject(Object.assign(new Error('db down'), { code: 'db_unavailable' }));
  const db = {
    repos: {
      workerNodes: {
        upsertHeartbeat: () => {
          if (state.hangDb === true) return new Promise<never>(() => undefined);
          if (state.failDb) return fail();
          state.upserts += 1;
          return Promise.resolve();
        },
      },
      attempts: {
        heartbeat: (ids: readonly Uuid[]) => (state.failDb ? fail() : Promise.resolve(ids.filter((id) => state.owned.has(id)))),
      },
      tasks: {
        findCancelRequested: (ids: readonly Uuid[]) =>
          Promise.resolve(ids.filter((id) => state.cancelRequested.has(id)).map((id) => ({ id, cancelRequestedAt: new Date() }))),
      },
    },
  } as unknown as Database;
  const redis = {
    set: (key: string) => {
      state.hbKeys.push(key);
      return Promise.resolve('OK');
    },
  } as unknown as Redis;
  const git = { freeBytes: () => Promise.resolve(1_000_000) } as unknown as GitManager;
  const deps = { db, git, logger: silentLogger(), clock, config: orchestratorTestConfig() } as unknown as OrchestratorDeps;
  const hb = createHeartbeat({
    ...deps,
    active,
    redisCommand: redis,
    workerInfo: () => ({ workerId: 'unit-worker', hostname: 'h', pid: 1, status: 'ready', concurrency: 2, activeAttemptIds: [] }),
    onDbHealth: (ok: boolean) => dbHealth.push(ok),
  });
  return { hb, clock, dbHealth };
}

describe('createHeartbeat', () => {
  it('writes WorkerNodes + hb key, supersedes attempts missing from the result and aborts cancel requests', async () => {
    const active = createActiveAttemptRegistry();
    const a1 = attempt(A1, T1);
    const a2 = attempt(A2, T2);
    active.register(a1);
    active.register(a2);
    const state: FakeState = { owned: new Set([A1]), cancelRequested: new Set([T1]), failDb: false, upserts: 0, hbKeys: [] };
    const { hb } = heartbeatWorld(active, state);
    await hb.tick();
    expect(state.upserts).toBe(1);
    expect(state.hbKeys).toEqual(['orcunit:worker:unit-worker:hb']);
    expect(active.supersededKind(A2)).toBe('superseded');
    expect(a2.controller.signal.reason).toBe('worker_shutdown');
    expect(a1.controller.signal.reason).toBe('cancel');
  });

  it('supersedes an attempt whose lock or lease renewal fails and aborts over-quota attempts on the Nth tick', async () => {
    const active = createActiveAttemptRegistry();
    const lost = attempt(A1, T1, { hooks: { renew: () => Promise.resolve(false), measure: () => Promise.resolve(null), quotaBytes: () => 10 } });
    const big = attempt(A2, T2, {
      hooks: { renew: () => Promise.resolve(true), measure: () => Promise.resolve({ bytes: 11, entries: 1, truncated: false }), quotaBytes: () => 10 },
    });
    active.register(lost);
    active.register(big);
    const state: FakeState = { owned: new Set([A1, A2]), cancelRequested: new Set(), failDb: false, upserts: 0, hbKeys: [] };
    const { hb } = heartbeatWorld(active, state);
    await hb.tick();
    expect(active.supersededKind(A1)).toBe('superseded');
    expect(big.controller.signal.aborted).toBe(false);
    await hb.tick(); // quotaCheckEveryNthHeartbeat = 2
    expect(big.controller.signal.reason).toBe('quota');
  });

  it('self-fences after selfFenceAfterMs without a DB heartbeat and reports DB health', async () => {
    const active = createActiveAttemptRegistry();
    const a = attempt(A1, T1);
    active.register(a);
    const state: FakeState = { owned: new Set([A1]), cancelRequested: new Set(), failDb: false, upserts: 0, hbKeys: [] };
    const { hb, clock, dbHealth } = heartbeatWorld(active, state);
    await hb.tick();
    state.failDb = true;
    for (let i = 0; i < 3; i++) {
      clock.advance(400);
      await hb.tick();
    }
    expect(hb.consecutiveDbFailures).toBe(3);
    expect(dbHealth).toEqual([false]);
    expect(state.hbKeys).toHaveLength(1); // no hb key without a DB heartbeat (F7)
    expect(active.supersededKind(A1)).toBe('fenced');
    state.failDb = false;
    await hb.tick();
    expect(dbHealth).toEqual([false, true]);
  });

  it('self-fences even while a previous tick is blocked on a hung database call', async () => {
    const active = createActiveAttemptRegistry();
    const a = attempt(A1, T1);
    active.register(a);
    const state: FakeState = { owned: new Set([A1]), cancelRequested: new Set(), failDb: false, upserts: 0, hbKeys: [] };
    const { hb, clock } = heartbeatWorld(active, state);
    await hb.tick();
    state.hangDb = true; // every upsertHeartbeat from now on never settles
    void hb.tick();
    clock.advance(1500); // > selfFenceAfterMs (1000) of the unit config
    expect(active.supersededKind(A1)).toBeNull();
    void hb.tick(); // the next interval: the hung tick is still running, fencing is evaluated anyway
    expect(active.supersededKind(A1)).toBe('fenced');
    expect(a.controller.signal.aborted).toBe(true);
  });
});
