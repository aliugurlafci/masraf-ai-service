// `<P>:control` pub/sub channel (contract §7, §14.4): the API publishes cancel requests, every worker subscribes
// on a dedicated subscriber connection. Invalid messages are logged and dropped.
import type { Redis } from 'ioredis';
import { ControlMessageSchema } from '@orc/shared';
import type { CancelControlMessage, ControlMessage } from '@orc/shared';
import type { Logger } from '@orc/logger';
import type { RedisFactory } from './redis.js';
import { REDIS_OP_TIMEOUT_MS, boundRedis, closeRedis, toRedisError } from './redis.js';

export interface ControlChannel {
  /** Bounded by `opTimeoutMs`: a timeout or Redis failure rejects with OrcError('redis_unavailable'). */
  publishCancel(m: Omit<CancelControlMessage, 'v' | 'type'>): Promise<void>;
  /** Invalid messages logged + dropped. Resolves once SUBSCRIBE is acknowledged; returns the unsubscribe function. */
  subscribe(h: (m: ControlMessage) => void): Promise<() => Promise<void>>;
}

export function controlChannelName(prefix: string): string {
  return `${prefix}:control`;
}

export function createControlChannel(
  f: RedisFactory,
  o: {
    prefix: string;
    logger: Logger;
    /** Bound of one PUBLISH (default REDIS_OP_TIMEOUT_MS), like the queue registry's opTimeoutMs. */
    opTimeoutMs?: number;
  },
): ControlChannel {
  const channel = controlChannelName(o.prefix);
  const opTimeoutMs = o.opTimeoutMs ?? REDIS_OP_TIMEOUT_MS;
  let publisher: Redis | null = null;
  let subSeq = 0;

  return {
    async publishCancel(m) {
      const message = ControlMessageSchema.parse({ v: 1, type: 'cancel', ...m });
      publisher ??= f.create('command', 'control-publisher');
      await boundRedis(publisher.publish(channel, JSON.stringify(message)), opTimeoutMs, 'control publish');
    },

    async subscribe(h) {
      subSeq += 1;
      const sub = f.create('subscriber', `control-subscriber-${subSeq}`);
      const onMessage = (ch: string, raw: string): void => {
        if (ch !== channel) return;
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch {
          o.logger.warn({ channel }, 'control message is not JSON; dropped');
          return;
        }
        const parsed = ControlMessageSchema.safeParse(value);
        if (!parsed.success) {
          o.logger.warn(
            { channel, issues: parsed.error.issues.length },
            'invalid control message; dropped',
          );
          return;
        }
        try {
          h(parsed.data);
        } catch (err) {
          o.logger.error({ err, channel }, 'control message handler failed');
        }
      };
      sub.on('message', onMessage);
      try {
        await sub.subscribe(channel);
      } catch (err) {
        sub.off('message', onMessage);
        await closeRedis(sub);
        throw toRedisError(err, 'control subscribe');
      }
      let done = false;
      return async () => {
        if (done) return;
        done = true;
        sub.off('message', onMessage);
        try {
          await sub.unsubscribe(channel);
        } catch {
          // closing the connection drops the subscription anyway
        }
        await closeRedis(sub);
      };
    },
  };
}
