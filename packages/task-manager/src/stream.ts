// Redis stream publisher / reader for live task output (contract §7, §8). DB is the source of truth:
// publication failures are logged and swallowed; readers surface Redis errors to the SSE route (F8).
import type { Redis } from 'ioredis';
import { TaskStreamEventSchema } from '@orc/shared';
import type { TaskStreamEvent, Uuid } from '@orc/shared';
import type { Logger } from '@orc/logger';
import type { RedisFactory } from './redis.js';
import { REDIS_OP_TIMEOUT_MS, boundRedis, closeRedis, toRedisError } from './redis.js';

export const STREAM_MAXLEN = 1000;
export const SETTLED_STREAM_TTL_SECONDS = 86_400;
const READ_COUNT = 500;
const STREAM_ID_REGEX = /^\d+-\d+$/;

export interface TaskStreamPublisher {
  /** XADD MAXLEN ~ 1000; returns entry id; never throws (logs, returns ''). */
  publish(taskId: Uuid, e: TaskStreamEvent): Promise<string>;
  /** PERSIST (attempt start). Never throws. */
  persist(taskId: Uuid): Promise<void>;
  /** EXPIRE 86400 (after 'end'). Never throws. */
  expireSettled(taskId: Uuid): Promise<void>;
}

export interface StreamEntry {
  id: string;
  event: TaskStreamEvent;
}

export interface TaskStreamReader {
  exists(taskId: Uuid): Promise<boolean>;
  firstId(taskId: Uuid): Promise<string | null>;
  /** XRANGE (exclusive after). */
  range(taskId: Uuid, afterId: string | null, count: number): Promise<StreamEntry[]>;
  /** XREAD BLOCK on a dedicated connection owned by the reader instance; resolves [] on timeout or abort. */
  read(taskId: Uuid, afterId: string, blockMs: number, signal: AbortSignal): Promise<StreamEntry[]>;
  close(): Promise<void>;
}

export function taskStreamKey(prefix: string, taskId: Uuid): string {
  return `${prefix}:task:${taskId}:events`;
}

function assertStreamId(id: string): void {
  if (!STREAM_ID_REGEX.test(id)) throw new RangeError(`Invalid stream id: ${id}`);
}

type RawEntry = [id: string, fields: string[]];

function toEntries(raw: readonly RawEntry[]): StreamEntry[] {
  const out: StreamEntry[] = [];
  for (const [id, fields] of raw) {
    let json: string | undefined;
    for (let i = 0; i + 1 < fields.length; i += 2) {
      if (fields[i] === 'e') json = fields[i + 1];
    }
    if (json === undefined) continue;
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      continue;
    }
    const parsed = TaskStreamEventSchema.safeParse(value);
    if (parsed.success) out.push({ id, event: parsed.data });
  }
  return out;
}

export function createTaskStreamPublisher(
  redis: Redis,
  o: { prefix: string; logger: Logger },
): TaskStreamPublisher {
  const warn = (err: unknown, taskId: Uuid, op: string): void => {
    o.logger.warn({ err, taskId, op }, 'task stream publication failed');
  };
  return {
    async publish(taskId, e) {
      try {
        const id = await redis.xadd(
          taskStreamKey(o.prefix, taskId),
          'MAXLEN',
          '~',
          STREAM_MAXLEN,
          '*',
          'e',
          JSON.stringify(e),
        );
        return id ?? '';
      } catch (err) {
        warn(err, taskId, 'xadd');
        return '';
      }
    },
    async persist(taskId) {
      try {
        await redis.persist(taskStreamKey(o.prefix, taskId));
      } catch (err) {
        warn(err, taskId, 'persist');
      }
    },
    async expireSettled(taskId) {
      try {
        await redis.expire(taskStreamKey(o.prefix, taskId), SETTLED_STREAM_TTL_SECONDS);
      } catch (err) {
        warn(err, taskId, 'expire');
      }
    },
  };
}

let readerSeq = 0;

/**
 * One reader per SSE connection; it owns one dedicated 'blocking' connection, created lazily. That connection uses
 * maxRetriesPerRequest:null, so every command is bounded (`commandTimeoutMs`, XREAD: blockMs + commandTimeoutMs) and a
 * timeout rejects with redis_unavailable, letting the SSE route switch to DB replay (F8) instead of hanging.
 */
export function createTaskStreamReader(
  f: RedisFactory,
  o: { prefix: string; commandTimeoutMs?: number },
): TaskStreamReader {
  const commandTimeoutMs = o.commandTimeoutMs ?? REDIS_OP_TIMEOUT_MS;
  readerSeq += 1;
  const name = `stream-reader-${process.pid}-${readerSeq}`;
  let conn: Redis | null = null;
  let closed = false;

  const connection = (): Redis => {
    if (closed) throw toRedisError(new Error('Connection is closed'), 'stream read');
    conn ??= f.create('blocking', name);
    return conn;
  };

  const close = async (): Promise<void> => {
    closed = true;
    const c = conn;
    conn = null;
    if (c) await closeRedis(c);
  };

  return {
    async exists(taskId) {
      const n = await boundRedis(
        connection().exists(taskStreamKey(o.prefix, taskId)),
        commandTimeoutMs,
        'EXISTS',
      );
      return n === 1;
    },
    async firstId(taskId) {
      const raw = (await boundRedis(
        connection().xrange(taskStreamKey(o.prefix, taskId), '-', '+', 'COUNT', 1),
        commandTimeoutMs,
        'XRANGE',
      )) as RawEntry[];
      return raw[0]?.[0] ?? null;
    },
    async range(taskId, afterId, count) {
      if (afterId !== null) assertStreamId(afterId);
      const n = Math.max(1, Math.trunc(count));
      const raw = (await boundRedis(
        connection().xrange(
          taskStreamKey(o.prefix, taskId),
          afterId === null ? '-' : `(${afterId}`,
          '+',
          'COUNT',
          n,
        ),
        commandTimeoutMs,
        'XRANGE',
      )) as RawEntry[];
      return toEntries(raw);
    },
    async read(taskId, afterId, blockMs, signal) {
      assertStreamId(afterId);
      if (signal.aborted || closed) return [];
      const c = connection();
      const onAbort = (): void => {
        // Abort closes the dedicated connection, which rejects the pending XREAD.
        void close();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const block = Math.max(0, Math.trunc(blockMs));
      try {
        const pending = c.xread(
          'COUNT',
          READ_COUNT,
          'BLOCK',
          block,
          'STREAMS',
          taskStreamKey(o.prefix, taskId),
          afterId,
        );
        // BLOCK 0 waits forever by design (only abort ends it); otherwise a reply overdue by commandTimeoutMs means
        // Redis is unreachable: close the connection (its pending XREAD would block later reads) and report it.
        const res =
          block === 0
            ? await pending
            : await boundRedis(pending, block + commandTimeoutMs, 'XREAD', () => {
                void close();
              });
        if (res === null) return [];
        return toEntries(res[0]?.[1] ?? []);
      } catch (err) {
        if (signal.aborted) return [];
        throw toRedisError(err, 'XREAD');
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
    close,
  };
}
