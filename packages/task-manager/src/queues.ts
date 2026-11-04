// BullMQ queue registry (contract §6). The API and the worker only PRODUCE through this registry; consumers
// (Worker/QueueEvents instances) live in @orc/orchestrator / apps/worker.
import { Queue } from 'bullmq';
import type { Job, JobsOptions } from 'bullmq';
import {
  DeadLetterJobDataSchema,
  JOB_NAMES,
  OrcError,
  ProjectJobDataSchema,
  QUEUE_NAMES,
  RunAttemptJobDataSchema,
  decodeCursor,
  encodeCursor,
  filterHash,
  toIso,
} from '@orc/shared';
import type {
  Clock,
  DeadLetterEntry,
  DeadLetterJobData,
  MaintenanceJobData,
  Page,
  ProjectJobData,
  QueueStats,
  QueueStatus,
  RunAttemptJobData,
  Uuid,
} from '@orc/shared';
import type { RedisFactory } from './redis.js';
import { REDIS_OP_TIMEOUT_MS, boundRedis, closeRedis } from './redis.js';

export type JobStateName =
  | 'waiting'
  | 'delayed'
  | 'active'
  | 'completed'
  | 'failed'
  | 'prioritized'
  | 'waiting-children'
  | 'unknown';

export interface QueueRegistry {
  readonly tasks: Queue<RunAttemptJobData>;
  readonly tasksDlq: Queue<DeadLetterJobData>;
  readonly projects: Queue<ProjectJobData>;
  readonly maintenance: Queue<MaintenanceJobData>;
  readonly apiMaintenance: Queue<MaintenanceJobData>;
  /** jobId = attemptId; duplicate add is a no-op. */
  enqueueAttempt(d: RunAttemptJobData): Promise<void>;
  removePendingAttempt(attemptId: Uuid): Promise<'removed' | 'absent' | 'active'>;
  enqueueProjectJob(d: ProjectJobData): Promise<{ jobId: string; deduplicated: boolean }>;
  deadLetter(d: DeadLetterJobData): Promise<void>;
  /** GET /system/dlq (newest first). */
  listDeadLetters(q: { limit: number; cursor?: string }): Promise<Page<DeadLetterEntry>>;
  /** INFO memory; null on error. */
  redisMemory(): Promise<QueueStatus['redisMemory']>;
  jobState(attemptId: Uuid): Promise<JobStateName>;
  /** State of an orc-projects job (`sync-<projectId>` | `index-<operationId>`); used by the queued reconciler (§6.5). */
  projectJobState(jobId: string): Promise<JobStateName>;
  stats(): Promise<QueueStats[]>;
  close(): Promise<void>;
}

export interface QueueRegistryConfig {
  prefix: string;
  jobAttempts: number;
  backoffMs: number;
  /** Bound of one registry operation (default REDIS_OP_TIMEOUT_MS); a timeout => OrcError('redis_unavailable'). */
  opTimeoutMs?: number;
}

const KNOWN_STATES: ReadonlySet<string> = new Set([
  'waiting',
  'delayed',
  'active',
  'completed',
  'failed',
  'prioritized',
  'waiting-children',
]);
const PENDING_STATES: ReadonlySet<string> = new Set(['waiting', 'delayed', 'prioritized']);
const LIVE_STATES: ReadonlySet<string> = new Set([
  'waiting',
  'delayed',
  'prioritized',
  'active',
  'waiting-children',
]);
const DLQ_CURSOR_FILTER = filterHash({ list: 'dlq' });

export const MAINTENANCE_JOB_OPTIONS: JobsOptions = Object.freeze({
  attempts: 1,
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 100 },
});

/** BullMQ job ids use only [A-Za-z0-9-] and are never integer-like (§6.1). */
export function safeJobId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 200);
  return /^\d+$/.test(cleaned) || cleaned === '' ? `j-${cleaned}` : cleaned;
}

export function projectJobId(d: ProjectJobData): string {
  return d.kind === 'sync' ? `sync-${d.projectId}` : `index-${d.operationId}`;
}

function ignoreQueueError(): void {
  // logged by the RedisFactory connection listener
}

async function stateOf(job: Job | undefined): Promise<JobStateName> {
  if (!job) return 'unknown';
  const state = await job.getState();
  return KNOWN_STATES.has(state) ? state : 'unknown';
}

function parseInfoMemory(info: string): QueueStatus['redisMemory'] {
  const fields = new Map<string, string>();
  for (const line of info.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0) fields.set(line.slice(0, idx), line.slice(idx + 1).trim());
  }
  const used = Number(fields.get('used_memory'));
  if (!Number.isFinite(used)) return null;
  const max = Number(fields.get('maxmemory'));
  return {
    usedBytes: used,
    maxBytes: Number.isFinite(max) && max > 0 ? max : null,
    policy: fields.get('maxmemory_policy') ?? 'unknown',
  };
}

function dlqOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const c = decodeCursor(cursor);
  const offset = c.k[0];
  if (
    c.f !== DLQ_CURSOR_FILTER ||
    c.k.length !== 1 ||
    typeof offset !== 'number' ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    throw new OrcError('invalid_cursor', 'Invalid pagination cursor');
  }
  return offset;
}

export function createQueueRegistry(f: RedisFactory, cfg: QueueRegistryConfig): QueueRegistry {
  const connection = f.create('queue', 'queues');
  const opts = { connection, prefix: cfg.prefix };
  const tasks = new Queue<RunAttemptJobData>(QUEUE_NAMES.tasks, opts);
  const tasksDlq = new Queue<DeadLetterJobData>(QUEUE_NAMES.tasksDlq, opts);
  const projects = new Queue<ProjectJobData>(QUEUE_NAMES.projects, opts);
  const maintenance = new Queue<MaintenanceJobData>(QUEUE_NAMES.maintenance, opts);
  const apiMaintenance = new Queue<MaintenanceJobData>(QUEUE_NAMES.apiMaintenance, opts);
  const all = [tasks, tasksDlq, projects, maintenance, apiMaintenance] as const;
  // BullMQ re-emits connection errors on every Queue; without a listener EventEmitter throws (process crash on a
  // Redis outage). The factory already logs the underlying connection errors (rate-limited), so these are no-ops.
  for (const queue of all) queue.on('error', ignoreQueueError);
  const opTimeoutMs = cfg.opTimeoutMs ?? REDIS_OP_TIMEOUT_MS;
  /** Every Redis round trip of the registry is bounded and mapped to redis_unavailable (never hangs a request). */
  const guard = <T>(what: string, fn: () => Promise<T>): Promise<T> =>
    boundRedis(fn(), opTimeoutMs, what);

  const runAttemptOptions = (attemptId: Uuid): JobsOptions => ({
    jobId: attemptId,
    attempts: cfg.jobAttempts,
    backoff: { type: 'exponential', delay: cfg.backoffMs },
    removeOnComplete: { age: 86_400, count: 5000 },
    removeOnFail: { age: 604_800, count: 5000 },
  });

  const projectOptions = (d: ProjectJobData): JobsOptions => ({
    jobId: projectJobId(d),
    attempts: d.kind === 'sync' ? 3 : 2,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: true,
    removeOnFail: true,
  });

  return {
    tasks,
    tasksDlq,
    projects,
    maintenance,
    apiMaintenance,

    async enqueueAttempt(d) {
      const data = RunAttemptJobDataSchema.parse(d);
      await guard('enqueue', async () => {
        await tasks.add(JOB_NAMES.runAttempt, data, runAttemptOptions(data.attemptId));
      });
    },

    async removePendingAttempt(attemptId) {
      return guard('job removal', async () => {
        const job = await tasks.getJob(attemptId);
        if (!job) return 'absent';
        const state = await job.getState();
        if (state === 'active') return 'active';
        if (!PENDING_STATES.has(state)) return 'absent';
        try {
          await job.remove();
          return 'removed';
        } catch (err) {
          // A worker locked the job between getState and remove: the claim CAS decides (§5.4).
          if ((await stateOf(await tasks.getJob(attemptId))) === 'active') return 'active';
          throw err;
        }
      });
    },

    async enqueueProjectJob(d) {
      const data = ProjectJobDataSchema.parse(d);
      const jobId = projectJobId(data);
      const name = data.kind === 'sync' ? JOB_NAMES.syncProject : JOB_NAMES.indexProject;
      return guard('enqueue', async () => {
        const existing = await projects.getJob(jobId);
        if (existing) {
          const state = await existing.getState();
          if (LIVE_STATES.has(state)) return { jobId, deduplicated: true };
          // A finished job kept by an older retention setting would make add() a silent no-op.
          await existing.remove();
        }
        await projects.add(name, data, projectOptions(data));
        return { jobId, deduplicated: false };
      });
    },

    async deadLetter(d) {
      const data = DeadLetterJobDataSchema.parse(d);
      await guard('dead-letter', async () => {
        await tasksDlq.add(JOB_NAMES.deadLetter, data, {
          jobId: safeJobId(`dlq-${data.jobId}`),
          removeOnComplete: false,
          removeOnFail: false,
        });
      });
    },

    async listDeadLetters(q) {
      const limit = Math.max(1, Math.min(100, Math.trunc(q.limit)));
      const offset = dlqOffset(q.cursor);
      // DLQ jobs are never consumed: they stay in the wait list, newest at the head.
      const jobs: Job<DeadLetterJobData>[] = await guard('DLQ listing', () =>
        tasksDlq.getJobs(['waiting'], offset, offset + limit, false),
      );
      const page = jobs.slice(0, limit);
      const items: DeadLetterEntry[] = [];
      for (const job of page) {
        const parsed = DeadLetterJobDataSchema.safeParse(job.data);
        if (!parsed.success || job.id === undefined) continue;
        items.push({ jobId: job.id, data: parsed.data, createdAt: toIso(new Date(job.timestamp)) });
      }
      const nextCursor =
        jobs.length > limit ? encodeCursor({ k: [offset + limit], f: DLQ_CURSOR_FILTER }) : null;
      return { items, nextCursor };
    },

    async redisMemory() {
      try {
        return parseInfoMemory(await guard('INFO memory', () => connection.info('memory')));
      } catch {
        return null;
      }
    },

    async jobState(attemptId) {
      return guard('job state', async () => stateOf(await tasks.getJob(attemptId)));
    },

    async projectJobState(jobId) {
      return guard('job state', async () => stateOf(await projects.getJob(jobId)));
    },

    async stats() {
      return guard('queue stats', () =>
        Promise.all(
          all.map(async (queue): Promise<QueueStats> => {
            const counts = await queue.getJobCounts(
              'waiting',
              'active',
              'delayed',
              'prioritized',
              'failed',
              'completed',
            );
            return {
              name: queue.name,
              waiting: counts['waiting'] ?? 0,
              active: counts['active'] ?? 0,
              delayed: counts['delayed'] ?? 0,
              prioritized: counts['prioritized'] ?? 0,
              failed: counts['failed'] ?? 0,
              completed: counts['completed'] ?? 0,
              paused: await queue.isPaused(),
            };
          }),
        ),
      );
    },

    async close() {
      // The Queues share one factory connection (BullMQ never closes a shared client): close it explicitly.
      await Promise.allSettled(all.map((q) => guard('queue close', () => q.close())));
      await closeRedis(connection);
    },
  };
}

/** GET /system/queue body (§9.5): queue counts, DLQ size and Redis memory. Redis failure => redis_unavailable. */
export async function getQueueStatus(queues: QueueRegistry, clock: Clock): Promise<QueueStatus> {
  const [stats, redisMemory] = await Promise.all([queues.stats(), queues.redisMemory()]);
  const dlq = stats.find((s) => s.name === QUEUE_NAMES.tasksDlq);
  const deadLetterCount = dlq
    ? dlq.waiting + dlq.delayed + dlq.prioritized + dlq.completed + dlq.failed
    : 0;
  return { queues: stats, deadLetterCount, redisMemory, checkedAt: toIso(clock.now()) };
}
