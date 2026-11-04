// ClaudeSessions, Workspaces, ChangedFiles, AttemptPatches, TestRuns/TestResults (§2.5, §6.5 F12). Writer = orc_worker.
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import sql from 'mssql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClaudeResultSummary } from '@orc/shared';
import type { Database, NewChangedFile } from '@orc/database';
import { openDb, openPool, query, resetDb } from '../../helpers/database/db';
import { WORKER_ID, createQueuedTask, createTaskWorld, workerActor } from '../../helpers/database/fixtures';
import type { TaskWorld } from '../../helpers/database/fixtures';

const result: ClaudeResultSummary = {
  status: 'completed',
  resultSubtype: 'success',
  isError: false,
  stopReason: 'end_turn',
  terminalReason: null,
  numTurns: 7,
  totalCostUsd: 0.123456,
  inputTokens: 1000,
  outputTokens: 2000,
  cacheCreationInputTokens: 10,
  cacheReadInputTokens: 20,
  durationMs: 12_345,
  durationApiMs: 10_000,
  permissionDenialsCount: 1,
  permissionDenials: [{ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }],
  resultText: 'Done.',
};

function file(path: string, patch: string | null, o: Partial<NewChangedFile> = {}): NewChangedFile {
  return {
    path,
    oldPath: null,
    changeType: 'M',
    similarity: null,
    additions: 1,
    deletions: 1,
    isBinary: false,
    patch,
    patchBytes: patch === null ? 0 : Buffer.byteLength(patch),
    patchTruncated: false,
    ...o,
  };
}

describe('attempt artefacts', () => {
  let api: Database;
  let worker: Database;
  let migrator: sql.ConnectionPool;
  let w: TaskWorld;

  /** A claimed attempt (task in preparing_workspace). */
  async function activeAttempt(): Promise<{ taskId: string; attemptId: string }> {
    const { attempt } = await createQueuedTask(api, w);
    await worker.repos.taskState.claimAttempt({ attemptId: attempt.id, workerId: WORKER_ID, actor: workerActor });
    return { taskId: attempt.taskId, attemptId: attempt.id };
  }

  async function settle(taskId: string, attemptId: string, daysAgo: number): Promise<void> {
    await worker.repos.taskState.transition({
      taskId, from: 'preparing_workspace', to: 'failed', attemptId, reason: 'internal_error', actor: workerActor, correlationId: null,
    });
    await query(migrator, 'UPDATE orc.Tasks SET FinishedAt = DATEADD(DAY, -@d, FinishedAt) WHERE Id = @id;', [
      ['d', sql.Int, daysAgo],
      ['id', sql.UniqueIdentifier, taskId],
    ]);
  }

  beforeAll(async () => {
    api = await openDb('orc_api');
    worker = await openDb('orc_worker');
    migrator = await openPool('orc_migrator', 1);
    w = await createTaskWorld(api);
  });

  afterAll(async () => {
    await api.close();
    await worker.close();
    await migrator.close();
    await resetDb();
  });

  describe('claude sessions', () => {
    it('start upserts on AttemptId and resets init/result columns (T-M5)', async () => {
      const { taskId, attemptId } = await activeAttempt();
      const sessionId = randomUUID();
      await worker.repos.claudeSessions.start({ attemptId, taskId, sessionId, resumedFromSessionId: null, model: 'sonnet', cliVersion: '2.1.0', permissionMode: 'acceptEdits' });
      await worker.repos.claudeSessions.recordInit(attemptId, {
        sessionId, model: 'claude-sonnet', tools: ['Read', 'Edit'], mcpServers: [{ name: 'codebase-memory-mcp', status: 'connected' }], apiKeySource: 'ANTHROPIC_API_KEY', cliVersion: null,
      });
      let s = await api.repos.claudeSessions.findByAttempt(attemptId);
      expect(s).toMatchObject({ status: 'running', model: 'claude-sonnet', tools: ['Read', 'Edit'], cliVersion: '2.1.0', apiKeySource: 'ANTHROPIC_API_KEY' });
      expect(s?.initAt).not.toBeNull();

      await worker.repos.claudeSessions.recordResult(attemptId, result);
      s = await api.repos.claudeSessions.findByAttempt(attemptId);
      expect(s).toMatchObject({ status: 'completed', numTurns: 7, totalCostUsd: 0.123456, inputTokens: 1000, permissionDenialsCount: 1, resultText: 'Done.' });
      expect(s?.permissionDenials).toHaveLength(1);

      // Fallback run in the same attempt: same row, init/result columns cleared.
      await worker.repos.claudeSessions.start({ attemptId, taskId, sessionId: null, resumedFromSessionId: sessionId, model: 'sonnet', cliVersion: '2.1.1', permissionMode: 'acceptEdits' });
      s = await api.repos.claudeSessions.findByAttempt(attemptId);
      expect(s).toMatchObject({ status: 'starting', sessionId: null, resumedFromSessionId: sessionId, tools: null, numTurns: null, resultText: null, initAt: null, endedAt: null, cliVersion: '2.1.1' });
      const [row] = await query<{ RunCount: number; N: number }>(
        migrator,
        'SELECT MAX(RunCount) AS RunCount, COUNT(*) AS N FROM orc.ClaudeSessions WHERE AttemptId = @a;',
        [['a', sql.UniqueIdentifier, attemptId]],
      );
      expect(row).toEqual({ RunCount: 2, N: 1 });
      expect((await worker.repos.claudeSessions.findLatestWithSessionId(taskId))).toBeNull();
      await worker.repos.claudeSessions.recordInit(attemptId, { sessionId, model: 'm', tools: [], mcpServers: [], apiKeySource: null, cliVersion: null });
      expect((await worker.repos.claudeSessions.findLatestWithSessionId(taskId))?.sessionId).toBe(sessionId);
    });
  });

  describe('workspaces', () => {
    it('tracks status, size, base workspace and cleanup candidates', async () => {
      const { taskId, attemptId } = await activeAttempt();
      const base = await worker.repos.workspaces.insert({
        projectId: w.project.id, taskId: null, kind: 'base', createdByAttemptId: null, path: `/ws/base-${randomUUID()}`,
        branchName: null, baseSha: null, quotaBytes: 5_000_000_000, workerId: WORKER_ID,
      });
      expect(base).toMatchObject({ status: 'creating', quotaBytes: 5_000_000_000, sizeBytes: null });
      await worker.repos.workspaces.setStatus(base.id, 'ready');
      expect((await worker.repos.workspaces.findBase(w.project.id))?.id).toBe(base.id);
      await expect(
        worker.repos.workspaces.insert({ projectId: w.project.id, taskId: null, kind: 'base', createdByAttemptId: null, path: `/ws/base2-${randomUUID()}`, branchName: null, baseSha: null, quotaBytes: 1, workerId: WORKER_ID }),
      ).rejects.toMatchObject({ code: 'unique_violation' });

      const ws = await worker.repos.workspaces.insert({
        projectId: w.project.id, taskId, kind: 'attempt', createdByAttemptId: attemptId, path: `/ws/a-${randomUUID()}`,
        branchName: 'orc/x/a1', baseSha: 'a'.repeat(40), quotaBytes: 3_000_000_000, workerId: WORKER_ID,
      });
      await worker.repos.attempts.setWorkspace(attemptId, { workspaceId: ws.id, branchName: 'orc/x/a1', baseSha: 'a'.repeat(40) });
      await worker.repos.workspaces.recordSize(ws.id, 4_294_967_296);
      await worker.repos.workspaces.setStatus(ws.id, 'retained', { headSha: 'b'.repeat(40), retainUntil: new Date(Date.now() - 1000), errorDetail: null });
      const got = await worker.repos.workspaces.findById(ws.id);
      expect(got).toMatchObject({ status: 'retained', headSha: 'b'.repeat(40), sizeBytes: 4_294_967_296 });

      // Still used by an active attempt => not a cleanup candidate.
      expect((await worker.repos.workspaces.findForCleanup(100)).map((x) => x.id)).not.toContain(ws.id);
      await settle(taskId, attemptId, 40);
      expect((await worker.repos.workspaces.findForCleanup(100)).map((x) => x.id)).toContain(ws.id);

      await worker.repos.workspaces.setStatus(ws.id, 'removed');
      expect((await worker.repos.workspaces.findById(ws.id))?.removedAt).not.toBeNull();
      expect((await worker.repos.workspaces.findBranchesForDeletion(60, 100)).map((x) => x.id)).not.toContain(ws.id);
      expect((await worker.repos.workspaces.findBranchesForDeletion(30, 100)).map((x) => x.id)).toContain(ws.id);
      await worker.repos.workspaces.markBranchDeleted(ws.id);
      expect((await worker.repos.workspaces.findBranchesForDeletion(30, 100)).map((x) => x.id)).not.toContain(ws.id);
      expect(await worker.repos.workspaces.findById(randomUUID())).toBeNull();
    });
  });

  describe('changed files and patches', () => {
    it('replaces files per attempt, lists with/without patch and purges old patches (F12)', async () => {
      const { taskId, attemptId } = await activeAttempt();
      const files = Array.from({ length: 130 }, (_, i) => file(`src/f${String(i).padStart(3, '0')}.ts`, `@@ -1 +1 @@\n-a${i}\n+b${i}\n`));
      files.push(file('img.png', null, { isBinary: true, additions: null, deletions: null, changeType: 'A' }));
      files.push(file('new/name.ts', null, { oldPath: 'old/name.ts', changeType: 'R', similarity: 98 }));
      await worker.repos.changedFiles.replaceForAttempt(attemptId, taskId, files.slice(0, 5));
      await worker.repos.changedFiles.replaceForAttempt(attemptId, taskId, files);

      const meta = await api.repos.changedFiles.listByAttempt({ attemptId, includePatch: false, limit: 1000 });
      expect(meta.map((f) => f.path)).toEqual(files.map((f) => f.path));
      expect(meta[0]).toMatchObject({ patchPurged: false, changeType: 'M' });
      expect(meta[0]).not.toHaveProperty('patch');
      expect(meta.at(-1)).toMatchObject({ oldPath: 'old/name.ts', changeType: 'R', similarity: 98 });
      const withPatch = await api.repos.changedFiles.listByAttempt({ attemptId, includePatch: true, limit: 2 });
      expect(withPatch[0]?.patch).toBe(files[0]!.patch);
      const page2 = await api.repos.changedFiles.listByAttempt({ attemptId, includePatch: false, afterId: meta[1]!.id, limit: 1 });
      expect(page2[0]?.path).toBe(files[2]!.path);

      const content = gzipSync(Buffer.from(files.map((f) => f.patch ?? '').join('')));
      const sha256 = createHash('sha256').update(content).digest();
      await worker.repos.patches.upsert({ attemptId, byteLength: 1234, sha256, content, tooLarge: false });
      expect(await api.repos.patches.getMeta(attemptId)).toMatchObject({ byteLength: 1234, sha256: sha256.toString('hex'), tooLarge: false, purged: false });
      expect((await api.repos.patches.getContent(attemptId))?.equals(content)).toBe(true);
      await worker.repos.patches.upsert({ attemptId, byteLength: 99_999_999, sha256, content: null, tooLarge: true });
      expect(await api.repos.patches.getContent(attemptId)).toBeNull();
      await worker.repos.patches.upsert({ attemptId, byteLength: 1234, sha256, content, tooLarge: false });

      // Not settled yet: nothing to purge.
      const cutoff = new Date(Date.now() - 90 * 86_400_000);
      expect(await worker.repos.changedFiles.purgePatchesOlderThan(cutoff, 5000)).toBe(0);
      expect(await worker.repos.patches.purgeOlderThan(cutoff, 5000)).toBe(0);
      await settle(taskId, attemptId, 91);
      expect(await worker.repos.changedFiles.purgePatchesOlderThan(cutoff, 100)).toBe(100);
      expect(await worker.repos.changedFiles.purgePatchesOlderThan(cutoff, 100)).toBe(30);
      expect(await worker.repos.changedFiles.purgePatchesOlderThan(cutoff, 100)).toBe(0);
      expect(await worker.repos.patches.purgeOlderThan(cutoff, 10)).toBe(1);
      const purged = await api.repos.changedFiles.listByAttempt({ attemptId, includePatch: true, limit: 1 });
      expect(purged[0]).toMatchObject({ patch: null, patchPurged: true, path: files[0]!.path });
      expect(await api.repos.patches.getMeta(attemptId)).toMatchObject({ purged: true });
      expect(await api.repos.patches.getContent(attemptId)).toBeNull();
      expect(await api.repos.patches.getMeta(randomUUID())).toBeNull();
    });

    it('rejects invalid change types', async () => {
      const { taskId, attemptId } = await activeAttempt();
      await expect(
        worker.repos.changedFiles.replaceForAttempt(attemptId, taskId, [file('x', null, { changeType: 'Z' as 'M' })]),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    });
  });

  describe('test runs', () => {
    it('starts, finishes and stores results in batches', async () => {
      const { taskId, attemptId } = await activeAttempt();
      const run = await worker.repos.testRuns.start({ attemptId, taskId, command: ['npm', 'test', '--', '--ci'], junitPath: 'reports/junit.xml' });
      expect(run).toMatchObject({ status: 'running', command: ['npm', 'test', '--', '--ci'], total: 0, reportParsed: false });
      const results = Array.from({ length: 450 }, (_, i) => ({
        suiteName: 'suite',
        className: 'Cls',
        name: `case ${i}`,
        filePath: 'test/a.test.ts',
        status: i % 50 === 0 ? ('failed' as const) : ('passed' as const),
        durationMs: i,
        failureType: i % 50 === 0 ? 'AssertionError' : null,
        failureMessage: i % 50 === 0 ? 'expected 1 to be 2' : null,
        failureDetail: i % 50 === 0 ? 'stack'.repeat(10_000) : null,
      }));
      await worker.repos.testRuns.insertResults(run.id, results);
      await worker.repos.testRuns.finish(run.id, {
        status: 'failed', exitCode: 1, signal: null, durationMs: 4321, total: 450, passed: 441, failed: 9, errored: 0, skipped: 0, reportParsed: true, reportError: null,
      });
      const runs = await api.repos.testRuns.listByAttempt(attemptId);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: 'failed', exitCode: 1, durationMs: 4321, failed: 9, reportParsed: true });
      expect(runs[0]?.endedAt).not.toBeNull();
      const failed = await api.repos.testRuns.listResults({ testRunId: run.id, status: 'failed', limit: 100 });
      expect(failed).toHaveLength(9);
      expect(Buffer.byteLength(failed[0]?.failureDetail ?? '')).toBeLessThanOrEqual(16_384);
      const first = await api.repos.testRuns.listResults({ testRunId: run.id, limit: 3 });
      expect(first.map((r) => r.name)).toEqual(['case 0', 'case 1', 'case 2']);
      const next = await api.repos.testRuns.listResults({ testRunId: run.id, afterId: first[2]!.id, limit: 1 });
      expect(next[0]?.name).toBe('case 3');
    });
  });
});
