// Contract v2.0.0 schema/error rules (F3, F9, F10, F12, T-M7, T-m3, T-m4, T-m7).
import { describe, expect, it } from 'vitest';
import {
  AGENT_INSTRUCTIONS_MAX_BYTES,
  APPEND_SYSTEM_PROMPT_MAX_BYTES,
  AUDIT_ACTIONS,
  BigIdSchema,
  ChangedFileSchema,
  CLAUDE_EVENT_TEXT_MAX_CHARS,
  CreateAgentRequestSchema,
  CreateTaskRequestSchema,
  ERROR_CODES,
  MCP_OPERATION_KINDS,
  QueueStatusSchema,
  TASK_SCOPED_MCP_OPERATION_KINDS,
  toPublicError,
  UpdateAgentRequestSchema,
} from '@orc/shared';

const ID = '0b6f1e2a-1111-4222-8333-444455556666';

describe('task prompt (T-m4)', () => {
  it('rejects whitespace-only prompts', () => {
    const base = { projectId: ID, title: 'Fix it' };
    expect(CreateTaskRequestSchema.safeParse({ ...base, prompt: '   \n\t ' }).success).toBe(false);
    expect(CreateTaskRequestSchema.safeParse({ ...base, prompt: '  x  ' }).success).toBe(true);
    expect(CreateTaskRequestSchema.safeParse({ ...base, title: '   ', prompt: 'x' }).success).toBe(
      false,
    );
  });
});

describe('agent instructions (F10, T-m7)', () => {
  const agent = {
    teamId: ID,
    name: 'a',
    title: 't',
    model: 'claude-a',
    allowedTools: [],
    disallowedTools: [],
    maxTimeoutSeconds: 600,
  };

  it('allows 4000 ASCII chars but at most 4096 UTF-8 bytes', () => {
    expect(AGENT_INSTRUCTIONS_MAX_BYTES).toBe(4096);
    expect(APPEND_SYSTEM_PROMPT_MAX_BYTES).toBe(8192);
    expect(
      CreateAgentRequestSchema.safeParse({ ...agent, instructions: 'x'.repeat(4000) }).success,
    ).toBe(true);
    expect(
      CreateAgentRequestSchema.safeParse({ ...agent, instructions: 'x'.repeat(4001) }).success,
    ).toBe(false);
    // 1366 three-byte chars = 4098 bytes: within 4000 chars but over the byte budget.
    expect(
      CreateAgentRequestSchema.safeParse({ ...agent, instructions: '€'.repeat(1366) }).success,
    ).toBe(false);
    expect(
      CreateAgentRequestSchema.safeParse({ ...agent, instructions: '€'.repeat(1365) }).success,
    ).toBe(true);
    expect(UpdateAgentRequestSchema.safeParse({ instructions: '€'.repeat(1366) }).success).toBe(
      false,
    );
    expect(UpdateAgentRequestSchema.safeParse({ instructions: null }).success).toBe(true);
  });
});

describe('BigIdSchema range (T-m3)', () => {
  it('accepts 1..9223372036854775807 only', () => {
    expect(BigIdSchema.safeParse('9223372036854775807').success).toBe(true);
    expect(BigIdSchema.safeParse('9223372036854775808').success).toBe(false);
    expect(BigIdSchema.safeParse('9999999999999999999').success).toBe(false);
    expect(BigIdSchema.safeParse('1').success).toBe(true);
    expect(BigIdSchema.safeParse('0').success).toBe(false);
  });
});

describe('toPublicError (F9)', () => {
  it('maps dependency failures to 503 dependency_unavailable with Retry-After 5', () => {
    for (const code of ['db_unavailable', 'db_deadlock', 'redis_unavailable'] as const) {
      expect(toPublicError(code)).toEqual({
        code: 'dependency_unavailable',
        status: 503,
        retryAfterSeconds: 5,
      });
    }
  });

  it('maps other internal codes to 500 internal_error and keeps public codes', () => {
    expect(toPublicError('git_failed')).toEqual({
      code: 'internal_error',
      status: 500,
      retryAfterSeconds: null,
    });
    expect(toPublicError('not_found')).toEqual({
      code: 'not_found',
      status: 404,
      retryAfterSeconds: null,
    });
    expect(ERROR_CODES).toContain('redis_unavailable');
  });
});

describe('index-operation visibility and retention DTOs (F3, F12, T-M7)', () => {
  it('lists the task-scoped MCP operation kinds', () => {
    expect(TASK_SCOPED_MCP_OPERATION_KINDS).toEqual([
      'task_index',
      'task_reindex',
      'impact_analysis',
    ]);
    for (const k of TASK_SCOPED_MCP_OPERATION_KINDS) expect(MCP_OPERATION_KINDS).toContain(k);
    expect(AUDIT_ACTIONS).toContain('maintenance.audit_purged');
  });

  it('requires patchPurged on changed files and redisMemory on queue status', () => {
    const file = {
      id: '1',
      attemptId: ID,
      taskId: ID,
      path: 'a.ts',
      oldPath: null,
      changeType: 'M',
      similarity: null,
      additions: 1,
      deletions: 0,
      isBinary: false,
      patchBytes: 10,
      patchTruncated: false,
      createdAt: '2026-11-02T10:00:00.000Z',
    };
    expect(ChangedFileSchema.safeParse(file).success).toBe(false);
    expect(ChangedFileSchema.safeParse({ ...file, patchPurged: true }).success).toBe(true);
    const status = { queues: [], deadLetterCount: 0, checkedAt: '2026-11-02T10:00:00.000Z' };
    expect(QueueStatusSchema.safeParse({ ...status, redisMemory: null }).success).toBe(true);
    expect(
      QueueStatusSchema.safeParse({
        ...status,
        redisMemory: { usedBytes: 1024, maxBytes: 419_430_400, policy: 'noeviction' },
      }).success,
    ).toBe(true);
    expect(QueueStatusSchema.safeParse(status).success).toBe(false);
    expect(CLAUDE_EVENT_TEXT_MAX_CHARS).toBe(2000);
  });
});
