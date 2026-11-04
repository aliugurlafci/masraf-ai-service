// Redis-test helpers for task-manager / project-manager integration tests (contract §7, §18.2). Every test file uses
// its own random REDIS_PREFIX so keys never collide, and removes every key under that prefix when it finishes.
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { createRedisFactory } from '@orc/task-manager';
import type { RedisConfig, RedisFactory } from '@orc/task-manager';
import { silentLogger, testEnv } from '../database/env';

/** A fresh prefix matching /^[a-z][a-z0-9_-]{1,31}$/. */
export function uniquePrefix(): string {
  return `orct${randomBytes(5).toString('hex')}`;
}

export function testRedisConfig(prefix: string): RedisConfig {
  const env = testEnv();
  const password = env['REDIS_PASSWORD'];
  return {
    host: env['REDIS_HOST'] ?? '127.0.0.1',
    port: Number(env['REDIS_PORT']),
    password: password === undefined || password === '' ? null : password,
    db: 0,
    prefix,
  };
}

export function testRedisFactory(prefix: string): RedisFactory {
  return createRedisFactory(testRedisConfig(prefix), { logger: silentLogger() });
}

/** A raw client for assertions (TTL, EXISTS, PUBLISH of invalid payloads). Close it with quit(). */
export function rawRedis(prefix: string): Redis {
  const cfg = testRedisConfig(prefix);
  return new Redis({
    host: cfg.host,
    port: cfg.port,
    db: cfg.db,
    ...(cfg.password !== null ? { password: cfg.password } : {}),
    connectionName: 'orc:test-helper',
    maxRetriesPerRequest: 2,
  });
}

export async function keysUnder(client: Redis, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await client.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 500);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

/** Deletes every key under `prefix` and returns how many remain (0 expected). */
export async function cleanupPrefix(prefix: string): Promise<number> {
  const client = rawRedis(prefix);
  try {
    const keys = await keysUnder(client, prefix);
    for (let i = 0; i < keys.length; i += 500) await client.del(...keys.slice(i, i + 500));
    return (await keysUnder(client, prefix)).length;
  } finally {
    await client.quit();
  }
}
