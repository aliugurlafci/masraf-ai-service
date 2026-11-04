// Shared setup for claude-runner tests driven by tests/fixtures/fake-claude (contract §18.3).
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaudeInitEvent, ParsedClaudeLine } from '@orc/shared';
import type { HostPlatform, LaunchLease } from '@orc/shared/node';
import { computeToolPolicy } from '@orc/security';
import type { ClaudeRunHandlers, ClaudeRunnerConfig, ClaudeRunRequest, InitValidation } from '@orc/claude-runner';

export const FAKE_CLAUDE_PATH = fileURLToPath(
  new URL('../../fixtures/fake-claude/fake-claude.mjs', import.meta.url),
);
export const FAKE_HELP_PATH = fileURLToPath(
  new URL('../../fixtures/fake-claude/claude-help-2.1.316.txt', import.meta.url),
);

/** A syntactically realistic test-only API key (masked by the `sk-ant-` pattern). */
export const TEST_API_KEY = 'sk-ant-api03-TESTONLY0000000000000000000000000000';
export const TEST_PROXY_TOKEN = 'proxytoken_TESTONLY_000000000000';

export const ATTEMPT_ID = '11111111-2222-4333-8444-555555555555';
export const TASK_ID = '22222222-3333-4444-8555-666666666666';
export const WORKSPACE_ID = '33333333-4444-4555-8666-777777777777';
export const SESSION_ID = '44444444-5555-4666-8777-888888888888';

export const hostPlatform: HostPlatform = process.platform === 'win32' ? 'win32' : 'posix';

export interface RunnerLayout {
  root: string;
  workspacesRoot: string;
  projectsRoot: string;
  claudeHomeRoot: string;
  cbmCacheRoot: string;
  worktree: string;
  metaDir: string;
  tmpDir: string;
  mcpConfigPath: string;
}

/** Creates the §10.3/§11.1-like directory layout below `root` (an existing realpath). */
export async function createRunnerLayout(root: string): Promise<RunnerLayout> {
  const workspacesRoot = join(root, 'workspaces');
  const worktree = join(workspacesRoot, 'proj', 'task', 'wt');
  const metaDir = join(workspacesRoot, 'proj', 'task', '.meta');
  const tmpDir = join(metaDir, 'tmp');
  const claudeHomeRoot = join(root, 'claude-home');
  const layout: RunnerLayout = {
    root,
    workspacesRoot,
    projectsRoot: join(root, 'projects'),
    claudeHomeRoot,
    cbmCacheRoot: join(root, 'cbm-cache'),
    worktree,
    metaDir,
    tmpDir,
    mcpConfigPath: join(metaDir, 'mcp.json'),
  };
  for (const dir of [
    worktree,
    tmpDir,
    layout.projectsRoot,
    join(claudeHomeRoot, 'w', WORKSPACE_ID, 'home'),
    join(claudeHomeRoot, 'w', WORKSPACE_ID, 'config'),
    join(claudeHomeRoot, 'probe'),
    join(layout.cbmCacheRoot, 'w', WORKSPACE_ID),
  ]) {
    await mkdir(dir, { recursive: true });
  }
  return layout;
}

export function fakeRunnerConfig(
  layout: RunnerLayout,
  overrides: Partial<ClaudeRunnerConfig> = {},
): ClaudeRunnerConfig {
  return {
    bin: process.execPath,
    binPrefixArgs: [FAKE_CLAUDE_PATH],
    bare: true,
    claudeHomeRoot: layout.claudeHomeRoot,
    apiKey: TEST_API_KEY,
    proxy: { https: null, http: null, noProxy: null, token: null },
    killGraceMs: 1500,
    initTimeoutMs: 20_000,
    maxOutputBytes: 50 * 1024 * 1024,
    maxLineBytes: 4 * 1024 * 1024,
    cbmCacheRoot: layout.cbmCacheRoot,
    platform: hostPlatform,
    workerId: 'worker-test-1',
    initExtraTools: [],
    ...overrides,
  };
}

export interface RequestOptions {
  lease: LaunchLease;
  prompt?: string;
  directives?: readonly string[];
  mcp?: boolean;
  signal?: AbortSignal;
  deadlineMs?: number;
  session?: ClaudeRunRequest['session'];
  agentAllowedTools?: readonly string[];
  maxBudgetUsd?: number | null;
}

/** stdin prompt whose task description carries the fake-claude directives. */
export function directivePrompt(directives: readonly string[]): string {
  return ['ORC TASK MESSAGE v1 (test)', 'Do the task.', ...directives, ''].join('\n');
}

export function makeRunRequest(layout: RunnerLayout, o: RequestOptions): ClaudeRunRequest {
  const mcp = o.mcp ?? false;
  const tools = computeToolPolicy(
    { allowedTools: o.agentAllowedTools ?? ['Read', 'Edit', 'Glob', 'Grep'], disallowedTools: [] },
    {
      mcpEnabled: mcp,
      worktreePath: layout.worktree,
      workspacesRoot: layout.workspacesRoot,
      projectsRoot: layout.projectsRoot,
      claudeHomeRoot: layout.claudeHomeRoot,
      cbmCacheRoot: layout.cbmCacheRoot,
    },
  );
  return {
    attemptId: ATTEMPT_ID,
    taskId: TASK_ID,
    workspaceId: WORKSPACE_ID,
    cwd: layout.worktree,
    metaDir: layout.metaDir,
    tmpDir: layout.tmpDir,
    lease: o.lease,
    model: 'claude-sonnet-4-5',
    effort: null,
    tools,
    mcp: mcp ? { configPath: layout.mcpConfigPath, cacheDir: join(layout.cbmCacheRoot, 'w', WORKSPACE_ID) } : null,
    appendSystemPrompt: '# ORC PLATFORM RULES\nTest rules.',
    stdinPrompt: o.prompt ?? directivePrompt(o.directives ?? []),
    session: o.session ?? { kind: 'new', sessionId: SESSION_ID },
    maxBudgetUsd: o.maxBudgetUsd ?? null,
    deadlineAt: new Date(Date.now() + (o.deadlineMs ?? 60_000)),
    signal: o.signal ?? new AbortController().signal,
  };
}

export interface Recorded {
  spawn: { pid: number; pgid: number | null; startedAt: Date } | null;
  inits: { init: ClaudeInitEvent; validation: InitValidation }[];
  lines: { parsed: ParsedClaudeLine; raw: string; lineNo: number }[];
  stderr: string[];
  /** PIDs reported by fake-claude `fake_pid` events (grandchildren). */
  fakePids: number[];
  /** Resolves once the given predicate over a line is satisfied. */
  events: { onLine: ((p: ParsedClaudeLine) => void)[] };
}

export function systemSubtype(p: ParsedClaudeLine): string | null {
  return p.kind === 'system' ? p.subtype : null;
}

export function recordingHandlers(
  extra: Partial<ClaudeRunHandlers> = {},
): { handlers: ClaudeRunHandlers; rec: Recorded } {
  const rec: Recorded = { spawn: null, inits: [], lines: [], stderr: [], fakePids: [], events: { onLine: [] } };
  const handlers: ClaudeRunHandlers = {
    async onSpawn(p) {
      rec.spawn = p;
      if (extra.onSpawn) await extra.onSpawn(p);
    },
    async onInit(init, validation) {
      rec.inits.push({ init, validation });
      if (extra.onInit) await extra.onInit(init, validation);
    },
    onLine(parsed, raw, lineNo) {
      rec.lines.push({ parsed, raw, lineNo });
      if (parsed.kind === 'system' && parsed.subtype === 'fake_pid' && typeof parsed.event.pid === 'number') {
        rec.fakePids.push(parsed.event.pid);
      }
      for (const cb of rec.events.onLine) cb(parsed);
      extra.onLine?.(parsed, raw, lineNo);
    },
    onStderr(chunk) {
      rec.stderr.push(chunk);
      extra.onStderr?.(chunk);
    },
  };
  return { handlers, rec };
}
