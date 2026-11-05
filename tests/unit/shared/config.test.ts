import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isOrcError } from '@orc/shared';
import {
  ApiConfigSchema,
  ConfigError,
  DbNameGuardError,
  CLAUDE_OAUTH_TOKEN_REGEX,
  SECRET_ENV_KEYS,
  assertDbNameForEnv,
  loadApiConfig,
  loadConfig,
  loadDbCliConfig,
  loadEgressProxyConfig,
  loadWorkerConfig,
  readEnvWithFiles,
  type Env,
} from '@orc/shared/node';

const SECRET = 'S3cr3t-value-never-logged';
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'orc-shared-config-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function secretFile(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected an error');
}

const abs = (name: string): string => resolve(dir, name);

const apiEnv = (extra: Env = {}): Env => ({
  NODE_ENV: 'development',
  DB_USER: 'orc_api',
  DB_PASSWORD: SECRET,
  CLAUDE_ALLOWED_MODELS: 'claude-a, claude-b',
  CLAUDE_DEFAULT_MODEL: 'claude-a',
  ...extra,
});

const OAUTH_TOKEN = 'sk-ant-oat01-unit_Test-Token0123456789abcdefghij';
const API_KEY = 'sk-ant-api03-test-key-000000000000000000';
const workerEnv = (extra: Env = {}): Env => ({
  NODE_ENV: 'development',
  DB_USER: 'orc_worker',
  DB_PASSWORD: SECRET,
  PROJECTS_ROOT: abs('projects'),
  WORKSPACES_ROOT: abs('workspaces'),
  CLAUDE_HOME_ROOT: abs('claude-home'),
  CBM_CACHE_DIR: abs('cbm'),
  CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN,
  WORKER_ID: 'worker-1',
  ...extra,
});

describe('readEnvWithFiles (_FILE secret indirection)', () => {
  it('reads K from K_FILE and removes exactly one trailing newline', () => {
    const lf = secretFile('lf.txt', `${SECRET}\n\n`);
    const crlf = secretFile('crlf.txt', `${SECRET}\r\n`);
    const none = secretFile('none.txt', SECRET);
    const out = readEnvWithFiles({ A_FILE: lf, B_FILE: crlf, C_FILE: none, OTHER: 'x' }, [
      'A',
      'B',
      'C',
    ]);
    expect(out.A).toBe(`${SECRET}\n`);
    expect(out.B).toBe(SECRET);
    expect(out.C).toBe(SECRET);
    expect(out.OTHER).toBe('x');
    expect(out).not.toHaveProperty('A_FILE');
  });

  it('keeps direct values and ignores _FILE for non-secret keys', () => {
    const out = readEnvWithFiles({ A: 'direct', NOT_SECRET_FILE: '/nope' }, ['A']);
    expect(out.A).toBe('direct');
    expect(out.NOT_SECRET_FILE).toBe('/nope');
  });

  it('rejects K and K_FILE both set without leaking values', () => {
    const p = secretFile('both.txt', 'from-file');
    const e = captureError(() => readEnvWithFiles({ A: SECRET, A_FILE: p }, ['A']));
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as ConfigError).code).toBe('config_invalid');
    expect((e as ConfigError).message).toContain('A and A_FILE are both set');
    expect((e as ConfigError).message).not.toContain(SECRET);
    expect(JSON.stringify((e as ConfigError).details)).not.toContain(SECRET);
  });

  it('treats empty strings as unset', () => {
    const p = secretFile('empty-direct.txt', 'file-value');
    expect(readEnvWithFiles({ A: '', A_FILE: p }, ['A']).A).toBe('file-value');
    expect(readEnvWithFiles({ A: 'v', A_FILE: '' }, ['A']).A).toBe('v');
  });

  it('rejects unreadable files', () => {
    const e = captureError(() => readEnvWithFiles({ A_FILE: join(dir, 'missing.txt') }, ['A']));
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as ConfigError).message).toContain('A_FILE could not be read (ENOENT)');
  });

  it('uses the injected reader', () => {
    const out = readEnvWithFiles(
      { A_FILE: '/run/secrets/a' },
      ['A'],
      (path) => `${path}:content\n`,
    );
    expect(out.A).toBe('/run/secrets/a:content');
  });
});

describe('loadConfig', () => {
  it('lists keys and issues but never values', () => {
    const e = captureError(() =>
      loadConfig(ApiConfigSchema, {
        app: 'api',
        env: apiEnv({ API_PORT: SECRET, DB_PORT: '99999', LOG_LEVEL: SECRET }),
        secretKeys: SECRET_ENV_KEYS.api,
      }),
    );
    expect(e).toBeInstanceOf(ConfigError);
    const err = e as ConfigError;
    expect(err.message).toContain('API_PORT');
    expect(err.message).toContain('DB_PORT');
    expect(err.message).toContain('LOG_LEVEL');
    expect(err.message).not.toContain(SECRET);
    expect(err.message).not.toContain('99999');
    expect(JSON.stringify(err.details)).not.toContain(SECRET);
    expect(err.expose).toBe(false);
  });

  it('reports required keys', () => {
    const e = captureError(() => loadApiConfig({ NODE_ENV: 'development' })) as ConfigError;
    for (const key of ['DB_USER', 'DB_PASSWORD', 'CLAUDE_ALLOWED_MODELS', 'CLAUDE_DEFAULT_MODEL']) {
      expect(e.message).toContain(key);
    }
  });
});

describe('loadApiConfig', () => {
  it('applies defaults and maps to nested db/redis + camelCase keys', () => {
    const cfg = loadApiConfig(apiEnv());
    expect(cfg.app).toBe('api');
    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.db).toEqual({
      host: '127.0.0.1',
      port: 1433,
      database: 'orchestrator',
      user: 'orc_api',
      password: SECRET,
      encrypt: true,
      trustServerCertificate: false,
      caCert: null,
      poolMin: 0,
      poolMax: 10,
      connectTimeoutMs: 15_000,
      requestTimeoutMs: 30_000,
      appName: 'orc-api',
    });
    expect(cfg.redis).toEqual({
      host: '127.0.0.1',
      port: 6379,
      password: null,
      db: 0,
      prefix: 'orc',
    });
    expect(cfg.apiPort).toBe(4000);
    expect(cfg.publicOrigin).toBe('http://127.0.0.1:5173');
    expect(cfg.cookieSecure).toBe(true);
    expect(cfg.passwordScryptN).toBe(131_072);
    expect(cfg.sseMaxPerUser).toBe(10);
    expect(cfg.claudeAllowedModels).toEqual(['claude-a', 'claude-b']);
    expect(cfg.claudeDefaultModel).toBe('claude-a');
    expect(cfg.shutdownTimeoutMs).toBe(15_000);
  });

  it('reads DB_PASSWORD from DB_PASSWORD_FILE', () => {
    const p = secretFile('db-password.txt', `${SECRET}\n`);
    const { DB_PASSWORD: _unused, ...rest } = apiEnv();
    expect(loadApiConfig({ ...rest, DB_PASSWORD_FILE: p }).db.password).toBe(SECRET);
  });

  it('parses booleans as true|false|1|0 only', () => {
    expect(loadApiConfig(apiEnv({ DB_ENCRYPT: '0', MCP_ENABLED: 'FALSE' })).db.encrypt).toBe(false);
    expect(loadApiConfig(apiEnv({ DB_ENCRYPT: '1' })).db.encrypt).toBe(true);
    expect(() => loadApiConfig(apiEnv({ DB_ENCRYPT: 'yes' }))).toThrow(ConfigError);
  });

  it('honors LOG_PRETTY only in development', () => {
    expect(loadApiConfig(apiEnv({ LOG_PRETTY: 'true' })).logPretty).toBe(true);
    expect(
      loadApiConfig(apiEnv({ LOG_PRETTY: 'true', NODE_ENV: 'test', DB_NAME: 'orc_test' }))
        .logPretty,
    ).toBe(false);
  });

  it('enforces production rules', () => {
    const prod = apiEnv({
      NODE_ENV: 'production',
      PUBLIC_ORIGIN: 'https://orc.example.com',
      REDIS_PASSWORD: 'redis-secret',
    });
    expect(loadApiConfig(prod).publicOrigin).toBe('https://orc.example.com');
    for (const [patch, key] of [
      [{ PUBLIC_ORIGIN: undefined }, 'PUBLIC_ORIGIN'],
      [{ REDIS_PASSWORD: undefined }, 'REDIS_PASSWORD'],
      [{ COOKIE_SECURE: 'false' }, 'COOKIE_SECURE'],
    ] as const) {
      const e = captureError(() => loadApiConfig({ ...prod, ...patch })) as ConfigError;
      expect(e).toBeInstanceOf(ConfigError);
      expect(e.message).toContain(key);
    }
    expect(loadApiConfig(apiEnv({ COOKIE_SECURE: 'false' })).cookieSecure).toBe(false);
  });

  it('validates cross-field rules', () => {
    expect(() => loadApiConfig(apiEnv({ CLAUDE_DEFAULT_MODEL: 'claude-z' }))).toThrow(
      /CLAUDE_DEFAULT_MODEL/,
    );
    expect(() => loadApiConfig(apiEnv({ PASSWORD_SCRYPT_N: '100000' }))).toThrow(
      /PASSWORD_SCRYPT_N/,
    );
    expect(() => loadApiConfig(apiEnv({ PASSWORD_SCRYPT_N: '8192' }))).toThrow(/PASSWORD_SCRYPT_N/);
    expect(loadApiConfig(apiEnv({ PASSWORD_SCRYPT_N: '16384' })).passwordScryptN).toBe(16_384);
    expect(() => loadApiConfig(apiEnv({ DB_POOL_MIN: '20', DB_POOL_MAX: '5' }))).toThrow(
      /DB_POOL_MIN/,
    );
    expect(() => loadApiConfig(apiEnv({ PUBLIC_ORIGIN: 'https://x.example/app' }))).toThrow(
      /PUBLIC_ORIGIN/,
    );
    expect(() => loadApiConfig(apiEnv({ PUBLIC_ORIGIN: 'ftp://x.example' }))).toThrow(
      /PUBLIC_ORIGIN/,
    );
    expect(() => loadApiConfig(apiEnv({ REDIS_PREFIX: 'Orc!' }))).toThrow(/REDIS_PREFIX/);
    expect(() => loadApiConfig(apiEnv({ DB_NAME: 'orc;drop' }))).toThrow(/DB_NAME/);
  });
});

describe('loadWorkerConfig', () => {
  it('applies worker defaults', () => {
    const cfg = loadWorkerConfig(workerEnv());
    expect(cfg.app).toBe('worker');
    expect(cfg.workerId).toBe('worker-1');
    expect(cfg.db.poolMax).toBe(5);
    expect(cfg.db.appName).toBe('orc-worker');
    expect(cfg.workerConcurrency).toBe(2);
    expect(cfg.claudeAuth).toEqual({ mode: 'oauth', oauthToken: OAUTH_TOKEN });
    expect(cfg.claudeBinPrefixArgs).toEqual([]);
    expect(cfg.httpsProxy).toBeNull();
    expect(cfg.noProxy).toBe('localhost,127.0.0.1');
    expect(cfg.shutdownTimeoutMs).toBe(30_000);
    expect(cfg.quotaCheckEveryNHeartbeats).toBe(6);
    expect(cfg.workspaceMaxBytes).toBe(2_147_483_648);
  });

  it('defaults WORKER_ID to the host name', () => {
    const { WORKER_ID: _unused, ...rest } = workerEnv();
    expect(loadWorkerConfig(rest).workerId.length).toBeGreaterThan(0);
  });

  it('reads CLAUDE_CODE_OAUTH_TOKEN from a file in oauth mode (the default)', () => {
    const p = secretFile(
      'oauth.txt',
      `${OAUTH_TOKEN}
`,
    );
    const { CLAUDE_CODE_OAUTH_TOKEN: _unused, ...rest } = workerEnv();
    const cfg = loadWorkerConfig({ ...rest, CLAUDE_CODE_OAUTH_TOKEN_FILE: p });
    expect(cfg.claudeAuth).toEqual({ mode: 'oauth', oauthToken: OAUTH_TOKEN });
    expect(() => loadWorkerConfig(rest)).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it('treats the token and the token file as one credential (both set => ConfigError)', () => {
    const p = secretFile('oauth-both.txt', OAUTH_TOKEN);
    expect(() => loadWorkerConfig(workerEnv({ CLAUDE_CODE_OAUTH_TOKEN_FILE: p }))).toThrow(
      /CLAUDE_CODE_OAUTH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN_FILE are both set/,
    );
  });
});

describe('loadWorkerConfig: Claude auth mode matrix (ADR-0036)', () => {
  const withoutCredential = (): Env => {
    const { CLAUDE_CODE_OAUTH_TOKEN: _t, ...rest } = workerEnv();
    return rest;
  };
  const apiKeyEnv = (extra: Env = {}): Env => ({
    ...withoutCredential(),
    CLAUDE_AUTH_MODE: 'api_key',
    ANTHROPIC_API_KEY: API_KEY,
    ...extra,
  });
  const messageOf = (env: Env): string => {
    try {
      loadWorkerConfig(env);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    return '';
  };

  it('defaults to oauth in every NODE_ENV and exposes the token', () => {
    expect(loadWorkerConfig(workerEnv()).claudeAuth.mode).toBe('oauth');
    const test = workerEnv({ NODE_ENV: 'test', DB_NAME: 'orc_test' });
    expect(loadWorkerConfig(test).claudeAuth).toEqual({ mode: 'oauth', oauthToken: OAUTH_TOKEN });
  });

  it('oauth: requires a token matching CLAUDE_OAUTH_TOKEN_REGEX', () => {
    expect(messageOf(withoutCredential())).toMatch(/CLAUDE_CODE_OAUTH_TOKEN: Required/);
    const bad = 'sk-ant-oat1-too-short';
    const msg = messageOf({ ...withoutCredential(), CLAUDE_CODE_OAUTH_TOKEN: bad });
    expect(msg).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(msg).not.toContain(bad);
    expect(CLAUDE_OAUTH_TOKEN_REGEX.test(OAUTH_TOKEN)).toBe(true);
    expect(CLAUDE_OAUTH_TOKEN_REGEX.test(API_KEY)).toBe(false);
    expect(
      CLAUDE_OAUTH_TOKEN_REGEX.test(`${OAUTH_TOKEN}
`),
    ).toBe(false);
    expect(CLAUDE_OAUTH_TOKEN_REGEX.test('sk-ant-oat01-' + 'a'.repeat(19))).toBe(false);
    expect(CLAUDE_OAUTH_TOKEN_REGEX.test('sk-ant-oat01-' + 'a'.repeat(500))).toBe(true);
    expect(CLAUDE_OAUTH_TOKEN_REGEX.test('sk-ant-oat01-' + 'a'.repeat(501))).toBe(false);
  });

  it('oauth: ANTHROPIC_API_KEY set => ConfigError naming only the key, never a value', () => {
    const msg = messageOf(workerEnv({ ANTHROPIC_API_KEY: API_KEY }));
    expect(msg).toMatch(/ANTHROPIC_API_KEY: Must not be set when CLAUDE_AUTH_MODE=oauth/);
    expect(msg).not.toContain(API_KEY);
    expect(msg).not.toContain(OAUTH_TOKEN);
    // An empty value counts as unset (§16).
    expect(loadWorkerConfig(workerEnv({ ANTHROPIC_API_KEY: '' })).claudeAuth.mode).toBe('oauth');
  });

  it('api_key: requires ANTHROPIC_API_KEY and exposes it', () => {
    expect(loadWorkerConfig(apiKeyEnv()).claudeAuth).toEqual({ mode: 'api_key', apiKey: API_KEY });
    const { ANTHROPIC_API_KEY: _k, ...rest } = apiKeyEnv();
    expect(() => loadWorkerConfig(rest)).toThrow(/ANTHROPIC_API_KEY: Required/);
    const p = secretFile(
      'apikey.txt',
      `${API_KEY}
`,
    );
    const fromFile = loadWorkerConfig({ ...rest, ANTHROPIC_API_KEY_FILE: p });
    expect(fromFile.claudeAuth).toEqual({ mode: 'api_key', apiKey: API_KEY });
  });

  it('api_key: rejects an OAuth token in ANTHROPIC_API_KEY and a set CLAUDE_CODE_OAUTH_TOKEN', () => {
    const asKey = messageOf(apiKeyEnv({ ANTHROPIC_API_KEY: OAUTH_TOKEN }));
    expect(asKey).toMatch(/ANTHROPIC_API_KEY: Holds an OAuth token/);
    expect(asKey).not.toContain(OAUTH_TOKEN);
    const both = messageOf(apiKeyEnv({ CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN }));
    expect(both).toMatch(/CLAUDE_CODE_OAUTH_TOKEN: Must not be set when CLAUDE_AUTH_MODE=api_key/);
    expect(both).not.toContain(OAUTH_TOKEN);
    expect(both).not.toContain(API_KEY);
  });

  it('rejects an unknown mode and the removed CLAUDE_BARE in every mode', () => {
    expect(() => loadWorkerConfig(workerEnv({ CLAUDE_AUTH_MODE: 'auto' }))).toThrow(
      /CLAUDE_AUTH_MODE/,
    );
    for (const bare of ['true', 'false', '1']) {
      expect(messageOf(workerEnv({ CLAUDE_BARE: bare }))).toMatch(
        /CLAUDE_BARE: Removed by ADR-0036/,
      );
      expect(messageOf(apiKeyEnv({ CLAUDE_BARE: bare }))).toMatch(
        /CLAUDE_BARE: Removed by ADR-0036/,
      );
    }
    expect(loadWorkerConfig(workerEnv({ CLAUDE_BARE: '' })).claudeAuth.mode).toBe('oauth');
  });

  it('does not leak the old flat keys into the config output', () => {
    const cfg: Record<string, unknown> = loadWorkerConfig(workerEnv());
    for (const key of ['claudeBare', 'anthropicApiKey', 'claudeCodeOauthToken', 'claudeAuthMode']) {
      expect(key in cfg).toBe(false);
    }
  });

  it('keeps MCP_REQUIRED (needs MCP_ENABLED) available for the per-task fail-closed rule (ADR-0037)', () => {
    expect(loadWorkerConfig(workerEnv()).mcpRequired).toBe(false);
    expect(loadWorkerConfig(workerEnv({ MCP_REQUIRED: 'true' })).mcpRequired).toBe(true);
    expect(() =>
      loadWorkerConfig(workerEnv({ MCP_REQUIRED: 'true', MCP_ENABLED: 'false' })),
    ).toThrow(/MCP_REQUIRED/);
  });
});

describe('loadWorkerConfig (continued)', () => {
  it('enforces absolute roots, JSON prefix args, prompt budget and production proxy', () => {
    expect(() => loadWorkerConfig(workerEnv({ WORKSPACES_ROOT: 'relative/dir' }))).toThrow(
      /WORKSPACES_ROOT/,
    );
    expect(
      loadWorkerConfig(workerEnv({ CLAUDE_BIN_PREFIX_ARGS: '["--x","y"]' })).claudeBinPrefixArgs,
    ).toEqual(['--x', 'y']);
    expect(() => loadWorkerConfig(workerEnv({ CLAUDE_BIN_PREFIX_ARGS: '--x' }))).toThrow(
      /CLAUDE_BIN_PREFIX_ARGS/,
    );
    expect(() => loadWorkerConfig(workerEnv({ CLAUDE_BIN_PREFIX_ARGS: '[1]' }))).toThrow(
      /CLAUDE_BIN_PREFIX_ARGS/,
    );
    expect(() => loadWorkerConfig(workerEnv({ PROMPT_MAX_BYTES: '100000' }))).toThrow(
      /PROMPT_MAX_BYTES/,
    );
    expect(() => loadWorkerConfig(workerEnv({ WORKER_CONCURRENCY: '17' }))).toThrow(
      /WORKER_CONCURRENCY/,
    );
    expect(() => loadWorkerConfig(workerEnv({ WORKER_ID: 'bad id' }))).toThrow(/WORKER_ID/);
    expect(() =>
      loadWorkerConfig(workerEnv({ MCP_ENABLED: 'false', MCP_REQUIRED: 'true' })),
    ).toThrow(/MCP_REQUIRED/);
    // Compose value (22 B): runner mode bounds the CBM_CACHE_DIR root to 26 B on POSIX (ADR-0035).
    const prod = workerEnv({
      NODE_ENV: 'production',
      REDIS_PASSWORD: 'r',
      CBM_CACHE_DIR: '/var/lib/orc/cbm-cache',
    });
    expect(() => loadWorkerConfig(prod)).toThrow(/HTTPS_PROXY/);
    expect(
      loadWorkerConfig({
        ...prod,
        HTTPS_PROXY: 'http://egress-proxy:3128',
        EGRESS_PROXY_TOKEN: 'A'.repeat(32),
      }).httpsProxy,
    ).toBe('http://egress-proxy:3128');
  });

  // The socket-path check is skipped on win32 (config.ts: process.platform !== 'win32').
  it.skipIf(process.platform === 'win32')(
    'rejects a 27 B CBM_CACHE_DIR root in runner mode (POSIX only; check skipped on win32)',
    () => {
      const env = workerEnv({
        NODE_ENV: 'production',
        REDIS_PASSWORD: 'r',
        HTTPS_PROXY: 'http://egress-proxy:3128',
        EGRESS_PROXY_TOKEN: 'A'.repeat(32),
      });
      expect(() =>
        loadWorkerConfig({ ...env, CBM_CACHE_DIR: '/var/lib/orc/cbm-cache12345' }),
      ).toThrow(/CBM_CACHE_DIR.*at most 26 bytes/);
    },
  );
});

describe('loadEgressProxyConfig and loadDbCliConfig', () => {
  it('parses egress lists', () => {
    const cfg = loadEgressProxyConfig({});
    expect(cfg.egressAllowedHosts).toEqual(['api.anthropic.com']);
    expect(cfg.egressAllowedPorts).toEqual([443]);
    expect(cfg.egressDenyPrivateIps).toBe(true);
    const custom = loadEgressProxyConfig({
      EGRESS_ALLOWED_HOSTS: 'API.anthropic.com, *.example.org',
      EGRESS_ALLOWED_PORTS: '443,8443',
    });
    expect(custom.egressAllowedHosts).toEqual(['api.anthropic.com', '*.example.org']);
    expect(custom.egressAllowedPorts).toEqual([443, 8443]);
    expect(() => loadEgressProxyConfig({ EGRESS_ALLOWED_HOSTS: 'http://x' })).toThrow(
      /EGRESS_ALLOWED_HOSTS/,
    );
    expect(() => loadEgressProxyConfig({ EGRESS_ALLOWED_PORTS: '70000' })).toThrow(
      /EGRESS_ALLOWED_PORTS/,
    );
  });

  it('reads db-cli secrets from files and does not require REDIS_PASSWORD in production', () => {
    const sa = secretFile('sa.txt', 'sa-pass\r\n');
    const cfg = loadDbCliConfig({
      NODE_ENV: 'production',
      DB_USER: 'orc_migrator',
      DB_PASSWORD: 'p',
      MSSQL_SA_PASSWORD_FILE: sa,
    });
    expect(cfg.mssqlSaPassword).toBe('sa-pass');
    expect(cfg.dbApiPassword).toBeNull();
    expect(cfg.backupDir).toBe('/var/opt/mssql/backups');
    expect(cfg.db.appName).toBe('orc-db-cli');
  });
});

describe('DB name guard', () => {
  it.each([
    ['test', 'orchestrator_test'],
    ['test', 'ORC_TEST'],
    ['production', 'orchestrator'],
    ['development', 'orchestrator_dev'],
    ['production', 'test_orchestrator'],
  ] as const)('allows %s with %s', (env, name) => {
    expect(() => assertDbNameForEnv(env, name)).not.toThrow();
  });

  it.each([
    ['test', 'orchestrator'],
    ['test', 'orchestrator_testing'],
    ['test', 'test'],
    ['production', 'orchestrator_test'],
    ['production', 'Orchestrator_TEST'],
    ['development', 'orchestrator_test'],
    ['production', ''],
  ] as const)('rejects %s with %j', (env, name) => {
    const e = captureError(() => assertDbNameForEnv(env, name));
    expect(e).toBeInstanceOf(DbNameGuardError);
    expect(isOrcError(e) && e.code).toBe('db_name_guard');
  });

  it('is applied by the app loaders', () => {
    expect(() => loadApiConfig(apiEnv({ NODE_ENV: 'test' }))).toThrow(DbNameGuardError);
    expect(
      loadApiConfig(apiEnv({ NODE_ENV: 'test', DB_NAME: 'orchestrator_test' })).db.database,
    ).toBe('orchestrator_test');
    expect(() =>
      loadApiConfig(
        apiEnv({
          NODE_ENV: 'production',
          DB_NAME: 'orchestrator_test',
          PUBLIC_ORIGIN: 'https://o.example',
          REDIS_PASSWORD: 'r',
        }),
      ),
    ).toThrow(DbNameGuardError);
    expect(() => loadWorkerConfig(workerEnv({ DB_NAME: 'orchestrator_test' }))).toThrow(
      DbNameGuardError,
    );
    expect(() => loadDbCliConfig({ NODE_ENV: 'test', DB_USER: 'u', DB_PASSWORD: 'p' })).toThrow(
      DbNameGuardError,
    );
  });
});

describe('SECRET_ENV_KEYS (ADR-0036)', () => {
  it('worker reads both Claude credentials through _FILE; no other app sees them', () => {
    expect(SECRET_ENV_KEYS.worker).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(SECRET_ENV_KEYS.worker).toContain('ANTHROPIC_API_KEY');
    for (const app of ['api', 'runner', 'egress-proxy', 'db-cli'] as const) {
      expect(SECRET_ENV_KEYS[app]).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    }
  });
});
