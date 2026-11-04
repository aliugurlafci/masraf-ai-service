// BullMQ job payloads (contract §6.2). Job data always carries v: 1 and is strict.
import { z } from 'zod';
import { INDEX_MODES } from '../constants';
import { IdSchema as Id } from './common';

const correlationId = z.string().max(128).nullable();

export const RunAttemptJobDataSchema = z.strictObject({
  v: z.literal(1),
  taskId: Id,
  attemptId: Id,
  attemptNumber: z.int().min(1),
  correlationId,
});
export type RunAttemptJobData = z.infer<typeof RunAttemptJobDataSchema>;

export const ProjectJobDataSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    v: z.literal(1),
    kind: z.literal('sync'),
    projectId: Id,
    requestedByUserId: Id.nullable(),
    correlationId,
  }),
  z.strictObject({
    v: z.literal(1),
    kind: z.literal('index'),
    projectId: Id,
    operationId: Id,
    mode: z.enum(INDEX_MODES),
    requestedByUserId: Id.nullable(),
    correlationId,
  }),
]);
export type ProjectJobData = z.infer<typeof ProjectJobDataSchema>;

export const MaintenanceJobDataSchema = z.strictObject({ v: z.literal(1) });
export type MaintenanceJobData = z.infer<typeof MaintenanceJobDataSchema>;

export const DeadLetterJobDataSchema = z.strictObject({
  v: z.literal(1),
  sourceQueue: z.string(),
  jobName: z.string(),
  jobId: z.string(),
  data: z.unknown(),
  failedReason: z.string().max(2000),
  attemptsMade: z.int(),
  failedAt: z.iso.datetime(),
});
export type DeadLetterJobData = z.infer<typeof DeadLetterJobDataSchema>;

/** Result of a maintenance job handler (contract §6.5). */
export interface MaintenanceReport {
  job: string;
  durationMs: number;
  counts: Record<string, number>;
  errors: string[];
}
