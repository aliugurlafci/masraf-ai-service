// Worker-side row seeding for API tests (orc_worker writes what a real worker would: claim, settle, artefacts, logs).
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { Database, NewChangedFile } from '@orc/database';
import type { FailureReason, MergeCheck } from '@orc/shared';
import { WORKER_ID, workerActor } from '../database/fixtures';

export const SAMPLE_PATCH_A = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
export const SAMPLE_PATCH_B = '--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1,2 @@\n x\n+y\n';

function changedFile(path: string, patch: string): NewChangedFile {
  return {
    path,
    oldPath: null,
    changeType: 'M',
    similarity: null,
    additions: 1,
    deletions: 1,
    isBinary: false,
    patch,
    patchBytes: Buffer.byteLength(patch),
    patchTruncated: false,
  };
}

/** claimAttempt (task queued -> preparing_workspace, attempt active). */
export async function claim(worker: Database, attemptId: string): Promise<void> {
  const claimed = await worker.repos.taskState.claimAttempt({ attemptId, workerId: WORKER_ID, actor: workerActor });
  if (!claimed) throw new Error('claim failed');
}

/** preparing_workspace -> failed (settles the task and its attempt). */
export async function settleFailed(
  worker: Database,
  taskId: string,
  attemptId: string,
  reason: FailureReason = 'internal_error',
): Promise<void> {
  await worker.repos.taskState.transition({
    taskId,
    from: 'preparing_workspace',
    to: 'failed',
    attemptId,
    attemptStatus: 'failed',
    reason,
    actor: workerActor,
    correlationId: null,
  });
}

export interface SeededArtefacts {
  testRunId: string;
  impactOperationId: string;
}

/** Changed files + patch, a finished test run with results, merge check, Claude session, impact analysis, logs. */
export async function seedArtefacts(
  worker: Database,
  w: { projectId: string; taskId: string; attemptId: string },
): Promise<SeededArtefacts> {
  const { projectId, taskId, attemptId } = w;
  const repos = worker.repos;
  await repos.changedFiles.replaceForAttempt(attemptId, taskId, [
    changedFile('src/a.ts', SAMPLE_PATCH_A),
    changedFile('src/b.ts', SAMPLE_PATCH_B),
  ]);
  const raw = Buffer.from(SAMPLE_PATCH_A + SAMPLE_PATCH_B);
  const content = gzipSync(raw);
  await repos.patches.upsert({
    attemptId,
    byteLength: raw.length,
    sha256: createHash('sha256').update(raw).digest(),
    content,
    tooLarge: false,
  });
  const run = await repos.testRuns.start({ attemptId, taskId, command: ['npm', 'test'], junitPath: null });
  await repos.testRuns.insertResults(
    run.id,
    Array.from({ length: 3 }, (_, i) => ({
      suiteName: 'suite',
      className: 'Cls',
      name: `case ${i}`,
      filePath: 'test/a.test.ts',
      status: i === 2 ? ('failed' as const) : ('passed' as const),
      durationMs: 5,
      failureType: i === 2 ? 'AssertionError' : null,
      failureMessage: i === 2 ? 'expected 1 to be 2' : null,
      failureDetail: null,
    })),
  );
  await repos.testRuns.finish(run.id, {
    status: 'failed',
    exitCode: 1,
    signal: null,
    durationMs: 15,
    total: 3,
    passed: 2,
    failed: 1,
    errored: 0,
    skipped: 0,
    reportParsed: true,
    reportError: null,
  });
  const mergeCheck: MergeCheck = {
    status: 'clean',
    baseBranch: 'main',
    latestBaseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    conflicts: [],
    isFastForward: true,
    error: null,
    checkedAt: new Date().toISOString(),
  };
  await repos.attempts.setReview(attemptId, {
    headSha: 'b'.repeat(40),
    filesChanged: 2,
    additions: 2,
    deletions: 1,
    commits: [],
    mergeCheck,
  });
  await repos.claudeSessions.start({
    attemptId,
    taskId,
    sessionId: '11111111-2222-3333-4444-555555555555',
    resumedFromSessionId: null,
    model: 'sonnet',
    cliVersion: '2.1.0',
    permissionMode: 'acceptEdits',
  });
  const op = await repos.mcpOperations.insert({
    projectId,
    taskId,
    attemptId,
    workspaceId: null,
    kind: 'impact_analysis',
    indexName: 'orc-t-test',
    mode: null,
    status: 'running',
    requestedByUserId: null,
    workerId: WORKER_ID,
  });
  await repos.mcpOperations.finish(op.id, {
    status: 'succeeded',
    nodeCount: null,
    edgeCount: null,
    result: { changedSymbols: 2 },
    errorCode: null,
    errorMessage: null,
    durationMs: 10,
  });
  return { testRunId: run.id, impactOperationId: op.id };
}

/** TaskLogs rows (stdout lines + a claude stream-json line split across two rows). */
export async function seedLogs(
  worker: Database,
  w: { taskId: string; attemptId: string },
  startSeq = 0,
): Promise<void> {
  const claudeLine = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Hello from Claude' }] },
  });
  const half = Math.floor(claudeLine.length / 2);
  const rows = [
    { stream: 'stdout' as const, source: 'orchestrator' as const, content: 'first line\n' },
    { stream: 'claude' as const, source: 'claude' as const, content: claudeLine.slice(0, half) },
    { stream: 'claude' as const, source: 'claude' as const, content: `${claudeLine.slice(half)}\n` },
    { stream: 'stderr' as const, source: 'orchestrator' as const, content: 'warning line\n' },
  ];
  await worker.repos.taskLogs.appendBatch(
    rows.map((r, i) => ({
      taskId: w.taskId,
      attemptId: w.attemptId,
      seq: startSeq + i,
      stream: r.stream,
      source: r.source,
      content: r.content,
      byteLength: Buffer.byteLength(r.content),
    })),
  );
}
