// Request DTOs and query schemas (contract §3.3).
// Body schemas are strict; strings are trimmed except prompt, acceptanceCriteria, scope,
// additionalInstructions, instructions and passwords. Config-dependent limits (TASK_PROMPT_MAX_CHARS,
// CLAUDE_MAX_TIMEOUT_SECONDS, WORKSPACE_MAX_BYTES, allowed models) and the @orc/security validators
// (normalizeRepoRelativePath, isSafeRefName, validateTestCommand, computeToolPolicy) are applied by the services.
import { z } from 'zod';
import {
  AGENT_INSTRUCTIONS_MAX_BYTES,
  AGENT_INSTRUCTIONS_MAX_CHARS,
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  EFFORT_LEVELS,
  INDEX_MODES,
  LOG_STREAMS,
  PERMISSIONS,
  PROJECT_STATUSES,
  ROLES,
  TASK_STATUSES,
  TASK_TEXT_MAX_BYTES,
  TEST_CASE_STATUSES,
} from '../constants';
import { utf8Length } from '../primitives';
import {
  AT_LEAST_ONE_KEY,
  IdSchema,
  IsoDateTimeSchema,
  hasAtLeastOneKey,
  queryInt,
} from './common';
import { ApiTokenSchema, UserSchema } from './domain';

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);
const raw = (min: number, max: number) => z.string().min(min).max(max);
const password = (min: number) => raw(min, 256);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

// ---- auth / users ---------------------------------------------------------------

export const LoginRequestSchema = z.strictObject({
  username: z.string().trim().toLowerCase().min(1).max(64),
  password: password(1),
});
export type LoginRequest = z.output<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  user: UserSchema,
  csrfToken: z.string(),
  expiresAt: IsoDateTimeSchema,
  permissions: z.array(z.enum(PERMISSIONS)),
});
export type LoginResponse = z.output<typeof LoginResponseSchema>;

export const MeResponseSchema = z.object({
  user: UserSchema,
  permissions: z.array(z.enum(PERMISSIONS)),
  authMethod: z.enum(['session', 'token']),
  csrfToken: z.string().nullable(),
  sessionExpiresAt: IsoDateTimeSchema.nullable(),
  tokenReadOnly: z.boolean(),
});
export type MeResponse = z.output<typeof MeResponseSchema>;

export const ChangePasswordRequestSchema = z.strictObject({
  currentPassword: password(1),
  newPassword: password(12),
});
export type ChangePasswordRequest = z.output<typeof ChangePasswordRequestSchema>;

export const CreateApiTokenRequestSchema = z.strictObject({
  name: trimmed(1, 100),
  expiresInDays: z.int().min(1).max(365).default(90),
  readOnly: z.boolean().default(false),
});
export type CreateApiTokenRequest = z.output<typeof CreateApiTokenRequestSchema>;

export const CreatedApiTokenSchema = z.object({
  token: z.string(),
  apiToken: ApiTokenSchema,
});
export type CreatedApiToken = z.output<typeof CreatedApiTokenSchema>;

const email = z.string().trim().max(254).pipe(z.email());

export const CreateUserRequestSchema = z.strictObject({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z0-9][a-z0-9._-]{2,63}$/,
      'Username must be 3..64 chars of a-z 0-9 . _ - and start alphanumeric',
    ),
  displayName: trimmed(1, 128),
  email: email.nullable().optional(),
  role: z.enum(ROLES),
  password: password(12),
});
export type CreateUserRequest = z.output<typeof CreateUserRequestSchema>;

export const UpdateUserRequestSchema = z
  .strictObject({
    displayName: trimmed(1, 128).optional(),
    email: email.nullable().optional(),
    role: z.enum(ROLES).optional(),
    isActive: z.boolean().optional(),
    password: password(12).optional(),
  })
  .refine(hasAtLeastOneKey, AT_LEAST_ONE_KEY);
export type UpdateUserRequest = z.output<typeof UpdateUserRequestSchema>;

// ---- projects -----------------------------------------------------------------------

const projectName = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,99}$/,
    'Name must be 2..100 chars of A-Z a-z 0-9 space . _ - and start alphanumeric',
  );

/** Mutable project fields without defaults (shared by create and update). */
const projectFields = {
  name: projectName,
  description: optionalText(2000),
  defaultBranch: trimmed(1, 200).nullable().optional(),
  testCommand: z.array(raw(1, 1024)).min(1).max(32).nullable().optional(),
  testTimeoutSeconds: z.int().min(30).max(7200),
  junitReportPath: trimmed(1, 400).nullable().optional(),
  requireIndex: z.boolean(),
  autoIndex: z.boolean(),
  indexMode: z.enum(INDEX_MODES),
  defaultAgentId: IdSchema.nullable().optional(),
  defaultTimeoutSeconds: z.int().min(60).max(86_400),
  workspaceMaxBytes: z.int().min(104_857_600).nullable().optional(),
};

export const CreateProjectRequestSchema = z.strictObject({
  ...projectFields,
  repoPath: trimmed(1, 255),
  testTimeoutSeconds: projectFields.testTimeoutSeconds.default(900),
  requireIndex: projectFields.requireIndex.default(false),
  autoIndex: projectFields.autoIndex.default(true),
  indexMode: projectFields.indexMode.default('moderate'),
  defaultTimeoutSeconds: projectFields.defaultTimeoutSeconds.default(3600),
});
export type CreateProjectRequest = z.output<typeof CreateProjectRequestSchema>;

export const UpdateProjectRequestSchema = z
  .strictObject({
    name: projectFields.name.optional(),
    description: projectFields.description,
    defaultBranch: projectFields.defaultBranch,
    testCommand: projectFields.testCommand,
    testTimeoutSeconds: projectFields.testTimeoutSeconds.optional(),
    junitReportPath: projectFields.junitReportPath,
    requireIndex: projectFields.requireIndex.optional(),
    autoIndex: projectFields.autoIndex.optional(),
    indexMode: projectFields.indexMode.optional(),
    defaultAgentId: projectFields.defaultAgentId,
    defaultTimeoutSeconds: projectFields.defaultTimeoutSeconds.optional(),
    workspaceMaxBytes: projectFields.workspaceMaxBytes,
    archived: z.boolean().optional(),
  })
  .refine(hasAtLeastOneKey, AT_LEAST_ONE_KEY);
export type UpdateProjectRequest = z.output<typeof UpdateProjectRequestSchema>;

export const RequestIndexRequestSchema = z.strictObject({
  mode: z.enum(INDEX_MODES).optional(),
});
export type RequestIndexRequest = z.output<typeof RequestIndexRequestSchema>;

// ---- tasks ------------------------------------------------------------------------------

const refName = trimmed(1, 200);

export const CreateTaskRequestSchema = z.strictObject({
  projectId: IdSchema,
  agentId: IdSchema.optional(),
  title: trimmed(1, 200),
  /**
   * Absolute ceiling; the configured TASK_PROMPT_MAX_CHARS and TASK_TEXT_MAX_BYTES are enforced by
   * TaskService. Whitespace-only prompts are rejected (SQL LEN() ignores trailing spaces).
   */
  prompt: raw(1, TASK_TEXT_MAX_BYTES).refine((s) => /\S/.test(s), {
    message: 'Prompt must contain a non-whitespace character',
  }),
  acceptanceCriteria: z.string().max(8000).nullable().optional(),
  scope: z.string().max(4000).nullable().optional(),
  baseRef: refName.nullable().optional(),
  model: trimmed(1, 100).optional(),
  effort: z.enum(EFFORT_LEVELS).nullable().optional(),
  timeoutSeconds: z.int().min(60).max(86_400).optional(),
  maxBudgetUsd: z.number().min(0.01).max(1000).nullable().optional(),
});
export type CreateTaskRequest = z.output<typeof CreateTaskRequestSchema>;

export const CancelTaskRequestSchema = z.strictObject({
  reason: z.string().trim().max(500).optional(),
});
export type CancelTaskRequest = z.output<typeof CancelTaskRequestSchema>;

export const RetryTaskRequestSchema = z
  .strictObject({
    mode: z.enum(['fresh', 'continue']).default('fresh'),
    additionalInstructions: z
      .string()
      .max(8000)
      .refine((s) => utf8Length(s) <= 24_576, {
        message: 'Too big: expected at most 24576 UTF-8 bytes',
      })
      .nullable()
      .optional(),
    baseRef: refName.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.baseRef !== undefined && value.mode !== 'fresh') {
      ctx.addIssue({
        code: 'custom',
        path: ['baseRef'],
        message: 'baseRef is only allowed with mode "fresh"',
      });
    }
  });
export type RetryTaskRequest = z.output<typeof RetryTaskRequestSchema>;

// ---- agents / teams -----------------------------------------------------------------

const toolRules = z.array(trimmed(1, 512)).max(64);

const agentFields = {
  teamId: IdSchema,
  parentAgentId: IdSchema.nullable().optional(),
  name: trimmed(1, 100),
  title: trimmed(1, 100),
  description: optionalText(2000),
  isManager: z.boolean(),
  model: trimmed(1, 100),
  effort: z.enum(EFFORT_LEVELS).nullable().optional(),
  allowedTools: toolRules,
  disallowedTools: toolRules,
  /** <= 4000 chars and <= 4096 UTF-8 bytes so Layer 1 stays within APPEND_SYSTEM_PROMPT_MAX_BYTES. */
  instructions: z
    .string()
    .max(AGENT_INSTRUCTIONS_MAX_CHARS)
    .refine((s) => utf8Length(s) <= AGENT_INSTRUCTIONS_MAX_BYTES, {
      message: `Too big: expected at most ${AGENT_INSTRUCTIONS_MAX_BYTES} UTF-8 bytes`,
    })
    .nullable()
    .optional(),
  maxTimeoutSeconds: z.int().min(60).max(86_400),
  maxBudgetUsd: z.number().min(0.01).max(1000).nullable().optional(),
  isActive: z.boolean(),
};

export const CreateAgentRequestSchema = z.strictObject({
  ...agentFields,
  isManager: agentFields.isManager.default(false),
  isActive: agentFields.isActive.default(true),
});
export type CreateAgentRequest = z.output<typeof CreateAgentRequestSchema>;

export const UpdateAgentRequestSchema = z
  .strictObject({
    teamId: agentFields.teamId.optional(),
    parentAgentId: agentFields.parentAgentId,
    name: agentFields.name.optional(),
    title: agentFields.title.optional(),
    description: agentFields.description,
    isManager: agentFields.isManager.optional(),
    model: agentFields.model.optional(),
    effort: agentFields.effort,
    allowedTools: agentFields.allowedTools.optional(),
    disallowedTools: agentFields.disallowedTools.optional(),
    instructions: agentFields.instructions,
    maxTimeoutSeconds: agentFields.maxTimeoutSeconds.optional(),
    maxBudgetUsd: agentFields.maxBudgetUsd,
    isActive: agentFields.isActive.optional(),
  })
  .refine(hasAtLeastOneKey, AT_LEAST_ONE_KEY);
export type UpdateAgentRequest = z.output<typeof UpdateAgentRequestSchema>;

const teamFields = {
  name: trimmed(1, 100),
  description: optionalText(2000),
  managerAgentId: IdSchema.nullable().optional(),
  ownedPaths: z.array(trimmed(1, 200)).max(50).optional(),
};

export const CreateTeamRequestSchema = z.strictObject(teamFields);
export type CreateTeamRequest = z.output<typeof CreateTeamRequestSchema>;

export const UpdateTeamRequestSchema = z
  .strictObject({ ...teamFields, name: teamFields.name.optional() })
  .refine(hasAtLeastOneKey, AT_LEAST_ONE_KEY);
export type UpdateTeamRequest = z.output<typeof UpdateTeamRequestSchema>;

// ---- query / params schemas (unknown query keys are ignored) --------------------------------

const cursor = z.string().min(1).max(512).optional();

export const PageQuerySchema = z.object({
  limit: queryInt(1, 100).default(25),
  cursor,
});
export type PageQuery = z.output<typeof PageQuerySchema>;

const statusList = z
  .union([z.string(), z.array(z.string())])
  .transform((v) =>
    (Array.isArray(v) ? v : [v])
      .flatMap((s) => s.split(','))
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
  .pipe(z.array(z.enum(TASK_STATUSES)).min(1).max(TASK_STATUSES.length));

export const TaskListQuerySchema = PageQuerySchema.extend({
  projectId: IdSchema.optional(),
  status: statusList.optional(),
  createdBy: IdSchema.optional(),
});
export type TaskListQuery = z.output<typeof TaskListQuerySchema>;

export const ProjectListQuerySchema = PageQuerySchema.extend({
  status: z.enum(PROJECT_STATUSES).optional(),
});
export type ProjectListQuery = z.output<typeof ProjectListQuerySchema>;

export const AuditLogQuerySchema = PageQuerySchema.extend({
  actorUserId: IdSchema.optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  entityType: z.enum(AUDIT_ENTITY_TYPES).optional(),
  entityId: trimmed(1, 128).optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
}).superRefine((q, ctx) => {
  if (q.from !== undefined && q.to !== undefined && Date.parse(q.from) > Date.parse(q.to)) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: '"to" must not be before "from"' });
  }
});
export type AuditLogQuery = z.output<typeof AuditLogQuerySchema>;

export const AttemptQuerySchema = z.object({
  attemptId: IdSchema.optional(),
});
export type AttemptQuery = z.output<typeof AttemptQuerySchema>;

export const LogQuerySchema = z
  .object({
    attemptId: IdSchema.optional(),
    stream: z.enum(LOG_STREAMS).optional(),
    afterSeq: queryInt(-1, 2_147_483_647).default(-1),
    limit: queryInt(1, 1000).default(500),
    format: z.enum(['json', 'text']).default('json'),
  })
  .superRefine((q, ctx) => {
    if (q.format === 'text' && q.stream === undefined) {
      ctx.addIssue({ code: 'custom', path: ['stream'], message: 'format=text requires stream' });
    }
  });
export type LogQuery = z.output<typeof LogQuerySchema>;

export const DiffQuerySchema = z.object({
  attemptId: IdSchema.optional(),
  path: z.string().min(1).max(1024).optional(),
  limit: queryInt(1, 50).default(20),
  cursor,
});
export type DiffQuery = z.output<typeof DiffQuerySchema>;

export const TestResultQuerySchema = z.object({
  limit: queryInt(1, 500).default(25),
  cursor,
  status: z.enum(TEST_CASE_STATUSES).optional(),
});
export type TestResultQuery = z.output<typeof TestResultQuerySchema>;

/** Route id parameter: GUID, case-insensitive input, normalized lower-case. */
export const IdParamSchema = IdSchema;
export type IdParam = z.output<typeof IdParamSchema>;
