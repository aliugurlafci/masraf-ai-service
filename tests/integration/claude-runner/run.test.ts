// End-to-end runs of fake-claude through the local launcher (contract §10.1-§10.5, §18.3).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_ENV_ALLOWLIST, WINDOWS_BASE_ENV } from '@orc/security';
import { isProcessAlive } from '../../helpers/common';
import {
  directivePrompt,
  FAKE_CLAUDE_PATH,
  makeRunRequest,
  recordingHandlers,
  SESSION_ID,
  systemSubtype,
  TEST_API_KEY,
} from '../../helpers/claude/fake-claude';
import { useRunnerEnv } from '../../helpers/claude/integration';

const env = useRunnerEnv();

function event(rec: ReturnType<typeof recordingHandlers>['rec'], subtype: string): Record<string, unknown> {
  const hit = rec.lines.find((l) => systemSubtype(l.parsed) === subtype);
  if (!hit || hit.parsed.kind !== 'system') throw new Error(`no ${subtype} event`);
  return hit.parsed.event;
}

describe('claude-runner with fake-claude (integration)', () => {
  it('normal success: session id, cost and usage captured; onSpawn before stdin', async () => {
    const e = env();
    const { handlers, rec } = recordingHandlers();
    const res = await e
      .runner()
      .run(makeRunRequest(e.layout, { lease: e.lease, directives: ['@@fake text working', '@@fake cost 0.42', '@@fake usage 120 34'] }), handlers);
    e.trackPids(rec.spawn?.pid);
    expect(res).toMatchObject({
      outcome: 'success',
      exitCode: 0,
      signal: null,
      sessionId: SESSION_ID,
      violation: null,
      result: { subtype: 'success', is_error: false, total_cost_usd: 0.42, usage: { input_tokens: 120, output_tokens: 34 } },
    });
    expect(res.init).toMatchObject({ session_id: SESSION_ID, permissionMode: 'dontAsk', claude_code_version: '2.1.316' });
    expect(rec.spawn?.pid).toBeGreaterThan(0);
    expect(rec.inits).toHaveLength(1);
    expect(rec.inits[0]?.validation).toEqual({ ok: true, violations: [], mcpConnected: false });
    expect(rec.lines.map((l) => l.parsed.kind)).toEqual(['init', 'assistant', 'assistant', 'result']);
    expect(res.durationMs).toBeGreaterThan(0);
    expect(isProcessAlive(rec.spawn?.pid ?? 0)).toBe(false);
  });

  it('passes the exact argv and only allowlisted environment variables', async () => {
    const e = env();
    const runner = e.runner();
    const req = makeRunRequest(e.layout, { lease: e.lease, directives: ['@@fake echo-argv', '@@fake echo-env'], maxBudgetUsd: 1.25 });
    const { handlers, rec } = recordingHandlers();
    const res = await runner.run(req, handlers);
    e.trackPids(rec.spawn?.pid);
    expect(res.outcome).toBe('success');
    expect(event(rec, 'fake_argv').argv).toEqual(runner.buildArgv(req));
    const launch = e.launcher.launches[0];
    expect(launch?.spec).toMatchObject({ kind: 'claude', cmd: process.execPath, cwd: e.layout.worktree });
    expect(launch?.spec.args.slice(0, 1)).toEqual([FAKE_CLAUDE_PATH]);

    const fakeEnv = event(rec, 'fake_env');
    expect(fakeEnv.hasApiKey).toBe(true);
    const allowed = new Set(
      [...CLAUDE_ENV_ALLOWLIST, ...(process.platform === 'win32' ? WINDOWS_BASE_ENV : [])].map((k) => k.toUpperCase()),
    );
    // The env handed to the launcher is exactly the allowlist on every platform.
    const built = Object.keys(runner.buildEnv(req));
    expect(built.filter((n) => !allowed.has(n.toUpperCase()))).toEqual([]);
    expect(launch?.spec.env).toEqual(runner.buildEnv(req));
    // libuv (Windows only) copies these from the parent when the child env lacks them; this is
    // outside the runner's control and does not apply to the Linux production target.
    const libuvInjected = new Set(
      process.platform === 'win32' ? ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'USERDOMAIN', 'USERNAME'] : [],
    );
    const names = fakeEnv.names as string[];
    expect(names.filter((n) => !allowed.has(n.toUpperCase()) && !libuvInjected.has(n.toUpperCase()))).toEqual([]);
    expect(names.filter((n) => /^(DB_|REDIS_|SESSION_|NODE_OPTIONS$|npm_)|_FILE$/i.test(n))).toEqual([]);
    expect(names).toEqual(expect.arrayContaining(['ORC_ATTEMPT_ID', 'CLAUDE_CONFIG_DIR', 'HOME', 'ANTHROPIC_API_KEY']));
  });

  it('keeps stdout (stream-json) and stderr separate', async () => {
    const e = env();
    const { handlers, rec } = recordingHandlers();
    const res = await e
      .runner()
      .run(
        makeRunRequest(e.layout, {
          lease: e.lease,
          directives: ['@@fake stderr err-only-line', '@@fake text out-only-line', '@@fake stderr second-err'],
        }),
        handlers,
      );
    e.trackPids(rec.spawn?.pid);
    expect(res.outcome).toBe('success');
    expect(rec.stderr.join('')).toBe('err-only-line\nsecond-err\n');
    const raw = rec.lines.map((l) => l.raw).join('\n');
    expect(raw).toContain('out-only-line');
    expect(raw).not.toContain('err-only-line');
    expect(rec.stderr.join('')).not.toContain('out-only-line');
  });

  it('records the exit code of a crash (no result => exit_nonzero)', async () => {
    const e = env();
    const { handlers, rec } = recordingHandlers();
    const res = await e.runner().run(makeRunRequest(e.layout, { lease: e.lease, directives: ['@@fake text before', '@@fake crash'] }), handlers);
    e.trackPids(rec.spawn?.pid);
    expect(res).toMatchObject({ outcome: 'exit_nonzero', exitCode: 137, result: null });
  });

  it.each([
    [['@@fake result error_during_execution', '@@fake exit 1'], 'result_error', 1],
    [['@@fake result error_max_budget_usd', '@@fake exit 1'], 'budget_exceeded', 1],
    [['@@fake no-result'], 'protocol_error', 0],
    [['@@fake exit 3'], 'exit_nonzero', 3],
  ] as const)('maps %j to %s', async (directives, outcome, exitCode) => {
    const e = env();
    const { handlers, rec } = recordingHandlers();
    const res = await e.runner().run(makeRunRequest(e.layout, { lease: e.lease, directives }), handlers);
    e.trackPids(rec.spawn?.pid);
    expect(res.outcome).toBe(outcome);
    expect(res.exitCode).toBe(exitCode);
  });

  it('tolerates invalid and unknown lines and masks secrets before onLine', async () => {
    const e = env();
    const { handlers, rec } = recordingHandlers();
    const res = await e
      .runner()
      .run(makeRunRequest(e.layout, { lease: e.lease, directives: ['@@fake invalid-line', '@@fake unknown-event', '@@fake secret'] }), handlers);
    e.trackPids(rec.spawn?.pid);
    expect(res.outcome).toBe('success');
    expect(rec.lines.map((l) => l.parsed.kind)).toEqual(['init', 'invalid', 'unknown', 'assistant', 'assistant', 'result']);
    const raw = rec.lines.map((l) => l.raw).join('\n');
    expect(raw).not.toContain('sk-ant-FAKE');
    expect(raw).toContain('[REDACTED]');
    expect(raw).not.toContain(TEST_API_KEY);
  });

  it('resume: --resume <id> --fork-session yields a new session id', async () => {
    const e = env();
    const runner = e.runner();
    const req = makeRunRequest(e.layout, {
      lease: e.lease,
      directives: ['@@fake echo-argv'],
      session: { kind: 'resume', resumeSessionId: SESSION_ID },
    });
    const { handlers, rec } = recordingHandlers();
    const res = await runner.run(req, handlers);
    e.trackPids(rec.spawn?.pid);
    expect(res.outcome).toBe('success');
    const argv = event(rec, 'fake_argv').argv as string[];
    expect(argv.slice(argv.indexOf('--resume'), argv.indexOf('--resume') + 3)).toEqual(['--resume', SESSION_ID, '--fork-session']);
    expect(argv).not.toContain('--session-id');
    expect(res.sessionId).not.toBeNull();
    expect(res.sessionId).not.toBe(SESSION_ID);
    expect(res.result?.session_id).toBe(res.sessionId);
  });

  it('resume of a missing session => resume_failed (exit before init)', async () => {
    const e = env();
    const { handlers, rec } = recordingHandlers();
    const res = await e.runner().run(
      makeRunRequest(e.layout, {
        lease: e.lease,
        directives: ['@@fake session-missing'],
        session: { kind: 'resume', resumeSessionId: SESSION_ID },
      }),
      handlers,
    );
    e.trackPids(rec.spawn?.pid);
    expect(res).toMatchObject({ outcome: 'resume_failed', exitCode: 1, init: null });
    expect(rec.stderr.join('')).toContain(`No conversation found with session ID: ${SESSION_ID}`);
  });

  it('a missing executable => spawn_failed', async () => {
    const e = env();
    const { handlers } = recordingHandlers();
    const res = await e
      .runner({ bin: join(e.layout.root, 'no-such-claude.exe'), binPrefixArgs: [] })
      .run(makeRunRequest(e.layout, { lease: e.lease }), handlers);
    expect(res).toMatchObject({ outcome: 'spawn_failed', exitCode: null, init: null });
  });

  it('file edits stay inside the worktree', async () => {
    const e = env();
    const { handlers, rec } = recordingHandlers();
    writeFileSync(join(e.layout.worktree, 'old.txt'), 'old');
    const content = Buffer.from('hello from fake claude').toString('base64');
    const res = await e.runner().run(
      makeRunRequest(e.layout, {
        lease: e.lease,
        directives: [`@@fake write src/new.txt ${content}`, `@@fake write ../escape.txt ${content}`, '@@fake delete old.txt'],
      }),
      handlers,
    );
    e.trackPids(rec.spawn?.pid);
    expect(res.outcome).toBe('success');
    expect(readFileSync(join(e.layout.worktree, 'src', 'new.txt'), 'utf8')).toBe('hello from fake claude');
    expect(existsSync(join(e.layout.worktree, '..', 'escape.txt'))).toBe(false);
    expect(existsSync(join(e.layout.worktree, 'old.txt'))).toBe(false);
  });

  it('kills descendants left behind by a normally exiting CLI', async () => {
    const e = env();
    const { handlers, rec } = recordingHandlers();
    // Windows: a non-detached grandchild sits in the leader's libuv kill-on-close job and dies with
    // it, so `detached` is what leaves a live descendant behind there. POSIX: it stays in the group.
    const directive = process.platform === 'win32' ? '@@fake spawn-grandchild detached' : '@@fake spawn-grandchild';
    const res = await e.runner().run(makeRunRequest(e.layout, { lease: e.lease, directives: [directive] }), handlers);
    e.trackPids(rec.spawn?.pid, ...rec.fakePids);
    expect(res.outcome).toBe('success');
    expect(rec.fakePids).toHaveLength(1);
    // The post-exit sweep reports a kill only when it had to force it (win32: tree kill) or something survived; on
    // POSIX the left-behind group member ends on SIGTERM within the grace period, so `kill` may be null there.
    if (process.platform === 'win32') expect(res.kill).not.toBeNull();
    expect(res.kill?.survivors ?? []).toEqual([]);
    for (const pid of [rec.spawn?.pid ?? 0, ...rec.fakePids]) expect(isProcessAlive(pid)).toBe(false);
  });

  it('runs with MCP enabled: --mcp-config is passed and the server is reported connected', async () => {
    const e = env();
    writeFileSync(e.layout.mcpConfigPath, JSON.stringify({ mcpServers: { 'codebase-memory-mcp': { command: 'cbm' } } }));
    const { handlers, rec } = recordingHandlers();
    const res = await e.runner().run(
      makeRunRequest(e.layout, { lease: e.lease, mcp: true, prompt: directivePrompt(['@@fake text ok']) }),
      handlers,
    );
    e.trackPids(rec.spawn?.pid);
    expect(res.outcome).toBe('success');
    expect(rec.inits[0]?.validation).toEqual({ ok: true, violations: [], mcpConnected: true });
    expect(res.init?.tools).toContain('mcp__codebase-memory-mcp__search_graph');
  });
});
