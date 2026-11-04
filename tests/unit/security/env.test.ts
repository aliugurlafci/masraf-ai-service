import { describe, expect, it } from 'vitest';
import {
  buildChildEnv,
  CLAUDE_ENV_ALLOWLIST,
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
