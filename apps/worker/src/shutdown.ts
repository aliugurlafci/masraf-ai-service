// Graceful shutdown sequence (contract §14.5) as an ordered list of steps with a hard deadline.
import type { Logger } from '@orc/logger';
import { serializeError } from '@orc/logger';

export interface ShutdownSteps {
  /** 1. readiness false, WorkerNodes `draining`, heartbeat quota checks off. */
  drain(): Promise<void>;
  /** 2. `worker.pause(true)` on every BullMQ worker (no new jobs). */
  pauseWorkers(): Promise<void>;
  /** 3. `active.abortAll('worker_shutdown')`; returns the number of interrupted attempts. */
  interruptActive(): number;
  /** 4a. `await worker.close()` (in-flight pipelines finish their interruption/requeue). */
  closeWorkers(): Promise<void>;
  /** 4b. unsubscribe control, stop heartbeat, final `offline` heartbeat, audit `worker.stopped`. */
  finalHeartbeat(interrupted: number): Promise<void>;
  /** 5. close QueueRegistry, Redis, launcher, DB, health server. */
  closeResources(): Promise<void>;
  /** 6. hard deadline: force-kill registered trees and leases. */
  forceKill(): Promise<void>;
}

/** Upper bound of each forced step after the hard deadline. */
export const FORCED_STEP_MAX_MS = 5000;

/** Resolves when `p` settles or after `ms`, whichever comes first; never rejects. */
function bounded(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

type StepName ='drain' | 'pauseWorkers' | 'closeWorkers' | 'finalHeartbeat' | 'closeResources';

/** Runs §14.5; resolves 0 on a clean stop, 1 when `timeoutMs` elapsed first (after the forced kill). */
export async function gracefulShutdown(steps: ShutdownSteps, o: { timeoutMs: number; logger: Logger }): Promise<number> {
  const run = async (name: StepName, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      o.logger.warn({ err: serializeError(err), step: name }, 'shutdown step failed');
    }
  };
  const sequence = async (): Promise<number> => {
    await run('drain', () => steps.drain());
    await run('pauseWorkers', () => steps.pauseWorkers());
    let interrupted = 0;
    try {
      interrupted = steps.interruptActive();
    } catch (err) {
      o.logger.warn({ err: serializeError(err) }, 'shutdown interrupt failed');
    }
    o.logger.info({ interrupted }, 'graceful shutdown: active attempts interrupted');
    await run('closeWorkers', () => steps.closeWorkers());
    await run('finalHeartbeat', () => steps.finalHeartbeat(interrupted));
    await run('closeResources', () => steps.closeResources());
    return 0;
  };
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<number>((resolve) => {
    timer = setTimeout(() => {
      o.logger.error({ timeoutMs: o.timeoutMs }, 'shutdown deadline exceeded: forcing');
      void (async () => {
        // Past the deadline every step is bounded: a hung close (DB/Redis/launcher) must not keep the process alive.
        await bounded(steps.forceKill(), FORCED_STEP_MAX_MS);
        await bounded(steps.closeResources(), FORCED_STEP_MAX_MS);
        resolve(1);
      })();
    }, o.timeoutMs);
  });
  try {
    return await Promise.race([sequence(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
