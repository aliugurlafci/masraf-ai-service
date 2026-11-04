// Redis client factory (contract §2.9, §6.1, §7). One ioredis connection per (role, name); every connection is
// tracked so closeAll() can shut the process down cleanly. Connection errors are logged, never thrown as events.
import { Redis } from 'ioredis';
import type { RedisOptions } from 'ioredis';
import { OrcError } from '@orc/shared';
import type { Logger } from '@orc/logger';

export interface RedisConfig {
  host: string;
  port: number;
  password: string | null;
  db: number;
  prefix: string;
}

export type RedisRole = 'command' | 'queue' | 'worker' | 'subscriber' | 'blocking';

export interface RedisFactory {
  create(role: RedisRole, name: string): Redis;
  closeAll(): Promise<void>;
}

/** Roles whose commands may legitimately wait forever (BullMQ, XREAD BLOCK, SUBSCRIBE). */
const UNBOUNDED_ROLES: ReadonlySet<RedisRole> = new Set([
  'queue',
  'worker',
  'subscriber',
  'blocking',
]);

/** Command connections fail fast so callers can degrade (F8) instead of hanging on an unavailable Redis. */
const COMMAND_MAX_RETRIES_PER_REQUEST = 2;
const PREFIX_REGEX = /^[a-z][a-z0-9_-]{1,31}$/;
const QUIT_TIMEOUT_MS = 2_000;

export function redisOptionsFor(cfg: RedisConfig, role: RedisRole, name: string): RedisOptions {
  return {
    host: cfg.host,
    port: cfg.port,
    db: cfg.db,
    ...(cfg.password !== null && cfg.password !== '' ? { password: cfg.password } : {}),
    connectionName: `orc:${name}`,
    enableReadyCheck: true,
    lazyConnect: false,
    maxRetriesPerRequest: UNBOUNDED_ROLES.has(role) ? null : COMMAND_MAX_RETRIES_PER_REQUEST,
  };
}

/** Closes one connection: QUIT (bounded), then a hard disconnect. Never rejects. */
export async function closeRedis(conn: Redis): Promise<void> {
  const ended = (): boolean => conn.status === 'end';
  if (ended()) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      conn.quit().then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, QUIT_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // fall through to disconnect
  } finally {
    if (timer) clearTimeout(timer);
    if (!ended()) conn.disconnect(false);
  }
}

export function createRedisFactory(cfg: RedisConfig, deps: { logger: Logger }): RedisFactory {
  if (!PREFIX_REGEX.test(cfg.prefix)) {
    throw new OrcError('config_invalid', 'REDIS_PREFIX must match /^[a-z][a-z0-9_-]{1,31}$/');
  }
  const open = new Set<Redis>();
  let closed = false;
  return {
    create(role, name) {
      if (closed) throw new OrcError('redis_unavailable', 'Redis factory is closed');
      const conn = new Redis(redisOptionsFor(cfg, role, name));
      open.add(conn);
      let lastLogged = 0;
      conn.on('error', (err: unknown) => {
        const now = Date.now();
        if (now - lastLogged < 10_000) return;
        lastLogged = now;
        deps.logger.warn({ err, redisRole: role, redisConnection: name }, 'redis connection error');
      });
      conn.on('end', () => {
        open.delete(conn);
      });
      return conn;
    },
    async closeAll() {
      closed = true;
      const conns = [...open];
      open.clear();
      await Promise.all(conns.map((c) => closeRedis(c)));
    },
  };
}

/** True for ioredis transport failures (connection closed/refused, retries exhausted). */
export function isRedisTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'MaxRetriesPerRequestError') return true;
  const code = (err as NodeJS.ErrnoException).code;
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND'
  )
    return true;
  return /Connection is closed|Stream isn't writeable|enableOfflineQueue/i.test(err.message);
}

/** Default bound of one request-path Redis/BullMQ operation (connections with maxRetriesPerRequest:null queue forever). */
export const REDIS_OP_TIMEOUT_MS = 5_000;

/**
 * Bounds `p` to `ms`: connections of the 'queue'/'blocking' roles use maxRetriesPerRequest:null, so during an outage
 * their commands wait in the offline queue indefinitely. A timeout rejects with OrcError('redis_unavailable') (after
 * running `onTimeout`) so HTTP requests and SSE loops degrade (F8) instead of hanging; other failures are mapped
 * through toRedisError.
 */
export async function boundRedis<T>(
  p: Promise<T>,
  ms: number,
  what: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new OrcError('redis_unavailable', `Redis ${what} timed out after ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } catch (err) {
    throw toRedisError(err, what);
  } finally {
    clearTimeout(timer);
  }
}

/** Maps a Redis failure to OrcError('redis_unavailable') (=> 503 dependency_unavailable, §9.6). */
export function toRedisError(err: unknown, what: string): OrcError {
  if (err instanceof OrcError) return err;
  return new OrcError('redis_unavailable', `Redis ${what} failed`, { cause: err });
}
