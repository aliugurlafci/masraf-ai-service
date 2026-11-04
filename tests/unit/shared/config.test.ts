import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isOrcError } from '@orc/shared';
import {
  ApiConfigSchema,
  ConfigError,
  DbNameGuardError,
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

const workerEnv = (extra: Env = {}): Env => ({
  NODE_ENV: 'development',
  DB_USER: 'orc_worker',
  DB_PASSWORD: SECRET,
  PROJECTS_ROOT: abs('projects'),
  WORKSPACES_ROOT: abs('workspaces'),
  CLAUDE_HOME_ROOT: abs('claude-home'),
  CBM_CACHE_DIR: abs('cbm'),
  ANTHROPIC_API_KEY: 'sk-ant-test-key-000000000000000000',
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
    expect(cfg.claudeBare).toBe(true);
    expect(cfg.anthropicApiKey).toBe('sk-ant-test-key-000000000000000000');
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

  it('reads ANTHROPIC_API_KEY from a file and requires it when CLAUDE_BARE=true', () => {
    const p = secretFile('anthropic.txt', 'sk-ant-from-file\n');
    const { ANTHROPIC_API_KEY: _unused, ...rest } = workerEnv();
    expect(loadWorkerConfig({ ...rest, ANTHROPIC_API_KEY_FILE: p }).anthropicApiKey).toBe(
      'sk-ant-from-file',
    );
    expect(() => loadWorkerConfig(rest)).toThrow(/ANTHROPIC_API_KEY/);
    expect(loadWorkerConfig({ ...rest, CLAUDE_BARE: 'false' }).anthropicApiKey).toBeNull();
  });

  it('allows CLAUDE_BARE=false only in development', () => {
    expect(() =>
      loadWorkerConfig(workerEnv({ NODE_ENV: 'test', DB_NAME: 'orc_test', CLAUDE_BARE: 'false' })),
    ).toThrow(/CLAUDE_BARE/);
  });

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
    const prod = workerEnv({ NODE_ENV: 'production', REDIS_PASSWORD: 'r' });
    expect(() => loadWorkerConfig(prod)).toThrow(/HTTPS_PROXY/);
    expect(
      loadWorkerConfig({
        ...prod,
        HTTPS_PROXY: 'http://egress-proxy:3128',
        EGRESS_PROXY_TOKEN: 'A'.repeat(32),
      }).httpsProxy,
    ).toBe('http://egress-proxy:3128');
  });
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
