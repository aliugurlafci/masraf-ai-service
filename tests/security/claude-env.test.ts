// Contract §18.5 extra gate "Claude env allowlist / argv" (§10.3, §11.3, §13.5): every child process
// (Claude, git, the project test command) receives only allowlisted variables; secrets present in the
// worker's own environment never pass. The pipeline-level proof (`@@fake echo-env` / `echo-argv`
// through the real worker) is in workspace-isolation.test.ts.
import { describe, expect, it } from 'vitest';
import { buildClaudeEnv, buildProbeEnv } from '@orc/claude-runner';
import type { ClaudeRunnerConfig, ClaudeRunRequest } from '@orc/claude-runner';
import {
  CLAUDE_ENV_ALLOWLIST,
  GIT_ENV_ALLOWLIST,
  TEST_ENV_ALLOWLIST,
  WINDOWS_BASE_ENV,
  buildChildEnv,
} from '@orc/security';
import { allowedEnvKeys } from '@orc/sandbox';
import { memoryLease } from '../helpers/claude/memory-process';

const SECRET_VALUES = {
  DB_PASSWORD: 'db-password-SEC-0001',
  DB_PASSWORD_FILE: '/run/secrets/db_worker_password',
  REDIS_PASSWORD: 'redis-password-SEC-0001',
  MSSQL_SA_PASSWORD: 'sa-password-SEC-0001',
  SESSION_SECRET: 'session-secret-SEC-0001',
  EGRESS_PROXY_TOKEN: 'egress-token-SEC-0001',
  ANTHROPIC_API_KEY_FILE: '/run/secrets/anthropic_api_key',
  GH_TOKEN: 'ghp_SEC000000000000000000000000000000000',
  AWS_SECRET_ACCESS_KEY: 'aws-secret-SEC-0001',
  NODE_OPTIONS: '--require /tmp/evil.js',
  LD_PRELOAD: '/tmp/evil.so',
  GIT_SSH_COMMAND: 'touch /tmp/pwned',
  GIT_CONFIG_PARAMETERS: "'core.hooksPath=/tmp/hooks'",
  npm_config_userconfig: '/home/worker/.npmrc',
};

const WORKER_ENV: Record<string, string> = {
  PATH: '/usr/local/bin:/usr/bin',
  HOME: '/home/worker',
  LANG: 'en_US.UTF-8',
  ANTHROPIC_API_KEY: 'sk-ant-api03-WORKERENV0000000000000000000000',
  SystemRoot: 'C:\\Windows',
  ...SECRET_VALUES,
};

const FORBIDDEN_NAME = /^(DB_|REDIS_|MSSQL_|SESSION_|EGRESS_|GH_|AWS_|npm_|NODE_OPTIONS$|LD_|GIT_SSH|GIT_CONFIG_PARAMETERS)|_FILE$/i;

function config(platform: 'posix' | 'win32'): ClaudeRunnerConfig {
  return {
    bin: 'claude',
    binPrefixArgs: [],
    bare: true,
    claudeHomeRoot: platform === 'win32' ? 'C:\\orc\\claude-home' : '/srv/claude-home',
    apiKey: 'sk-ant-api03-CONFIGURED000000000000000000000',
    proxy: { https: 'http://egress-proxy:3128', http: 'http://egress-proxy:3128', noProxy: 'localhost', token: 'proxy-token-SEC-0001' },
    killGraceMs: 10_000,
    initTimeoutMs: 60_000,
    maxOutputBytes: 52_428_800,
    maxLineBytes: 4_194_304,
    cbmCacheRoot: platform === 'win32' ? 'C:\\orc\\cbm' : '/srv/cbm-cache',
    platform,
    workerId: 'worker-1',
    initExtraTools: [],
  };
}

const REQUEST: ClaudeRunRequest = {
  attemptId: '11111111-2222-4333-8444-555555555555',
  taskId: '22222222-3333-4444-8555-666666666666',
  workspaceId: '33333333-4444-4555-8666-777777777777',
  cwd: '/srv/ws/p/t/a1',
  metaDir: '/srv/ws/p/t/a1.meta',
  tmpDir: '/srv/ws/p/t/a1.meta/tmp',
  lease: memoryLease,
  model: 'sonnet',
  effort: null,
  tools: { builtinTools: ['Read'], allowedRules: [], disallowedRules: ['WebFetch'] },
  mcp: null,
  appendSystemPrompt: 'rules',
  stdinPrompt: 'task',
  session: { kind: 'new', sessionId: '44444444-5555-4666-8777-888888888888' },
  maxBudgetUsd: null,
  deadlineAt: new Date(Date.now() + 60_000),
  signal: new AbortController().signal,
};

function assertClean(env: Record<string, string>, allowed: readonly string[], where: string): void {
  const allow = new Set([...allowed, ...WINDOWS_BASE_ENV]);
  for (const key of Object.keys(env)) {
    expect(allow.has(key), `${where}: ${key} not allowlisted`).toBe(true);
    expect(key, where).not.toMatch(FORBIDDEN_NAME);
  }
  const values = Object.values(env).join('\n');
  for (const v of Object.values(SECRET_VALUES)) expect(values, where).not.toContain(v);
}

describe('allowlists contain no secret-bearing names', () => {
  it.each([
    ['CLAUDE', CLAUDE_ENV_ALLOWLIST],
    ['GIT', GIT_ENV_ALLOWLIST],
    ['TEST', TEST_ENV_ALLOWLIST],
  ] as const)('%s_ENV_ALLOWLIST', (_name, list) => {
    for (const key of list) expect(key).not.toMatch(FORBIDDEN_NAME);
    expect(list).not.toContain('NODE_OPTIONS');
  });

  it('only Claude may receive the API key and proxy settings', () => {
    for (const list of [GIT_ENV_ALLOWLIST, TEST_ENV_ALLOWLIST]) {
      for (const key of ['ANTHROPIC_API_KEY', 'HTTPS_PROXY', 'HTTP_PROXY']) expect(list).not.toContain(key);
    }
    for (const kind of ['test', 'mcp'] as const) {
      expect(allowedEnvKeys(kind).has('ANTHROPIC_API_KEY')).toBe(false);
      expect(allowedEnvKeys(kind).has('HTTPS_PROXY')).toBe(false);
    }
  });
});

describe('child environments built from a poisoned worker environment', () => {
  it.each([['posix'], ['win32']] as const)('git, test and Claude children get allowlisted keys only (%s)', (platform) => {
    assertClean(buildChildEnv(GIT_ENV_ALLOWLIST, WORKER_ENV, {}, platform), GIT_ENV_ALLOWLIST, `git/${platform}`);
    assertClean(buildChildEnv(TEST_ENV_ALLOWLIST, WORKER_ENV, {}, platform), TEST_ENV_ALLOWLIST, `test/${platform}`);
    const claude = buildClaudeEnv(config(platform), REQUEST, WORKER_ENV);
    assertClean(claude, CLAUDE_ENV_ALLOWLIST, `claude/${platform}`);
    // The configured key replaces whatever the worker environment carried.
    expect(claude['ANTHROPIC_API_KEY']).toBe('sk-ant-api03-CONFIGURED000000000000000000000');
    expect(claude['ORC_ATTEMPT_ID']).toBe(REQUEST.attemptId);
    expect(claude['CBM_ALLOWED_ROOT']).toBe(REQUEST.cwd);
    expect(claude['HOME']).toContain(REQUEST.workspaceId);
    expect(claude['CLAUDE_CONFIG_DIR']).toContain(REQUEST.workspaceId);
    const probeDir = platform === 'win32' ? 'C:\\orc\\claude-home\\probe' : '/srv/claude-home/probe';
    const probe = buildProbeEnv(config(platform), probeDir, WORKER_ENV);
    assertClean(probe, CLAUDE_ENV_ALLOWLIST, `probe/${platform}`);
  });

  it('a home directory per workspace keeps transcripts of other workspaces out of reach', () => {
    const a = buildClaudeEnv(config('posix'), REQUEST, WORKER_ENV);
    const b = buildClaudeEnv(config('posix'), { ...REQUEST, workspaceId: '99999999-4444-4555-8666-777777777777' }, WORKER_ENV);
    expect(a['HOME']).not.toBe(b['HOME']);
    expect(a['CLAUDE_CONFIG_DIR']).not.toBe(b['CLAUDE_CONFIG_DIR']);
    expect(a['CBM_CACHE_DIR']).not.toBe(b['CBM_CACHE_DIR']);
  });
});
