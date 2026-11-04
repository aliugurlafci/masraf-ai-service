import { describe, expect, it } from 'vitest';
import {
  AuditLogQuerySchema,
  CancelTaskRequestSchema,
  ControlMessageSchema,
  CreateAgentRequestSchema,
  CreateProjectRequestSchema,
  CreateTaskRequestSchema,
  CreateUserRequestSchema,
  DeadLetterJobDataSchema,
  IdParamSchema,
  LogQuerySchema,
  LoginRequestSchema,
  MaintenanceJobDataSchema,
  PageQuerySchema,
  ProblemDetailsSchema,
  ProjectJobDataSchema,
  RetryTaskRequestSchema,
  RunAttemptJobDataSchema,
  TASK_TEXT_MAX_BYTES,
  TaskListQuerySchema,
  TaskSchema,
  TaskStreamEventSchema,
  UpdateProjectRequestSchema,
  UpdateUserRequestSchema,
  WorkerHeartbeatSchema,
  pageOf,
} from '@orc/shared';

const ID = '0b6f1c2e-3d4a-4b5c-8d9e-0f1a2b3c4d5e';
const SEQ_ID = '6f9619ff-8b86-d011-b42d-00c04fc964ff'; // NEWSEQUENTIALID-style, not RFC 9562 versioned
const NOW = '2026-11-02T10:00:00.000Z';

describe('ids and timestamps', () => {
  it('accepts non-RFC GUIDs and normalizes case/whitespace', () => {
    expect(IdParamSchema.parse(SEQ_ID)).toBe(SEQ_ID);
    expect(IdParamSchema.parse(`  ${ID.toUpperCase()} `)).toBe(ID);
  });

  it.each(['', 'not-a-guid', `${ID}0`, ID.replaceAll('-', ''), `{${ID}}`])('rejects %j', (v) => {
    expect(IdParamSchema.safeParse(v).success).toBe(false);
  });
});

describe('request bodies are strict', () => {
  it('rejects unknown keys', () => {
    const r = CancelTaskRequestSchema.safeParse({ reason: 'x', extra: 1 });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.code).toBe('unrecognized_keys');
  });

  it('login lower-cases and trims the username but never trims the password', () => {
    expect(LoginRequestSchema.parse({ username: '  Admin ', password: ' secret ' })).toEqual({
      username: 'admin',
      password: ' secret ',
    });
    expect(LoginRequestSchema.safeParse({ username: '   ', password: 'x' }).success).toBe(false);
    expect(LoginRequestSchema.safeParse({ username: 'a', password: 'x'.repeat(257) }).success).toBe(
      false,
    );
  });

  it('create user enforces username pattern, password length and email', () => {
    const base = {
      username: 'ops.user',
      displayName: 'Ops',
      role: 'operator',
      password: 'x'.repeat(12),
    };
    expect(CreateUserRequestSchema.parse(base).username).toBe('ops.user');
    expect(CreateUserRequestSchema.safeParse({ ...base, username: '-bad' }).success).toBe(false);
    expect(CreateUserRequestSchema.safeParse({ ...base, username: 'ab' }).success).toBe(false);
    expect(CreateUserRequestSchema.safeParse({ ...base, password: 'x'.repeat(11) }).success).toBe(
      false,
    );
    expect(CreateUserRequestSchema.safeParse({ ...base, email: 'nope' }).success).toBe(false);
    expect(CreateUserRequestSchema.parse({ ...base, email: ' a@b.example ' }).email).toBe(
      'a@b.example',
    );
    expect(CreateUserRequestSchema.safeParse({ ...base, role: 'root' }).success).toBe(false);
  });

  it('PATCH bodies need at least one key; null clears email', () => {
    expect(UpdateUserRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateUserRequestSchema.parse({ email: null })).toEqual({ email: null });
    expect(UpdateProjectRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateProjectRequestSchema.safeParse({ repoPath: 'x' }).success).toBe(false);
    expect(UpdateProjectRequestSchema.parse({ archived: true })).toEqual({ archived: true });
  });
});

describe('CreateProjectRequestSchema', () => {
  const base = { name: 'My Repo', repoPath: 'team/repo' };

  it('applies defaults', () => {
    expect(CreateProjectRequestSchema.parse(base)).toMatchObject({
      testTimeoutSeconds: 900,
      requireIndex: false,
      autoIndex: true,
      indexMode: 'moderate',
      defaultTimeoutSeconds: 3600,
    });
  });

  it('does not apply create defaults on update', () => {
    expect(UpdateProjectRequestSchema.parse({ name: 'Other' })).toEqual({ name: 'Other' });
  });

  it.each([
    [{ name: 'a' }],
    [{ name: '_repo' }],
    [{ testTimeoutSeconds: 29 }],
    [{ testTimeoutSeconds: 7201 }],
    [{ testCommand: [] }],
    [{ testCommand: Array.from({ length: 33 }, () => 'x') }],
    [{ testCommand: [''] }],
    [{ workspaceMaxBytes: 104_857_599 }],
    [{ defaultTimeoutSeconds: 59 }],
    [{ indexMode: 'deep' }],
    [{ defaultAgentId: 'x' }],
  ])('rejects %j', (patch) => {
    expect(CreateProjectRequestSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });

  it('accepts nullable optional fields', () => {
    const r = CreateProjectRequestSchema.parse({
      ...base,
      testCommand: null,
      junitReportPath: null,
      defaultAgentId: null,
    });
    expect(r.testCommand).toBeNull();
  });
});

describe('CreateTaskRequestSchema', () => {
  const base = { projectId: ID, title: '  Fix bug  ', prompt: '  keep my spacing  ' };

  it('trims title but not prompt/acceptanceCriteria/scope', () => {
    const r = CreateTaskRequestSchema.parse({ ...base, acceptanceCriteria: ' a ', scope: ' s ' });
    expect(r.title).toBe('Fix bug');
    expect(r.prompt).toBe('  keep my spacing  ');
    expect(r.acceptanceCriteria).toBe(' a ');
    expect(r.scope).toBe(' s ');
  });

  it.each([
    [{ title: '' }],
    [{ title: 'x'.repeat(201) }],
    [{ prompt: '' }],
    [{ prompt: 'x'.repeat(TASK_TEXT_MAX_BYTES + 1) }],
    [{ acceptanceCriteria: 'x'.repeat(8001) }],
    [{ scope: 'x'.repeat(4001) }],
    [{ timeoutSeconds: 59 }],
    [{ timeoutSeconds: 86_401 }],
    [{ timeoutSeconds: 61.5 }],
    [{ maxBudgetUsd: 0 }],
    [{ maxBudgetUsd: 1000.01 }],
    [{ effort: 'max' }],
    [{ agentId: 'nope' }],
  ])('rejects %j', (patch) => {
    expect(CreateTaskRequestSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });
});

describe('RetryTaskRequestSchema', () => {
  it('defaults to fresh and allows baseRef only with fresh', () => {
    expect(RetryTaskRequestSchema.parse({})).toEqual({ mode: 'fresh' });
    expect(RetryTaskRequestSchema.parse({ baseRef: 'main' })).toEqual({
      mode: 'fresh',
      baseRef: 'main',
    });
    const r = RetryTaskRequestSchema.safeParse({ mode: 'continue', baseRef: 'main' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['baseRef']);
    expect(RetryTaskRequestSchema.safeParse({ mode: 'resume' }).success).toBe(false);
  });

  it('limits additionalInstructions by chars and UTF-8 bytes', () => {
    expect(
      RetryTaskRequestSchema.safeParse({ additionalInstructions: 'x'.repeat(8000) }).success,
    ).toBe(true);
    expect(
      RetryTaskRequestSchema.safeParse({ additionalInstructions: 'x'.repeat(8001) }).success,
    ).toBe(false);
    // 8000 three-byte chars = 24000 UTF-8 bytes: within both limits.
    expect(
      RetryTaskRequestSchema.safeParse({ additionalInstructions: '€'.repeat(8000) }).success,
    ).toBe(true);
    // Zod counts code points: 6144 four-byte chars = 24576 bytes (limit), one more exceeds the byte limit.
    expect(
      RetryTaskRequestSchema.safeParse({ additionalInstructions: '\u{1F600}'.repeat(6144) })
        .success,
    ).toBe(true);
    expect(
      RetryTaskRequestSchema.safeParse({ additionalInstructions: '\u{1F600}'.repeat(6145) })
        .success,
    ).toBe(false);
  });
});

describe('agents', () => {
  it('applies defaults and limits tool rules', () => {
    const base = {
      teamId: ID,
      name: 'a',
      title: 't',
      model: 'm',
      allowedTools: ['Read'],
      disallowedTools: [],
      maxTimeoutSeconds: 600,
    };
    expect(CreateAgentRequestSchema.parse(base)).toMatchObject({
      isManager: false,
      isActive: true,
    });
    expect(
      CreateAgentRequestSchema.safeParse({
        ...base,
        allowedTools: Array.from({ length: 65 }, () => 'Read'),
      }).success,
    ).toBe(false);
    expect(CreateAgentRequestSchema.safeParse({ ...base, maxTimeoutSeconds: 86_401 }).success).toBe(
      false,
    );
  });
});

describe('query schemas', () => {
  it('coerces numeric query strings and applies defaults', () => {
    expect(PageQuerySchema.parse({})).toEqual({ limit: 25 });
    expect(PageQuerySchema.parse({ limit: '100', cursor: 'abc' })).toEqual({
      limit: 100,
      cursor: 'abc',
    });
    for (const limit of ['0', '101', '1.5', 'abc', '', '-1']) {
      expect(PageQuerySchema.safeParse({ limit }).success, limit).toBe(false);
    }
    expect(PageQuerySchema.safeParse({ cursor: 'x'.repeat(513) }).success).toBe(false);
  });

  it('parses comma-separated and repeated task status filters', () => {
    expect(TaskListQuerySchema.parse({ status: 'queued, running' }).status).toEqual([
      'queued',
      'running',
    ]);
    expect(TaskListQuerySchema.parse({ status: ['queued', 'failed,blocked'] }).status).toEqual([
      'queued',
      'failed',
      'blocked',
    ]);
    expect(TaskListQuerySchema.safeParse({ status: 'queued,bogus' }).success).toBe(false);
    expect(TaskListQuerySchema.safeParse({ status: ',' }).success).toBe(false);
  });

  it('log query: afterSeq >= -1, limit <= 1000, text format requires stream', () => {
    expect(LogQuerySchema.parse({})).toEqual({ afterSeq: -1, limit: 500, format: 'json' });
    expect(LogQuerySchema.safeParse({ afterSeq: '-2' }).success).toBe(false);
    expect(LogQuerySchema.safeParse({ limit: '1001' }).success).toBe(false);
    expect(LogQuerySchema.safeParse({ format: 'text' }).success).toBe(false);
    expect(LogQuerySchema.parse({ format: 'text', stream: 'stdout' }).format).toBe('text');
  });

  it('audit query rejects from > to', () => {
    expect(
      AuditLogQuerySchema.safeParse({ from: NOW, to: '2026-11-01T00:00:00.000Z' }).success,
    ).toBe(false);
    expect(
      AuditLogQuerySchema.safeParse({ from: '2026-11-01T00:00:00.000Z', to: NOW }).success,
    ).toBe(true);
    expect(AuditLogQuerySchema.safeParse({ action: 'task.unknown' }).success).toBe(false);
  });
});

describe('queue payloads', () => {
  const job = { v: 1, taskId: ID, attemptId: SEQ_ID, attemptNumber: 1, correlationId: null };

  it('accepts a valid run-attempt job and rejects version, extra keys and bad numbers', () => {
    expect(RunAttemptJobDataSchema.parse(job)).toEqual(job);
    expect(RunAttemptJobDataSchema.safeParse({ ...job, v: 2 }).success).toBe(false);
    expect(RunAttemptJobDataSchema.safeParse({ ...job, extra: true }).success).toBe(false);
    expect(RunAttemptJobDataSchema.safeParse({ ...job, attemptNumber: 0 }).success).toBe(false);
    expect(
      RunAttemptJobDataSchema.safeParse({ ...job, correlationId: 'x'.repeat(129) }).success,
    ).toBe(false);
  });

  it('discriminates project jobs on kind', () => {
    const sync = {
      v: 1,
      kind: 'sync',
      projectId: ID,
      requestedByUserId: null,
      correlationId: null,
    };
    expect(ProjectJobDataSchema.parse(sync)).toEqual(sync);
    expect(ProjectJobDataSchema.safeParse({ ...sync, kind: 'index' }).success).toBe(false);
    expect(
      ProjectJobDataSchema.safeParse({ ...sync, kind: 'index', operationId: ID, mode: 'fast' })
        .success,
    ).toBe(true);
    expect(ProjectJobDataSchema.safeParse({ ...sync, mode: 'fast' }).success).toBe(false);
  });

  it('maintenance and dead-letter payloads', () => {
    expect(MaintenanceJobDataSchema.safeParse({ v: 1 }).success).toBe(true);
    expect(MaintenanceJobDataSchema.safeParse({ v: 1, x: 1 }).success).toBe(false);
    const dlq = {
      v: 1,
      sourceQueue: 'orc-tasks',
      jobName: 'run-attempt',
      jobId: ID,
      data: { anything: true },
      failedReason: 'x'.repeat(2000),
      attemptsMade: 3,
      failedAt: NOW,
    };
    expect(DeadLetterJobDataSchema.safeParse(dlq).success).toBe(true);
    expect(
      DeadLetterJobDataSchema.safeParse({ ...dlq, failedReason: 'x'.repeat(2001) }).success,
    ).toBe(false);
    expect(
      DeadLetterJobDataSchema.safeParse({ ...dlq, failedAt: '2026-11-02 10:00:00' }).success,
    ).toBe(false);
  });
});

describe('stream, control and heartbeat payloads', () => {
  it('discriminates task stream events on type', () => {
    const status = {
      v: 1,
      type: 'status',
      taskId: ID,
      attemptId: null,
      attemptNumber: null,
      status: 'queued',
      previousStatus: 'created',
      reason: null,
      detail: null,
      cancelRequested: false,
      at: NOW,
    };
    expect(TaskStreamEventSchema.parse(status).type).toBe('status');
    expect(TaskStreamEventSchema.safeParse({ ...status, snapshot: false }).success).toBe(false);
    expect(TaskStreamEventSchema.safeParse({ ...status, snapshot: true, gap: true }).success).toBe(
      true,
    );
    expect(TaskStreamEventSchema.safeParse({ ...status, type: 'heartbeat' }).success).toBe(false);
    const end = {
      v: 1,
      type: 'end',
      taskId: ID,
      attemptId: ID,
      status: 'running',
      reason: null,
      at: NOW,
    };
    expect(TaskStreamEventSchema.safeParse(end).success).toBe(false);
    expect(TaskStreamEventSchema.safeParse({ ...end, status: 'completed' }).success).toBe(true);
    const log = {
      v: 1,
      type: 'log',
      taskId: ID,
      attemptId: ID,
      seq: 0,
      stream: 'claude',
      source: 'claude',
      content: 'x',
      at: NOW,
    };
    expect(TaskStreamEventSchema.safeParse(log).success).toBe(false);
    expect(TaskStreamEventSchema.safeParse({ ...log, stream: 'stderr' }).success).toBe(true);
  });

  it('validates control messages and heartbeats', () => {
    const cancel = {
      v: 1,
      type: 'cancel',
      taskId: ID,
      attemptId: ID,
      requestedByUserId: ID,
      requestedAt: NOW,
      correlationId: null,
    };
    expect(ControlMessageSchema.parse(cancel)).toEqual(cancel);
    expect(ControlMessageSchema.safeParse({ ...cancel, type: 'kill' }).success).toBe(false);
    const hb = {
      v: 1,
      workerId: 'w1',
      hostname: 'h',
      pid: 1,
      status: 'ready',
      concurrency: 2,
      activeAttemptIds: [ID],
      at: NOW,
    };
    expect(WorkerHeartbeatSchema.safeParse(hb).success).toBe(true);
    expect(WorkerHeartbeatSchema.safeParse({ ...hb, status: 'busy' }).success).toBe(false);
  });
});

describe('response schemas', () => {
  it('Task schema requires every field and validates enums', () => {
    const task = {
      id: ID,
      projectId: ID,
      agentId: ID,
      createdByUserId: ID,
      title: 't',
      prompt: 'p',
      acceptanceCriteria: null,
      scope: null,
      baseRef: null,
      model: 'm',
      effort: null,
      timeoutSeconds: 3600,
      maxBudgetUsd: null,
      status: 'queued',
      statusReason: null,
      statusDetail: null,
      currentAttemptId: ID,
      attemptCount: 1,
      autoRecoveryCount: 0,
      cancelRequestedAt: null,
      cancelRequestedByUserId: null,
      correlationId: null,
      queuedAt: NOW,
      startedAt: null,
      finishedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(TaskSchema.safeParse(task).success).toBe(true);
    expect(TaskSchema.safeParse({ ...task, statusReason: 'bogus' }).success).toBe(false);
    const { updatedAt: _omitted, ...missing } = task;
    expect(TaskSchema.safeParse(missing).success).toBe(false);
    expect(pageOf(TaskSchema).safeParse({ items: [task], nextCursor: null }).success).toBe(true);
  });

  it('ProblemDetails requires a catalogued code', () => {
    const p = {
      type: '/api/v1/problems/not_found',
      title: 'x',
      status: 404,
      code: 'not_found',
      requestId: 'r',
      correlationId: 'c',
    };
    expect(ProblemDetailsSchema.safeParse(p).success).toBe(true);
    expect(ProblemDetailsSchema.safeParse({ ...p, code: 'teapot' }).success).toBe(false);
  });
});
