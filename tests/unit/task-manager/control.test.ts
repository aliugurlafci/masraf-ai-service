// ControlChannel.publishCancel is bounded like the queue registry (contract §7, F8): a PUBLISH stuck in the ioredis
// offline queue / retry loop rejects with OrcError('redis_unavailable') after opTimeoutMs instead of hanging the
// cancel request; transport failures map to redis_unavailable too.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrcError, toIso } from '@orc/shared';
import { REDIS_OP_TIMEOUT_MS, createControlChannel } from '@orc/task-manager';
import type { RedisFactory } from '@orc/task-manager';
import { silentLogger } from '../../helpers/task-manager/fakes';

function factoryWith(publish: (channel: string, message: string) => Promise<number>): {
  factory: RedisFactory;
  created: string[];
} {
  const created: string[] = [];
  const factory = {
    create(role: string, name: string) {
      created.push(`${role}:${name}`);
      return { publish };
    },
    closeAll: () => Promise.resolve(),
  } as unknown as RedisFactory;
  return { factory, created };
}

const hanging = (): Promise<number> => new Promise<number>(() => undefined);

const message = () => ({
  taskId: randomUUID(),
  attemptId: randomUUID(),
  requestedByUserId: randomUUID(),
  requestedAt: toIso(new Date()),
  correlationId: null,
});

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('ControlChannel.publishCancel bound', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with redis_unavailable after opTimeoutMs when PUBLISH never answers', async () => {
    const { factory, created } = factoryWith(hanging);
    const control = createControlChannel(factory, { prefix: 'orc', logger: silentLogger(), opTimeoutMs: 50 });
    const started = Date.now();
    const err = await rejection(control.publishCancel(message()));
    expect(err).toBeInstanceOf(OrcError);
    expect(err).toMatchObject({ code: 'redis_unavailable' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(created).toEqual(['command:control-publisher']);
  });

  it('defaults the bound to REDIS_OP_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    const { factory } = factoryWith(hanging);
    const control = createControlChannel(factory, { prefix: 'orc', logger: silentLogger() });
    let settled: unknown = 'pending';
    const p = control.publishCancel(message()).then(
      () => 'resolved',
      (e: unknown) => e,
    );
    void p.then((v) => {
      settled = v;
    });
    await vi.advanceTimersByTimeAsync(REDIS_OP_TIMEOUT_MS - 1);
    expect(settled).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBeInstanceOf(OrcError);
    expect(settled).toMatchObject({ code: 'redis_unavailable' });
  });

  it('maps a failed PUBLISH to redis_unavailable and publishes the validated message on success', async () => {
    const failing = createControlChannel(
      factoryWith(() => Promise.reject(new Error('Connection is closed.'))).factory,
      { prefix: 'orc', logger: silentLogger(), opTimeoutMs: 1_000 },
    );
    expect(await rejection(failing.publishCancel(message()))).toMatchObject({ code: 'redis_unavailable' });

    const sent: [string, string][] = [];
    const ok = createControlChannel(
      factoryWith((channel, raw) => {
        sent.push([channel, raw]);
        return Promise.resolve(1);
      }).factory,
      { prefix: 'orc', logger: silentLogger(), opTimeoutMs: 1_000 },
    );
    const m = message();
    await ok.publishCancel(m);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[0]).toBe('orc:control');
    expect(JSON.parse(sent[0]?.[1] ?? '')).toEqual({ v: 1, type: 'cancel', ...m });
  });
});
