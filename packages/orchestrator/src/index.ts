// @orc/orchestrator — attempt pipeline, BullMQ processors, heartbeat and recovery (contract §2.11, §13).
export type {
  AbortReason,
  ActiveAttempt,
  ActiveAttemptHooks,
  ActiveAttemptRegistry,
  AttemptLogSink,
  AttemptOutcome,
  AttemptPipeline,
  Heartbeat,
  OrchestratorConfig,
  OrchestratorDeps,
  ParsedJUnit,
  RetentionConfig,
  SupersedeKind,
  TestRunOutcome,
  TestRunner,
  WorkerNodeInfo,
} from './types.js';
export { createActiveAttemptRegistry } from './active-registry.js';
export { LOG_CHUNK_MAX_CHARS, PARTIAL_LINE_MAX_AGE_MS, createAttemptLogSink, splitChunks } from './log-sink.js';
export { parseJUnitXml } from './junit.js';
export { createTestRunner, testProcessKey } from './test-runner.js';
export {
  STALLED_LIMIT_TEXT,
  classifyJobFailure,
  claudeSessionStatusFor,
  isTransientDbError,
  mapAbortReason,
  mapClaudeOutcome,
  pendingTestReason,
} from './outcome.js';
export type { DeadLetterDecision, StageDecision } from './outcome.js';
export { DbWriteAbandonedError, withDbRetry } from './util.js';
export { createDbGitOperationRecorder, createDbMcpOperationRecorder } from './recorders.js';
export type { DbMcpOperationRecorder } from './recorders.js';
export { commitMessage, createAttemptPipeline, resultSummary, workerHeartbeatKey } from './pipeline.js';
export { createDeadLetterHandler, createProjectJobProcessor, createRunAttemptProcessor } from './processors.js';
export { DB_FAILURES_UNHEALTHY, createHeartbeat } from './heartbeat.js';
export type { HeartbeatDeps } from './heartbeat.js';
export {
  WORKER_JOB_SCHEDULERS,
  createMaintenanceProcessor,
  recoverOnStartup,
  registerJobSchedulers,
  sweepWorkerOrphans,
} from './maintenance.js';
