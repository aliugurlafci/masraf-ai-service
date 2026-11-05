import { describe, expect, it } from 'vitest';
import {
  buildClaudeArgv,
  CLAUDE_HARDENED_SETTINGS,
  createClaudeRunner,
  type ClaudeRunnerConfig,
  type ClaudeRunRequest,
} from '@orc/claude-runner';
import { APPEND_SYSTEM_PROMPT_MAX_BYTES } from '@orc/shared';
import { createSecretRegistry, PromptTooLargeError, ToolPolicyError, UnsafeArgumentError } from '@orc/security';
import { createMemoryLauncher, memoryLease, silentLogger } from '../../helpers/claude/memory-process';

const SESSION = '0b6f1c2e-3d4a-4b5c-8d9e-0f1a2b3c4d5e';
const DENY = ['WebFetch', 'WebSearch', 'Bash(curl:*)', 'Read(//run/secrets/**)'];
const ALLOW = ['Read(//srv/ws/p/t/wt/**)', 'Edit(//srv/ws/p/t/wt/**)', 'mcp__codebase-memory-mcp'];

function request(over: Partial<ClaudeRunRequest> = {}): ClaudeRunRequest {
  return {
    attemptId: '11111111-2222-4333-8444-555555555555',
    taskId: '22222222-3333-4444-8555-666666666666',
    workspaceId: '33333333-4444-4555-8666-777777777777',
    cwd: '/srv/ws/p/t/wt',
    metaDir: '/srv/ws/p/t/.meta',
    tmpDir: '/srv/ws/p/t/.meta/tmp',
    lease: memoryLease,
    model: 'claude-sonnet-4-5',
    effort: null,
    tools: { builtinTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'], allowedRules: [], disallowedRules: DENY },
    mcp: null,
    appendSystemPrompt: '# ORC PLATFORM RULES',
    stdinPrompt: 'task',
    session: { kind: 'new', sessionId: SESSION },
    maxBudgetUsd: null,
    deadlineAt: new Date(Date.now() + 60_000),
    signal: new AbortController().signal,
    ...over,
  };
}

const HARDENED = '{"disableAllHooks":true,"autoMemoryEnabled":false,"attribution":{"commit":"","pr":""},"includeGitInstructions":false}';

interface Combo {
  effort: 'high' | null;
  allow: boolean;
  mcp: boolean;
  resume: boolean;
  budget: number | null;
}

/** Independent rendering of the §10.2 table (row order and conditions). */
function expectedArgv(c: Combo): string[] {
  const rows: [boolean, string[]][] = [
    [true, ['-p']],
    [true, ['--output-format', 'stream-json']],
    [true, ['--verbose']],
    [true, ['--include-hook-events']],
    [true, ['--restricted']],
    [true, ['--setting-sources', 'user']],
    [true, ['--settings', HARDENED]],
    [true, ['--model', 'claude-sonnet-4-5']],
    [c.effort !== null, ['--effort', String(c.effort)]],
    [true, ['--permission-mode', 'dontAsk']],
    [true, ['--tools', 'Read,Edit,Write,Glob,Grep']],
    [c.allow, ['--allowed-tools', ...ALLOW]],
    [true, ['--disallowed-tools', ...DENY]],
    [c.mcp, ['--mcp-config', '/srv/ws/p/t/.meta/mcp.json']],
    [true, ['--strict-mcp-config']],
    [true, ['--append-system-prompt', '# ORC PLATFORM RULES']],
    [!c.resume, ['--session-id', SESSION]],
    [c.resume, ['--resume', 'prev-session-1', '--fork-session']],
    [c.budget !== null, ['--max-budget-usd', c.budget === null ? '' : c.budget.toFixed(2)]],
  ];
  return rows.filter(([on]) => on).flatMap(([, parts]) => parts);
}

function combos(): Combo[] {
  const out: Combo[] = [];
  for (const effort of ['high', null] as const)
    for (const allow of [true, false])
      for (const mcp of [true, false])
        for (const resume of [true, false])
          for (const budget of [1.5, null]) out.push({ effort, allow, mcp, resume, budget });
  return out;
}

describe('buildClaudeArgv (§10.2)', () => {
  it('renders the full production argv in the exact order', () => {
    const argv = buildClaudeArgv(
      request({
        effort: 'medium',
        tools: { builtinTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'], allowedRules: ALLOW, disallowedRules: DENY },
        mcp: { configPath: '/srv/ws/p/t/.meta/mcp.json', cacheDir: '/srv/cbm/w/x' },
        maxBudgetUsd: 2,
      }),
      { platform: 'posix' },
    );
    expect(argv).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-hook-events',
      '--restricted',
      '--setting-sources',
      'user',
      '--settings',
      HARDENED,
      '--model',
      'claude-sonnet-4-5',
      '--effort',
      'medium',
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read,Edit,Write,Glob,Grep',
      '--allowed-tools',
      'Read(//srv/ws/p/t/wt/**)',
      'Edit(//srv/ws/p/t/wt/**)',
      'mcp__codebase-memory-mcp',
      '--disallowed-tools',
      'WebFetch',
      'WebSearch',
      'Bash(curl:*)',
      'Read(//run/secrets/**)',
      '--mcp-config',
      '/srv/ws/p/t/.meta/mcp.json',
      '--strict-mcp-config',
      '--append-system-prompt',
      '# ORC PLATFORM RULES',
      '--session-id',
      SESSION,
      '--max-budget-usd',
      '2.00',
    ]);
  });

  it('mcp === null: no --mcp-config but --strict-mcp-config stays (ADR-0037, K9 9.2)', () => {
    const argv = buildClaudeArgv(request({ mcp: null }), { platform: 'posix' });
    expect(argv).not.toContain('--mcp-config');
    expect(argv).toContain('--strict-mcp-config');
    const withMcp = buildClaudeArgv(request({ mcp: { configPath: '/m.json', cacheDir: '/c' } }), { platform: 'posix' });
    expect(withMcp).toContain('--mcp-config');
    expect(withMcp).toContain('--strict-mcp-config');
  });

  it('renders the minimal argv (no effort, allow rules, MCP or budget)', () => {
    expect(buildClaudeArgv(request(), { platform: 'posix' })).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-hook-events',
      '--restricted',
      '--setting-sources',
      'user',
      '--settings',
      HARDENED,
      '--model',
      'claude-sonnet-4-5',
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read,Edit,Write,Glob,Grep',
      '--disallowed-tools',
      ...DENY,
      '--strict-mcp-config',
      '--append-system-prompt',
      '# ORC PLATFORM RULES',
      '--session-id',
      SESSION,
    ]);
  });

  it.each(combos())('matches the §10.2 table for %o', (c) => {
    const argv = buildClaudeArgv(
      request({
        effort: c.effort,
        tools: {
          builtinTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
          allowedRules: c.allow ? ALLOW : [],
          disallowedRules: DENY,
        },
        mcp: c.mcp ? { configPath: '/srv/ws/p/t/.meta/mcp.json', cacheDir: '/srv/cbm/w/x' } : null,
        session: c.resume ? { kind: 'resume', resumeSessionId: 'prev-session-1' } : { kind: 'new', sessionId: SESSION },
        maxBudgetUsd: c.budget,
      }),
      { platform: 'posix' },
    );
    expect(argv).toEqual(expectedArgv(c));
  });

  it('never emits unverified or dangerous flags', () => {
    const argv = buildClaudeArgv(
      request({ mcp: { configPath: '/m.json', cacheDir: '/c' }, maxBudgetUsd: 3, effort: 'low' }),
      { platform: 'posix' },
    );
    for (const flag of [
      '--bare',
      '--safe-mode',
      '--max-turns',
      '--dangerously-skip-permissions',
      '--system-prompt',
      '--add-dir',
      '--agents',
      '--json-schema',
      '--include-partial-messages',
      '--fallback-model',
      '--no-session-persistence',
    ]) {
      expect(argv).not.toContain(flag);
    }
    expect(argv.filter((a) => a.startsWith('-')).every((a) => a === '-p' || a.startsWith('--'))).toBe(true);
    expect(argv.filter((a) => a === '--settings')).toHaveLength(1);
  });

  it('passes the frozen hardened settings inline (never a file path)', () => {
    expect(CLAUDE_HARDENED_SETTINGS).toBe(HARDENED);
    expect(JSON.parse(CLAUDE_HARDENED_SETTINGS)).toEqual({
      disableAllHooks: true,
      autoMemoryEnabled: false,
      attribution: { commit: '', pr: '' },
      includeGitInstructions: false,
    });
    const argv = buildClaudeArgv(request(), { platform: 'win32' });
    expect(argv[argv.indexOf('--settings') + 1]).toBe(CLAUDE_HARDENED_SETTINGS);
  });

  it('is identical in both auth modes on both platforms (ADR-0036 Decision 3)', () => {
    const base: Omit<ClaudeRunnerConfig, 'auth' | 'platform'> = {
      bin: 'claude',
      binPrefixArgs: [],
      claudeHomeRoot: '/srv/claude-home',
      proxy: { https: null, http: null, noProxy: null, token: null },
      killGraceMs: 1000,
      initTimeoutMs: 1000,
      maxOutputBytes: 1_000_000,
      maxLineBytes: 100_000,
      cbmCacheRoot: '/srv/cbm',
      workerId: 'w1',
      initExtraTools: [],
    };
    const auths: ClaudeRunnerConfig['auth'][] = [
      { mode: 'oauth', oauthToken: `sk-ant-oat01-${'A'.repeat(40)}` },
      { mode: 'api_key', apiKey: 'sk-ant-api03-ARGVUNIT000000000000000000000' },
    ];
    const r = request({
      effort: 'high',
      tools: { builtinTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'], allowedRules: ALLOW, disallowedRules: DENY },
      mcp: { configPath: '/srv/ws/p/t/.meta/mcp.json', cacheDir: '/srv/cbm/w/x' },
      maxBudgetUsd: 5,
    });
    for (const platform of ['posix', 'win32'] as const) {
      const [oauth, apiKey] = auths.map((auth) =>
        createClaudeRunner(
          { ...base, auth, platform },
          { logger: silentLogger(), secrets: createSecretRegistry(), launcher: createMemoryLauncher(() => new Error('unused')) },
        ).buildArgv(r),
      );
      expect(oauth).toEqual(apiKey);
      expect(oauth).toEqual(buildClaudeArgv(r, { platform }));
      const joined = (oauth ?? []).join(' ');
      expect(joined).not.toContain('sk-ant-');
      expect(oauth).not.toContain('--bare');
    }
  });

  it('adds Bash to --tools only when the policy says so', () => {
    const argv = buildClaudeArgv(
      request({
        tools: {
          builtinTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
          allowedRules: ['Bash(npm test:*)'],
          disallowedRules: DENY,
        },
      }),
      { platform: 'posix' },
    );
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Edit,Write,Glob,Grep,Bash');
    expect(argv.slice(argv.indexOf('--allowed-tools'), argv.indexOf('--disallowed-tools'))).toEqual([
      '--allowed-tools',
      'Bash(npm test:*)',
    ]);
  });

  it('rejects an oversized Layer 1 with PromptTooLargeError before anything is spawned', () => {
    const big = 'x'.repeat(APPEND_SYSTEM_PROMPT_MAX_BYTES + 1);
    expect(() => buildClaudeArgv(request({ appendSystemPrompt: big }), { platform: 'posix' })).toThrow(
      PromptTooLargeError,
    );
    const fits = 'x'.repeat(APPEND_SYSTEM_PROMPT_MAX_BYTES);
    expect(() => buildClaudeArgv(request({ appendSystemPrompt: fits }), { platform: 'posix' })).not.toThrow();
    // Multi-byte text is measured in UTF-8 bytes, not characters.
    const wide = 'é'.repeat(APPEND_SYSTEM_PROMPT_MAX_BYTES / 2 + 1);
    expect(() => buildClaudeArgv(request({ appendSystemPrompt: wide }), { platform: 'posix' })).toThrow(
      PromptTooLargeError,
    );
  });

  it('rejects option-like or malformed values', () => {
    const o = { platform: 'posix' } as const;
    expect(() => buildClaudeArgv(request({ model: '--dangerously-skip-permissions' }), o)).toThrow(UnsafeArgumentError);
    expect(() => buildClaudeArgv(request({ model: 'claude sonnet' }), o)).toThrow(UnsafeArgumentError);
    expect(() => buildClaudeArgv(request({ session: { kind: 'new', sessionId: 'not-a-uuid' } }), o)).toThrow(
      UnsafeArgumentError,
    );
    expect(() => buildClaudeArgv(request({ session: { kind: 'resume', resumeSessionId: '--help' } }), o)).toThrow(
      UnsafeArgumentError,
    );
    expect(() => buildClaudeArgv(request({ maxBudgetUsd: 0 }), o)).toThrow(UnsafeArgumentError);
    expect(() => buildClaudeArgv(request({ maxBudgetUsd: Number.NaN }), o)).toThrow(UnsafeArgumentError);
    expect(() =>
      buildClaudeArgv(
        request({ tools: { builtinTools: [], allowedRules: [], disallowedRules: DENY } }),
        o,
      ),
    ).toThrow(ToolPolicyError);
    expect(() =>
      buildClaudeArgv(
        request({ tools: { builtinTools: ['Read', 'WebFetch'], allowedRules: [], disallowedRules: DENY } }),
        o,
      ),
    ).toThrow(ToolPolicyError);
    expect(() =>
      buildClaudeArgv(
        request({ tools: { builtinTools: ['Read'], allowedRules: [], disallowedRules: [] } }),
        o,
      ),
    ).toThrow(ToolPolicyError);
    expect(() =>
      buildClaudeArgv(
        request({ tools: { builtinTools: ['Read'], allowedRules: ['--evil'], disallowedRules: DENY } }),
        o,
      ),
    ).toThrow(ToolPolicyError);
  });

  it('formats the budget with two decimals', () => {
    const argv = buildClaudeArgv(request({ maxBudgetUsd: 0.125 }), { platform: 'posix' });
    expect(argv.slice(-2)).toEqual(['--max-budget-usd', '0.13']);
  });

  it('applies the win32 command-line budget (assertSafeArgv)', () => {
    const rules = Array.from({ length: 700 }, (_, i) => `Read(//C:/very/long/path/segment/number/${i}/**)`);
    const r = request({ tools: { builtinTools: ['Read'], allowedRules: [], disallowedRules: rules } });
    expect(() => buildClaudeArgv(r, { platform: 'win32' })).toThrow(UnsafeArgumentError);
    expect(() => buildClaudeArgv(r, { platform: 'posix' })).not.toThrow();
  });
});
