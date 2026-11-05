import { describe, expect, it } from 'vitest';
import {
  assertNoClaudeCredential,
  assertSingleClaudeCredential,
  buildChildEnv,
  buildClaudeAppDataEnv,
  buildClaudeCredentialEnv,
  CLAUDE_ENV_ALLOWLIST,
  CLAUDE_FIXED_ENV,
  GIT_ENV_ALLOWLIST,
  TEST_ENV_ALLOWLIST,
  UnsafeArgumentError,
  WINDOWS_BASE_ENV,
} from '@orc/security';

const HOST_ENV: Readonly<Record<string, string | undefined>> = {
  PATH: '/usr/local/bin:/usr/bin',
  HOME: '/home/node',
  LANG: 'en_US.UTF-8',
  ANTHROPIC_API_KEY: 'sk-ant-api03-test-key-value-000000000000',
  ANTHROPIC_API_KEY_FILE: '/run/secrets/anthropic_api_key',
  DB_PASSWORD: 'db-password',
  DB_PASSWORD_FILE: '/run/secrets/db_password',
  DB_USER: 'orc_worker',
  REDIS_PASSWORD: 'redis-password',
  REDIS_URL: 'redis://:redis-password@redis:6379',
  SESSION_SECRET: 'session-secret',
  NODE_OPTIONS: '--require /tmp/evil.js',
  npm_config_registry: 'https://registry.npmjs.org',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  GITHUB_TOKEN: 'ghp_x',
  HTTPS_PROXY: 'http://egress-proxy:3128',
  UNDEFINED_VALUE: undefined,
  SystemRoot: 'C:\\Windows',
};

const FORBIDDEN = /^(DB_|REDIS_|SESSION_|NODE_OPTIONS$|npm_|AWS_|GITHUB_)|_FILE$/;

describe('child env allowlists', () => {
  it('match the contract lists', () => {
    expect(CLAUDE_ENV_ALLOWLIST).toEqual([
      'PATH',
      'HOME',
      'LANG',
      'TMPDIR',
      'CLAUDE_CONFIG_DIR',
      'ANTHROPIC_API_KEY',
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'NO_PROXY',
      'DISABLE_AUTOUPDATER',
      'DISABLE_TELEMETRY',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'CBM_CACHE_DIR',
      'CBM_ALLOWED_ROOT',
      'ORC_ATTEMPT_ID',
      'CLAUDE_CODE_GIT_BASH_PATH',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
      'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
      'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
    ]);
    expect(GIT_ENV_ALLOWLIST).toEqual([
      'PATH',
      'HOME',
      'GIT_CONFIG_NOSYSTEM',
      'GIT_CONFIG_GLOBAL',
      'GIT_TERMINAL_PROMPT',
      'GIT_OPTIONAL_LOCKS',
      'LC_ALL',
      'LANG',
    ]);
    expect(TEST_ENV_ALLOWLIST).toEqual([
      'PATH',
      'HOME',
      'LANG',
      'TMPDIR',
      'CI',
      'FORCE_COLOR',
      'ORC_ATTEMPT_ID',
    ]);
    expect(WINDOWS_BASE_ENV).toContain('SystemRoot');
  });

  it('never lists database, Redis, session or *_FILE secrets', () => {
    for (const list of [
      CLAUDE_ENV_ALLOWLIST,
      GIT_ENV_ALLOWLIST,
      TEST_ENV_ALLOWLIST,
      WINDOWS_BASE_ENV,
    ]) {
      for (const key of list) expect(key).not.toMatch(FORBIDDEN);
    }
    expect(GIT_ENV_ALLOWLIST).not.toContain('ANTHROPIC_API_KEY');
    expect(TEST_ENV_ALLOWLIST).not.toContain('ANTHROPIC_API_KEY');
    expect(TEST_ENV_ALLOWLIST).not.toContain('HTTPS_PROXY');
  });
});

describe('buildChildEnv', () => {
  it('copies only allowlisted keys and applies overrides (posix)', () => {
    const env = buildChildEnv(
      CLAUDE_ENV_ALLOWLIST,
      HOST_ENV,
      { HOME: '/claude/home', DISABLE_TELEMETRY: '1' },
      'posix',
    );
    expect(env).toEqual({
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/claude/home',
      LANG: 'en_US.UTF-8',
      ANTHROPIC_API_KEY: 'sk-ant-api03-test-key-value-000000000000',
      HTTPS_PROXY: 'http://egress-proxy:3128',
      DISABLE_TELEMETRY: '1',
    });
    for (const key of Object.keys(env)) expect(key).not.toMatch(FORBIDDEN);
    expect(env).not.toHaveProperty('SystemRoot');
  });

  it('excludes every secret from the test and git environments', () => {
    const testEnv = buildChildEnv(
      TEST_ENV_ALLOWLIST,
      HOST_ENV,
      { CI: '1', FORCE_COLOR: '0' },
      'posix',
    );
    expect(Object.keys(testEnv).sort()).toEqual(['CI', 'FORCE_COLOR', 'HOME', 'LANG', 'PATH']);
    const gitEnv = buildChildEnv(
      GIT_ENV_ALLOWLIST,
      HOST_ENV,
      { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      'posix',
    );
    expect(Object.keys(gitEnv).sort()).toEqual([
      'GIT_TERMINAL_PROMPT',
      'HOME',
      'LANG',
      'LC_ALL',
      'PATH',
    ]);
    const values = [...Object.values(testEnv), ...Object.values(gitEnv)].join('\n');
    expect(values).not.toMatch(/password|secret|sk-ant/);
  });

  it('does not copy inherited prototype keys or undefined values', () => {
    const source = Object.create({ PATH: '/inherited' }) as Record<string, string | undefined>;
    source.HOME = undefined;
    expect(buildChildEnv(['PATH', 'HOME'], source, {}, 'posix')).toEqual({});
  });

  it('skips source values containing NUL', () => {
    expect(buildChildEnv(['PATH'], { PATH: '/bin\0/evil' }, {}, 'posix')).toEqual({});
  });

  it('win32: adds the Windows base env, matches keys case-insensitively and uses allowlist spelling', () => {
    const source = {
      Path: 'C:\\Windows\\system32',
      windir: 'C:\\Windows',
      SYSTEMROOT: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      USERPROFILE: 'C:\\Users\\dev',
      DB_PASSWORD: 'db-password',
      ProgramFiles: 'C:\\Program Files',
    };
    const env = buildChildEnv(
      TEST_ENV_ALLOWLIST,
      source,
      { Temp: 'D:\\attempt\\tmp', CI: '1' },
      'win32',
    );
    expect(env).toEqual({
      PATH: 'C:\\Windows\\system32',
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\dev',
      Temp: 'D:\\attempt\\tmp',
      CI: '1',
    });
  });

  it('rejects invalid override names and NUL values', () => {
    expect(() => buildChildEnv(['PATH'], {}, { 'A=B': 'x' }, 'posix')).toThrow(UnsafeArgumentError);
    expect(() => buildChildEnv(['PATH'], {}, { HOME: 'a\0b' }, 'posix')).toThrow(
      UnsafeArgumentError,
    );
  });
});

const OAUTH = 'sk-ant-oat01-' + 'A'.repeat(40);
const API = 'sk-ant-api03-' + 'b'.repeat(30);

describe('ADR-0036 credential transport', () => {
  it('oauth/posix: fd variable only, token returned for fd 3 and never in env', () => {
    const r = buildClaudeCredentialEnv({ mode: 'oauth', oauthToken: OAUTH }, 'posix');
    expect(r.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3' });
    expect(r.credentialFd).toBe(OAUTH);
    expect(JSON.stringify(r.env)).not.toContain(OAUTH);
  });

  it('oauth/win32: token in env, no fd', () => {
    const r = buildClaudeCredentialEnv({ mode: 'oauth', oauthToken: OAUTH }, 'win32');
    expect(r.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: OAUTH });
    expect(r.credentialFd).toBeNull();
  });

  it('api_key: key in env on both platforms, no fd', () => {
    for (const p of ['posix', 'win32'] as const) {
      const r = buildClaudeCredentialEnv({ mode: 'api_key', apiKey: API }, p);
      expect(r.env).toEqual({ ANTHROPIC_API_KEY: API });
      expect(r.credentialFd).toBeNull();
    }
  });

  it('rejects both credentials and never echoes a value', () => {
    for (const p of ['posix', 'win32'] as const) {
      for (const auth of [
        { mode: 'oauth', oauthToken: OAUTH, apiKey: API },
        { mode: 'api_key', apiKey: API, oauthToken: OAUTH },
      ]) {
        let caught: unknown;
        try {
          buildClaudeCredentialEnv(auth as never, p);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(UnsafeArgumentError);
        expect(JSON.stringify(caught) + String(caught)).not.toMatch(/sk-ant/);
      }
    }
  });

  it('rejects empty, NUL and unknown-mode credentials', () => {
    expect(() => buildClaudeCredentialEnv({ mode: 'oauth', oauthToken: '' }, 'posix')).toThrow(
      UnsafeArgumentError,
    );
    expect(() => buildClaudeCredentialEnv({ mode: 'api_key', apiKey: 'a\0b' }, 'win32')).toThrow(
      UnsafeArgumentError,
    );
    expect(() => buildClaudeCredentialEnv({ mode: 'x' } as never, 'posix')).toThrow(
      UnsafeArgumentError,
    );
  });

  it('assertSingleClaudeCredential rejects any pair and the never-set keys', () => {
    expect(() => assertSingleClaudeCredential({ ANTHROPIC_API_KEY: API })).not.toThrow();
    expect(() => assertSingleClaudeCredential({ CLAUDE_CODE_OAUTH_TOKEN: OAUTH })).not.toThrow();
    expect(() =>
      assertSingleClaudeCredential({ ANTHROPIC_API_KEY: API, CLAUDE_CODE_OAUTH_TOKEN: OAUTH }),
    ).toThrow(UnsafeArgumentError);
    expect(() =>
      assertSingleClaudeCredential({
        ANTHROPIC_API_KEY: API,
        CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3',
      }),
    ).toThrow(UnsafeArgumentError);
    expect(() =>
      assertSingleClaudeCredential({
        CLAUDE_CODE_OAUTH_TOKEN: OAUTH,
        CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3',
      }),
    ).toThrow(UnsafeArgumentError);
    for (const k of ['CLAUDE_CODE_SIMPLE', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
      expect(() => assertSingleClaudeCredential({ [k]: '1' })).toThrow(UnsafeArgumentError);
    }
  });

  it('buildChildEnv refuses to emit both credentials (source or overrides)', () => {
    const source = { ANTHROPIC_API_KEY: API, CLAUDE_CODE_OAUTH_TOKEN: OAUTH };
    expect(() => buildChildEnv(CLAUDE_ENV_ALLOWLIST, source, {}, 'posix')).toThrow(
      UnsafeArgumentError,
    );
    expect(() =>
      buildChildEnv(
        CLAUDE_ENV_ALLOWLIST,
        { ANTHROPIC_API_KEY: API },
        { CLAUDE_CODE_OAUTH_TOKEN: OAUTH },
        'win32',
      ),
    ).toThrow(UnsafeArgumentError);
  });

  it('probe env carries no credential variable and no fd 3', () => {
    expect(() => assertNoClaudeCredential({ PATH: '/bin' })).not.toThrow();
    for (const k of [
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
    ]) {
      expect(() => assertNoClaudeCredential({ [k]: 'x' })).toThrow(UnsafeArgumentError);
    }
  });

  it('fixed Claude env disables auto memory and CLAUDE.md loading', () => {
    expect(CLAUDE_FIXED_ENV).toEqual({
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    });
    const env = buildChildEnv(CLAUDE_ENV_ALLOWLIST, {}, { ...CLAUDE_FIXED_ENV }, 'posix');
    expect(env).toMatchObject(CLAUDE_FIXED_ENV);
  });
});

describe('B-020 isolated AppData', () => {
  const BS = String.fromCharCode(92);
  const w = (...parts: string[]): string => parts.join(BS);
  const HOME = w('D:', 'claude', 'w', 'abc', 'home');
  const ROAM = w(HOME, 'AppData', 'Roaming');
  const LOCAL = w(HOME, 'AppData', 'Local');
  const REAL_ROAM = w('C:', 'Users', 'real', 'AppData', 'Roaming');
  const REAL_LOCAL = w('C:', 'Users', 'real', 'AppData', 'Local');

  it('claude and probe on win32 get isolated APPDATA and LOCALAPPDATA', () => {
    for (const kind of ['claude', 'probe'] as const) {
      expect(buildClaudeAppDataEnv(kind, HOME, 'win32')).toEqual({
        APPDATA: ROAM,
        LOCALAPPDATA: LOCAL,
      });
    }
  });

  it('other kinds and posix are unchanged (empty)', () => {
    for (const kind of ['test', 'mcp', 'git'] as const) {
      expect(buildClaudeAppDataEnv(kind, HOME, 'win32')).toEqual({});
    }
    expect(buildClaudeAppDataEnv('claude', '/h', 'posix')).toEqual({});
  });

  it('overrides replace the real values copied from the worker (win32, case-insensitive)', () => {
    const source = { appdata: REAL_ROAM, LocalAppData: REAL_LOCAL };
    const env = buildChildEnv(
      CLAUDE_ENV_ALLOWLIST,
      source,
      buildClaudeAppDataEnv('claude', HOME, 'win32'),
      'win32',
    );
    expect(env.APPDATA).toBe(ROAM);
    expect(env.LOCALAPPDATA).toBe(LOCAL);
    expect(Object.values(env).join(' ')).not.toContain('real');
    // test kind: real values still copied (known issue, ADR 8.6)
    const testEnv = buildChildEnv(TEST_ENV_ALLOWLIST, source, {}, 'win32');
    expect(testEnv.APPDATA).toBe(REAL_ROAM);
  });

  it('rejects empty or NUL home', () => {
    expect(() => buildClaudeAppDataEnv('claude', '', 'win32')).toThrow(UnsafeArgumentError);
    expect(() =>
      buildClaudeAppDataEnv('probe', 'a' + String.fromCharCode(0) + 'b', 'win32'),
    ).toThrow(UnsafeArgumentError);
  });
});
