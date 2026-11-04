// run-attempt processor contract (§6.4): payload validation => UnrecoverableError('invalid:...'), business outcomes
// => UnrecoverableError('business:...'), transient errors rethrown as plain errors (BullMQ retry), others returned.
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { OrcError } from '@orc/shared';
import type { RunAttemptJobData } from '@orc/shared';
import { createActiveAttemptRegistry, createProjectJobProcessor, createRunAttemptProcessor } from '@orc/orchestrator';
import type { AttemptOutcome, AttemptPipeline, OrchestratorDeps } from '@orc/orchestrator';
import { orchestratorTestConfig, silentLogger } from '../../helpers/worker/fakes';

const DATA: RunAttemptJobData = {
  v: 1,
  taskId: '0b6f6f1e-0000-4000-8000-000000000001',
  attemptId: '0b6f6f1e-0000-4000-8000-000000000002',
  attemptNumber: 1,
  correlationId: 'corr-1',
};

function job(data: unknown, name = 'run-attempt'): Job<unknown> {
  return { id: DATA.attemptId, name, data, attemptsMade: 0, opts: { attempts: 3 } } as unknown as Job<unknown>;
}

function processor(run: AttemptPipeline['run']) {
  const deps = { config: orchestratorTestConfig(), logger: silentLogger() } as unknown as OrchestratorDeps;
  return createRunAttemptProcessor({ ...deps, active: createActiveAttemptRegistry(), pipeline: { run } });
}

describe('createRunAttemptProcessor', () => {
  it('rejects invalid payloads as unrecoverable invalid:', async () => {
    const p = processor(() => Promise.reject(new Error('must not run')));
    await expect(p(job({ ...DATA, v: 2 }))).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(p(job({ ...DATA, extra: 1 }))).rejects.toThrow(/^invalid:/);
    await expect(p(job(DATA, 'other-name'))).rejects.toThrow(/^invalid:/);
  });

  it('turns failed / timed_out / blocked into business: failures', async () => {
    for (const status of ['failed', 'timed_out', 'blocked'] as const) {
      const p = processor(() => Promise.resolve<AttemptOutcome>({ status, reason: 'timeout' }));
      const err = await p(job(DATA)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnrecoverableError);
      expect((err as Error).message).toBe('business:timeout');
    }
  });

  it('completes the job for completed / cancelled / interrupted / noop', async () => {
    for (const status of ['completed', 'cancelled', 'interrupted', 'noop'] as const) {
      const p = processor(() => Promise.resolve<AttemptOutcome>({ status, reason: null }));
      await expect(p(job(DATA))).resolves.toEqual({ status, reason: null });
    }
  });

  it('rethrows transient claim errors as retryable errors', async () => {
    const p = processor(() => Promise.reject(new OrcError('db_unavailable', 'db down')));
    const err = await p(job(DATA)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrcError);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });
});

describe('createProjectJobProcessor (index job)', () => {
  const PROJECT = '0b6f6f1e-0000-4000-8000-000000000010';
  const OP = '0b6f6f1e-0000-4000-8000-000000000011';
  const INDEX = { v: 1, kind: 'index', projectId: PROJECT, operationId: OP, mode: 'full', requestedByUserId: null, correlationId: null };

  function world(opStatus: 'running' | 'succeeded') {
    const calls: string[] = [];
    const db = {
      repos: {
        mcpOperations: {
          markRunning: () => Promise.resolve(false),
          findById: () => Promise.resolve({ id: OP, status: opStatus }),
        },
        projects: {
          findById: () => {
            calls.push('project');
            return Promise.reject(new OrcError('db_unavailable', 'stop here'));
          },
        },
      },
    };
    const deps = { db, config: orchestratorTestConfig(), logger: silentLogger() } as unknown as OrchestratorDeps;
    return { p: createProjectJobProcessor(deps), calls };
  }
  const indexJob = (attemptsMade: number): Job<unknown> =>
    ({ id: `index-${OP}`, name: 'index-project', data: INDEX, attemptsMade, opts: { attempts: 2 } }) as unknown as Job<unknown>;

  it('a BullMQ retry adopts the operation its failed previous try left running', async () => {
    const w = world('running');
    await expect(w.p(indexJob(1))).rejects.toThrow('stop here');
    expect(w.calls).toEqual(['project']);
  });

  it('a first delivery or a finished operation is not run again', async () => {
    const first = world('running');
    await expect(first.p(indexJob(0))).resolves.toBeUndefined();
    const done = world('succeeded');
    await expect(done.p(indexJob(1))).resolves.toBeUndefined();
    expect([...first.calls, ...done.calls]).toEqual([]);
  });
});
