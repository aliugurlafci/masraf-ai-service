// Graceful shutdown sequencing (§14.5) with fakes: step order, failure tolerance and the hard deadline.
import { describe, expect, it } from 'vitest';
import { FORCED_STEP_MAX_MS, gracefulShutdown } from '../../../apps/worker/src/shutdown';
import type { ShutdownSteps } from '../../../apps/worker/src/shutdown';
import { silentLogger } from '../../helpers/worker/fakes';

function steps(log: string[], o: { slowClose?: boolean; failDrain?: boolean } = {}): ShutdownSteps {
  return {
    drain: () => {
      log.push('drain');
      return o.failDrain ? Promise.reject(new Error('db down')) : Promise.resolve();
    },
    pauseWorkers: () => {
      log.push('pause');
      return Promise.resolve();
    },
    interruptActive: () => {
      log.push('interrupt');
      return 2;
    },
    closeWorkers: () => {
      log.push('close-workers');
      return o.slowClose ? new Promise<void>(() => undefined) : Promise.resolve();
    },
    finalHeartbeat: (n) => {
      log.push(`offline:${n}`);
      return Promise.resolve();
    },
    closeResources: () => {
      log.push('close-resources');
      return Promise.resolve();
    },
    forceKill: () => {
      log.push('force-kill');
      return Promise.resolve();
    },
  };
}

describe('gracefulShutdown', () => {
  it('runs drain -> pause -> interrupt -> close workers -> offline heartbeat -> close resources and exits 0', async () => {
    const log: string[] = [];
    await expect(gracefulShutdown(steps(log), { timeoutMs: 5000, logger: silentLogger() })).resolves.toBe(0);
    expect(log).toEqual(['drain', 'pause', 'interrupt', 'close-workers', 'offline:2', 'close-resources']);
  });

  it('continues after a failing step', async () => {
    const log: string[] = [];
    await expect(gracefulShutdown(steps(log, { failDrain: true }), { timeoutMs: 5000, logger: silentLogger() })).resolves.toBe(0);
    expect(log.at(-1)).toBe('close-resources');
  });

  it('force-kills and exits 1 when the hard deadline passes', async () => {
    const log: string[] = [];
    const started = Date.now();
    await expect(gracefulShutdown(steps(log, { slowClose: true }), { timeoutMs: 200, logger: silentLogger() })).resolves.toBe(1);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(log).toEqual(['drain', 'pause', 'interrupt', 'close-workers', 'force-kill', 'close-resources']);
  });

  it('still exits 1 when a resource close hangs after the hard deadline', async () => {
    const log: string[] = [];
    const s = steps(log, { slowClose: true });
    s.closeResources = () => {
      log.push('close-resources');
      return new Promise<void>(() => undefined);
    };
    const started = Date.now();
    await expect(gracefulShutdown(s, { timeoutMs: 100, logger: silentLogger() })).resolves.toBe(1);
    expect(Date.now() - started).toBeLessThan(FORCED_STEP_MAX_MS + 2000);
    expect(log.slice(-2)).toEqual(['force-kill', 'close-resources']);
  }, 15_000);
});
