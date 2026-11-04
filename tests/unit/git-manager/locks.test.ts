import { afterEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '@orc/shared';
import { createRedisMirrorLock, createRedisWorkspaceLock } from '@orc/git-manager';
import { createMemoryRedis } from '../../helpers/git/memory-redis';

const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WSID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

afterEach(() => {
  vi.useRealTimers();
});

describe('createRedisMirrorLock', () => {
  it('holds <P>:lock:mirror:<projectId> with a random token for the duration of fn', async () => {
    const redis = createMemoryRedis();
    const lock = createRedisMirrorLock(redis, { prefix: 'orc', ttlMs: 120_000, waitMs: 1000 });
    const seen = await lock.withLock(PID, () => {
      const e = redis.store.get(`orc:lock:mirror:${PID}`);
      return Promise.resolve(e?.value);
    });
    expect(seen).toMatch(/^[0-9a-f]{32}$/);
    expect(redis.store.has(`orc:lock:mirror:${PID}`)).toBe(false);
    expect(redis.calls[0]).toEqual({
      cmd: 'set',
      args: [`orc:lock:mirror:${PID}`, seen, 'PX', 120_000, 'NX'],
    });
  });

  it('serialises holders and releases even when fn throws', async () => {
    const redis = createMemoryRedis();
    const lock = createRedisMirrorLock(redis, { prefix: 'orc', ttlMs: 5000, waitMs: 5000 });
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = lock.withLock(PID, async () => {
      order.push('first:start');
      await gate;
      order.push('first:end');
      throw new Error('boom');
    });
    await new Promise((r) => setTimeout(r, 20));
    const second = lock.withLock(PID, () => {
      order.push('second');
      return Promise.resolve(2);
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(order).toEqual(['first:start']);
    release();
    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('times out with service_unavailable(mirror_lock_timeout) when the lock stays held', async () => {
    const redis = createMemoryRedis();
    await redis.set(`orc:lock:mirror:${PID}`, 'other', 'PX', 60_000, 'NX');
    const lock = createRedisMirrorLock(redis, { prefix: 'orc', ttlMs: 5000, waitMs: 150 });
    await expect(lock.withLock(PID, () => Promise.resolve(1))).rejects.toMatchObject({
      code: 'service_unavailable',
      details: { reason: 'mirror_lock_timeout' },
    });
    expect(redis.store.get(`orc:lock:mirror:${PID}`)?.value).toBe('other');
  });

  it('renews the TTL every ttl/3 while fn runs', async () => {
    const redis = createMemoryRedis();
    const lock = createRedisMirrorLock(redis, { prefix: 'orc', ttlMs: 1500, waitMs: 0 });
    await lock.withLock(PID, () => new Promise((r) => setTimeout(r, 1200)));
    const renewals = redis.calls.filter(
      (c) => c.cmd === 'eval' && String(c.args[0]).includes("'pexpire'"),
    );
    expect(renewals.length).toBeGreaterThanOrEqual(2);
  });

  it('validates its inputs', async () => {
    const redis = createMemoryRedis();
    expect(() => createRedisMirrorLock(redis, { prefix: 'bad prefix', ttlMs: 5000, waitMs: 0 })).toThrow(
      ValidationError,
    );
    const lock = createRedisMirrorLock(redis, { prefix: 'orc', ttlMs: 5000, waitMs: 0 });
    await expect(lock.withLock('../x', () => Promise.resolve(1))).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('createRedisWorkspaceLock', () => {
  it('SET NX PX; second owner gets null; same owner re-acquires; renew/release compare tokens', async () => {
    const redis = createMemoryRedis();
    const locks = createRedisWorkspaceLock(redis, { prefix: 'orc' });
    const key = `orc:lock:workspace:${WSID}`;
    const lease = await locks.tryAcquire(WSID, 'worker-1:att-1', 60_000);
    expect(lease).not.toBeNull();
    expect(redis.calls[0]).toEqual({ cmd: 'set', args: [key, 'worker-1:att-1', 'PX', 60_000, 'NX'] });
    await expect(locks.tryAcquire(WSID, 'worker-2:att-9', 60_000)).resolves.toBeNull();
    const again = await locks.tryAcquire(WSID, 'worker-1:att-1', 60_000);
    expect(again).not.toBeNull();
    await expect(lease?.renew()).resolves.toBe(true);
    // Lock stolen (expired and re-taken by another owner) => renew reports false.
    redis.store.set(key, { value: 'worker-2:att-9', expiresAt: Date.now() + 60_000 });
    await expect(lease?.renew()).resolves.toBe(false);
    await lease?.release();
    expect(redis.store.get(key)?.value).toBe('worker-2:att-9');
    redis.store.delete(key);
    const third = await locks.tryAcquire(WSID, 'worker-3:att-1', 60_000);
    await third?.release();
    expect(redis.store.has(key)).toBe(false);
    await expect(third?.renew()).resolves.toBe(false);
  });

  it('validates workspace id, token and ttl', async () => {
    const locks = createRedisWorkspaceLock(createMemoryRedis(), { prefix: 'orc' });
    await expect(locks.tryAcquire('nope', 't', 60_000)).rejects.toBeInstanceOf(ValidationError);
    await expect(locks.tryAcquire(WSID, 'has space', 60_000)).rejects.toBeInstanceOf(ValidationError);
    await expect(locks.tryAcquire(WSID, 't', 10)).rejects.toBeInstanceOf(ValidationError);
  });
});
