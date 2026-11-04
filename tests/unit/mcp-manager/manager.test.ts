import { existsSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpManager, McpError } from '@orc/mcp-manager';
import { LEASE_KEY_REGEX, validateSpawnEnv } from '@orc/sandbox';
import type { IndexScope, McpManager, McpManagerConfig } from '@orc/mcp-manager';
import { isOrcError } from '@orc/shared';
import type { LaunchLease } from '@orc/shared/node';
import { createTestLauncher } from '../../helpers/mcp/local-launcher';
import type { TestLauncher } from '../../helpers/mcp/local-launcher';
import {
  createScriptedFactory,
  standardTools,
  structuredResult,
  textResult,
} from '../../helpers/mcp/fake-factory';
import type { ScriptedFactory } from '../../helpers/mcp/fake-factory';
import { createMemoryRecorder, createTempRoot, createTestLogger } from '../../helpers/mcp/support';
import type { MemoryRecorder, TempRoot } from '../../helpers/mcp/support';

const PROJECT_ID = '0a1b2c3d-1111-4222-8333-444455556666';
const TASK_ID = 'f00dbabe-2222-4333-8444-555566667777';
const ATTEMPT_ID = 'abcdef01-3333-4444-8555-666677778888';
const WORKSPACE_ID = '12345678-4444-4555-8666-777788889999';
const SHA = '0123456789abcdef0123456789abcdef01234567';

interface Ctx {
  tmp: TempRoot;
  factory: ScriptedFactory;
  recorder: MemoryRecorder;
  launcher: TestLauncher;
  manager: McpManager;
  cfg: McpManagerConfig;
  project: IndexScope & { kind: 'project' };
  workspace: IndexScope & { kind: 'workspace' };
}

function config(tmp: TempRoot, over: Partial<McpManagerConfig> = {}): McpManagerConfig {
  return {
    bin: 'codebase-memory-mcp',
    binPrefixArgs: ['--flag'],
    cacheRoot: tmp.cache,
    workspacesRoot: tmp.workspaces,
    logLevel: 'warn',
    connectTimeoutMs: 1000,
    callTimeoutMs: 2000,
    indexTimeoutMs: 3000,
    detectTimeoutMs: 4000,
    resultMaxBytes: 262_144,
    workerId: 'worker-test',
    ...over,
  };
}

async function setup(mode: 'local' | 'runner' = 'local', over: Partial<McpManagerConfig> = {}): Promise<Ctx> {
  const tmp = await createTempRoot();
  const factory = createScriptedFactory();
  const recorder = createMemoryRecorder();
  const launcher = createTestLauncher({ mode });
  const cfg = config(tmp, over);
  const manager = createMcpManager(cfg, { logger: createTestLogger().logger, factory, recorder, launcher });
  const base = join(tmp.workspaces, PROJECT_ID, '_base');
  const wt = join(tmp.workspaces, PROJECT_ID, TASK_ID, 'wt');
  await mkdir(base, { recursive: true });
  await mkdir(wt, { recursive: true });
  return {
    tmp,
    factory,
    recorder,
    launcher,
    manager,
    cfg,
    project: { kind: 'project', projectId: PROJECT_ID, path: base },
    workspace: {
      kind: 'workspace',
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      attemptNumber: 2,
      path: wt,
      keyLength: 12,
    },
  };
}

async function attemptLease(c: Ctx): Promise<LaunchLease> {
  return c.launcher.acquire({
    key: `attempt-${ATTEMPT_ID}`,
    attemptId: ATTEMPT_ID,
    workerId: 'worker-test',
    paths: [c.workspace.path, c.manager.cacheDir(c.workspace)],
  });
}

let ctx: Ctx;
const cleanups: Ctx[] = [];

beforeEach(async () => {
  ctx = await setup();
  cleanups.push(ctx);
});

afterEach(async () => {
  for (const c of cleanups.splice(0)) {
    await c.manager.deleteIndex(c.project).catch(() => undefined);
    await c.manager.deleteIndex(c.workspace).catch(() => undefined);
    await c.launcher.close();
    await c.tmp.cleanup();
  }
});

describe('naming and isolation (§12.3)', () => {
  it('derives deterministic index names and per-scope cache dirs', () => {
    expect(ctx.manager.indexName(ctx.project)).toBe('orc-p-0a1b2c3d');
    expect(ctx.manager.indexName(ctx.workspace)).toBe('orc-t-f00dbabe2222-a2');
    expect(ctx.manager.indexName({ ...ctx.workspace, keyLength: 8, attemptNumber: 1 })).toBe('orc-t-f00dbabe-a1');
    expect(ctx.manager.cacheDir(ctx.project)).toBe(resolve(ctx.tmp.cache, 'p', PROJECT_ID));
    expect(ctx.manager.cacheDir(ctx.workspace)).toBe(resolve(ctx.tmp.cache, 'w', WORKSPACE_ID));
  });

  it('rejects non-GUID ids and paths outside WORKSPACES_ROOT', async () => {
    expect(() => ctx.manager.cacheDir({ ...ctx.project, projectId: '../../etc' })).toThrow(/GUID/);
    expect(() => ctx.manager.indexName({ ...ctx.workspace, attemptNumber: 0 })).toThrow(/attemptNumber/);
    await expect(
      ctx.manager.index({ ...ctx.project, path: ctx.tmp.root }, { mode: 'fast', kind: 'project_index' }),
    ).rejects.toMatchObject({ code: 'path_escape' });
    await expect(
      ctx.manager.index({ ...ctx.project, path: ctx.tmp.workspaces }, { mode: 'fast', kind: 'project_index' }),
    ).rejects.toMatchObject({ code: 'path_escape' });
    expect(ctx.recorder.started).toHaveLength(0);
  });

  it('builds Claude mcp.json with the workspace cache and allowed root', () => {
    const file = ctx.manager.claudeMcpConfig(ctx.workspace);
    const server = file.mcpServers['codebase-memory-mcp'];
    expect(server.type).toBe('stdio');
    expect(server.command).toBe('codebase-memory-mcp');
    expect(server.args).toEqual(['--flag']);
    expect(server.env['CBM_CACHE_DIR']).toBe(ctx.manager.cacheDir(ctx.workspace));
    expect(server.env['CBM_ALLOWED_ROOT']).toBe(resolve(ctx.workspace.path));
    expect(server.env['CBM_LOG_LEVEL']).toBe('warn');
  });

  it('isolates the daemon per cache: runner mode uses the leased cache dir, local mode a temp dir', async () => {
    const c = await setup('runner');
    cleanups.push(c);
    const env = c.manager.claudeMcpConfig(c.workspace).mcpServers['codebase-memory-mcp'].env;
    expect(Object.keys(env).sort()).toEqual(['CBM_ALLOWED_ROOT', 'CBM_CACHE_DIR', 'CBM_LOG_LEVEL', 'CBM_RUNTIME_DIR']);
    expect(env['CBM_RUNTIME_DIR']).toBe(c.manager.cacheDir(c.workspace));
    const local = ctx.manager.claudeMcpConfig(ctx.workspace).mcpServers['codebase-memory-mcp'].env;
    expect(local['CBM_RUNTIME_DIR']).toBeTypeOf('string');
    expect(local['CBM_RUNTIME_DIR']).not.toBe(ctx.manager.cacheDir(ctx.workspace));
    // The launcher accepts exactly these keys for kind `mcp` in both modes.
    expect(() => validateSpawnEnv('mcp', env)).not.toThrow();
    expect(() => validateSpawnEnv('mcp', local)).not.toThrow();
  });
});

describe('index', () => {
  it('indexes a project under an op lease with filtered optional params', async () => {
    const out = await ctx.manager.index(ctx.project, { mode: 'moderate', kind: 'project_index' });
    expect(out.status).toBe('succeeded');
    expect(out.nodeCount).toBe(20);
    expect(out.edgeCount).toBe(9);
    expect(out.errorCode).toBeNull();

    const [idx, st] = ctx.factory.calls;
    expect(idx).toEqual({
      tool: 'index_repository',
      args: { repo_path: resolve(ctx.project.path), mode: 'moderate', name: 'orc-p-0a1b2c3d', doc_candidates: true },
      timeoutMs: 3000,
    });
    expect(idx?.args).not.toHaveProperty('async');
    expect(st).toEqual({ tool: 'index_status', args: { project: 'orc-p-0a1b2c3d', format: 'json' }, timeoutMs: 2000 });

    const lease = ctx.launcher.leases.find((l) => l.key === `op-${out.operationId}`);
    expect(lease?.paths).toEqual([resolve(ctx.project.path), ctx.manager.cacheDir(ctx.project)]);
    expect(lease?.released).toBe(true);
    const conn = ctx.factory.connects[0];
    expect(conn?.cwd).toBe(resolve(ctx.project.path));
    expect(conn?.timeoutMs).toBe(1000);
    expect(conn?.env['CBM_CACHE_DIR']).toBe(ctx.manager.cacheDir(ctx.project));
    expect(conn?.env['CBM_ALLOWED_ROOT']).toBe(resolve(ctx.project.path));
    expect(conn?.env['CBM_LOG_LEVEL']).toBe('warn');
    expect(ctx.factory.closed).toBe(1);
    expect(existsSync(ctx.manager.cacheDir(ctx.project))).toBe(true);

    expect(ctx.recorder.started[0]).toMatchObject({
      projectId: PROJECT_ID,
      taskId: null,
      attemptId: null,
      workspaceId: null,
      kind: 'project_index',
      indexName: 'orc-p-0a1b2c3d',
      mode: 'moderate',
    });
    expect(ctx.recorder.finished[0]?.id).toBe(out.operationId);
    expect(ctx.recorder.finished[0]?.outcome.result).toEqual({
      index: { project: 'orc-p-0a1b2c3d', nodes: 12, edges: 7, status: 'indexed' },
      status: { project: 'orc-p-0a1b2c3d', nodes: 20, edges: 9, status: 'ready' },
    });
  });

  it('omits optional params the server does not advertise and doc_candidates on reindex', async () => {
    ctx.factory.tools = standardTools();
    const lease = await attemptLease(ctx);
    await ctx.manager.index(ctx.workspace, { mode: 'fast', kind: 'task_index', lease });
    expect(ctx.factory.calls[0]?.args).toEqual({
      repo_path: resolve(ctx.workspace.path),
      mode: 'fast',
      name: 'orc-t-f00dbabe2222-a2',
    });
    expect(ctx.factory.calls[1]?.args).toEqual({ project: 'orc-t-f00dbabe2222-a2' });

    ctx.factory.tools = standardTools({ index_repository: ['doc_candidates'] });
    ctx.factory.calls.length = 0;
    await ctx.manager.index(ctx.workspace, { mode: 'fast', kind: 'task_reindex', lease });
    expect(ctx.factory.calls[0]?.args).not.toHaveProperty('doc_candidates');
    // the caller's attempt lease is used, never released by the manager
    expect(ctx.factory.connects.every((c) => c.leaseKey === `attempt-${ATTEMPT_ID}`)).toBe(true);
    expect(ctx.launcher.leases.filter((l) => l.key.startsWith('op-'))).toHaveLength(0);
    expect(ctx.launcher.leases[0]?.released).toBe(false);
  });

  it('requires the attempt lease for workspace scopes', async () => {
    await expect(ctx.manager.index(ctx.workspace, { mode: 'fast', kind: 'task_index' })).rejects.toThrow(
      /attempt lease/,
    );
  });

  it('passes existingOperationId to the recorder', async () => {
    const id = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
    const out = await ctx.manager.index(ctx.project, { mode: 'full', kind: 'project_index', existingOperationId: id });
    expect(out.operationId).toBe(id);
    expect(ctx.recorder.started[0]?.existingOperationId).toBe(id);
  });

  it.each([
    ['missing tool', () => standardTools().filter((t) => t.name !== 'detect_changes'), 'mcp_tool_missing'],
    [
      'missing required param',
      () =>
        standardTools().map((t) =>
          t.name === 'index_repository' ? { name: t.name, inputSchema: { properties: { repo_path: {}, mode: {} } } } : t,
        ),
      'mcp_tool_schema_mismatch',
    ],
  ] as const)('fails with a typed error on %s', async (_label, tools, code) => {
    ctx.factory.tools = tools();
    const out = await ctx.manager.index(ctx.project, { mode: 'fast', kind: 'project_index' });
    expect(out.status).toBe('failed');
    expect(out.errorCode).toBe(code);
    expect(ctx.factory.calls).toHaveLength(0);
    expect(ctx.factory.closed).toBe(1);
    expect(ctx.recorder.finished[0]?.outcome.errorCode).toBe(code);
  });

  it('maps isError to mcp_tool_error with a masked, capped message', async () => {
    const secret = 'ghp_' + 'A'.repeat(36);
    ctx.factory.handlers['index_repository'] = () => textResult(`boom token=${secret} ${'x'.repeat(5000)}`, true);
    const out = await ctx.manager.index(ctx.project, { mode: 'fast', kind: 'project_index' });
    expect(out.errorCode).toBe('mcp_tool_error');
    expect(out.errorMessage).toMatch(/^boom/);
    expect(out.errorMessage).not.toContain(secret);
    expect(out.errorMessage?.length).toBeLessThanOrEqual(2000);
  });

  it('maps a connect failure to the outcome and still releases the op lease', async () => {
    ctx.factory.connectError = new McpError('mcp_unavailable', 'spawn ENOENT');
    const out = await ctx.manager.index(ctx.project, { mode: 'fast', kind: 'project_index' });
    expect(out).toMatchObject({ status: 'failed', errorCode: 'mcp_unavailable', nodeCount: null });
    expect(ctx.launcher.leases.every((l) => l.released)).toBe(true);
  });

  it('maps an aborted signal to mcp_timeout', async () => {
    const ac = new AbortController();
    ctx.factory.handlers['index_repository'] = () => {
      ac.abort();
      throw new Error('cancelled');
    };
    const out = await ctx.manager.index(ctx.project, { mode: 'fast', kind: 'project_index', signal: ac.signal });
    expect(out.errorCode).toBe('mcp_timeout');
  });

  it('maps an abort that lands right after connect to mcp_timeout without calling tools', async () => {
    const ac = new AbortController();
    const connect = ctx.factory.connect.bind(ctx.factory);
    ctx.factory.connect = async (o) => {
      const session = await connect(o);
      ac.abort();
      return session;
    };
    const out = await ctx.manager.index(ctx.project, { mode: 'fast', kind: 'project_index', signal: ac.signal });
    expect(out).toMatchObject({ status: 'failed', errorCode: 'mcp_timeout' });
    expect(ctx.factory.calls).toEqual([]);
    expect(ctx.factory.closed).toBe(1);
  });

  it('refuses a scope path that leaves WORKSPACES_ROOT through a link', async () => {
    const outside = join(ctx.tmp.root, 'outside');
    await mkdir(outside, { recursive: true });
    const link = join(ctx.tmp.workspaces, PROJECT_ID, 'linked');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const out = await ctx.manager.index({ ...ctx.project, path: link }, { mode: 'fast', kind: 'project_index' });
    expect(out).toMatchObject({ status: 'failed', errorCode: 'mcp_unavailable' });
    expect(out.errorMessage).toMatch(/escapes/);
    expect(ctx.factory.connects).toEqual([]);
    expect(ctx.recorder.finished.at(-1)?.outcome.status).toBe('failed');
  });
});

describe('result parsing (§12.2)', () => {
  const run = async (status: unknown, index: unknown = { status: 'indexed' }) => {
    ctx.factory.handlers['index_repository'] = () => (isResult(index) ? index : textResult(index));
    ctx.factory.handlers['index_status'] = () => (isResult(status) ? status : textResult(status));
    return ctx.manager.index(ctx.project, { mode: 'fast', kind: 'project_index' });
  };
  const isResult = (v: unknown): v is ReturnType<typeof textResult> =>
    typeof v === 'object' && v !== null && 'isError' in v && 'structured' in v;

  it('prefers structuredContent objects over text', async () => {
    const out = await run(structuredResult({ stats: { node_count: 5, edge_count: 3 } }, '{"nodes":1,"edges":1}'));
    expect([out.nodeCount, out.edgeCount]).toEqual([5, 3]);
  });

  it('parses JSON text and finds counts up to depth 3 with alternate names', async () => {
    const out = await run({ a: { b: { total_nodes: 8, edgeCount: 4 } } });
    expect([out.nodeCount, out.edgeCount]).toEqual([8, 4]);
    const deep = await run({ a: { b: { c: { nodes: 8, edges: 4 } } } }, { status: 'indexed' });
    expect([deep.nodeCount, deep.edgeCount]).toEqual([null, null]);
  });

  it('takes the shallowest numeric match and ignores non-numeric values', async () => {
    const out = await run({ nodes: 'many', inner: { nodeCount: 11, edges: -1, deeper: { edges: 6 } } });
    expect([out.nodeCount, out.edgeCount]).toEqual([11, 6]);
  });

  it('wraps non-JSON text and falls back to index_repository counts', async () => {
    const out = await run('index is ready (tree format)', { nodes: 30, edges: 15 });
    expect([out.nodeCount, out.edgeCount]).toEqual([30, 15]);
    expect(out.result).toEqual({ index: { nodes: 30, edges: 15 }, status: { text: 'index is ready (tree format)' } });
  });

  it('keeps a successful index when index_status fails', async () => {
    const out = await run(textResult({ error: 'project not found' }, true), { nodes: 3, edges: 2 });
    expect(out.status).toBe('succeeded');
    expect([out.nodeCount, out.edgeCount]).toEqual([3, 2]);
  });

  it('caps stored results at resultMaxBytes', async () => {
    const c = await setup('local', { resultMaxBytes: 2048 });
    cleanups.push(c);
    c.factory.handlers['detect_changes'] = () =>
      textResult({ changed_files: Array.from({ length: 500 }, (_, i) => `src/file-${i}.ts`) });
    const lease = await attemptLease(c);
    const out = await c.manager.detectChanges(c.workspace, { baseSha: SHA, lease });
    expect(out.status).toBe('succeeded');
    const result = out.result as { truncated: boolean; preview: string };
    expect(result.truncated).toBe(true);
    expect(result.preview.startsWith('{"changed_files":["src/file-0.ts"')).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(2048);
  });
});

describe('detectChanges', () => {
  it('sends project, base_branch, scope impact and format json', async () => {
    const lease = await attemptLease(ctx);
    const out = await ctx.manager.detectChanges(ctx.workspace, { baseSha: SHA, lease });
    expect(out.status).toBe('succeeded');
    expect(out.result).toEqual({ changed_files: ['src/a.ts'], impacted_symbols: [] });
    expect(ctx.factory.calls[0]).toEqual({
      tool: 'detect_changes',
      args: { project: 'orc-t-f00dbabe2222-a2', base_branch: SHA, scope: 'impact', format: 'json' },
      timeoutMs: 4000,
    });
    expect(ctx.recorder.started[0]).toMatchObject({ kind: 'impact_analysis', mode: null, taskId: TASK_ID });
  });

  it('rejects a base that is not a commit SHA', async () => {
    const lease = await attemptLease(ctx);
    await expect(ctx.manager.detectChanges(ctx.workspace, { baseSha: '--output=x', lease })).rejects.toMatchObject({
      code: 'unsafe_argument',
    });
  });
});

describe('deleteIndex', () => {
  it('deletes the project and removes the cache dir; idempotent', async () => {
    await ctx.manager.index(ctx.project, { mode: 'fast', kind: 'project_index' });
    const cache = ctx.manager.cacheDir(ctx.project);
    await writeFile(join(cache, 'graph.db'), 'x');
    ctx.factory.calls.length = 0;
    await ctx.manager.deleteIndex(ctx.project);
    expect(ctx.factory.calls).toEqual([
      { tool: 'delete_project', args: { project: 'orc-p-0a1b2c3d' }, timeoutMs: 2000 },
    ]);
    expect(existsSync(cache)).toBe(false);
    const del = ctx.recorder.finished.at(-1)?.outcome;
    expect(del).toMatchObject({ status: 'succeeded', errorCode: null });
    expect(ctx.recorder.started.at(-1)).toMatchObject({ kind: 'index_delete', mode: null });

    await ctx.manager.deleteIndex(ctx.project);
    expect(ctx.factory.calls).toHaveLength(1);
    expect(ctx.recorder.finished.at(-1)?.outcome.status).toBe('succeeded');
  });

  it('treats delete_project not_found as success and removes the cache when MCP fails', async () => {
    const lease = await attemptLease(ctx);
    await ctx.manager.index(ctx.workspace, { mode: 'fast', kind: 'task_index', lease });
    ctx.factory.handlers['delete_project'] = (a) => textResult({ project: a['project'], status: 'not_found' }, true);
    await ctx.manager.deleteIndex(ctx.workspace, { lease });
    expect(ctx.recorder.finished.at(-1)?.outcome.result).toMatchObject({ warning: null });

    await ctx.manager.index(ctx.workspace, { mode: 'fast', kind: 'task_index', lease });
    ctx.factory.connectError = new McpError('mcp_unavailable', 'down');
    await ctx.manager.deleteIndex(ctx.workspace, { lease });
    expect(existsSync(ctx.manager.cacheDir(ctx.workspace))).toBe(false);
    expect(ctx.recorder.finished.at(-1)?.outcome).toMatchObject({
      status: 'succeeded',
      result: { warning: { code: 'mcp_unavailable' } },
    });
  });
});

describe('probe', () => {
  it('reports ok with the server version and tools', async () => {
    const res = await ctx.manager.probe();
    expect(res).toMatchObject({ ok: true, serverVersion: '0.12.0-scripted', missingTools: [], schemaMismatches: [] });
    expect(res.tools).toEqual(expect.arrayContaining(['index_repository', 'detect_changes']));
    expect(ctx.factory.calls).toEqual([{ tool: 'list_projects', args: {}, timeoutMs: 2000 }]);
    const lease = ctx.launcher.leases[0];
    expect(lease?.key).toBe('op-mcp-probe-worker-test');
    expect(LEASE_KEY_REGEX.test(lease?.key ?? '')).toBe(true);
    expect(lease?.paths).toEqual([resolve(ctx.tmp.cache, 'probe')]);
    expect(lease?.released).toBe(true);
  });

  it('lists missing tools and schema mismatches without throwing', async () => {
    ctx.factory.tools = standardTools()
      .filter((t) => t.name !== 'list_projects')
      .map((t) => (t.name === 'delete_project' ? { name: t.name, inputSchema: {} } : t));
    const res = await ctx.manager.probe();
    expect(res.ok).toBe(false);
    expect(res.missingTools).toEqual(['list_projects']);
    expect(res.schemaMismatches).toEqual(['delete_project.project']);
  });

  it('returns ok=false when the server cannot start', async () => {
    ctx.factory.connectError = new McpError('mcp_unavailable', 'spawn ENOENT');
    const res = await ctx.manager.probe();
    expect(res.ok).toBe(false);
    expect(ctx.launcher.leases.every((l) => l.released)).toBe(true);
  });
});

describe('McpError', () => {
  it('is an OrcError carrying an MCP code', () => {
    const e = new McpError('mcp_timeout', 'slow');
    expect(isOrcError(e)).toBe(true);
    expect(e.code).toBe('mcp_timeout');
    expect(e.status).toBe(500);
  });
});
