// Real redis-test: task stream publisher/reader (publish, range resume, blocking read, abort, expiry), control
// channel round trip and BullMQ queue registry semantics (contract §2.9, §6.3, §7, §8.3).
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { toIso } from '@orc/shared';
import type { ControlMessage, TaskStreamEvent } from '@orc/shared';
import {
  createControlChannel,
  createQueueRegistry,
  createRedisFactory,
  createTaskStreamPublisher,
  createTaskStreamReader,
  getQueueStatus,
  taskStreamKey,
} from '@orc/task-manager';
import type { QueueRegistry, RedisFactory, TaskStreamPublisher } from '@orc/task-manager';
import { silentLogger } from '../../helpers/database/env';
import {
  cleanupPrefix,
  rawRedis,
  testRedisFactory,
  uniquePrefix,
} from '../../helpers/task-manager/redis';

const prefix = uniquePrefix();
let factory: RedisFactory;
let raw: Redis;
let publisher: TaskStreamPublisher;
let queues: QueueRegistry;

function logEvent(taskId: string, attemptId: string, seq: number): TaskStreamEvent {
  return {
    v: 1,
    type: 'log',
    taskId,
    attemptId,
    seq,
    stream: 'stdout',
    source: 'orchestrator',
    content: `line ${seq}`,
    at: toIso(new Date()),
  };
}

function endEvent(taskId: string, attemptId: string): TaskStreamEvent {
  return {
    v: 1,
    type: 'end',
    taskId,
    attemptId,
    status: 'completed',
    reason: null,
    at: toIso(new Date()),
  };
}

beforeAll(() => {
  factory = testRedisFactory(prefix);
  raw = rawRedis(prefix);
  publisher = createTaskStreamPublisher(factory.create('command', 'test-publisher'), {
    prefix,
    logger: silentLogger(),
  });
  queues = createQueueRegistry(factory, { prefix, jobAttempts: 3, backoffMs: 5000 });
});

afterAll(async () => {
  await queues.close();
  await factory.closeAll();
  await raw.quit();
  expect(await cleanupPrefix(prefix)).toBe(0);
});

describe('task stream', () => {
  it('publishes with XADD, ranges exclusively after an id and resumes from the last id', async () => {
    const taskId = randomUUID();
    const attemptId = randomUUID();
    const reader = createTaskStreamReader(factory, { prefix });
    try {
      expect(await reader.exists(taskId)).toBe(false);
      expect(await reader.firstId(taskId)).toBeNull();
      const ids: string[] = [];
      for (let seq = 1; seq <= 5; seq += 1)
        ids.push(await publisher.publish(taskId, logEvent(taskId, attemptId, seq)));
      expect(ids.every((id) => /^\d+-\d+$/.test(id))).toBe(true);
      expect(await reader.exists(taskId)).toBe(true);
      expect(await reader.firstId(taskId)).toBe(ids[0]);

      const all = await reader.range(taskId, null, 500);
      expect(all.map((e) => e.id)).toEqual(ids);
      expect(all[0]?.event).toMatchObject({ type: 'log', seq: 1 });

      const resumed = await reader.range(taskId, ids[2] ?? null, 500);
      expect(resumed.map((e) => (e.event.type === 'log' ? e.event.seq : -1))).toEqual([4, 5]);
      expect(await reader.range(taskId, ids[1] ?? null, 1)).toHaveLength(1);
    } finally {
      await reader.close();
    }
  });

  it('blocking read delivers new entries, times out with [] and resolves [] on abort', async () => {
    const taskId = randomUUID();
    const attemptId = randomUUID();
    const reader = createTaskStreamReader(factory, { prefix });
    try {
      const first = await publisher.publish(taskId, logEvent(taskId, attemptId, 1));
      expect(await reader.read(taskId, first, 200, new AbortController().signal)).toEqual([]);

      const pending = reader.read(taskId, first, 5000, new AbortController().signal);
      await new Promise((r) => setTimeout(r, 100));
      const second = await publisher.publish(taskId, logEvent(taskId, attemptId, 2));
      const got = await pending;
      expect(got.map((e) => e.id)).toEqual([second]);
    } finally {
      await reader.close();
    }

    const aborting = createTaskStreamReader(factory, { prefix });
    const ac = new AbortController();
    const started = Date.now();
    const blocked = aborting.read(taskId, '0-0', 10_000, ac.signal);
    // '0-0' returns the existing entries immediately; block from the tail instead.
    expect((await blocked).length).toBe(2);
    const tail = (await aborting.range(taskId, null, 10)).at(-1)?.id ?? '0-0';
    const waiting = aborting.read(taskId, tail, 10_000, ac.signal);
    setTimeout(() => ac.abort(), 100);
    expect(await waiting).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5000);
    await aborting.close();
  });

  it('PERSIST keeps the stream, EXPIRE 86400 after end makes it expire (expiry detection via exists)', async () => {
    const taskId = randomUUID();
    const attemptId = randomUUID();
    await publisher.publish(taskId, logEvent(taskId, attemptId, 1));
    await publisher.publish(taskId, endEvent(taskId, attemptId));
    await publisher.expireSettled(taskId);
    const key = taskStreamKey(prefix, taskId);
    const ttl = await raw.ttl(key);
    expect(ttl).toBeGreaterThan(86_000);
    expect(ttl).toBeLessThanOrEqual(86_400);
    await publisher.persist(taskId);
    expect(await raw.ttl(key)).toBe(-1);

    await raw.pexpire(key, 50);
    await new Promise((r) => setTimeout(r, 150));
    const reader = createTaskStreamReader(factory, { prefix });
    try {
      expect(await reader.exists(taskId)).toBe(false);
      expect(await reader.range(taskId, null, 10)).toEqual([]);
    } finally {
      await reader.close();
    }
  });

  it('caps the stream near MAXLEN 1000 and drops invalid entries on read', async () => {
    const taskId = randomUUID();
    const attemptId = randomUUID();
    const pipeline = raw.pipeline();
    for (let seq = 0; seq < 1300; seq += 1) {
      pipeline.xadd(
        taskStreamKey(prefix, taskId),
        'MAXLEN',
        '~',
        1000,
        '*',
        'e',
        JSON.stringify(logEvent(taskId, attemptId, seq)),
      );
    }
    await pipeline.exec();
    await publisher.publish(taskId, logEvent(taskId, attemptId, 1300));
    expect(await raw.xlen(taskStreamKey(prefix, taskId))).toBeLessThan(1300);
    await raw.xadd(taskStreamKey(prefix, taskId), '*', 'e', '{"not":"an event"}');
    const reader = createTaskStreamReader(factory, { prefix });
    try {
      const last = await reader.range(taskId, null, 2000);
      expect(last.at(-1)?.event).toMatchObject({ type: 'log', seq: 1300 });
    } finally {
      await reader.close();
    }
  });
});

describe('control channel', () => {
  it('round-trips cancel messages and drops invalid payloads', async () => {
    const control = createControlChannel(factory, { prefix, logger: silentLogger() });
    const received: ControlMessage[] = [];
    const unsubscribe = await control.subscribe((m) => received.push(m));
    const message = {
      taskId: randomUUID(),
      attemptId: randomUUID(),
      requestedByUserId: randomUUID(),
      requestedAt: toIso(new Date()),
      correlationId: 'corr-1',
    };
    await raw.publish(`${prefix}:control`, 'not json');
    await raw.publish(`${prefix}:control`, JSON.stringify({ v: 1, type: 'reboot' }));
    await control.publishCancel(message);
    const deadline = Date.now() + 5000;
    while (received.length === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    expect(received).toEqual([{ v: 1, type: 'cancel', ...message }]);
    await unsubscribe();
    await control.publishCancel(message);
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toHaveLength(1);
  });
});

describe('queue registry', () => {
  it('enqueueAttempt uses jobId = attemptId; a duplicate add is a no-op; removal of a waiting job', async () => {
    const taskId = randomUUID();
    const attemptId = randomUUID();
    const data = { v: 1 as const, taskId, attemptId, attemptNumber: 1, correlationId: null };
    await queues.enqueueAttempt(data);
    await queues.enqueueAttempt(data);
    const job = await queues.tasks.getJob(attemptId);
    expect(job?.name).toBe('run-attempt');
    expect(job?.opts).toMatchObject({ attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
    expect(await queues.jobState(attemptId)).toBe('waiting');
    expect(
      (await queues.tasks.getJobs(['waiting'])).filter((j) => j.id === attemptId),
    ).toHaveLength(1);
    expect(await queues.removePendingAttempt(attemptId)).toBe('removed');
    expect(await queues.removePendingAttempt(attemptId)).toBe('absent');
    expect(await queues.jobState(attemptId)).toBe('unknown');
  });

  it('enqueueProjectJob deduplicates sync-<projectId> while waiting; index jobs use index-<operationId>', async () => {
    const projectId = randomUUID();
    const sync = {
      v: 1 as const,
      kind: 'sync' as const,
      projectId,
      requestedByUserId: null,
      correlationId: null,
    };
    expect(await queues.enqueueProjectJob(sync)).toEqual({
      jobId: `sync-${projectId}`,
      deduplicated: false,
    });
    expect(await queues.enqueueProjectJob(sync)).toEqual({
      jobId: `sync-${projectId}`,
      deduplicated: true,
    });
    expect(await queues.projectJobState(`sync-${projectId}`)).toBe('waiting');
    const operationId = randomUUID();
    const res = await queues.enqueueProjectJob({
      ...sync,
      kind: 'index',
      operationId,
      mode: 'full',
    });
    expect(res.jobId).toBe(`index-${operationId}`);
    expect((await queues.projects.getJob(res.jobId))?.opts).toMatchObject({
      attempts: 2,
      removeOnComplete: true,
    });
  });

  it('dead letters are listed newest first with cursor paging; queue status reports counts and memory', async () => {
    for (let i = 0; i < 3; i += 1) {
      await queues.deadLetter({
        v: 1,
        sourceQueue: 'orc-tasks',
        jobName: 'run-attempt',
        jobId: `src-${i}`,
        data: { i },
        failedReason: 'boom',
        attemptsMade: 3,
        failedAt: toIso(new Date()),
      });
      await new Promise((r) => setTimeout(r, 5));
    }
    const first = await queues.listDeadLetters({ limit: 2 });
    expect(first.items.map((e) => e.jobId)).toEqual(['dlq-src-2', 'dlq-src-1']);
    expect(first.nextCursor).not.toBeNull();
    const second = await queues.listDeadLetters({
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((e) => e.jobId)).toEqual(['dlq-src-0']);
    expect(second.nextCursor).toBeNull();
    await expect(queues.listDeadLetters({ limit: 2, cursor: 'garbage' })).rejects.toMatchObject({
      code: 'invalid_cursor',
    });

    const status = await getQueueStatus(queues, { now: () => new Date(), nowMs: () => Date.now() });
    expect(status.queues.map((q) => q.name).sort()).toEqual(
      [
        'orc-api-maintenance',
        'orc-maintenance',
        'orc-projects',
        'orc-tasks',
        'orc-tasks-dlq',
      ].sort(),
    );
    expect(status.deadLetterCount).toBe(3);
    expect(status.redisMemory?.usedBytes).toBeGreaterThan(0);
    expect(typeof status.redisMemory?.policy).toBe('string');
  });
});

/** A localhost port with nothing listening (bound once, then released). */
async function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

describe('unreachable Redis (F8: bounded operations, no hang, no crash)', () => {
  it('queue registry and stream reader reject with redis_unavailable within their bound', async () => {
    const down = createRedisFactory(
      {
        host: '127.0.0.1',
        port: await closedPort(),
        password: null,
        db: 0,
        prefix: uniquePrefix(),
      },
      { logger: silentLogger() },
    );
    const q = createQueueRegistry(down, {
      prefix,
      jobAttempts: 3,
      backoffMs: 5000,
      opTimeoutMs: 300,
    });
    const reader = createTaskStreamReader(down, { prefix, commandTimeoutMs: 300 });
    const taskId = randomUUID();
    const unavailable = { code: 'redis_unavailable' };
    try {
      const started = Date.now();
      await expect(
        q.enqueueAttempt({
          v: 1,
          taskId,
          attemptId: randomUUID(),
          attemptNumber: 1,
          correlationId: null,
        }),
      ).rejects.toMatchObject(unavailable);
      await expect(q.removePendingAttempt(randomUUID())).rejects.toMatchObject(unavailable);
      await expect(
        q.enqueueProjectJob({
          v: 1,
          kind: 'sync',
          projectId: randomUUID(),
          requestedByUserId: null,
          correlationId: null,
        }),
      ).rejects.toMatchObject(unavailable);
      await expect(q.jobState(randomUUID())).rejects.toMatchObject(unavailable);
      await expect(q.stats()).rejects.toMatchObject(unavailable);
      expect(await q.redisMemory()).toBeNull();
      await expect(reader.exists(taskId)).rejects.toMatchObject(unavailable);
      await expect(reader.range(taskId, null, 10)).rejects.toMatchObject(unavailable);
      await expect(
        reader.read(taskId, '0-0', 200, new AbortController().signal),
      ).rejects.toMatchObject(unavailable);
      // the overdue XREAD closed the reader's dedicated connection
      await expect(reader.exists(taskId)).rejects.toMatchObject(unavailable);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await reader.close();
      await q.close();
      await down.closeAll();
    }
  }, 30_000);
});
