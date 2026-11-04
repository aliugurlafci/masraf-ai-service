import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createLogger, getLogContext, runWithLogContext } from '@orc/logger';

type LogRecord = Record<string, unknown>;

function capture() {
  let buffer = '';
  const destination = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      buffer += chunk.toString();
      callback();
    },
  });
  const logger = createLogger({
    service: 'worker',
    level: 'info',
    version: '0.0.0',
    env: 'test',
    destination,
  });
  const records = (): LogRecord[] =>
    buffer
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as LogRecord);
  return { logger, records };
}

const TASK = '11111111-1111-1111-1111-111111111111';
const ATTEMPT = '22222222-2222-2222-2222-222222222222';

describe('log context (AsyncLocalStorage)', () => {
  it('is empty and frozen outside any context', () => {
    expect(getLogContext()).toEqual({});
    expect(Object.isFrozen(getLogContext())).toBe(true);
  });

  it('propagates across awaits, timers and nested contexts (merged, inner wins)', async () => {
    const { logger, records } = capture();
    await runWithLogContext({ requestId: 'req-1', correlationId: 'corr-1' }, async () => {
      await delay(1);
      logger.info('outer');
      await runWithLogContext(
        { taskId: TASK, attemptId: ATTEMPT, correlationId: 'corr-2' },
        async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          logger.info('inner');
          expect(getLogContext()).toEqual({
            requestId: 'req-1',
            correlationId: 'corr-2',
            taskId: TASK,
            attemptId: ATTEMPT,
          });
        },
      );
      logger.info('outer again');
    });
    logger.info('none');

    const [outer, inner, outerAgain, none] = records();
    expect(outer).toMatchObject({ requestId: 'req-1', correlationId: 'corr-1', msg: 'outer' });
    expect(outer).not.toHaveProperty('taskId');
    expect(inner).toMatchObject({
      requestId: 'req-1',
      correlationId: 'corr-2',
      taskId: TASK,
      attemptId: ATTEMPT,
    });
    expect(outerAgain).toMatchObject({ correlationId: 'corr-1' });
    expect(outerAgain).not.toHaveProperty('attemptId');
    expect(none).not.toHaveProperty('requestId');
  });

  it('keeps concurrent contexts isolated', async () => {
    const { logger, records } = capture();
    const run = (jobId: string, waitMs: number) =>
      runWithLogContext({ jobId, queue: 'orc-tasks', workerId: 'w-1' }, async () => {
        await delay(waitMs);
        logger.info(`job ${jobId}`);
      });
    await Promise.all([run('job-a', 15), run('job-b', 1)]);
    const byMsg = new Map(records().map((r) => [r.msg, r]));
    expect(byMsg.get('job job-a')).toMatchObject({
      jobId: 'job-a',
      queue: 'orc-tasks',
      workerId: 'w-1',
    });
    expect(byMsg.get('job job-b')).toMatchObject({ jobId: 'job-b' });
  });

  it('ignores undefined values and unknown keys, and explicit fields override the context', () => {
    const { logger, records } = capture();
    runWithLogContext({ requestId: 'req-1', userId: 'u-1' }, () => {
      runWithLogContext(
        { requestId: undefined, projectId: 'p-1', bogus: 'x' } as Parameters<
          typeof runWithLogContext
        >[0],
        () => {
          expect(getLogContext()).toEqual({ requestId: 'req-1', userId: 'u-1', projectId: 'p-1' });
          logger.info({ userId: 'explicit' }, 'override');
        },
      );
    });
    expect(records()[0]).toMatchObject({
      requestId: 'req-1',
      userId: 'explicit',
      projectId: 'p-1',
    });
    expect(records()[0]).not.toHaveProperty('bogus');
  });

  it('applies to child loggers created outside the context', () => {
    const { logger, records } = capture();
    const child = logger.child({ component: 'claude-runner' });
    runWithLogContext({ taskId: TASK }, () => child.info('from child'));
    expect(records()[0]).toMatchObject({
      component: 'claude-runner',
      taskId: TASK,
      msg: 'from child',
    });
  });

  it('returns the callback result', () => {
    expect(runWithLogContext({ requestId: 'r' }, () => 42)).toBe(42);
  });
});
