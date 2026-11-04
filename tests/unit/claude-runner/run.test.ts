// Runner state machine with an in-memory process (no real processes): parsing, masking, init
// validation, limits, stop reasons and the §13.4 outcome mapping.
import { describe, expect, it } from 'vitest';
import {
  createClaudeRunner,
  outcomeForStopReason,
  toAbortReason,
  type ClaudeRunHandlers,
  type ClaudeRunnerConfig,
  type ClaudeRunRequest,
} from '@orc/claude-runner';
import type { ParsedClaudeLine } from '@orc/shared';
import { createSecretRegistry } from '@orc/security';
import {
  captureLogger,
  createMemoryLauncher,
  createMemoryProcess,
  memoryLease,
  silentLogger,
  type MemoryProcess,
  type MemoryProcessOptions,
} from '../../helpers/claude/memory-process';

const SESSION = '44444444-5555-4666-8777-888888888888';
const CWD = process.platform === 'win32' ? 'C:\\srv\\ws\\p\\t\\wt' : '/srv/ws/p/t/wt';
const API_KEY = 'sk-ant-api03-RUNUNIT00000000000000000000000';
const PLATFORM = process.platform === 'win32' ? 'win32' : 'posix';

function cfg(over: Partial<ClaudeRunnerConfig> = {}): ClaudeRunnerConfig {
  return {
    bin: 'claude',
    binPrefixArgs: [],
    bare: true,
    claudeHomeRoot: process.platform === 'win32' ? 'C:\\srv\\claude-home' : '/srv/claude-home',
    apiKey: API_KEY,
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
  tools: ['Read', 'Edit'],
  mcp_servers: [],
  model: 'claude-sonnet-4-5',
  permissionMode: 'dontAsk',
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
    launcher: createMemoryLauncher(() => proc),
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
      x.proc.line(text(`key sk-ant-FAKE0000000000000000000000 and ${API_KEY}`));
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
    expect(all).not.toContain(API_KEY);
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

  it('hook events are violations with --bare and ignored without it', async () => {
    const bare = await harness((x) => {
      x.proc.line(init());
      x.proc.line({ type: 'system', subtype: 'hook_started' });
    });
    expect(bare.res.outcome).toBe('security_violation');
    expect(bare.res.violation?.rule).toBe('hook_event');

    const nonBare = await harness(
      async (x) => {
        x.proc.line(init());
        x.proc.line({ type: 'system', subtype: 'hook_started' });
        x.proc.line(result());
        await tick();
        x.proc.exit(0);
      },
      { cfg: { bare: false } },
    );
    expect(nonBare.res.outcome).toBe('success');
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
        x.proc.line(text('y'.repeat(500)));
        x.proc.line(result());
        await tick();
        x.proc.exit(0);
      },
      { cfg: { maxLineBytes: 300 } },
    );
    expect(res.outcome).toBe('success');
    const cut = h.lines[1]?.parsed;
    expect(cut?.kind).toBe('invalid');
    expect(cut?.kind === 'invalid' ? cut.error : '').toContain('300');
    expect(h.lines[1]?.raw.length).toBe(300);
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
    const launcher = createMemoryLauncher(() => createMemoryProcess());
    const runner = createClaudeRunner(cfg(), { logger: silentLogger(), secrets: createSecretRegistry(), launcher });
    const res = await runner.run(request({ signal: ac.signal }), {
      onSpawn: () => Promise.resolve(),
      onInit: () => Promise.resolve(),
      onLine: () => undefined,
      onStderr: () => undefined,
    });
    expect(res.outcome).toBe('cancelled');
    expect(launcher.specs).toHaveLength(0);
  });

  it('an abort that arrives while spawn is pending still stops the process (no prompt written)', async () => {
    const ac = new AbortController();
    const proc = createMemoryProcess();
    const launcher = createMemoryLauncher(() => {
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
      launcher: createMemoryLauncher(() => enoent),
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
      launcher: createMemoryLauncher(() => new Error('runner connection lost')),
    });
    await expect(broken.run(request(), handlers)).rejects.toThrow('runner connection lost');
  });

  it('a failing onSpawn stops the process (forced), skips the prompt and rejects', async () => {
    const proc = createMemoryProcess();
    const runner = createClaudeRunner(cfg(), {
      logger: silentLogger(),
      secrets: createSecretRegistry(),
      launcher: createMemoryLauncher(() => proc),
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
    const launcher = createMemoryLauncher(() => createMemoryProcess());
    const runner = createClaudeRunner(cfg(), { logger: silentLogger(), secrets: createSecretRegistry(), launcher });
    await expect(
      runner.run(request({ appendSystemPrompt: 'x'.repeat(9000) }), {
        onSpawn: () => Promise.resolve(),
        onInit: () => Promise.resolve(),
        onLine: () => undefined,
        onStderr: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'prompt_too_large' });
    expect(launcher.specs).toHaveLength(0);
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
    expect(text).not.toContain(API_KEY);
  });
});
