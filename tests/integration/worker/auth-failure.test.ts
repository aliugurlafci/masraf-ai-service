// Auth failure (ADR-0036 m.10, contract §18.5 "(extra) Auth failure") against mssql-test + redis-test with
// fake-claude through the local launcher: `@@fake auth-error <401|not-logged-in>` ends the attempt once. The task
// settles failed with a Claude failure reason (its own outcome is deferred to B-022), there is exactly one attempt
// and one Claude session, the BullMQ job is finished after a single run (no retry, no re-enqueue, no dead letter)
// and nothing new appears after the queue backoff window has passed several times. The OAuth token is in no log.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sql from 'mssql';
import type { Uuid } from '@orc/shared';
import { resetDb } from '../../helpers/database/db';
import { FAKE_OAUTH_TOKEN } from '../../helpers/claude/fake-claude';
import { createWorkerWorld } from '../../helpers/worker/world';
import type { WorkerWorld } from '../../helpers/worker/world';

/** QUEUE_BACKOFF_MS 500 with 3 job attempts (world defaults): a retry would surface well within this window. */
const QUIET_MS = 4000;
/** Claude failures; an infra path (worker_lost, recovery_limit_reached, queue_exhausted, ...) would mean re-runs. */
const CLAUDE_FAILURES = ['claude_result_error', 'claude_exit_nonzero', 'claude_start_failed', 'claude_protocol_error'];

let world: WorkerWorld;

beforeAll(async () => {
  world = await createWorkerWorld();
  await world.startWorker({ workerId: 'it-auth-failure' });
});

afterAll(async () => {
  await world?.dispose();
  await resetDb();
});

async function counts(taskId: Uuid): Promise<{ attempts: number; sessions: number; runningEvents: number }> {
  const [row] = await world.sql<{ Attempts: number; Sessions: number }>(
    `SELECT
       (SELECT COUNT(*) FROM orc.TaskAttempts WHERE TaskId = @t) AS Attempts,
       (SELECT COUNT(*) FROM orc.ClaudeSessions WHERE TaskId = @t) AS Sessions`,
    [['t', sql.UniqueIdentifier, taskId]],
  );
  const events = await world.streamEvents(taskId);
  const runningEvents = events.filter((e) => e.type === 'status' && e.status === 'running').length;
  return { attempts: row?.Attempts ?? -1, sessions: row?.Sessions ?? -1, runningEvents };
}

describe('Claude authentication failure (ADR-0036 m.10)', () => {
  it.each(['401', 'not-logged-in'] as const)(
    'auth-error %s: one settle, no automatic re-enqueue, no retry storm',
    async (kind) => {
      const project = await world.project(world.repo());
      const { task, attempt } = await world.createTask(project, { directives: [`@@fake auth-error ${kind}`] });

      const settled = await world.waitSettled(task.id);
      const a = await world.db.repos.attempts.findById(attempt.id);
      const why = JSON.stringify({ reason: settled.statusReason, detail: a?.failureDetail ?? null });
      expect(settled.status, why).toBe('failed');
      expect(CLAUDE_FAILURES, why).toContain(settled.statusReason);
      expect(settled.currentAttemptId).toBe(attempt.id);
      expect(a?.status).toBe('failed');
      expect(await counts(task.id)).toEqual({ attempts: 1, sessions: 1, runningEvents: 1 });

      // The run-attempt job ran once and is finished: failed as a business outcome (UnrecoverableError).
      expect(await world.queues.jobState(attempt.id)).toBe('failed');
      const job = await world.queues.tasks.getJob(attempt.id);
      expect(job?.failedReason ?? '').toMatch(/^business:/);
      expect(job?.attemptsStarted).toBe(1);
      expect(job?.attemptsMade).toBeLessThanOrEqual(1);

      // Several backoff windows later nothing has been re-run or re-enqueued.
      await new Promise((r) => setTimeout(r, QUIET_MS));
      expect(await counts(task.id)).toEqual({ attempts: 1, sessions: 1, runningEvents: 1 });
      expect((await world.db.repos.tasks.findById(task.id))?.status).toBe('failed');
      expect(await world.queues.jobState(attempt.id)).toBe('failed');
      expect((await world.queues.tasks.getJob(attempt.id))?.attemptsStarted).toBe(1);
      const pending = await world.queues.tasks.getJobCounts('waiting', 'delayed', 'active', 'prioritized');
      expect(pending).toEqual({ waiting: 0, delayed: 0, active: 0, prioritized: 0 });
      const dlq = await world.queues.listDeadLetters({ limit: 100 });
      expect(JSON.stringify(dlq)).not.toContain(attempt.id);

      // The OAuth token (and its base64 form) never reaches the stored logs.
      const logs = await world.db.repos.taskLogs.listByAttempt({ attemptId: attempt.id, limit: 5000 });
      const text = logs.map((l) => l.content).join('\n');
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain(FAKE_OAUTH_TOKEN);
      expect(text).not.toContain(Buffer.from(FAKE_OAUTH_TOKEN, 'utf8').toString('base64'));
    },
  );
});
