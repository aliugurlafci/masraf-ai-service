// Worker-side DB write retry (§13.1): transient errors retried within the window, others rethrown at once.
import { describe, expect, it } from 'vitest';
import { ConflictError, OrcError, systemClock } from '@orc/shared';
import { DbWriteAbandonedError, withDbRetry } from '@orc/orchestrator';

describe('withDbRetry', () => {
  it('retries a transient failure and returns the eventual result', async () => {
    let calls = 0;
    const v = await withDbRetry(
      'x',
      () => {
        calls += 1;
        return calls < 2 ? Promise.reject(new OrcError('db_unavailable')) : Promise.resolve(42);
      },
      { windowMs: 5000, clock: systemClock },
    );
    expect(v).toBe(42);
    expect(calls).toBe(2);
  });

  it('does not retry conflicts (superseded detection)', async () => {
    let calls = 0;
    await expect(
      withDbRetry('x', () => {
        calls += 1;
        return Promise.reject(new ConflictError('cas'));
      }, { windowMs: 5000, clock: systemClock }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(calls).toBe(1);
  });

  it('gives up with DbWriteAbandonedError when the window is exhausted', async () => {
    await expect(
      withDbRetry('x', () => Promise.reject(new OrcError('db_unavailable')), { windowMs: 500, clock: systemClock }),
    ).rejects.toBeInstanceOf(DbWriteAbandonedError);
  });
});
