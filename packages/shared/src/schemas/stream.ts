// Redis stream / SSE / control payloads (contract §7, §8).
import { z } from 'zod';
import {
  FAILURE_REASONS,
  LOG_SOURCES,
  MERGE_CHECK_STATUSES,
  SETTLED_TASK_STATUSES,
  TASK_STATUSES,
  TEST_RUN_STATUSES,
  WORKER_STATUSES,
} from '../constants';
import { ERROR_CODES } from '../errors';
import { ClaudeEventPayloadSchema } from './claude';
import { IdSchema, IsoDateTimeSchema, nonNegInt } from './common';

export const StatusEventPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('status'),
  taskId: IdSchema,
  attemptId: IdSchema.nullable(),
  attemptNumber: z.int().min(1).nullable(),
  status: z.enum(TASK_STATUSES),
  previousStatus: z.enum(TASK_STATUSES).nullable(),
  reason: z.enum(FAILURE_REASONS).nullable(),
  detail: z.string().nullable(),
  cancelRequested: z.boolean(),
  at: IsoDateTimeSchema,
  /** SSE only. */
  snapshot: z.literal(true).optional(),
  /** SSE only. */
  gap: z.literal(true).optional(),
});
export type StatusEventPayload = z.infer<typeof StatusEventPayloadSchema>;

export const LogEventPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('log'),
  taskId: IdSchema,
  attemptId: IdSchema,
  seq: nonNegInt,
  stream: z.enum(['stdout', 'stderr', 'system']),
  source: z.enum(LOG_SOURCES),
  content: z.string(),
  at: IsoDateTimeSchema,
});
export type LogEventPayload = z.infer<typeof LogEventPayloadSchema>;

export const TestEventPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('test'),
  taskId: IdSchema,
  attemptId: IdSchema,
  testRunId: IdSchema,
  status: z.enum(TEST_RUN_STATUSES),
  total: nonNegInt,
  passed: nonNegInt,
  failed: nonNegInt,
  errored: nonNegInt,
  skipped: nonNegInt,
  durationMs: nonNegInt.nullable(),
  at: IsoDateTimeSchema,
});
export type TestEventPayload = z.infer<typeof TestEventPayloadSchema>;

export const DiffEventPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('diff'),
  taskId: IdSchema,
  attemptId: IdSchema,
  filesChanged: nonNegInt,
  additions: nonNegInt,
  deletions: nonNegInt,
  headSha: z.string(),
  mergeCheck: z.enum(MERGE_CHECK_STATUSES),
  patchAvailable: z.boolean(),
  at: IsoDateTimeSchema,
});
export type DiffEventPayload = z.infer<typeof DiffEventPayloadSchema>;

export const EndEventPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('end'),
  taskId: IdSchema,
  attemptId: IdSchema.nullable(),
  status: z.enum(SETTLED_TASK_STATUSES),
  reason: z.enum(FAILURE_REASONS).nullable(),
  at: IsoDateTimeSchema,
});
export type EndEventPayload = z.infer<typeof EndEventPayloadSchema>;

/** Field `e` of every `<P>:task:<taskId>:events` stream entry. */
export const TaskStreamEventSchema = z.discriminatedUnion('type', [
  StatusEventPayloadSchema,
  LogEventPayloadSchema,
  ClaudeEventPayloadSchema,
  TestEventPayloadSchema,
  DiffEventPayloadSchema,
  EndEventPayloadSchema,
]);
export type TaskStreamEvent = z.infer<typeof TaskStreamEventSchema>;

/** SSE only. */
export const HeartbeatEventPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('heartbeat'),
  at: IsoDateTimeSchema,
});
export type HeartbeatEventPayload = z.infer<typeof HeartbeatEventPayloadSchema>;

/** SSE only. */
export const ErrorEventPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('error'),
  code: z.enum(ERROR_CODES),
  message: z.string(),
  at: IsoDateTimeSchema,
});
export type ErrorEventPayload = z.infer<typeof ErrorEventPayloadSchema>;

export const CancelControlMessageSchema = z.object({
  v: z.literal(1),
  type: z.literal('cancel'),
  taskId: IdSchema,
  attemptId: IdSchema,
  requestedByUserId: IdSchema,
  requestedAt: IsoDateTimeSchema,
  correlationId: z.string().max(128).nullable(),
});
export type CancelControlMessage = z.infer<typeof CancelControlMessageSchema>;

/** `<P>:control` pub/sub payload. */
export const ControlMessageSchema = z.discriminatedUnion('type', [CancelControlMessageSchema]);
export type ControlMessage = z.infer<typeof ControlMessageSchema>;

/** `<P>:worker:<workerId>:hb` value. */
export const WorkerHeartbeatSchema = z.object({
  v: z.literal(1),
  workerId: z.string().min(1).max(128),
  hostname: z.string(),
  pid: z.int().min(0),
  status: z.enum(WORKER_STATUSES),
  concurrency: z.int().min(0),
  activeAttemptIds: z.array(IdSchema),
  at: IsoDateTimeSchema,
});
export type WorkerHeartbeat = z.infer<typeof WorkerHeartbeatSchema>;
