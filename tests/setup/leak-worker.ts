// Vitest setupFile of the infrastructure projects (B-005). Records the PID, the parent PID (the Vitest main
// process) and the time window of this worker's test file in the file task's meta, which Vitest reports to the
// main process. On Windows an orphaned process keeps the PID of its exited parent, so the leak guard
// (tests/setup/global-teardown.ts) can only prove that a leaked fake-claude was started by one of THIS run's workers
// when it knows when that worker held the PID. Nothing is written to disk, nothing is spawned.
import { afterAll, beforeAll } from 'vitest';
import type { WorkerRecord } from './leak-worker-record';

const startedAtMs = Date.now();

function record(endedAtMs: number | null): WorkerRecord {
  return { pid: process.pid, ppid: process.ppid, startedAtMs, endedAtMs };
}

// Vitest 5 parses the first hook parameter as a fixture pattern; the file task is the second parameter.
// eslint-disable-next-line no-empty-pattern
beforeAll(({}, file) => {
  file.meta.orcLeakWorker = record(null);
});

// Registered first, so it runs after every afterAll of the test file itself (hooks run in stack order).
// eslint-disable-next-line no-empty-pattern
afterAll(({}, file) => {
  file.meta.orcLeakWorker = record(Date.now());
});
