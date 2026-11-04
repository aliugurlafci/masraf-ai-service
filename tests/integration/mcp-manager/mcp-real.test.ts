// mcp-real: @orc/mcp-manager against the REAL codebase-memory-mcp binary (contract §12, §18.1, §18.5).
// Binary: CODEBASE_MEMORY_MCP_BIN, else `codebase-memory-mcp` on PATH. Skipped only when it is absent.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REQUIRED_MCP_TOOLS, createMcpManager, createSdkClientFactory } from '@orc/mcp-manager';
import type { IndexScope, McpManager } from '@orc/mcp-manager';
import type { LaunchLease } from '@orc/shared/node';
import { createTestLauncher } from '../../helpers/mcp/local-launcher';
import type { TestLauncher } from '../../helpers/mcp/local-launcher';
import {
  createMemoryRecorder,
  createTempRoot,
  createTestLogger,
  resolveRealCbmBinary,
} from '../../helpers/mcp/support';
import type { MemoryRecorder, TempRoot } from '../../helpers/mcp/support';

const BIN = resolveRealCbmBinary();
const SKIP_REASON =
  BIN === null
    ? 'SKIPPED: codebase-memory-mcp binary not found (set CODEBASE_MEMORY_MCP_BIN or put it on PATH)'
    : `binary ${BIN}`;

const PROJECT_ID = '7e57a11e-0000-4000-8000-00000000c0de';
const TASK_ID = '7e57a11e-1111-4111-8111-111111111111';
const ATTEMPT_ID = '7e57a11e-2222-4222-8222-222222222222';
const WORKSPACE_ID = '7e57a11e-3333-4333-8333-333333333333';
// second workspace of the runner-mode impact check (ADR-0035)
const RUNNER_TASK_ID = '7e57a11e-4444-4444-8444-444444444444';
const RUNNER_ATTEMPT_ID = '7e57a11e-5555-4555-8555-555555555555';
const RUNNER_WORKSPACE_ID = '7e57a11e-6666-4666-8666-666666666666';

const MATH_V1 = [
  'export function addNumbers(a: number, b: number): number {',
  '  return a + b;',
  '}',
  '',
  'export function sumAll(values: number[]): number {',
  '  return values.reduce((acc, v) => addNumbers(acc, v), 0);',
  '}',
  '',
].join('\n');
const MATH_V2 = MATH_V1.replace('  return a + b;', '  const total = a + b;\n  return total;');
const APP = [
  "import { sumAll } from './math';",
  '',
  'export function runApp(): number {',
  '  return sumAll([1, 2, 3]);',
  '}',
  '',
].join('\n');
const ADR = [
  '# ADR-0001: Math helpers',
  '',
  'All additions go through `addNumbers` in `src/math.ts`; `sumAll` aggregates values.',
  '',
].join('\n');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'orc-test',
      GIT_AUTHOR_EMAIL: 'orc-test@example.invalid',
      GIT_COMMITTER_NAME: 'orc-test',
      GIT_COMMITTER_EMAIL: 'orc-test@example.invalid',
    },
  }).trim();
}

async function createRepo(dir: string): Promise<string> {
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'docs', 'adr'), { recursive: true });
  await writeFile(join(dir, 'src', 'math.ts'), MATH_V1);
  await writeFile(join(dir, 'src', 'app.ts'), APP);
  await writeFile(join(dir, 'docs', 'adr', '0001-math.md'), ADR);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return git(dir, 'rev-parse', 'HEAD');
}

function asRecord(v: unknown): Record<string, unknown> {
  expect(v).toBeTypeOf('object');
  expect(v).not.toBeNull();
  return v as Record<string, unknown>;
}

describe.skipIf(BIN === null)(`mcp-real (${SKIP_REASON})`, () => {
  let tmp: TempRoot;
  let launcher: TestLauncher;
  let recorder: MemoryRecorder;
  let manager: McpManager;
  let lease: LaunchLease | null = null;
  let baseSha: string;
  let project: Extract<IndexScope, { kind: 'project' }>;
  let workspace: Extract<IndexScope, { kind: 'workspace' }>;

  beforeAll(async () => {
    tmp = await createTempRoot();
    launcher = createTestLauncher();
    recorder = createMemoryRecorder();
    const { logger } = createTestLogger();
    const cfg = {
      bin: BIN ?? '',
      binPrefixArgs: [],
      cacheRoot: tmp.cache,
      workspacesRoot: tmp.workspaces,
      logLevel: 'warn',
      connectTimeoutMs: 60_000,
      callTimeoutMs: 60_000,
      indexTimeoutMs: 300_000,
      detectTimeoutMs: 120_000,
      resultMaxBytes: 262_144,
      workerId: 'worker-mcp-real',
    };
    manager = createMcpManager(cfg, {
      logger,
      factory: createSdkClientFactory(cfg, { logger, launcher }),
      recorder,
      launcher,
    });
    const base = join(tmp.workspaces, PROJECT_ID, '_base');
    const wt = join(tmp.workspaces, PROJECT_ID, TASK_ID, 'wt');
    await createRepo(base);
    baseSha = await createRepo(wt);
    project = { kind: 'project', projectId: PROJECT_ID, path: base };
    workspace = {
      kind: 'workspace',
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      attemptNumber: 1,
      path: wt,
      keyLength: 8,
    };
  });

  afterAll(async () => {
    try {
      if (manager !== undefined) {
        await manager.deleteIndex(workspace, lease ? { lease } : {});
        await manager.deleteIndex(project);
      }
      if (lease) await lease.release();
      if (launcher !== undefined) {
        await launcher.close();
        expect(launcher.alivePids()).toEqual([]);
      }
    } finally {
      if (tmp !== undefined) await tmp.cleanup();
    }
    expect(existsSync(tmp.root)).toBe(false);
  });

  it('probes the real server and finds every required tool', async () => {
    const res = await manager.probe();
    expect(res.ok).toBe(true);
    expect(res.serverVersion).toMatch(/\d+\.\d+\.\d+/);
    expect(res.missingTools).toEqual([]);
    expect(res.schemaMismatches).toEqual([]);
    expect(res.tools).toEqual(expect.arrayContaining([...REQUIRED_MCP_TOOLS]));
  });

  it('indexes a worktree, re-indexes after a change, reports impact and deletes the index', async () => {
    lease = await launcher.acquire({
      key: `attempt-${ATTEMPT_ID}`,
      attemptId: ATTEMPT_ID,
      workerId: 'worker-mcp-real',
      paths: [workspace.path, manager.cacheDir(workspace)],
    });

    // index_repository (full + doc_candidates) -> index_status counts
    const first = await manager.index(workspace, { mode: 'full', kind: 'task_index', lease });
    expect(first.errorMessage).toBeNull();
    expect(first.status).toBe('succeeded');
    expect(first.nodeCount).toBeGreaterThan(0);
    expect(first.edgeCount).toBeGreaterThan(0);
    const firstResult = asRecord(first.result);
    const status = asRecord(firstResult['status']);
    expect(status['project']).toBe('orc-t-7e57a11e-a1');
    expect(status['nodes']).toBe(first.nodeCount);
    // F11: the ADR names exported symbols; doc-code links are reported by index_status
    const docLinks = asRecord(status['doc_links']);
    expect(docLinks['mentions']).toBeGreaterThan(0);

    // modify a file, commit, re-index (task_reindex, fast, no doc_candidates)
    await writeFile(join(workspace.path, 'src', 'math.ts'), MATH_V2);
    git(workspace.path, 'commit', '-q', '-am', 'change addNumbers');
    const second = await manager.index(workspace, { mode: 'fast', kind: 'task_reindex', lease });
    expect(second.errorMessage).toBeNull();
    expect(second.status).toBe('succeeded');
    expect(second.nodeCount).toBeGreaterThan(0);

    // detect_changes against the base commit reports the changed file and its impact
    const impact = await manager.detectChanges(workspace, { baseSha, lease });
    expect(impact.errorMessage).toBeNull();
    expect(impact.status).toBe('succeeded');
    const impactResult = asRecord(impact.result);
    expect(impactResult['changed_files']).toEqual(expect.arrayContaining(['src/math.ts']));
    const impacted = impactResult['impacted'];
    expect(Array.isArray(impacted)).toBe(true);
    expect((impacted as unknown[]).length).toBeGreaterThan(0);

    // delete_project + cache removal
    const cache = manager.cacheDir(workspace);
    expect(existsSync(cache)).toBe(true);
    await manager.deleteIndex(workspace, { lease });
    expect(existsSync(cache)).toBe(false);
    const deleted = recorder.finished.at(-1)?.outcome;
    expect(deleted?.status).toBe('succeeded');
    expect(asRecord(deleted?.result)).toMatchObject({ cacheRemoved: true, warning: null, deleteProject: { status: 'deleted' } });

    // idempotent
    await manager.deleteIndex(workspace, { lease });
    expect(recorder.finished.at(-1)?.outcome.status).toBe('succeeded');
    expect(launcher.alivePids()).toEqual([]);
  });

  it('derives the impact from the worker diff when the server cannot run git (runner mode, ADR-0035)', async () => {
    // The worker's diff, computed in a repository the server never sees.
    const src = join(tmp.root, 'diff-src');
    const base = await createRepo(src);
    await writeFile(join(src, 'src', 'math.ts'), MATH_V2);
    git(src, 'commit', '-q', '-am', 'change addNumbers');
    const head = git(src, 'rev-parse', 'HEAD');
    const diffArgs = ['-M', '--patch', '--no-color', '--no-ext-diff', '--no-textconv', '--full-index'];
    const patch = git(src, 'diff', ...diffArgs, base, 'HEAD', '--', 'src/math.ts');

    // A runner-mode worktree: its `.git` file names an admin dir (in the worker-owned mirror) the server's uid
    // cannot open.
    const wt = join(tmp.workspaces, PROJECT_ID, RUNNER_TASK_ID, 'wt');
    await mkdir(join(wt, 'src'), { recursive: true });
    await writeFile(join(wt, 'src', 'math.ts'), MATH_V2);
    await writeFile(join(wt, 'src', 'app.ts'), APP);
    await writeFile(join(wt, '.git'), `gitdir: ${join(tmp.root, 'unreadable-mirror', 'worktrees', 'wt')}\n`);
    const scope: Extract<IndexScope, { kind: 'workspace' }> = {
      ...workspace,
      taskId: RUNNER_TASK_ID,
      attemptId: RUNNER_ATTEMPT_ID,
      workspaceId: RUNNER_WORKSPACE_ID,
      path: wt,
    };
    const runnerLease = await launcher.acquire({
      key: `attempt-${RUNNER_ATTEMPT_ID}`,
      attemptId: RUNNER_ATTEMPT_ID,
      workerId: 'worker-mcp-real',
      paths: [wt, manager.cacheDir(scope)],
    });
    try {
      const idx = await manager.index(scope, { mode: 'fast', kind: 'task_reindex', lease: runnerLease });
      expect(idx.errorMessage).toBeNull();
      expect(idx.status).toBe('succeeded');

      // server-side detect_changes fails exactly as in production
      const viaGit = await manager.detectChanges(scope, { baseSha: base, lease: runnerLease });
      expect(viaGit).toMatchObject({ status: 'failed', errorCode: 'mcp_tool_error' });
      expect(viaGit.errorMessage).toContain('git revision resolution failed');

      const viaDiff = await manager.detectChanges(scope, {
        baseSha: base,
        lease: runnerLease,
        changes: {
          headSha: head,
          totalFiles: 1,
          truncated: false,
          files: [
            {
              path: 'src/math.ts',
              oldPath: null,
              changeType: 'M',
              isBinary: false,
              patch: `${patch}\n`,
              patchTruncated: false,
            },
          ],
        },
      });
      expect(viaDiff.errorMessage).toBeNull();
      expect(viaDiff.status).toBe('succeeded');
      const result = asRecord(viaDiff.result);
      expect(result).toMatchObject({ source: 'worker_diff', head, changed_files: ['src/math.ts'], truncated: false });
      const seeds = (result['seeds'] as { qn: string; seed_reason: string }[]).map((s) => `${s.qn}:${s.seed_reason}`);
      expect(seeds).toEqual([expect.stringMatching(/\.addNumbers:hunk$/)]);
      expect(result['impacted_symbols']).toEqual(
        expect.arrayContaining([expect.stringMatching(/\.sumAll$/), expect.stringMatching(/\.runApp$/)]),
      );
    } finally {
      await manager.deleteIndex(scope, { lease: runnerLease });
      await runnerLease.release();
    }
    expect(launcher.alivePids()).toEqual([]);
  });

  it('indexes the project base under an internal op lease and deletes it', async () => {
    const out = await manager.index(project, { mode: 'moderate', kind: 'project_index' });
    expect(out.errorMessage).toBeNull();
    expect(out.status).toBe('succeeded');
    expect(out.nodeCount).toBeGreaterThan(0);
    expect(out.edgeCount).toBeGreaterThan(0);
    // v0.12.0 "filtered" modes (moderate/fast) exclude docs/ from the index, so doc links are asserted
    // on the full-mode worktree index above; here only the status shape is checked.
    const status = asRecord(asRecord(out.result)['status']);
    expect(status['project']).toBe('orc-p-7e57a11e');
    expect(asRecord(status['doc_links'])['status']).toBe('ok');
    const opLease = launcher.leases.find((l) => l.key === `op-${out.operationId}`);
    expect(opLease?.released).toBe(true);

    await manager.deleteIndex(project);
    expect(existsSync(manager.cacheDir(project))).toBe(false);
    expect(recorder.finished.at(-1)?.outcome).toMatchObject({
      status: 'succeeded',
      result: { deleteProject: { status: 'deleted' }, warning: null },
    });
    expect(launcher.alivePids()).toEqual([]);
  });
});
