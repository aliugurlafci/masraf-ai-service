// In-memory fakes for @orc/orchestrator / apps/worker unit tests (no MSSQL, no Redis).
import { Writable } from 'node:stream';
import type { NewTaskLog, Database } from '@orc/database';
import type { TaskStreamEvent, Uuid } from '@orc/shared';
import type { TaskStreamPublisher } from '@orc/task-manager';
import { createLogger } from '@orc/logger';
import type { Logger } from '@orc/logger';
import { createSecretRegistry } from '@orc/security';
import type { SecretRegistry } from '@orc/security';
import type { OrchestratorConfig } from '@orc/orchestrator';

export function silentLogger(): Logger {
  return createLogger({ service: 'test', level: 'silent', version: 'test', env: 'test' });
}

/** A logger whose JSON lines are kept in memory. */
export function capturingLogger(): { logger: Logger; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
  const logger = createLogger({ service: 'test', level: 'debug', version: 'test', env: 'test', destination });
  return {
    logger,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

export interface RecordingPublisher extends TaskStreamPublisher {
  readonly events: { taskId: Uuid; event: TaskStreamEvent }[];
}

export function recordingPublisher(): RecordingPublisher {
  const events: { taskId: Uuid; event: TaskStreamEvent }[] = [];
  return {
    events,
    publish(taskId, event) {
      events.push({ taskId, event });
      return Promise.resolve(String(events.length));
    },
    persist: () => Promise.resolve(),
    expireSettled: () => Promise.resolve(),
  };
}

export interface FakeTaskLogs {
  rows: NewTaskLog[];
  /** While > 0, each appendBatch rejects with OrcError-like db_unavailable and decrements. */
  failNext: number;
  calls: number;
}

/** A Database whose only working repository is taskLogs (log sink tests). */
export function taskLogDb(state: FakeTaskLogs): Database {
  const taskLogs = {
    appendBatch(rows: readonly NewTaskLog[]): Promise<void> {
      state.calls += 1;
      if (state.failNext > 0) {
        state.failNext -= 1;
        return Promise.reject(Object.assign(new Error('db down'), { code: 'db_unavailable' }));
      }
      state.rows.push(...rows.map((r) => ({ ...r })));
      return Promise.resolve();
    },
  };
  return { repos: { taskLogs } } as unknown as Database;
}

export function testSecrets(...values: string[]): SecretRegistry {
  const s = createSecretRegistry();
  for (const v of values) s.add(v);
  return s;
}

/** A complete OrchestratorConfig with small, test-friendly values. */
export function orchestratorTestConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    workerId: 'unit-worker',
    workspacesRoot: '/srv/ws',
    projectsRoot: '/srv/projects',
    claudeHomeRoot: '/srv/claude-home',
    heartbeatIntervalMs: 1000,
    quotaCheckEveryNthHeartbeat: 2,
    attemptStaleMs: 3000,
    selfFenceAfterMs: 1000,
    maxAutoRecoveries: 2,
    logFlushIntervalMs: 60_000,
    logFlushBytes: 1_000_000,
    logBufferMaxBytes: 8_388_608,
    promptMaxBytes: 131_072,
    claudeMdMaxBytes: 16_384,
    mcpEnabled: true,
    testOutputMaxBytes: 10_485_760,
    junitMaxBytes: 20_971_520,
    testKillGraceMs: 500,
    artifactCaptureTimeoutMs: 10_000,
    workspaceRetentionHours: 72,
    branchRetentionDays: 14,
    retention: { logDays: 30, gitOpsDays: 30, mcpOpsDays: 90, patchDays: 90, batchSize: 5000 },
    platform: process.platform === 'win32' ? 'win32' : 'posix',
    cbmCacheRoot: '/srv/cbm',
    claudeBin: 'claude',
    cliVersion: '2.1.316',
    redisPrefix: 'orcunit',
    dbWriteRetryWindowMs: 500,
    workspaceMaxBytes: 2_147_483_648,
    sizeScanMaxEntries: 500_000,
    junitMaxCases: 5000,
    mcpIndexTimeoutMs: 900_000,
    ...overrides,
  };
}

/** A manually advanced clock. */
export function manualClock(startMs = Date.UTC(2026, 10, 3, 10, 0, 0)): {
  now(): Date;
  nowMs(): number;
  advance(ms: number): void;
} {
  let t = startMs;
  return {
    now: () => new Date(t),
    nowMs: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}
