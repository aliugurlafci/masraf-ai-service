// Redis mirror lock and workspace lock (contract §2.6, §7 keys `<P>:lock:mirror:*`, `<P>:lock:workspace:*`).
import { randomBytes } from 'node:crypto';
import { OrcError, type Uuid } from '@orc/shared';
import { assertGuid, invalid } from './naming';
import type { MirrorLock, RedisLike, WorkspaceLease, WorkspaceLock } from './types';

/** Compare-and-PEXPIRE: 1 when the key still holds our token. */
export const LOCK_RENEW_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
/** Compare-and-DEL. */
export const LOCK_RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

const MIN_TTL_MS = 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const POLL_START_MS = 50;
const POLL_MAX_MS = 1000;
const TOKEN_PATTERN = /^[\x21-\x7e]{1,256}$/;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function assertPrefix(prefix: unknown): asserts prefix is string {
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9:_-]{1,64}$/.test(prefix)) {
    throw invalid('prefix', 'Redis key prefix must be 1..64 chars [A-Za-z0-9:_-]');
  }
}

function assertTtl(ttlMs: unknown, name: string): asserts ttlMs is number {
  if (typeof ttlMs !== 'number' || !Number.isInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
    throw invalid(name, `${name} must be an integer ${MIN_TTL_MS}..${MAX_TTL_MS}`);
  }
}

function assertWait(waitMs: unknown): asserts waitMs is number {
  if (typeof waitMs !== 'number' || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_TTL_MS) {
    throw invalid('waitMs', 'waitMs must be a non-negative integer');
  }
}

/**
 * `SET <P>:lock:mirror:<projectId> <random token> NX PX ttl`; polls until `waitMs`, then fails with
 * OrcError('service_unavailable', details.reason 'mirror_lock_timeout'). The holder renews every
 * ttl/3 (compare-and-PEXPIRE) and releases with compare-and-DEL.
 */
export function createRedisMirrorLock(
  redis: RedisLike,
  opts: { prefix: string; ttlMs: number; waitMs: number },
): MirrorLock {
  assertPrefix(opts.prefix);
  assertTtl(opts.ttlMs, 'ttlMs');
  assertWait(opts.waitMs);
  return {
    async withLock<T>(
      projectId: Uuid,
      fn: () => Promise<T>,
      o?: { ttlMs?: number; waitMs?: number },
    ): Promise<T> {
      assertGuid(projectId, 'projectId');
      const ttlMs = o?.ttlMs ?? opts.ttlMs;
      const waitMs = o?.waitMs ?? opts.waitMs;
      assertTtl(ttlMs, 'ttlMs');
      assertWait(waitMs);
      const key = `${opts.prefix}:lock:mirror:${projectId}`;
      const token = randomBytes(16).toString('hex');
      const deadline = Date.now() + waitMs;
      let delay = POLL_START_MS;
      for (;;) {
        const r = await redis.set(key, token, 'PX', ttlMs, 'NX');
        if (r === 'OK') break;
        const left = deadline - Date.now();
        if (left <= 0) {
          throw new OrcError('service_unavailable', 'Mirror lock is held by another worker', {
            details: { reason: 'mirror_lock_timeout', projectId, waitMs },
          });
        }
        await sleep(Math.min(delay + Math.floor(Math.random() * delay), left));
        delay = Math.min(delay * 2, POLL_MAX_MS);
      }
      const renewEvery = Math.max(Math.floor(ttlMs / 3), 250);
      const timer = setInterval(() => {
        redis.eval(LOCK_RENEW_SCRIPT, 1, key, token, ttlMs).catch(() => undefined);
      }, renewEvery);
      timer.unref();
      try {
        return await fn();
      } finally {
        clearInterval(timer);
        await redis.eval(LOCK_RELEASE_SCRIPT, 1, key, token).catch(() => undefined);
      }
    },
  };
}

/**
 * F7: `SET <P>:lock:workspace:<workspaceId> <token> NX PX ttl`; an owner re-acquiring its own
 * still-held lock succeeds (compare-and-PEXPIRE). renew/release = Lua compare-and-(PEXPIRE|DEL).
 */
export function createRedisWorkspaceLock(redis: RedisLike, opts: { prefix: string }): WorkspaceLock {
  assertPrefix(opts.prefix);
  return {
    async tryAcquire(workspaceId, ownerToken, ttlMs): Promise<WorkspaceLease | null> {
      assertGuid(workspaceId, 'workspaceId');
      if (typeof ownerToken !== 'string' || !TOKEN_PATTERN.test(ownerToken)) {
        throw invalid('ownerToken', 'ownerToken must be 1..256 printable ASCII characters');
      }
      assertTtl(ttlMs, 'ttlMs');
      const key = `${opts.prefix}:lock:workspace:${workspaceId}`;
      const r = await redis.set(key, ownerToken, 'PX', ttlMs, 'NX');
      if (r !== 'OK') {
        const own = await redis.eval(LOCK_RENEW_SCRIPT, 1, key, ownerToken, ttlMs);
        if (Number(own) !== 1) return null;
      }
      let released = false;
      return {
        async renew(): Promise<boolean> {
          if (released) return false;
          const res = await redis.eval(LOCK_RENEW_SCRIPT, 1, key, ownerToken, ttlMs);
          return Number(res) === 1;
        },
        async release(): Promise<void> {
          if (released) return;
          released = true;
          await redis.eval(LOCK_RELEASE_SCRIPT, 1, key, ownerToken);
        },
      };
    },
  };
}
