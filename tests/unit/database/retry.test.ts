import { describe, expect, it, vi } from 'vitest';
import { OrcError } from '@orc/shared';
import { isDeadlockError } from '@orc/database';
import {
  DEFAULT_TX_MAX_RETRIES,
  RETRY_CAP_MS,
  retryDelayMs,
  withRetry,
} from '../../../packages/database/src/retry';

const deadlock = (): OrcError => new OrcError('db_deadlock', 'deadlock');

describe('retryDelayMs', () => {
  it('is 50ms * 2^n plus 0..50ms jitter', () => {
    expect(retryDelayMs(0, () => 0)).toBe(50);
    expect(retryDelayMs(1, () => 0)).toBe(100);
    expect(retryDelayMs(2, () => 0)).toBe(200);
    expect(retryDelayMs(0, () => 0.999999)).toBe(100);
    for (let n = 0; n < 5; n += 1) {
      const d = retryDelayMs(n);
      expect(d).toBeGreaterThanOrEqual(50 * 2 ** n);
      expect(d).toBeLessThanOrEqual(50 * 2 ** n + 50);
    }
  });

  it('is capped at 2s', () => {
    expect(retryDelayMs(10, () => 0.5)).toBe(RETRY_CAP_MS);
    expect(retryDelayMs(30, () => 0)).toBe(2000);
  });

  it('clamps out-of-range random values', () => {
    expect(retryDelayMs(0, () => -1)).toBe(50);
    expect(retryDelayMs(0, () => 5)).toBe(100);
  });
});

describe('withRetry', () => {
  it('defaults to 3 retries', () => {
    expect(DEFAULT_TX_MAX_RETRIES).toBe(3);
  });

  it('retries deadlocks with backoff and returns the eventual result', async () => {
    const sleep = vi.fn((_ms: number) => Promise.resolve());
    const onRetry = vi.fn();
    let calls = 0;
    const result = await withRetry(
      (attempt) => {
        calls += 1;
        if (attempt < 2) return Promise.reject(deadlock());
        return Promise.resolve('ok');
      },
      { maxRetries: 3, isRetryable: isDeadlockError, sleep, random: () => 0, onRetry },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([50, 100]);
    expect(onRetry.mock.calls.map(([info]) => (info as { retry: number }).retry)).toEqual([1, 2]);
  });

  it('gives up after maxRetries and rethrows the last error', async () => {
    const sleep = vi.fn((_ms: number) => Promise.resolve());
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          return Promise.reject(deadlock());
        },
        { maxRetries: 3, isRetryable: isDeadlockError, sleep },
      ),
    ).rejects.toMatchObject({ code: 'db_deadlock' });
    expect(calls).toBe(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('never retries non-retryable errors', async () => {
    const sleep = vi.fn((_ms: number) => Promise.resolve());
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          return Promise.reject(new OrcError('unique_violation', 'dup'));
        },
        { maxRetries: 3, isRetryable: isDeadlockError, sleep },
      ),
    ).rejects.toMatchObject({ code: 'unique_violation' });
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('treats maxRetries 0 as a single attempt', async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          return Promise.reject(deadlock());
        },
        { maxRetries: 0, isRetryable: isDeadlockError, sleep: () => Promise.resolve() },
      ),
    ).rejects.toBeInstanceOf(OrcError);
    expect(calls).toBe(1);
  });
});
