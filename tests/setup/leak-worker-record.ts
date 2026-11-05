// Worker record of the test leak guard (B-005). tests/setup/leak-worker.ts (a Vitest setupFile) stores it in the
// file task's meta; Vitest sends task meta to the main process, where tests/setup/global-teardown.ts reads it back
// through the test modules of the run and validates it with WorkerRecordSchema.
import { z } from 'zod';

/** One test file run by one worker process: [startedAtMs, endedAtMs] is a window in which `pid` was alive. */
export const WorkerRecordSchema = z.object({
  pid: z.number().int().positive(),
  ppid: z.number().int().nonnegative(),
  startedAtMs: z.number().int().positive(),
  endedAtMs: z.number().int().positive().nullable(),
});

export type WorkerRecord = z.infer<typeof WorkerRecordSchema>;

declare module 'vitest' {
  interface TaskMeta {
    /** Set by tests/setup/leak-worker.ts on the file task (B-005). */
    orcLeakWorker?: WorkerRecord;
  }
}
