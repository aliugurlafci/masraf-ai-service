import { describe, expect, it } from 'vitest';
import {
  buildClaudeEnv,
  buildClaudeLaunchEnv,
  buildProbeEnv,
  createClaudeRunner,
  proxyUrlWithToken,
  type ClaudeRunnerConfig,
  type ClaudeRunRequest,
} from '@orc/claude-runner';
import { CLAUDE_ENV_ALLOWLIST, createSecretRegistry, maskText, WINDOWS_BASE_ENV } from '@orc/security';
import { createMemoryLauncher, memoryLease, silentLogger } from '../../helpers/claude/memory-process';

const WS = '33333333-4444-4555-8666-777777777777';
const ATTEMPT = '11111111-2222-4333-8444-555555555555';
const API_KEY = 'sk-ant-api03-UNITTEST000000000000000000000000';
const OAUTH = `sk-ant-oat01-UNITTEST${'0'.repeat(30)}`;
const TOKEN = 'egress_token_UNITTEST_0000000000';
const API_KEY_AUTH = { mode: 'api_key', apiKey: API_KEY } as const;
const OAUTH_AUTH = { mode: 'oauth', oauthToken: OAUTH } as const;

/** A worker environment full of things that must never reach Claude. */
const WORKER_ENV: Record<string, string> = {
  PATH: '/usr/local/bin:/usr/bin',
  HOME: '/home/worker',
  LANG: 'en_US.UTF-8',
  TMPDIR: '/tmp',
  CLAUDE_CODE_GIT_BASH_PATH: 'C:/Program Files/Git/bin/bash.exe',
  ANTHROPIC_API_KEY: 'sk-ant-api03-FROMWORKERENV0000000000000000000',
  ANTHROPIC_API_KEY_FILE: '/run/secrets/anthropic',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-FROMWORKERENV00000000000000000000',
  CLAUDE_CODE_OAUTH_TOKEN_FILE: '/run/secrets/claude_oauth_token',
  CLAUDE_CODE_SIMPLE: '1',
  ANTHROPIC_AUTH_TOKEN: 'sk-ant-oat01-AUTHTOKENENV000000000000000000000',
  ANTHROPIC_BASE_URL: 'http://evil.example',
  APPDATA: 'C:\\Users\\worker\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\worker\\AppData\\Local',
  HTTPS_PROXY: 'http://worker-proxy:3128',
  DB_HOST: 'mssql',
  DB_PASSWORD: 'db-password-123456',
  DB_PASSWORD_FILE: '/run/secrets/db',
  DB_NAME: 'orchestrator',
  REDIS_URL: 'redis://:pw@redis:6379',
  REDIS_PASSWORD: 'redis-password-123456',
  SESSION_SECRET: 'session-secret-123456789',
  EGRESS_PROXY_TOKEN: TOKEN,
  EGRESS_PROXY_TOKEN_FILE: '/run/secrets/egress',
  NODE_OPTIONS: '--require /tmp/evil.js',
  npm_config_userconfig: '/home/worker/.npmrc',
  CLAUDE_CONFIG_DIR: '/home/worker/.claude',
  SystemRoot: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  USERPROFILE: 'C:\\Users\\worker',
  TEMP: 'C:\\Users\\worker\\AppData\\Local\\Temp',
};

function config(over: Partial<ClaudeRunnerConfig> = {}): ClaudeRunnerConfig {
  return {
    bin: 'claude',
    binPrefixArgs: [],
    claudeHomeRoot: '/srv/claude-home',
    auth: API_KEY_AUTH,
    proxy: { https: 'http://egress-proxy:3128', http: 'http://egress-proxy:3128', noProxy: 'localhost,127.0.0.1', token: TOKEN },
    killGraceMs: 10_000,
    initTimeoutMs: 60_000,
    maxOutputBytes: 52_428_800,
    maxLineBytes: 4_194_304,
    cbmCacheRoot: '/srv/cbm-cache',
    platform: 'posix',
    workerId: 'worker-1',
    initExtraTools: [],
    ...over,
  };
}

function request(over: Partial<ClaudeRunRequest> = {}): ClaudeRunRequest {
  return {
    attemptId: ATTEMPT,
    taskId: '22222222-3333-4444-8555-666666666666',
    workspaceId: WS,
    cwd: '/srv/ws/p/t/wt',
    metaDir: '/srv/ws/p/t/.meta',
    tmpDir: '/srv/ws/p/t/.meta/tmp',
    lease: memoryLease,
    model: 'claude-sonnet-4-5',
    effort: null,
    tools: { builtinTools: ['Read'], allowedRules: [], disallowedRules: ['WebFetch'] },
    mcp: { configPath: '/srv/ws/p/t/.meta/mcp.json', cacheDir: `/srv/cbm-cache/w/${WS}` },
    appendSystemPrompt: 'rules',
    stdinPrompt: 'task',
    session: { kind: 'new', sessionId: '44444444-5555-4666-8777-888888888888' },
    maxBudgetUsd: null,
    deadlineAt: new Date(Date.now() + 60_000),
    signal: new AbortController().signal,
    ...over,
  };
}

const FORBIDDEN = /^(DB_|REDIS_|SESSION_|NODE_OPTIONS$|npm_|EGRESS_)|_FILE$/i;

describe('buildClaudeEnv (§10.3)', () => {
  it('posix: exact allowlisted values and nothing inherited except PATH', () => {
    const env = buildClaudeEnv(config(), request(), WORKER_ENV);
    expect(env).toEqual({
      PATH: '/usr/local/bin:/usr/bin',
      CLAUDE_CODE_GIT_BASH_PATH: 'C:/Program Files/Git/bin/bash.exe',
      HOME: `/srv/claude-home/w/${WS}/home`,
      CLAUDE_CONFIG_DIR: `/srv/claude-home/w/${WS}/config`,
      LANG: 'C.UTF-8',
      TMPDIR: '/srv/ws/p/t/.meta/tmp',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CBM_CACHE_DIR: `/srv/cbm-cache/w/${WS}`,
      CBM_ALLOWED_ROOT: '/srv/ws/p/t/wt',
      ORC_ATTEMPT_ID: ATTEMPT,
      ANTHROPIC_API_KEY: API_KEY,
      HTTPS_PROXY: `http://orc:${TOKEN}@egress-proxy:3128`,
      HTTP_PROXY: 'http://egress-proxy:3128',
      NO_PROXY: 'localhost,127.0.0.1',
    });
    for (const key of Object.keys(env)) expect(CLAUDE_ENV_ALLOWLIST).toContain(key);
  });

  it('never contains DB, Redis, session, *_FILE, NODE_OPTIONS or npm_ variables', () => {
    for (const platform of ['posix', 'win32'] as const) {
      const env = buildClaudeEnv(
        config({ platform, claudeHomeRoot: platform === 'win32' ? 'C:\\orc\\claude-home' : '/srv/claude-home' }),
        request(),
        WORKER_ENV,
      );
      const bad = Object.keys(env).filter((k) => FORBIDDEN.test(k));
      expect(bad).toEqual([]);
      const values = Object.values(env).join('\n');
      for (const secret of [
        'db-password-123456',
        'redis-password-123456',
        'session-secret-123456789',
        'FROMWORKERENV',
        'AUTHTOKENENV',
        'evil.example',
      ]) {
        expect(values).not.toContain(secret);
      }
    }
  });

  it('win32: WINDOWS_BASE_ENV passes, USERPROFILE/TEMP/TMP are redirected', () => {
    const env = buildClaudeEnv(
      config({ platform: 'win32', claudeHomeRoot: 'C:\\orc\\claude-home', cbmCacheRoot: 'C:\\orc\\cbm' }),
      request({ tmpDir: 'C:\\orc\\ws\\p\\t\\.meta\\tmp', mcp: null, cwd: 'C:\\orc\\ws\\p\\t\\wt' }),
      WORKER_ENV,
    );
    const allowed = new Set([...CLAUDE_ENV_ALLOWLIST, ...WINDOWS_BASE_ENV].map((k) => k.toUpperCase()));
    for (const key of Object.keys(env)) expect(allowed.has(key.toUpperCase())).toBe(true);
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.HOME).toBe(`C:\\orc\\claude-home\\w\\${WS}\\home`);
    expect(env.USERPROFILE).toBe(env.HOME);
    expect(env.TEMP).toBe('C:\\orc\\ws\\p\\t\\.meta\\tmp');
    expect(env.TMP).toBe(env.TEMP);
    expect(env.CBM_CACHE_DIR).toBe(`C:\\orc\\cbm\\w\\${WS}`);
    // B-020: the per-workspace AppData replaces the worker's.
    expect(env.APPDATA).toBe(`C:\\orc\\claude-home\\w\\${WS}\\home\\AppData\\Roaming`);
    expect(env.LOCALAPPDATA).toBe(`C:\\orc\\claude-home\\w\\${WS}\\home\\AppData\\Local`);
  });

  const CREDENTIAL_KEY = /^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN.*)$/i;
  const win32Config = (auth: ClaudeRunnerConfig['auth']): ClaudeRunnerConfig =>
    config({ platform: 'win32', auth, claudeHomeRoot: 'C:\\orc\\claude-home', cbmCacheRoot: 'C:\\orc\\cbm' });

  it.each([
    ['posix', 'oauth', ['CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'], OAUTH],
    ['win32', 'oauth', ['CLAUDE_CODE_OAUTH_TOKEN'], null],
    ['posix', 'api_key', ['ANTHROPIC_API_KEY'], null],
    ['win32', 'api_key', ['ANTHROPIC_API_KEY'], null],
  ] as const)('credential transport %s/%s (ADR-0036 Decision 4)', (platform, mode, keys, fd) => {
    const auth = mode === 'oauth' ? OAUTH_AUTH : API_KEY_AUTH;
    const c = platform === 'win32' ? win32Config(auth) : config({ auth });
    const launch = buildClaudeLaunchEnv(c, request(), WORKER_ENV);
    expect(Object.keys(launch.env).filter((k) => CREDENTIAL_KEY.test(k))).toEqual(keys);
    expect(launch.credentialFd).toBe(fd);
    if (fd !== null) {
      expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR).toBe('3');
      expect(Object.values(launch.env).join('\n')).not.toContain(OAUTH);
    }
    expect(launch.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(launch.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');
    for (const never of ['CLAUDE_CODE_SIMPLE', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
      expect(launch.env).not.toHaveProperty(never);
    }
    expect(buildClaudeEnv(c, request(), WORKER_ENV)).toEqual(launch.env);
  });

  it('never emits both credentials, even for an auth input that carries both', () => {
    const both = { mode: 'oauth', oauthToken: OAUTH, apiKey: API_KEY } as unknown as ClaudeRunnerConfig['auth'];
    const err = ((): unknown => {
      try {
        buildClaudeLaunchEnv(config({ auth: both }), request(), WORKER_ENV);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toMatchObject({ code: 'unsafe_argument', details: { reason: 'credential_conflict' } });
    expect(JSON.stringify(err)).not.toContain(OAUTH);
    expect(String((err as Error).message)).not.toContain(API_KEY);
  });

  it('posix: no AppData variables (B-020 is win32 only)', () => {
    const env = buildClaudeEnv(config({ auth: OAUTH_AUTH }), request(), WORKER_ENV);
    expect(env).not.toHaveProperty('APPDATA');
    expect(env).not.toHaveProperty('LOCALAPPDATA');
  });

  it('omits proxy variables that are not configured', () => {
    const env = buildClaudeEnv(
      config({ proxy: { https: null, http: null, noProxy: null, token: null } }),
      request(),
      WORKER_ENV,
    );
    expect(Object.keys(env).filter((k) => k.endsWith('_PROXY'))).toEqual([]);
  });

  it('rejects malformed ids used in paths', () => {
    expect(() => buildClaudeEnv(config(), request({ workspaceId: '../../etc' }), WORKER_ENV)).toThrow();
    expect(() => buildClaudeEnv(config(), request({ attemptId: 'x' }), WORKER_ENV)).toThrow();
  });

  it.each([OAUTH_AUTH, API_KEY_AUTH])('probe env has no credential and no proxy credentials (%o)', (auth) => {
    const env = buildProbeEnv(config({ auth }), '/srv/claude-home/probe', WORKER_ENV);
    expect(Object.keys(env).filter((k) => /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN)/i.test(k))).toEqual([]);
    expect(env).not.toHaveProperty('HTTPS_PROXY');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/srv/claude-home/probe');
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(env).not.toHaveProperty('APPDATA');
    expect(Object.keys(env).filter((k) => FORBIDDEN.test(k))).toEqual([]);
  });

  it('win32 probe env: AppData below the probe directory, never the worker one', () => {
    const env = buildProbeEnv(win32Config(OAUTH_AUTH), 'C:\\orc\\claude-home\\probe', WORKER_ENV);
    expect(env.APPDATA).toBe('C:\\orc\\claude-home\\probe\\AppData\\Roaming');
    expect(env.LOCALAPPDATA).toBe('C:\\orc\\claude-home\\probe\\AppData\\Local');
    expect(env.USERPROFILE).toBe('C:\\orc\\claude-home\\probe');
    expect(Object.keys(env).filter((k) => /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN)/i.test(k))).toEqual([]);
  });
});

describe('proxyUrlWithToken', () => {
  it('injects orc:<token> credentials without changing the rest', () => {
    expect(proxyUrlWithToken('http://egress-proxy:3128', 'abc_DEF-123456789012345678')).toBe(
      'http://orc:abc_DEF-123456789012345678@egress-proxy:3128',
    );
    expect(proxyUrlWithToken('http://egress-proxy:3128/', 'tok_000000000000000000000000')).toBe(
      'http://orc:tok_000000000000000000000000@egress-proxy:3128/',
    );
    expect(proxyUrlWithToken('http://egress-proxy:3128', null)).toBe('http://egress-proxy:3128');
  });
});

describe('createClaudeRunner secret registration', () => {
  it('registers the API key, the proxy token and the credentialed proxy URL for masking', () => {
    const secrets = createSecretRegistry();
    createClaudeRunner(config(), {
      logger: silentLogger(),
      secrets,
      launcher: createMemoryLauncher(() => new Error('unused')),
    });
    const text = `key=${API_KEY} url=http://orc:${TOKEN}@egress-proxy:3128 tok ${TOKEN}`;
    const masked = maskText(text, secrets);
    expect(masked).not.toContain(API_KEY);
    expect(masked).not.toContain(TOKEN);
  });

  it('registers the OAuth token and its base64 form (the fd 3 payload) for masking', () => {
    const secrets = createSecretRegistry();
    createClaudeRunner(config({ auth: OAUTH_AUTH }), {
      logger: silentLogger(),
      secrets,
      launcher: createMemoryLauncher(() => new Error('unused')),
    });
    const b64 = Buffer.from(OAUTH, 'utf8').toString('base64');
    const masked = maskText(`t=${OAUTH} b=${b64}`, secrets);
    expect(masked).not.toContain(OAUTH);
    expect(masked).not.toContain(b64);
  });

  it('rejects an invalid configuration without echoing values', () => {
    const make = (over: Partial<ClaudeRunnerConfig>): unknown => {
      try {
        createClaudeRunner(config(over), {
          logger: silentLogger(),
          secrets: createSecretRegistry(),
          launcher: createMemoryLauncher(() => new Error('unused')),
        });
        return null;
      } catch (e) {
        return e;
      }
    };
    const e1 = make({ initExtraTools: ['WebFetch'] });
    expect(e1).toMatchObject({ code: 'config_invalid' });
    expect(make({ initExtraTools: ['mcp__other__x'] })).toMatchObject({ code: 'config_invalid' });
    const leak = `sk-ant-oat01-LEAKCHECK${'0'.repeat(30)}`;
    const invalidAuths: unknown[] = [
      { mode: 'oauth', oauthToken: 'not-an-oauth-token-LEAKCHECK' },
      { mode: 'oauth', oauthToken: leak, apiKey: API_KEY },
      { mode: 'api_key', apiKey: leak },
      { mode: 'api_key', apiKey: API_KEY, oauthToken: leak },
      { mode: 'bare', apiKey: API_KEY },
    ];
    for (const auth of invalidAuths) {
      const e = make({ auth: auth as ClaudeRunnerConfig['auth'] });
      expect(e).toMatchObject({ code: 'config_invalid' });
      expect(JSON.stringify(e) + String((e as Error).message)).not.toContain('LEAKCHECK');
    }
    const e2 = make({ workerId: 'bad id', auth: { mode: 'oauth', oauthToken: leak } });
    expect(String((e2 as Error).message)).not.toContain('LEAKCHECK');
    expect(make({ reviewedExtensions: { 'latest/posix/oauth': { skills: [], agents: [], slashCommands: [], plugins: [] } } })).toMatchObject({
      code: 'config_invalid',
    });
    expect(make({ auth: OAUTH_AUTH })).toBeNull();
    expect(make({ initExtraTools: ['ToolSearch'] })).toBeNull();
  });
});
