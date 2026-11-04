// createSdkClientFactory + createMcpManager against the fake codebase-memory-mcp server (§18.4):
// real stdio processes, real MCP protocol, deterministic behaviour switched by .fake-cbm.json.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpManager, createSdkClientFactory } from '@orc/mcp-manager';
import type { IndexScope, McpManager, McpManagerConfig } from '@orc/mcp-manager';
import type { LaunchLease } from '@orc/shared/node';
import { createTestLauncher } from '../../helpers/mcp/local-launcher';
import type { TestLauncher } from '../../helpers/mcp/local-launcher';
import {
  FAKE_CBM_PATH,
  createMemoryRecorder,
  createTempRoot,
  createTestLogger,
  readFakeCalls,
  writeFakeSwitch,
} from '../../helpers/mcp/support';
import type { FakeCbmSwitch, MemoryRecorder, TempRoot } from '../../helpers/mcp/support';

const PROJECT_ID = '0a1b2c3d-1111-4222-8333-444455556666';
const TASK_ID = 'f00dbabe-2222-4333-8444-555566667777';
const ATTEMPT_ID = 'abcdef01-3333-4444-8555-666677778888';
const WORKSPACE_ID = '12345678-4444-4555-8666-777788889999';
// Each operation spawns a Node MCP server (~1 s cold start on Windows): generous per-file timeouts.
const TEST_TIMEOUT_MS = 60_000;

interface Env {
  tmp: TempRoot;
  launcher: TestLauncher;
  recorder: MemoryRecorder;
  manager: McpManager;
  logLines: () => string[];
  project: Extract<IndexScope, { kind: 'project' }>;
  workspace: Extract<IndexScope, { kind: 'workspace' }>;
}

let env: Env;

async function build(over: Partial<McpManagerConfig> = {}): Promise<Env> {
  const tmp = await createTempRoot();
  const launcher = createTestLauncher();
  const recorder = createMemoryRecorder();
  const { logger, lines } = createTestLogger('debug');
  const cfg: McpManagerConfig = {
    bin: process.execPath,
    binPrefixArgs: [FAKE_CBM_PATH],
    cacheRoot: tmp.cache,
    workspacesRoot: tmp.workspaces,
    logLevel: 'warn',
    connectTimeoutMs: 15_000,
    callTimeoutMs: 15_000,
    indexTimeoutMs: 15_000,
    detectTimeoutMs: 15_000,
    resultMaxBytes: 262_144,
    workerId: 'worker-fake',
    appVersion: '1.2.3-test',
    ...over,
  };
  const factory = createSdkClientFactory(cfg, { logger, launcher });
  const manager = createMcpManager(cfg, { logger, factory, recorder, launcher });
  const base = join(tmp.workspaces, PROJECT_ID, '_base');
  const wt = join(tmp.workspaces, PROJECT_ID, TASK_ID, 'wt');
  for (const dir of [base, wt]) {
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(dir, 'src', 'b.ts'), 'export const b = 2;\n');
  }
  return {
    tmp,
    launcher,
    recorder,
    manager,
    logLines: lines,
    project: { kind: 'project', projectId: PROJECT_ID, path: base },
    workspace: {
      kind: 'workspace',
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      attemptNumber: 1,
      path: wt,
      keyLength: 8,
    },
  };
}

async function attemptLease(e: Env): Promise<LaunchLease> {
  return e.launcher.acquire({
    key: `attempt-${ATTEMPT_ID}`,
    attemptId: ATTEMPT_ID,
    workerId: 'worker-fake',
    paths: [e.workspace.path, e.manager.cacheDir(e.workspace)],
  });
}

async function withSwitch(sw: FakeCbmSwitch): Promise<void> {
  await writeFakeSwitch(env.project.path, sw);
  await writeFakeSwitch(env.workspace.path, sw);
}

beforeEach(async () => {
  env = await build();
}, TEST_TIMEOUT_MS);

afterEach(async () => {
  await withSwitch({ mode: 'ok' });
  await env.manager.deleteIndex(env.project);
  await env.manager.deleteIndex(env.workspace);
  await env.launcher.close();
  expect(env.launcher.alivePids()).toEqual([]);
  await env.tmp.cleanup();
}, TEST_TIMEOUT_MS);

describe('fake-cbm happy path', { timeout: TEST_TIMEOUT_MS }, () => {
  it('indexes with deterministic counts and sends only advertised optional params', async () => {
    await withSwitch({ mode: 'ok' });
    const out = await env.manager.index(env.project, { mode: 'moderate', kind: 'project_index' });
    // 3 files: src/a.ts, src/b.ts, .fake-cbm.json
    expect(out).toMatchObject({ status: 'succeeded', nodeCount: 30, edgeCount: 15, errorCode: null });
    expect(out.result).toEqual({
      index: { project: 'orc-p-0a1b2c3d', nodes: 30, edges: 15, status: 'ready' },
      status: { project: 'orc-p-0a1b2c3d', nodes: 30, edges: 15, status: 'ready' },
    });
    const calls = await readFakeCalls(env.manager.cacheDir(env.project));
    expect(calls.map((c) => c.tool)).toEqual(['index_repository', 'index_status']);
    expect(calls[0]?.args).toEqual({
      repo_path: resolve(env.project.path),
      mode: 'moderate',
      name: 'orc-p-0a1b2c3d',
      doc_candidates: true,
    });
    expect(calls[1]?.args).toEqual({ project: 'orc-p-0a1b2c3d', format: 'json' });
    expect(env.launcher.spawns[0]?.spec).toMatchObject({ kind: 'mcp', cmd: process.execPath, args: [FAKE_CBM_PATH] });
    const spawnEnv = env.launcher.spawns[0]?.spec.env ?? {};
    expect(spawnEnv['CBM_CACHE_DIR']).toBe(env.manager.cacheDir(env.project));
    expect(spawnEnv['CBM_ALLOWED_ROOT']).toBe(resolve(env.project.path));
    expect(spawnEnv['CBM_LOG_LEVEL']).toBe('warn');
    expect(Object.keys(spawnEnv).some((k) => /^(DB_|REDIS_|SESSION_|ANTHROPIC)/.test(k))).toBe(false);
    expect(env.launcher.alivePids()).toEqual([]);
  });

  it('filters optional params by the advertised inputSchema', async () => {
    await withSwitch({ mode: 'ok', omitParams: { index_repository: ['doc_candidates'], index_status: ['format'] } });
    const lease = await attemptLease(env);
    const out = await env.manager.index(env.workspace, { mode: 'fast', kind: 'task_index', lease });
    expect(out.status).toBe('succeeded');
    const calls = await readFakeCalls(env.manager.cacheDir(env.workspace));
    expect(calls[0]?.args).toEqual({ repo_path: resolve(env.workspace.path), mode: 'fast', name: 'orc-t-f00dbabe-a1' });
    expect(calls[1]?.args).toEqual({ project: 'orc-t-f00dbabe-a1' });
  });

  it('parses structuredContent when the server returns it', async () => {
    await withSwitch({ mode: 'ok', structured: true });
    const out = await env.manager.index(env.project, { mode: 'fast', kind: 'project_index' });
    expect([out.nodeCount, out.edgeCount]).toEqual([30, 15]);
  });

  it('probes the server', async () => {
    const res = await env.manager.probe();
    expect(res).toMatchObject({ ok: true, serverVersion: '0.12.0-fake', missingTools: [], schemaMismatches: [] });
    expect(res.tools).toEqual([
      'delete_project',
      'detect_changes',
      'get_file_outline',
      'index_repository',
      'index_status',
      'list_projects',
      'trace_path',
    ]);
    expect(env.launcher.alivePids()).toEqual([]);
  });

  it('reports changed files from detect_changes and deletes idempotently', async () => {
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', env.workspace.path, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@example.invalid',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@example.invalid',
        },
      }).trim();
    git('init', '-q');
    await withSwitch({ mode: 'ok' });
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    const base = git('rev-parse', 'HEAD');
    await writeFile(join(env.workspace.path, 'src', 'a.ts'), 'export const a = 42;\n');

    const lease = await attemptLease(env);
    expect((await env.manager.index(env.workspace, { mode: 'fast', kind: 'task_index', lease })).status).toBe('succeeded');
    const impact = await env.manager.detectChanges(env.workspace, { baseSha: base, lease });
    expect(impact).toMatchObject({ status: 'succeeded', result: { changed_files: ['src/a.ts'], impacted_symbols: [] } });
    const calls = await readFakeCalls(env.manager.cacheDir(env.workspace));
    expect(calls.at(-1)).toEqual({
      tool: 'detect_changes',
      args: { project: 'orc-t-f00dbabe-a1', base_branch: base, scope: 'impact', format: 'json' },
    });

    await env.manager.deleteIndex(env.workspace, { lease });
    expect(existsSync(env.manager.cacheDir(env.workspace))).toBe(false);
    await env.manager.deleteIndex(env.workspace, { lease });
    expect(env.recorder.finished.at(-1)?.outcome.status).toBe('succeeded');
  });
});

describe('fake-cbm diff-seeded impact (ADR-0035)', { timeout: TEST_TIMEOUT_MS }, () => {
  it('derives seeds and inbound callers from the worker diff in a worktree without git', async () => {
    const src = join(env.workspace.path, 'src');
    await writeFile(join(src, 'a.ts'), 'export function a() {\n  return b();\n}\n');
    await writeFile(join(src, 'b.ts'), 'export function b() {\n  return 3;\n}\n\nexport function other() {\n  return 0;\n}\n');
    await writeFile(join(src, 'c.ts'), 'export function c() {\n  return a();\n}\n');
    expect(existsSync(join(env.workspace.path, '.git'))).toBe(false);
    const lease = await attemptLease(env);
    expect((await env.manager.index(env.workspace, { mode: 'fast', kind: 'task_reindex', lease })).status).toBe('succeeded');

    const head = 'fedcba9876543210fedcba9876543210fedcba98';
    const base = '0123456789abcdef0123456789abcdef01234567';
    const impact = await env.manager.detectChanges(env.workspace, {
      baseSha: base,
      lease,
      changes: {
        headSha: head,
        totalFiles: 1,
        truncated: false,
        files: [
          {
            path: 'src/b.ts',
            oldPath: null,
            changeType: 'M',
            isBinary: false,
            patchTruncated: false,
            patch: [
              'diff --git a/src/b.ts b/src/b.ts',
              '--- a/src/b.ts',
              '+++ b/src/b.ts',
              '@@ -1,3 +1,3 @@',
              ' export function b() {',
              '-  return 2;',
              '+  return 3;',
              ' }',
              '',
            ].join('\n'),
          },
        ],
      },
    });
    expect(impact.errorMessage).toBeNull();
    expect(impact).toMatchObject({
      status: 'succeeded',
      result: {
        source: 'worker_diff',
        head,
        changed_files: ['src/b.ts'],
        seeds: [{ qn: 'orc-t-f00dbabe-a1.src.b.b', file: 'src/b.ts', start: 1, end: 3, seed_reason: 'hunk' }],
        impacted_symbols: ['orc-t-f00dbabe-a1.src.a.a', 'orc-t-f00dbabe-a1.src.c.c'],
        truncated: false,
      },
    });
    const calls = await readFakeCalls(env.manager.cacheDir(env.workspace));
    expect(calls.map((c) => c.tool)).toEqual(['index_repository', 'index_status', 'get_file_outline', 'trace_path']);
  });

  it('a missing graph tool fails only the impact operation', async () => {
    await withSwitch({ mode: 'missing-tool:get_file_outline' });
    const lease = await attemptLease(env);
    expect((await env.manager.index(env.workspace, { mode: 'fast', kind: 'task_index', lease })).status).toBe('succeeded');
    const impact = await env.manager.detectChanges(env.workspace, {
      baseSha: '0123456789abcdef0123456789abcdef01234567',
      lease,
      changes: { headSha: 'fedcba9876543210fedcba9876543210fedcba98', totalFiles: 0, truncated: false, files: [] },
    });
    expect(impact).toMatchObject({ status: 'failed', errorCode: 'mcp_tool_missing' });
    expect(impact.errorMessage).toContain('get_file_outline');
  });
});

describe('fake-cbm failure mapping (§12.4)', { timeout: TEST_TIMEOUT_MS }, () => {
  it('missing required tool => mcp_tool_missing; probe lists it', async () => {
    await withSwitch({ mode: 'missing-tool:detect_changes' });
    const out = await env.manager.index(env.project, { mode: 'fast', kind: 'project_index' });
    expect(out).toMatchObject({ status: 'failed', errorCode: 'mcp_tool_missing', nodeCount: null, edgeCount: null });
    expect(out.errorMessage).toContain('detect_changes');
    expect(await readFakeCalls(env.manager.cacheDir(env.project))).toEqual([]);
  });

  it('required param absent => mcp_tool_schema_mismatch', async () => {
    await withSwitch({ mode: 'ok', omitParams: { detect_changes: ['base_branch'] } });
    const out = await env.manager.index(env.project, { mode: 'fast', kind: 'project_index' });
    expect(out.errorCode).toBe('mcp_tool_schema_mismatch');
    expect(out.errorMessage).toContain('detect_changes.base_branch');
  });

  it('tool isError => mcp_tool_error with the tool text', async () => {
    await withSwitch({ mode: 'error:index_repository' });
    const out = await env.manager.index(env.project, { mode: 'fast', kind: 'project_index' });
    expect(out.errorCode).toBe('mcp_tool_error');
    expect(out.errorMessage).toContain('simulated failure in index_repository');
  });

  it('call exceeding its timeout => mcp_timeout and the server is stopped', async () => {
    const e = await build({ indexTimeoutMs: 1500 });
    const prev = env;
    env = e;
    try {
      await withSwitch({ mode: 'hang:index_repository' });
      const started = Date.now();
      const out = await env.manager.index(env.project, { mode: 'fast', kind: 'project_index' });
      expect(out.errorCode).toBe('mcp_timeout');
      expect(Date.now() - started).toBeLessThan(12_000);
      expect(env.launcher.alivePids()).toEqual([]);
    } finally {
      await withSwitch({ mode: 'ok' });
      await env.manager.deleteIndex(env.project);
      await env.launcher.close();
      await env.tmp.cleanup();
      env = prev;
    }
  });

  it('abort signal => close() => mcp_timeout', async () => {
    await withSwitch({ mode: 'hang:index_repository' });
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('cancel')), 800).unref();
    const out = await env.manager.index(env.project, { mode: 'fast', kind: 'project_index', signal: ac.signal });
    expect(out.errorCode).toBe('mcp_timeout');
    expect(env.launcher.alivePids()).toEqual([]);
  });

  it('server crash during a call => mcp_unavailable with stderr tail', async () => {
    await withSwitch({ mode: 'crash' });
    const out = await env.manager.index(env.project, { mode: 'fast', kind: 'project_index' });
    expect(out.errorCode).toBe('mcp_unavailable');
    const result = out.result as { error: { stderrTail?: string[]; exit?: { exitCode: number | null } } };
    expect(result.error.stderrTail?.join('\n')).toContain('simulated crash in index_repository');
    expect(result.error.exit?.exitCode).toBe(70);
    expect(env.logLines().some((l) => l.includes('codebase-memory-mcp stderr'))).toBe(true);
  });

  it('server exiting before the handshake => mcp_unavailable; probe fails', async () => {
    await withSwitch({ mode: 'crash:startup' });
    const out = await env.manager.index(env.project, { mode: 'fast', kind: 'project_index' });
    expect(out.errorCode).toBe('mcp_unavailable');
    expect(JSON.stringify(out.result)).toContain('simulated startup crash');
  });

  it('session-level JSON-RPC error before the handshake => mcp_unavailable carrying the server message', async () => {
    await withSwitch({ mode: 'fatal:startup' });
    const out = await env.manager.index(env.project, { mode: 'fast', kind: 'project_index' });
    expect(out.errorCode).toBe('mcp_unavailable');
    const result = out.result as { error: { serverError?: string; exit?: { exitCode: number | null } } };
    expect(result.error.serverError).toBe('fake-cbm: daemon refused to start');
    expect(result.error.exit?.exitCode).toBe(1);
    expect(env.launcher.alivePids()).toEqual([]);
  });

  it('undecodable server output => mcp_protocol_error', async () => {
    await withSwitch({ mode: 'garbage:index_repository' });
    const out = await env.manager.index(env.project, { mode: 'fast', kind: 'project_index' });
    expect(out.errorCode).toBe('mcp_protocol_error');
    expect(env.launcher.alivePids()).toEqual([]);
  });

  it('missing binary => mcp_unavailable', async () => {
    const e = await build({ bin: join(env.tmp.root, 'no-such-cbm.exe'), binPrefixArgs: [] });
    try {
      const out = await e.manager.index(e.project, { mode: 'fast', kind: 'project_index' });
      expect(out.errorCode).toBe('mcp_unavailable');
      const res = await e.manager.probe();
      expect(res.ok).toBe(false);
    } finally {
      await e.manager.deleteIndex(e.project);
      await e.launcher.close();
      await e.tmp.cleanup();
    }
  });
});
