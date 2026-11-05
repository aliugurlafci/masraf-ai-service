// Runner state machine with an in-memory process (no real processes): parsing, masking, init
// validation, limits, stop reasons and the §13.4 outcome mapping.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  claudeExtensionKey,
  createClaudeRunner,
  outcomeForStopReason,
  toAbortReason,
  type ClaudeRunHandlers,
  type ClaudeRunnerConfig,
  type ClaudeRunRequest,
  type ReviewedExtensionTable,
} from '@orc/claude-runner';
import type { ParsedClaudeLine } from '@orc/shared';
import type { HostPlatform, LaunchSpec, SupervisedProcess } from '@orc/shared/node';
import { createSecretRegistry } from '@orc/security';
import {
  captureLogger,
  createMemoryLauncher,
  createMemoryProcess,
  memoryLease,
  silentLogger,
  type MemoryLauncher,
  type MemoryProcess,
  type MemoryProcessOptions,
} from '../../helpers/claude/memory-process';
import { FAKE_HELP_PATH } from '../../helpers/claude/fake-claude';

const SESSION = '44444444-5555-4666-8777-888888888888';
const CWD = process.platform === 'win32' ? 'C:\\srv\\ws\\p\\t\\wt' : '/srv/ws/p/t/wt';
const API_KEY = 'sk-ant-api03-RUNUNIT00000000000000000000000';
const TOKEN = `sk-ant-oat01-RUNUNIT${'0'.repeat(30)}`;
const PLATFORM: HostPlatform = process.platform === 'win32' ? 'win32' : 'posix';
const CLI_VERSION = '2.1.316';
const ROOT = mkdtempSync(join(tmpdir(), 'orc-claude-runner-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** Injected reviewed table (the production one only holds recorded names, keyed by the real CLI versions). */
const EMPTY_EXTENSIONS = { skills: [], agents: [], slashCommands: [], plugins: [] };
const TABLE: ReviewedExtensionTable = {
  [claudeExtensionKey(CLI_VERSION, 'posix', 'oauth')]: { ...EMPTY_EXTENSIONS, skills: ['verify'] },
  [claudeExtensionKey(CLI_VERSION, 'posix', 'api_key')]: { ...EMPTY_EXTENSIONS, skills: ['verify'] },
  [claudeExtensionKey(CLI_VERSION, 'win32', 'oauth')]: { ...EMPTY_EXTENSIONS, skills: ['verify'] },
  [claudeExtensionKey(CLI_VERSION, 'win32', 'api_key')]: { ...EMPTY_EXTENSIONS, skills: ['verify'] },
};

/** Answers the probe (`--version`, `--help`) itself; every other spawn goes to `factory`. */
const PROBE_OUTPUT: Readonly<Record<string, string>> = {
  '--version': `${CLI_VERSION} (Claude Code)\n`,
  '--help': readFileSync(FAKE_HELP_PATH, 'utf8'),
};
const isProbeSpec = (spec: LaunchSpec): boolean => spec.args.length === 1 && (spec.args[0] ?? '') in PROBE_OUTPUT;
function probing(factory: (spec: LaunchSpec) => SupervisedProcess | Error): MemoryLauncher {
  return createMemoryLauncher((spec) => {
    if (!isProbeSpec(spec)) return factory(spec);
    const proc = createMemoryProcess();
    setImmediate(() => {
      proc.writeStdout(PROBE_OUTPUT[spec.args[0] ?? ''] ?? '');
      proc.exit(0);
    });
    return proc;
  });
}
/** Spawns of the run itself (probe spawns excluded). */
const runSpecs = (l: MemoryLauncher): LaunchSpec[] => l.specs.filter((spec) => !isProbeSpec(spec));

function cfg(over: Partial<ClaudeRunnerConfig> = {}): ClaudeRunnerConfig {
  return {
    bin: 'claude',
    binPrefixArgs: [],
    claudeHomeRoot: join(ROOT, 'claude-home'),
    auth: { mode: 'oauth', oauthToken: TOKEN },
    reviewedExtensions: TABLE,
    proxy: { https: null, http: null, noProxy: null, token: null },
    killGraceMs: 777,
    initTimeoutMs: 5000,
    maxOutputBytes: 1_000_000,
    maxLineBytes: 100_000,
    cbmCacheRoot: process.platform === 'win32' ? 'C:\\srv\\cbm' : '/srv/cbm',
    platform: PLATFORM,
    workerId: 'w1',
    initExtraTools: [],
    ...over,
  };
}

function request(over: Partial<ClaudeRunRequest> = {}): ClaudeRunRequest {
  return {
    attemptId: '11111111-2222-4333-8444-555555555555',
    taskId: '22222222-3333-4444-8555-666666666666',
    workspaceId: '33333333-4444-4555-8666-777777777777',
    cwd: CWD,
    metaDir: `${CWD}-meta`,
    tmpDir: `${CWD}-meta-tmp`,
    lease: memoryLease,
    model: 'claude-sonnet-4-5',
    effort: null,
    tools: { builtinTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'], allowedRules: [], disallowedRules: ['WebFetch'] },
    mcp: null,
    appendSystemPrompt: 'rules',
    stdinPrompt: 'the task prompt',
    session: { kind: 'new', sessionId: SESSION },
    maxBudgetUsd: null,
    deadlineAt: new Date(Date.now() + 60_000),
    signal: new AbortController().signal,
    ...over,
  };
}

const init = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'system',
  subtype: 'init',
  cwd: CWD,
  session_id: SESSION,
  tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
  mcp_servers: [],
  model: 'claude-sonnet-4-5',
  permissionMode: 'dontAsk',
  claude_code_version: CLI_VERSION,
  apiKeySource: 'none',
  skills: ['verify'],
  ...over,
});
const text = (t: string): Record<string, unknown> => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text: t }] },
});
const result = (subtype = 'success', over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'result',
  subtype,
  is_error: subtype !== 'success',
  session_id: SESSION,
  total_cost_usd: 0.25,
  ...over,
});

interface Harness {
  proc: MemoryProcess;
  lines: { parsed: ParsedClaudeLine; raw: string; lineNo: number }[];
  stderr: string[];
  initCalls: number;
  handlers: ClaudeRunHandlers;
}

/** Runs the runner; `script` drives the process once stdin has been written. */
async function harness(
  script: (h: Harness) => void | Promise<void>,
  o: {
    cfg?: Partial<ClaudeRunnerConfig>;
    req?: Partial<ClaudeRunRequest>;
    proc?: MemoryProcessOptions;
    handlers?: Partial<ClaudeRunHandlers>;
    logger?: ReturnType<typeof captureLogger>;
  } = {},
): Promise<{ h: Harness; res: Awaited<ReturnType<ReturnType<typeof createClaudeRunner>['run']>> }> {
  const proc = createMemoryProcess(o.proc);
  const h: Harness = {
    proc,
    lines: [],
    stderr: [],
    initCalls: 0,
    handlers: {
      onSpawn: async (p) => {
        expect(proc.stdinText()).toBe('');
        await o.handlers?.onSpawn?.(p);
        setImmediate(() => void script(h));
      },
      onInit: async (i, v) => {
        h.initCalls += 1;
        await o.handlers?.onInit?.(i, v);
      },
      onLine: (parsed, raw, lineNo) => {
        h.lines.push({ parsed, raw, lineNo });
        o.handlers?.onLine?.(parsed, raw, lineNo);
      },
      onStderr: (c) => {
        h.stderr.push(c);
        o.handlers?.onStderr?.(c);
      },
    },
  };
  const runner = createClaudeRunner(cfg(o.cfg), {
    logger: o.logger?.logger ?? silentLogger(),
    secrets: createSecretRegistry(),
    launcher: probing(() => proc),
  });
  const res = await runner.run(request(o.req), h.handlers);
  return { h, res };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('ClaudeRunner.run with an in-memory process', () => {
  it('success: prompt on stdin after onSpawn, session and result captured', async () => {
    const { h, res } = await harness(async (x) => {
      expect(x.proc.stdinText()).toBe('the task prompt');
      expect(x.proc.stdinEnded()).toBe(true);
      x.proc.line(init());
      x.proc.line(text('hello'));
      x.proc.line(result());
      await tick();
      x.proc.exit(0);
    });
    expect(res).toMatchObject({
      outcome: 'success',
      exitCode: 0,
      sessionId: SESSION,
      violation: null,
      kill: null,
      result: { subtype: 'success', total_cost_usd: 0.25 },
    });
    expect(res.init?.session_id).toBe(SESSION);
    expect(h.initCalls).toBe(1);
    expect(h.lines.map((l) => [l.lineNo, l.parsed.kind])).toEqual([
      [1, 'init'],
      [2, 'assistant'],
      [3, 'result'],
    ]);
    expect(res.outputBytes).toBeGreaterThan(0);
  });

  it('tolerates invalid lines, unknown events, blank lines and split chunks', async () => {
    const { h, res } = await harness(async (x) => {
      x.proc.line(init());
      x.proc.writeStdout('this is not json\n\n   \n{"type":"future_event","x":1}\r\n{"type":"assis');
      await tick();
      x.proc.writeStdout('tant","message":{"content":[]}}\n[1,2]\n{"type":"result"}\n');
      x.proc.line(result());
      await tick();
      x.proc.exit(0);
    });
    expect(res.outcome).toBe('success');
    expect(h.lines.map((l) => l.parsed.kind)).toEqual(['init', 'invalid', 'unknown', 'assistant', 'invalid', 'invalid', 'result']);
    expect(h.lines.map((l) => l.lineNo)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const invalid = h.lines[1]?.parsed;
    expect(invalid?.kind === 'invalid' ? invalid.raw : null).toBe('this is not json');
  });

  it('masks secrets in stdout lines and in stderr (also when split across chunks)', async () => {
    const { h, res } = await harness(async (x) => {
      x.proc.line(init());
      x.proc.line(text(`key sk-ant-FAKE0000000000000000000000 and ${TOKEN}`));
      x.proc.writeStderr('warn: token sk-ant-FAKE00000');
      await tick();
      x.proc.writeStderr('00000000000000000 end\n');
      x.proc.line(result());
      await tick();
      x.proc.exit(0);
    });
    expect(res.outcome).toBe('success');
    const all = h.lines.map((l) => l.raw).join('\n') + h.stderr.join('');
    expect(all).not.toContain('sk-ant-FAKE');
    expect(all).not.toContain(TOKEN);
    expect(all).toContain('[REDACTED]');
    expect(h.stderr.join('')).toBe('warn: token [REDACTED] end\n');
  });

  it('init violation (extra MCP server) => immediate forced kill + security_violation', async () => {
    const { h, res } = await harness(
      (x) => {
        x.proc.line(init({ mcp_servers: [{ name: 'evil', status: 'connected' }] }));
        x.proc.line(text('after violation'));
        x.proc.line(result());
      },
      { proc: { onStop: 'exit' } },
    );
    expect(res.outcome).toBe('security_violation');
    expect(h.lines.map((l) => l.parsed.kind)).toEqual(['init']);
    expect(res.result).toBeNull();
    expect(res.violation?.rule).toBe('mcp_server');
    expect(res.violation?.detail).toContain('evil');
    expect(h.proc.stops[0]).toEqual({ graceMs: 0, forceImmediately: true });
    expect(res.kill?.forced).toBe(true);
    expect(h.initCalls).toBe(1);
  });

  it.each(['oauth', 'api_key'] as const)('a hook event is a violation at any time (%s mode)', async (mode) => {
    const auth = mode === 'oauth' ? ({ mode, oauthToken: TOKEN } as const) : ({ mode, apiKey: API_KEY } as const);
    const apiKeySource = mode === 'oauth' ? 'none' : 'ANTHROPIC_API_KEY';
    const afterInit = await harness(
      (x) => {
        x.proc.line(init({ apiKeySource }));
        x.proc.line({ type: 'system', subtype: 'hook_started' });
        x.proc.line(text('after hook'));
      },
      { cfg: { auth }, proc: { onStop: 'exit' } },
    );
    expect(afterInit.res.outcome).toBe('security_violation');
    expect(afterInit.res.violation).toEqual({
      rule: 'hook_event',
      detail: 'hook event "hook_started" (hooks are disabled)',
    });
    expect(afterInit.h.proc.stops[0]).toEqual({ graceMs: 0, forceImmediately: true });
    expect(afterInit.h.lines.map((l) => l.parsed.kind)).toEqual(['init', 'hook']);

    const beforeInit = await harness(
      (x) => {
        x.proc.line({ type: 'system', subtype: 'hook_response' });
        x.proc.line(init({ apiKeySource }));
      },
      { cfg: { auth }, proc: { onStop: 'exit' } },
    );
    expect(beforeInit.res.violation?.rule).toBe('hook_event');
    expect(beforeInit.h.initCalls).toBe(0);
  });

  it.each([
    ['tool_missing', { tools: ['Read', 'Edit'] }, 'requested builtin tool(s) missing from init: "Write", "Glob", "Grep"'],
    ['extension', { skills: ['verify', 'evil-skill'] }, 'unexpected skills: "evil-skill"'],
    [
      'extension',
      { claude_code_version: '2.1.999' },
      'claude_code_version="2.1.999" differs from the probed CLI version "2.1.316"',
    ],
    [
      'memory',
      { memory_paths: { auto: '/m/MEMORY.md' } },
      'memory_paths must be absent, null or empty (got {"auto":"/m/MEMORY.md"})',
    ],
    ['auth_source', { apiKeySource: 'apiKeyHelper' }, 'apiKeySource="apiKeyHelper" (expected "none" in oauth mode)'],
  ] as const)('init rule %s => forced kill + security_violation', async (rule, over, detail) => {
    const { h, res } = await harness(
      (x) => {
        x.proc.line(init(over));
        x.proc.line(text('after violation'));
      },
      { proc: { onStop: 'exit' } },
    );
    expect(res.outcome).toBe('security_violation');
    expect(res.violation).toEqual({ rule, detail });
    expect(h.proc.stops[0]).toEqual({ graceMs: 0, forceImmediately: true });
    expect(h.lines.map((l) => l.parsed.kind)).toEqual(['init']);
  });

  it('extension: a CLI version without a table entry fails closed and names the key', async () => {
    const { res } = await harness((x) => x.proc.line(init()), {
      cfg: { reviewedExtensions: {} },
      proc: { onStop: 'exit' },
    });
    expect(res.violation).toEqual({
      rule: 'extension',
      detail: `no reviewed extension entry for "${CLI_VERSION}/${PLATFORM}/oauth" (CLAUDE_REVIEWED_EXTENSIONS)`,
    });
  });

  // Host platform only (the probe creates real directories); the cross-platform matrix is in env.test.ts.
  it.each([
    [PLATFORM, 'oauth'],
    [PLATFORM, 'api_key'],
  ] as const)('credential transport %s/%s: fd 3 on POSIX oauth, env otherwise, never both', async (platform, mode) => {
    const launcher = probing(() => {
      const proc = createMemoryProcess();
      setImmediate(() => proc.exit(1));
      return proc;
    });
    const auth = mode === 'oauth' ? ({ mode, oauthToken: TOKEN } as const) : ({ mode, apiKey: API_KEY } as const);
    const runner = createClaudeRunner(cfg({ platform, auth }), {
      logger: silentLogger(),
      secrets: createSecretRegistry(),
      launcher,
    });
    await runner.run(request(), {
      onSpawn: () => Promise.resolve(),
      onInit: () => Promise.resolve(),
      onLine: () => undefined,
      onStderr: () => undefined,
    });
    const [spec] = runSpecs(launcher);
    const env = spec?.env ?? {};
    const credentialKeys = Object.keys(env).filter(
      (k) => k === 'ANTHROPIC_API_KEY' || k.startsWith('CLAUDE_CODE_OAUTH_TOKEN'),
    );
    if (mode === 'api_key') {
      expect(credentialKeys).toEqual(['ANTHROPIC_API_KEY']);
      expect(env.ANTHROPIC_API_KEY).toBe(API_KEY);
      expect(spec?.credentialFd).toBeUndefined();
    } else if (platform === 'posix') {
      expect(credentialKeys).toEqual(['CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR']);
      expect(env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR).toBe('3');
      expect(spec?.credentialFd).toBe(TOKEN);
      expect(JSON.stringify(env)).not.toContain(TOKEN);
    } else {
      expect(credentialKeys).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
      expect(spec?.credentialFd).toBeUndefined();
    }
    expect(spec?.args.join(' ')).not.toContain(mode === 'oauth' ? TOKEN : API_KEY);
  });

  it('an unprobed runner probes once before its first run; the run keys on the probed version', async () => {
    const proc = createMemoryProcess();
    const launcher = probing(() => proc);
    const runner = createClaudeRunner(cfg(), { logger: silentLogger(), secrets: createSecretRegistry(), launcher });
    const handlers: ClaudeRunHandlers = {
      onSpawn: () => {
        setImmediate(() => {
          proc.line(init());
          proc.line(result());
          setImmediate(() => proc.exit(0));
        });
        return Promise.resolve();
      },
      onInit: () => Promise.resolve(),
      onLine: () => undefined,
      onStderr: () => undefined,
    };
    await expect(runner.run(request(), handlers)).resolves.toMatchObject({ outcome: 'success' });
    expect(launcher.specs.filter(isProbeSpec).map((s) => s.args[0])).toEqual(['--version', '--help']);
    await runner.probe();
    expect(launcher.specs.filter(isProbeSpec)).toHaveLength(4);
  });

  it('a run on a runner whose probe fails rejects before spawning Claude', async () => {
    const launcher = createMemoryLauncher((spec) => {
      const proc = createMemoryProcess();
      setImmediate(() => {
        proc.writeStdout(spec.args[0] === '--version' ? 'unknown\n' : '');
        proc.exit(0);
      });
      return proc;
    });
    const runner = createClaudeRunner(cfg(), { logger: silentLogger(), secrets: createSecretRegistry(), launcher });
    await expect(
      runner.run(request(), {
        onSpawn: () => Promise.resolve(),
        onInit: () => Promise.resolve(),
        onLine: () => undefined,
        onStderr: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'claude_probe_failed' });
    expect(launcher.specs.every(isProbeSpec)).toBe(true);
  });

  it('a CLI that cannot be started on an unprobed runner => spawn_failed, nothing else spawned', async () => {
    const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const launcher = createMemoryLauncher(() => enoent);
    const runner = createClaudeRunner(cfg(), { logger: silentLogger(), secrets: createSecretRegistry(), launcher });
    const res = await runner.run(request(), {
      onSpawn: () => Promise.resolve(),
      onInit: () => Promise.resolve(),
      onLine: () => undefined,
      onStderr: () => undefined,
    });
    expect(res).toMatchObject({ outcome: 'spawn_failed', exitCode: null, init: null });
    expect(launcher.specs.map((spec) => spec.args)).toEqual([['--version']]);
  });

  it('output limit => graceful stop, outcome output_limit, later output discarded', async () => {
    const { h, res } = await harness(
      (x) => {
        x.proc.line(init());
        x.proc.line(text('x'.repeat(3000)));
        x.proc.line(text('after limit'));
      },
      { cfg: { maxOutputBytes: 2000 }, proc: { onStop: 'exit' } },
    );
    expect(res.outcome).toBe('output_limit');
    expect(res.outputBytes).toBeGreaterThan(2000);
    expect(h.proc.stops[0]).toEqual({ graceMs: 777 });
    expect(h.lines.map((l) => l.parsed.kind)).toEqual(['init']);
  });

  it('cuts lines over CLAUDE_MAX_LINE_BYTES and surfaces them as invalid', async () => {
    const { h, res } = await harness(
      async (x) => {
        x.proc.line(init());
        x.proc.line(text('y'.repeat(800)));
        x.proc.line(result());
        await tick();
        x.proc.exit(0);
      },
      { cfg: { maxLineBytes: 500 } },
    );
    expect(res.outcome).toBe('success');
    const cut = h.lines[1]?.parsed;
    expect(cut?.kind).toBe('invalid');
    expect(cut?.kind === 'invalid' ? cut.error : '').toContain('500');
    expect(h.lines[1]?.raw.length).toBe(500);
  });

  it('abort(cancel) => graceful kill sequence and outcome cancelled', async () => {
    const ac = new AbortController();
    const { h, res } = await harness(
      (x) => {
        x.proc.line(init());
        setTimeout(() => ac.abort('cancel'), 10);
      },
      { req: { signal: ac.signal } },
    );
    expect(res.outcome).toBe('cancelled');
    expect(h.proc.stops[0]).toEqual({ graceMs: 777 });
    expect(res.kill).not.toBeNull();
  });

  it.each([
    ['timeout', 'timeout'],
    ['worker_shutdown', 'shutdown'],
    ['quota', 'quota'],
    ['output_limit', 'output_limit'],
    ['security_violation', 'security_violation'],
    ['something-else', 'cancelled'],
  ] as const)('maps abort reason %s to outcome %s', async (reason, outcome) => {
    expect(outcomeForStopReason(toAbortReason(reason))).toBe(outcome);
    const ac = new AbortController();
    const { res } = await harness(
      (x) => {
        x.proc.line(init());
        setTimeout(() => ac.abort(reason), 5);
      },
      { req: { signal: ac.signal } },
    );
    expect(res.outcome).toBe(outcome);
  });

  it('an already aborted signal never spawns', async () => {
    const ac = new AbortController();
    ac.abort('cancel');
    const launcher = probing(() => createMemoryProcess());
    const runner = createClaudeRunner(cfg(), { logger: silentLogger(), secrets: createSecretRegistry(), launcher });
    const res = await runner.run(request({ signal: ac.signal }), {
      onSpawn: () => Promise.resolve(),
      onInit: () => Promise.resolve(),
      onLine: () => undefined,
      onStderr: () => undefined,
    });
    expect(res.outcome).toBe('cancelled');
    expect(runSpecs(launcher)).toHaveLength(0);
  });

  it('an abort that arrives while spawn is pending still stops the process (no prompt written)', async () => {
    const ac = new AbortController();
    const proc = createMemoryProcess();
    const launcher = probing(() => {
      ac.abort('worker_shutdown');
      return proc;
    });
    const runner = createClaudeRunner(cfg(), { logger: silentLogger(), secrets: createSecretRegistry(), launcher });
    const res = await runner.run(request({ signal: ac.signal }), {
      onSpawn: () => Promise.resolve(),
      onInit: () => Promise.resolve(),
      onLine: () => undefined,
      onStderr: () => undefined,
    });
    expect(res.outcome).toBe('shutdown');
    expect(proc.stops).toEqual([{ graceMs: 777 }]);
    expect(proc.stdinText()).toBe('');
    expect(proc.stdinEnded()).toBe(true);
  });

  it('missing init within CLAUDE_INIT_TIMEOUT_MS => init_timeout', async () => {
    const { h, res } = await harness(() => undefined, { cfg: { initTimeoutMs: 50 } });
    expect(res.outcome).toBe('init_timeout');
    expect(h.proc.stops[0]).toEqual({ graceMs: 777 });
  });

  it('deadline => timeout', async () => {
    const { res } = await harness((x) => x.proc.line(init()), {
      req: { deadlineAt: new Date(Date.now() + 60) },
    });
    expect(res.outcome).toBe('timeout');
  });

  it.each([
    ['protocol_error (exit 0 without result)', [init()], 0, 'protocol_error'],
    ['exit_nonzero (no result)', [init()], 2, 'exit_nonzero'],
    ['exit_nonzero (crash before init)', [], 137, 'exit_nonzero'],
    ['protocol_error (result without init)', [result()], 0, 'protocol_error'],
    ['result_error', [init(), result('error_during_execution')], 1, 'result_error'],
    ['budget_exceeded', [init(), result('error_max_budget_usd')], 1, 'budget_exceeded'],
    ['exit_nonzero (success result, failing exit)', [init(), result()], 3, 'exit_nonzero'],
  ] as const)('outcome mapping: %s', async (_name, lines, exitCode, outcome) => {
    const { res } = await harness(async (x) => {
      for (const l of lines) x.proc.line(l);
      await tick();
      x.proc.exit(exitCode);
    });
    expect(res.outcome).toBe(outcome);
    expect(res.exitCode).toBe(exitCode);
  });

  it('resume: exit before init => resume_failed; forked session id captured from init', async () => {
    const failed = await harness(
      async (x) => {
        x.proc.writeStderr('No conversation found with session ID: prev-1\n');
        await tick();
        x.proc.exit(1);
      },
      { req: { session: { kind: 'resume', resumeSessionId: 'prev-1' } } },
    );
    expect(failed.res.outcome).toBe('resume_failed');

    const forked = 'abababab-cdcd-4efe-8a0a-0b0b0b0b0b0b';
    const ok = await harness(
      async (x) => {
        x.proc.line(init({ session_id: forked }));
        x.proc.line(result('success', { session_id: forked }));
        await tick();
        x.proc.exit(0);
      },
      { req: { session: { kind: 'resume', resumeSessionId: 'prev-1' } } },
    );
    expect(ok.res).toMatchObject({ outcome: 'success', sessionId: forked });
  });

  it('spawn failure => spawn_failed; other launcher errors reject', async () => {
    const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const runner = createClaudeRunner(cfg(), {
      logger: silentLogger(),
      secrets: createSecretRegistry(),
      launcher: probing(() => enoent),
    });
    const handlers: ClaudeRunHandlers = {
      onSpawn: () => Promise.resolve(),
      onInit: () => Promise.resolve(),
      onLine: () => undefined,
      onStderr: () => undefined,
    };
    await expect(runner.run(request(), handlers)).resolves.toMatchObject({ outcome: 'spawn_failed', exitCode: null });

    const broken = createClaudeRunner(cfg(), {
      logger: silentLogger(),
      secrets: createSecretRegistry(),
      launcher: probing(() => new Error('runner connection lost')),
    });
    await expect(broken.run(request(), handlers)).rejects.toThrow('runner connection lost');
  });

  it('a failing onSpawn stops the process (forced), skips the prompt and rejects', async () => {
    const proc = createMemoryProcess();
    const runner = createClaudeRunner(cfg(), {
      logger: silentLogger(),
      secrets: createSecretRegistry(),
      launcher: probing(() => proc),
    });
    await expect(
      runner.run(request(), {
        onSpawn: () => Promise.reject(new Error('db down')),
        onInit: () => Promise.resolve(),
        onLine: () => undefined,
        onStderr: () => undefined,
      }),
    ).rejects.toThrow('db down');
    expect(proc.stdinText()).toBe('');
    expect(proc.stops[0]).toEqual({ graceMs: 0, forceImmediately: true });
  });

  it('a leader that survives the kill does not hang the run', async () => {
    const ac = new AbortController();
    const { res } = await harness(
      (x) => {
        x.proc.line(init());
        setTimeout(() => ac.abort('cancel'), 5);
      },
      { req: { signal: ac.signal }, proc: { onStop: 'survive', pid: 4242 } },
    );
    expect(res.outcome).toBe('cancelled');
    expect(res.exitCode).toBeNull();
    expect(res.kill?.survivors).toContain(4242);
  }, 15_000);

  it('rejects programmer errors before spawning (oversized Layer 1)', async () => {
    const launcher = probing(() => createMemoryProcess());
    const runner = createClaudeRunner(cfg(), { logger: silentLogger(), secrets: createSecretRegistry(), launcher });
    await expect(
      runner.run(request({ appendSystemPrompt: 'x'.repeat(9000) }), {
        onSpawn: () => Promise.resolve(),
        onInit: () => Promise.resolve(),
        onLine: () => undefined,
        onStderr: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'prompt_too_large' });
    expect(runSpecs(launcher)).toHaveLength(0);
  });

  it('never writes the API key or masked secrets into its own logs', async () => {
    const log = captureLogger();
    await harness(
      async (x) => {
        x.proc.line(init({ tools: ['Read', `sk-ant-FAKE0000000000000000000000`] }));
        await tick();
      },
      { logger: log },
    );
    const text = log.lines.join('');
    expect(text).toContain('claude security violation');
    expect(text).not.toContain('sk-ant-FAKE');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(Buffer.from(TOKEN, 'utf8').toString('base64'));
  });
});
