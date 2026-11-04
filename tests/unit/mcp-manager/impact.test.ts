// Diff-seeded impact analysis (ADR-0035): hunk -> line mapping, seed selection, and the manager's
// get_file_outline + trace_path flow over a scripted session (no git in the server).
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changedLines, createMcpManager, isSafeRepoPath, selectSeeds } from '@orc/mcp-manager';
import type { ImpactChangeSet, ImpactFileChange, IndexScope, McpManager } from '@orc/mcp-manager';
import type { Clock } from '@orc/shared';
import type { LaunchLease } from '@orc/shared/node';
import { createTestLauncher } from '../../helpers/mcp/local-launcher';
import type { TestLauncher } from '../../helpers/mcp/local-launcher';
import {
  createScriptedFactory,
  impactTools,
  outlineResult,
  standardTools,
  textResult,
  traceResult,
} from '../../helpers/mcp/fake-factory';
import type { ScriptedFactory } from '../../helpers/mcp/fake-factory';
import { createMemoryRecorder, createTempRoot, createTestLogger } from '../../helpers/mcp/support';
import type { MemoryRecorder, TempRoot } from '../../helpers/mcp/support';

const PROJECT_ID = '0a1b2c3d-1111-4222-8333-444455556666';
const TASK_ID = 'f00dbabe-2222-4333-8444-555566667777';
const ATTEMPT_ID = 'abcdef01-3333-4444-8555-666677778888';
const WORKSPACE_ID = '12345678-4444-4555-8666-777788889999';
const BASE = '0123456789abcdef0123456789abcdef01234567';
const HEAD = 'fedcba9876543210fedcba9876543210fedcba98';
const PROJECT = 'orc-t-f00dbabe-a1';

const PATCH_M = [
  'diff --git a/src/m.ts b/src/m.ts',
  'index 1111111..2222222 100644',
  '--- a/src/m.ts',
  '+++ b/src/m.ts',
  '@@ -3,7 +3,7 @@ export function a(): number {',
  ' }',
  ' ',
  ' export function b(): number {',
  '-  return 1;',
  '+  return 1 + 1;',
  ' }',
  ' ',
  ' export function unrelated(): number {',
  '',
].join('\n');

const PATCH_NEW = [
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,4 @@',
  "+import { b } from './m';",
  '+export function e(): number {',
  '+  return b();',
  '+}',
  '',
].join('\n');

function file(path: string, over: Partial<ImpactFileChange> = {}): ImpactFileChange {
  return { path, oldPath: null, changeType: 'M', isBinary: false, patch: null, patchTruncated: false, ...over };
}

function changeSet(files: ImpactFileChange[], over: Partial<ImpactChangeSet> = {}): ImpactChangeSet {
  return { headSha: HEAD, files, totalFiles: files.length, truncated: false, ...over };
}

describe('changedLines', () => {
  it('maps added lines and removal points of every hunk to new-side line numbers', () => {
    expect(changedLines(PATCH_M)).toEqual([5, 6]);
    expect(changedLines(PATCH_NEW)).toEqual([1, 2, 3, 4]);
    const twoHunks = [
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
      ' keep',
      '@@ -10,3 +10,2 @@ f()',
      ' a',
      '-gone',
      ' b',
      '\\ No newline at end of file',
    ].join('\r\n');
    expect(changedLines(twoHunks)).toEqual([1, 10]);
  });

  it('touches no line for a header-only patch (pure rename or mode change)', () => {
    expect(changedLines('diff --git a/x b/y\nsimilarity index 100%\nrename from x\nrename to y\n')).toEqual([]);
    expect(changedLines('')).toEqual([]);
  });

  it('does not treat the next file header of a type-change pair as hunk content', () => {
    const pair = ['@@ -1 +0,0 @@', '-link', 'diff --git a/x b/x', '+++ b/x', '@@ -0,0 +1,1 @@', '+file'].join('\n');
    expect(changedLines(pair)).toEqual([1]);
  });
});

describe('selectSeeds and isSafeRepoPath', () => {
  const decls = [
    { qn: 'p.Box', label: 'Class', start: 7, end: 17 },
    { qn: 'p.Box.area', label: 'Method', start: 10, end: 12 },
    { qn: 'p.useBox', label: 'Function', start: 19, end: 21 },
  ];

  it('keeps every declaration containing a changed line, or all of them without line information', () => {
    expect(selectSeeds(decls, [11]).map((d) => d.qn)).toEqual(['p.Box', 'p.Box.area']);
    expect(selectSeeds(decls, [1, 18, 22])).toEqual([]);
    expect(selectSeeds(decls, [21]).map((d) => d.qn)).toEqual(['p.useBox']);
    expect(selectSeeds(decls, null)).toEqual(decls);
  });

  it('accepts only repository-relative / paths', () => {
    expect(isSafeRepoPath('src/a b/c.ts')).toBe(true);
    for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', './a', 'C:/x', 'a\\b', 'a\u0000b', 'a\nb']) {
      expect(isSafeRepoPath(bad)).toBe(false);
    }
  });
});

interface Ctx {
  tmp: TempRoot;
  factory: ScriptedFactory;
  recorder: MemoryRecorder;
  launcher: TestLauncher;
  manager: McpManager;
  workspace: Extract<IndexScope, { kind: 'workspace' }>;
  lease: LaunchLease;
  clock: Clock & { advance(ms: number): void };
}

function fakeClock(): Clock & { advance(ms: number): void } {
  let t = 1_700_000_000_000;
  return {
    now: () => new Date(t),
    nowMs: () => t,
    advance(ms) {
      t += ms;
    },
  };
}

async function setup(): Promise<Ctx> {
  const tmp = await createTempRoot();
  const factory = createScriptedFactory();
  const recorder = createMemoryRecorder();
  const launcher = createTestLauncher({ mode: 'runner' });
  const clock = fakeClock();
  const manager = createMcpManager(
    {
      bin: 'codebase-memory-mcp',
      binPrefixArgs: [],
      cacheRoot: tmp.cache,
      workspacesRoot: tmp.workspaces,
      logLevel: 'warn',
      connectTimeoutMs: 1000,
      callTimeoutMs: 2000,
      indexTimeoutMs: 3000,
      detectTimeoutMs: 4000,
      resultMaxBytes: 262_144,
      workerId: 'worker-test',
    },
    { logger: createTestLogger().logger, factory, recorder, launcher, clock },
  );
  const wt = join(tmp.workspaces, PROJECT_ID, TASK_ID, 'a1');
  await mkdir(wt, { recursive: true });
  const workspace: Extract<IndexScope, { kind: 'workspace' }> = {
    kind: 'workspace',
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    taskId: TASK_ID,
    attemptId: ATTEMPT_ID,
    attemptNumber: 1,
    path: wt,
    keyLength: 8,
  };
  await mkdir(manager.cacheDir(workspace), { recursive: true });
  const lease = await launcher.acquire({
    key: `attempt-${ATTEMPT_ID}`,
    attemptId: ATTEMPT_ID,
    workerId: 'worker-test',
    paths: [wt, manager.cacheDir(workspace)],
  });
  return { tmp, factory, recorder, launcher, manager, workspace, lease, clock };
}

let ctx: Ctx;

beforeEach(async () => {
  ctx = await setup();
});

afterEach(async () => {
  await ctx.launcher.close();
  await ctx.tmp.cleanup();
});

function record(value: unknown): Record<string, unknown> {
  expect(typeof value === 'object' && value !== null && !Array.isArray(value)).toBe(true);
  return value as Record<string, unknown>;
}

const OUTLINES: Record<string, [string, string, string, string][]> = {
  'src/m.ts': [
    ['a', 'Function', '1-3', 'p.src.m.a'],
    ['b', 'Function', '5-7', 'p.src.m.b'],
    ['unrelated', 'Function', '9-11', 'p.src.m.unrelated'],
  ],
  'src/new.ts': [['e', 'Function', '2-4', 'p.src.new.e']],
};

const CALLERS: Record<string, [string, number][]> = {
  'p.src.m.b': [
    ['p.src.m.a', 1],
    ['p.src.new.e', 1],
    ['p.src.n.c', 2],
  ],
  'p.src.new.e': [['p.src.n.d', 2]],
};

function scriptGraph(c: Ctx): void {
  c.factory.handlers['get_file_outline'] = (args) => outlineResult(OUTLINES[String(args['file_path'])] ?? []);
  c.factory.handlers['trace_path'] = (args) => traceResult(CALLERS[String(args['function_name'])] ?? []);
}

describe('detectChanges with the worker diff (ADR-0035)', () => {
  it('seeds declarations from the hunks and walks inbound callers without detect_changes', async () => {
    scriptGraph(ctx);
    const changes = changeSet([
      file('src/m.ts', { patch: PATCH_M }),
      file('src/new.ts', { changeType: 'A', patch: PATCH_NEW }),
      file('src/old.ts', { changeType: 'D', patch: '@@ -1,3 +0,0 @@\n-x\n-y\n-z\n' }),
    ]);
    const out = await ctx.manager.detectChanges(ctx.workspace, { baseSha: BASE, lease: ctx.lease, changes });
    expect(out.errorMessage).toBeNull();
    expect(out.status).toBe('succeeded');
    expect(ctx.factory.calls.map((c) => c.tool)).toEqual([
      'get_file_outline',
      'get_file_outline',
      'trace_path',
      'trace_path',
    ]);
    expect(ctx.factory.calls[0]?.args).toEqual({
      project: PROJECT,
      file_path: 'src/m.ts',
      format: 'json',
      limit: 200,
      offset: 0,
    });
    expect(ctx.factory.calls[2]?.args).toEqual({
      project: PROJECT,
      function_name: 'p.src.m.b',
      direction: 'inbound',
      depth: 2,
      format: 'json',
      limit: 200,
    });
    // every call gets the remaining MCP_DETECT_TIMEOUT_MS budget (clock frozen here)
    expect(ctx.factory.calls.every((c) => c.timeoutMs === 4000)).toBe(true);
    const result = record(out.result);
    expect(result).toMatchObject({
      source: 'worker_diff',
      base: BASE,
      head: HEAD,
      direction: 'inbound',
      depth: 2,
      changed_total: 3,
      changed_files: ['src/m.ts', 'src/new.ts', 'src/old.ts'],
      changed_has_more: false,
      files_examined: 2,
      skipped_total: 0,
      seed_total: 2,
      seeds_traced: 2,
      seeds_unresolved: 0,
      seeds: [
        { qn: 'p.src.m.b', label: 'Function', file: 'src/m.ts', start: 5, end: 7, seed_reason: 'hunk' },
        { qn: 'p.src.new.e', label: 'Function', file: 'src/new.ts', start: 2, end: 4, seed_reason: 'hunk' },
      ],
      impacted_total: 3,
      impacted_total_relation: 'eq',
      impacted: [
        { qn: 'p.src.m.a', module: 'p.src.m', hop: 1, via: 'p.src.m.b' },
        { qn: 'p.src.n.c', module: 'p.src.n', hop: 2, via: 'p.src.m.b' },
        { qn: 'p.src.n.d', module: 'p.src.n', hop: 2, via: 'p.src.new.e' },
      ],
      impacted_symbols: ['p.src.m.a', 'p.src.n.c', 'p.src.n.d'],
      impacted_has_more: false,
      impacted_modules: [
        { module: 'p.src.n', count: 2 },
        { module: 'p.src.m', count: 1 },
      ],
      truncated: false,
    });
    expect(ctx.recorder.started[0]).toMatchObject({ kind: 'impact_analysis', mode: null, indexName: PROJECT });
    expect(ctx.recorder.finished[0]?.outcome).toMatchObject({ status: 'succeeded', nodeCount: null, edgeCount: null });
  });

  it('seeds the whole file when its patch is unavailable and skips binary and unsafe paths', async () => {
    scriptGraph(ctx);
    const changes = changeSet([
      file('src/m.ts', { patch: PATCH_M.slice(0, 40), patchTruncated: true }),
      file('assets/logo.png', { isBinary: true }),
      file('../escape.ts', { patch: PATCH_NEW }),
    ]);
    const out = await ctx.manager.detectChanges(ctx.workspace, { baseSha: BASE, lease: ctx.lease, changes });
    expect(out.status).toBe('succeeded');
    expect(ctx.factory.calls.filter((c) => c.tool === 'get_file_outline').map((c) => c.args['file_path'])).toEqual([
      'src/m.ts',
    ]);
    const result = record(out.result);
    expect((result['seeds'] as { qn: string; seed_reason: string }[]).map((s) => `${s.qn}:${s.seed_reason}`)).toEqual([
      'p.src.m.a:file',
      'p.src.m.b:file',
      'p.src.m.unrelated:file',
    ]);
    expect(result['skipped_total']).toBe(2);
    expect(result['skipped_files']).toEqual([
      { file: 'assets/logo.png', reason: 'binary' },
      { file: '../escape.ts', reason: 'invalid_path' },
    ]);
    // callers that are themselves seeds are not impacted
    expect(result['impacted_symbols']).toEqual(['p.src.new.e', 'p.src.n.c']);
  });

  it('reads further outline pages and flags truncated diffs', async () => {
    const rows: [string, string, string, string][] = Array.from({ length: 200 }, (_, i) => [
      `f${i}`,
      'Function',
      `${i + 1}-${i + 1}`,
      `p.big.f${i}`,
    ]);
    ctx.factory.handlers['get_file_outline'] = (args) =>
      args['offset'] === 0 ? outlineResult(rows, true) : outlineResult([['z', 'Function', '500-501', 'p.big.z']]);
    const patch = '@@ -500,1 +500,1 @@\n-old\n+new\n';
    const out = await ctx.manager.detectChanges(ctx.workspace, {
      baseSha: BASE,
      lease: ctx.lease,
      changes: changeSet([file('big.ts', { patch })], { totalFiles: 9000, truncated: true }),
    });
    expect(out.status).toBe('succeeded');
    expect(ctx.factory.calls.filter((c) => c.tool === 'get_file_outline').map((c) => c.args['offset'])).toEqual([0, 200]);
    const result = record(out.result);
    expect((result['seeds'] as { qn: string }[]).map((s) => s.qn)).toEqual(['p.big.z']);
    expect(result).toMatchObject({ changed_total: 9000, changed_has_more: true, truncated: true });
  });

  it('counts unknown seeds, flags partial traces and fails on other trace errors', async () => {
    scriptGraph(ctx);
    ctx.factory.handlers['trace_path'] = (args) =>
      args['function_name'] === 'p.src.m.b'
        ? textResult({ error: 'function not found', function_name: 'p.src.m.b' }, true)
        : traceResult([['p.src.n.d', 2]], 7);
    const changes = changeSet([file('src/m.ts', { patch: PATCH_M }), file('src/new.ts', { patch: PATCH_NEW })]);
    const out = await ctx.manager.detectChanges(ctx.workspace, { baseSha: BASE, lease: ctx.lease, changes });
    expect(out.status).toBe('succeeded');
    expect(record(out.result)).toMatchObject({
      seeds_unresolved: 1,
      impacted_total: 1,
      impacted_total_relation: 'gte',
      truncated: true,
    });

    ctx.factory.handlers['trace_path'] = () => textResult({ error: 'project not found or not indexed' }, true);
    const failed = await ctx.manager.detectChanges(ctx.workspace, { baseSha: BASE, lease: ctx.lease, changes });
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'mcp_tool_error' });
    expect(failed.errorMessage).toContain('project not found');
  });

  it('maps a missing graph tool, a missing parameter and an undecodable result to typed failures', async () => {
    const changes = changeSet([file('src/m.ts', { patch: PATCH_M })]);
    ctx.factory.tools = [...standardTools(), ...impactTools().filter((t) => t.name !== 'trace_path')];
    const missing = await ctx.manager.detectChanges(ctx.workspace, { baseSha: BASE, lease: ctx.lease, changes });
    expect(missing).toMatchObject({ status: 'failed', errorCode: 'mcp_tool_missing' });
    expect(missing.errorMessage).toContain('trace_path');

    ctx.factory.tools = [
      ...standardTools(),
      ...impactTools().map((t) =>
        t.name === 'get_file_outline' ? { name: t.name, inputSchema: { properties: { project: {} } } } : t,
      ),
    ];
    const mismatch = await ctx.manager.detectChanges(ctx.workspace, { baseSha: BASE, lease: ctx.lease, changes });
    expect(mismatch).toMatchObject({ status: 'failed', errorCode: 'mcp_tool_schema_mismatch' });
    expect(mismatch.errorMessage).toContain('get_file_outline.file_path');

    ctx.factory.tools = [...standardTools(), ...impactTools()];
    ctx.factory.handlers['get_file_outline'] = () => textResult('outline in tree format');
    const garbage = await ctx.manager.detectChanges(ctx.workspace, { baseSha: BASE, lease: ctx.lease, changes });
    expect(garbage).toMatchObject({ status: 'failed', errorCode: 'mcp_protocol_error' });
    // without `format`/`limit`/`offset` in the schema, none of them is sent
    expect(ctx.factory.calls.at(-1)?.args).toEqual({ project: PROJECT, file_path: 'src/m.ts' });
  });

  it('stops with mcp_timeout once MCP_DETECT_TIMEOUT_MS is spent', async () => {
    scriptGraph(ctx);
    ctx.factory.handlers['get_file_outline'] = (args) => {
      ctx.clock.advance(3000);
      return outlineResult(OUTLINES[String(args['file_path'])] ?? []);
    };
    const changes = changeSet([file('src/m.ts', { patch: PATCH_M }), file('src/new.ts', { patch: PATCH_NEW })]);
    const out = await ctx.manager.detectChanges(ctx.workspace, { baseSha: BASE, lease: ctx.lease, changes });
    expect(out).toMatchObject({ status: 'failed', errorCode: 'mcp_timeout' });
    expect(ctx.factory.calls.map((c) => c.timeoutMs)).toEqual([4000, 1000]);
  });

  it('rejects a head that is not a commit SHA before starting an operation', async () => {
    const changes = { ...changeSet([]), headSha: 'HEAD~1' };
    await expect(
      ctx.manager.detectChanges(ctx.workspace, { baseSha: BASE, lease: ctx.lease, changes }),
    ).rejects.toMatchObject({ code: 'unsafe_argument' });
    expect(ctx.recorder.started).toEqual([]);
  });
});
