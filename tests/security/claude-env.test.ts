// Contract §18.5 extra gate "Claude env allowlist / argv" (§10.3, §11.3, §13.5): every child process
// (Claude, git, the project test command) receives only allowlisted variables; secrets present in the
// worker's own environment never pass. The pipeline-level proof (`@@fake echo-env` / `echo-argv`
// through the real worker) is in workspace-isolation.test.ts.
import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildClaudeEnv, buildClaudeLaunchEnv, buildProbeEnv } from '@orc/claude-runner';
import type { ClaudeRunnerConfig, ClaudeRunRequest } from '@orc/claude-runner';
import {
  CLAUDE_ENV_ALLOWLIST,
  CLAUDE_FIXED_ENV,
  CLAUDE_NEVER_ENV,
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
  // ADR-0036 m.4: the worker's own credential variables never reach a child (the configured credential is set explicitly).
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-WORKERENV_SEC_0000000000000000000000',
  CLAUDE_CODE_OAUTH_TOKEN_FILE: '/run/secrets/claude_oauth_token',
  ANTHROPIC_AUTH_TOKEN: 'auth-token-SEC-0001',
  ANTHROPIC_BASE_URL: 'https://evil.example.invalid/SEC-0001',
};

/** The worker's own AppData (win32): Claude and the probe get a per-workspace layout instead (B-020). */
const WORKER_APPDATA = 'C:\\Users\\worker\\AppData\\Roaming';
const WORKER_LOCALAPPDATA = 'C:\\Users\\worker\\AppData\\Local';

const WORKER_ENV: Record<string, string> = {
  PATH: '/usr/local/bin:/usr/bin',
  HOME: '/home/worker',
  LANG: 'en_US.UTF-8',
  ANTHROPIC_API_KEY: 'sk-ant-api03-WORKERENV0000000000000000000000',
  SystemRoot: 'C:\\Windows',
  APPDATA: WORKER_APPDATA,
  LOCALAPPDATA: WORKER_LOCALAPPDATA,
  CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '9',
  CLAUDE_CODE_SIMPLE: '1',
  ...SECRET_VALUES,
};

const FORBIDDEN_NAME = /^(DB_|REDIS_|MSSQL_|SESSION_|EGRESS_|GH_|AWS_|npm_|NODE_OPTIONS$|LD_|GIT_SSH|GIT_CONFIG_PARAMETERS)|_FILE$/i;

const CONFIGURED_KEY = 'sk-ant-api03-CONFIGURED000000000000000000000';
const CONFIGURED_TOKEN = 'sk-ant-oat01-CONFIGURED_SEC_00000000000000000000000';
const API_KEY_AUTH: ClaudeRunnerConfig['auth'] = { mode: 'api_key', apiKey: CONFIGURED_KEY };
const OAUTH_AUTH: ClaudeRunnerConfig['auth'] = { mode: 'oauth', oauthToken: CONFIGURED_TOKEN };

function config(platform: 'posix' | 'win32', auth: ClaudeRunnerConfig['auth'] = API_KEY_AUTH): ClaudeRunnerConfig {
  return {
    bin: 'claude',
    binPrefixArgs: [],
    claudeHomeRoot: platform === 'win32' ? 'C:\\orc\\claude-home' : '/srv/claude-home',
    auth,
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
    expect(claude).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(claude).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR');
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

/** Every variable that names or carries a Claude credential, plus the "never set" keys (ADR-0036 m.4). */
const CREDENTIAL_KEYS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE',
  ...CLAUDE_NEVER_ENV,
];
/** §10.3 keys of every attempt spawn (PATH inherited, the rest set explicitly; the config sets all proxy keys). */
const BASE_KEYS: readonly string[] = [
  'PATH',
  'HOME',
  'CLAUDE_CONFIG_DIR',
  'LANG',
  'TMPDIR',
  'DISABLE_AUTOUPDATER',
  'DISABLE_TELEMETRY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
  'CBM_CACHE_DIR',
  'CBM_ALLOWED_ROOT',
  'ORC_ATTEMPT_ID',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
];
/** win32 additions: SystemRoot from the worker env, the rest per workspace (B-020). */
const WIN32_KEYS: readonly string[] = ['SystemRoot', 'USERPROFILE', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA'];

// [platform, mode, the only credential variable, fd 3 payload]
const MATRIX = [
  ['posix', 'oauth', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', CONFIGURED_TOKEN],
  ['win32', 'oauth', 'CLAUDE_CODE_OAUTH_TOKEN', null],
  ['posix', 'api_key', 'ANTHROPIC_API_KEY', null],
  ['win32', 'api_key', 'ANTHROPIC_API_KEY', null],
] as const;

const authFor = (mode: 'oauth' | 'api_key'): ClaudeRunnerConfig['auth'] => (mode === 'oauth' ? OAUTH_AUTH : API_KEY_AUTH);
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

describe('credential env matrix: both auth modes on both platforms (ADR-0036 m.4, B-020)', () => {
  it.each(MATRIX)('%s/%s: exact key set, exactly one credential where it belongs, fixed switches', (platform, mode, credentialKey, fd) => {
    const where = `${platform}/${mode}`;
    const credential = mode === 'oauth' ? CONFIGURED_TOKEN : CONFIGURED_KEY;
    const other = mode === 'oauth' ? CONFIGURED_KEY : CONFIGURED_TOKEN;
    const { env, credentialFd } = buildClaudeLaunchEnv(config(platform, authFor(mode)), REQUEST, WORKER_ENV);
    expect(Object.keys(env).sort(), where).toEqual(
      [...BASE_KEYS, credentialKey, ...(platform === 'win32' ? WIN32_KEYS : [])].sort(),
    );
    assertClean(env, CLAUDE_ENV_ALLOWLIST, where);
    expect(Object.keys(env).filter((k) => CREDENTIAL_KEYS.includes(k)), where).toEqual([credentialKey]);
    for (const [key, value] of Object.entries(CLAUDE_FIXED_ENV)) expect(env[key], `${where}: ${key}`).toBe(value);
    expect(credentialFd, where).toBe(fd);
    const values = Object.values(env).join('\n');
    const holders = Object.entries(env)
      .filter(([, v]) => v.includes(credential) || v.includes(b64(credential)))
      .map(([k]) => k);
    if (fd !== null) {
      // POSIX oauth: the env only names fd 3; the token (and its base64) is in no value at all.
      expect(env[credentialKey], where).toBe('3');
      expect(holders, `${where}: token in env`).toEqual([]);
    } else {
      // win32 oauth (token) and api_key (key): the value is in its own variable and nowhere else.
      expect(env[credentialKey], where).toBe(credential);
      expect(holders, where).toEqual([credentialKey]);
    }
    expect(values, `${where}: the other mode's credential`).not.toContain(other);
    expect(values, `${where}: the worker's AppData`).not.toContain(WORKER_APPDATA);
    expect(values, `${where}: the worker's LocalAppData`).not.toContain(WORKER_LOCALAPPDATA);
    if (platform === 'win32') {
      const home = env['HOME'] ?? '';
      expect(home).toContain(REQUEST.workspaceId);
      expect(env['USERPROFILE']).toBe(home);
      expect(env['APPDATA']).toBe(win32.join(home, 'AppData', 'Roaming'));
      expect(env['LOCALAPPDATA']).toBe(win32.join(home, 'AppData', 'Local'));
    }
  });

  it.each(MATRIX)('%s/%s: the probe env carries no credential variable and no credential value', (platform, mode) => {
    const where = `probe/${platform}/${mode}`;
    const probeDir = platform === 'win32' ? 'C:\\orc\\claude-home\\probe' : '/srv/claude-home/probe';
    const probe = buildProbeEnv(config(platform, authFor(mode)), probeDir, WORKER_ENV);
    assertClean(probe, CLAUDE_ENV_ALLOWLIST, where);
    expect(Object.keys(probe).filter((k) => CREDENTIAL_KEYS.includes(k)), where).toEqual([]);
    const values = Object.values(probe).join('\n');
    for (const v of [CONFIGURED_TOKEN, CONFIGURED_KEY, b64(CONFIGURED_TOKEN), b64(CONFIGURED_KEY), WORKER_APPDATA]) {
      expect(values, where).not.toContain(v);
    }
    for (const [key, value] of Object.entries(CLAUDE_FIXED_ENV)) expect(probe[key], `${where}: ${key}`).toBe(value);
    if (platform === 'win32') {
      expect(probe['APPDATA']).toBe(win32.join(probeDir, 'AppData', 'Roaming'));
      expect(probe['LOCALAPPDATA']).toBe(win32.join(probeDir, 'AppData', 'Local'));
    }
  });

  it.each([['posix'], ['win32']] as const)('git and test children never get a Claude credential variable (%s)', (platform) => {
    for (const list of [GIT_ENV_ALLOWLIST, TEST_ENV_ALLOWLIST]) {
      const env = buildChildEnv(list, WORKER_ENV, {}, platform);
      expect(Object.keys(env).filter((k) => CREDENTIAL_KEYS.includes(k))).toEqual([]);
      for (const key of CREDENTIAL_KEYS) expect(list).not.toContain(key);
    }
  });
});
