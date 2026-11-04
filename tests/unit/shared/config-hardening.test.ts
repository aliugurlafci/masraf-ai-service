// Contract v2.0.0 configuration rules (F6, F7, F15, F18, T-M6, T-M9, T-m10, F1).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CBM_SOCKET_PATH_MAX_BYTES,
  SANDBOX_UID_MIN,
  cbmSocketPathBytes,
  cbmSocketPathProblem,
  loadApiConfig,
  loadDbCliConfig,
  loadEgressProxyConfig,
  loadRunnerConfig,
  loadWorkerConfig,
  SQL_LOGIN_PASSWORD_REGEX,
  type Env,
} from '@orc/shared/node';

const SECRET = 'S3cr3t-value-never-logged';
const TOKEN = 'A'.repeat(32);
let dir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'orc-cfg2-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const abs = (name: string): string => resolve(dir, name);

const apiEnv = (extra: Env = {}): Env => ({
  NODE_ENV: 'development',
  DB_USER: 'orc_api',
  DB_PASSWORD: SECRET,
  CLAUDE_ALLOWED_MODELS: 'claude-a',
  CLAUDE_DEFAULT_MODEL: 'claude-a',
  ...extra,
});

const prodApiEnv = (extra: Env = {}): Env =>
  apiEnv({
    NODE_ENV: 'production',
    REDIS_PASSWORD: 'r',
    PUBLIC_ORIGIN: 'https://orc.example.com',
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

const prodWorkerEnv = (extra: Env = {}): Env =>
  workerEnv({
    NODE_ENV: 'production',
    REDIS_PASSWORD: 'r',
    HTTPS_PROXY: 'http://egress-proxy:3128',
    EGRESS_PROXY_TOKEN: TOKEN,
    ...extra,
  });

describe('API configuration (F6, T-M6, F18)', () => {
  it('requires an https PUBLIC_ORIGIN in production except for loopback hosts', () => {
    expect(() => loadApiConfig(prodApiEnv({ PUBLIC_ORIGIN: 'http://orc.example.com' }))).toThrow(
      /PUBLIC_ORIGIN: Must use https/,
    );
    expect(loadApiConfig(prodApiEnv()).publicOrigin).toBe('https://orc.example.com');
    for (const origin of ['http://localhost:8088', 'http://127.0.0.1:8088', 'http://[::1]:8088']) {
      expect(loadApiConfig(prodApiEnv({ PUBLIC_ORIGIN: origin })).publicOrigin).toBe(origin);
    }
    expect(loadApiConfig(apiEnv({ PUBLIC_ORIGIN: 'http://orc.example.com' })).publicOrigin).toBe(
      'http://orc.example.com',
    );
  });

  it('caps PASSWORD_SCRYPT_N at 2^17 and defaults PASSWORD_HASH_CONCURRENCY to 2', () => {
    expect(() => loadApiConfig(apiEnv({ PASSWORD_SCRYPT_N: '262144' }))).toThrow(
      /PASSWORD_SCRYPT_N/,
    );
    const cfg = loadApiConfig(apiEnv());
    expect(cfg.passwordScryptN).toBe(131_072);
    expect(cfg.passwordHashConcurrency).toBe(2);
    expect(() => loadApiConfig(apiEnv({ PASSWORD_HASH_CONCURRENCY: '0' }))).toThrow(
      /PASSWORD_HASH_CONCURRENCY/,
    );
  });

  it('forbids unverified or unencrypted DB connections in production only', () => {
    expect(() => loadApiConfig(prodApiEnv({ DB_TRUST_SERVER_CERTIFICATE: 'true' }))).toThrow(
      /DB_TRUST_SERVER_CERTIFICATE/,
    );
    expect(() => loadApiConfig(prodApiEnv({ DB_ENCRYPT: 'false' }))).toThrow(/DB_ENCRYPT/);
    expect(
      loadApiConfig(apiEnv({ DB_TRUST_SERVER_CERTIFICATE: 'true' })).db.trustServerCertificate,
    ).toBe(true);
  });

  it('reads DB_CA_CERT from DB_CA_CERT_FILE and rejects non-PEM content', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----';
    const file = join(dir, 'ca.crt');
    writeFileSync(file, `${pem}\n`);
    expect(loadApiConfig(prodApiEnv({ DB_CA_CERT_FILE: file })).db.caCert).toBe(pem);
    expect(() => loadApiConfig(apiEnv({ DB_CA_CERT: 'not a cert' }))).toThrow(/DB_CA_CERT/);
  });
});

describe('worker configuration (F7, T-m10, F1, F12, T-M9)', () => {
  it('derives self-fencing and keeps the DB retry window inside it', () => {
    const cfg = loadWorkerConfig(workerEnv());
    expect(cfg.dbWriteRetryWindowMs).toBe(30_000);
    expect(cfg.selfFenceAfterMs).toBe(40_000);
    expect(cfg.patchRetentionDays).toBe(90);
    expect(cfg.gitHooksDir).toBe('/opt/orc/git/empty-hooks');
    expect(cfg.runnerSocketPath).toBe('/run/orc-runner/runner.sock');
    expect(cfg.claudeInitExtraTools).toEqual([]);
    expect(() => loadWorkerConfig(workerEnv({ DB_WRITE_RETRY_WINDOW_MS: '40000' }))).toThrow(
      /DB_WRITE_RETRY_WINDOW_MS/,
    );
    expect(() => loadWorkerConfig(workerEnv({ ATTEMPT_STALE_MS: '25000' }))).toThrow(
      /ATTEMPT_STALE_MS/,
    );
  });

  it('requires SHUTDOWN_TIMEOUT_MS > CLAUDE_KILL_GRACE_MS + 10000', () => {
    expect(() => loadWorkerConfig(workerEnv({ SHUTDOWN_TIMEOUT_MS: '20000' }))).toThrow(
      /SHUTDOWN_TIMEOUT_MS/,
    );
    expect(loadWorkerConfig(workerEnv({ SHUTDOWN_TIMEOUT_MS: '20001' })).shutdownTimeoutMs).toBe(
      20_001,
    );
  });

  it('runs untrusted processes through the runner in production', () => {
    expect(loadWorkerConfig(workerEnv()).sandboxMode).toBe('local');
    expect(loadWorkerConfig(prodWorkerEnv()).sandboxMode).toBe('runner');
    expect(() => loadWorkerConfig(prodWorkerEnv({ SANDBOX_MODE: 'local' }))).toThrow(
      /SANDBOX_MODE/,
    );
    expect(() => loadWorkerConfig(prodWorkerEnv({ EGRESS_PROXY_TOKEN: undefined }))).toThrow(
      /EGRESS_PROXY_TOKEN/,
    );
    expect(() => loadWorkerConfig(prodWorkerEnv({ EGRESS_PROXY_TOKEN: 'short' }))).toThrow(
      /EGRESS_PROXY_TOKEN/,
    );
  });

  it('sizes the codebase-memory-mcp daemon socket below a scope cache (sun_path, measured layout)', () => {
    // <root>/w/<36>/cbm-daemon-<uid>/cbm-<16 hex>.sock; the production root is 22 bytes
    expect(cbmSocketPathBytes('/var/lib/orc/cbm-cache', 20_063)).toBe(104);
    expect(cbmSocketPathBytes('/var/lib/orc/cbm-cache/', 20_063)).toBe(104);
    expect(cbmSocketPathProblem('/var/lib/orc/cbm-cache', 20_063)).toBeNull();
    // measured: a 64-byte runtime dir (25-byte root) works with 5-digit uids, 65 bytes fail
    expect(cbmSocketPathProblem(`/${'a'.repeat(24)}`, 20_001)).toBeNull();
    expect(cbmSocketPathProblem(`/${'a'.repeat(25)}`, 20_001)).toMatch(
      /108 bytes with 5-digit sandbox uids, the AF_UNIX limit is 107; use at most 25 bytes/,
    );
    // ... 59 bytes for 10-digit uids
    expect(cbmSocketPathProblem(`/${'a'.repeat(19)}`, 2_000_000_001)).toBeNull();
    expect(cbmSocketPathProblem(`/${'a'.repeat(20)}`, 2_000_000_001)).toMatch(/at most 20 bytes/);
    expect(CBM_SOCKET_PATH_MAX_BYTES).toBe(107);
    expect(SANDBOX_UID_MIN).toBe(1000);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a CBM_CACHE_DIR whose daemon socket cannot fit in runner mode with MCP enabled',
    () => {
      expect(loadWorkerConfig(prodWorkerEnv({ CBM_CACHE_DIR: '/var/lib/orc/cbm-cache' })).cbmCacheDir).toBe(
        '/var/lib/orc/cbm-cache',
      );
      // 26 bytes fit the shortest (4-digit) sandbox uid; the worker re-checks the real range after `hello`
      expect(loadWorkerConfig(prodWorkerEnv({ CBM_CACHE_DIR: `/${'c'.repeat(25)}` })).sandboxMode).toBe('runner');
      const tooLong = `/${'c'.repeat(26)}`;
      expect(() => loadWorkerConfig(prodWorkerEnv({ CBM_CACHE_DIR: tooLong }))).toThrow(
        /CBM_CACHE_DIR: Too long for the codebase-memory-mcp daemon socket/,
      );
      expect(() => loadWorkerConfig(prodWorkerEnv({ CBM_CACHE_DIR: tooLong }))).not.toThrow(/c{26}/);
      expect(loadWorkerConfig(prodWorkerEnv({ CBM_CACHE_DIR: tooLong, MCP_ENABLED: 'false' })).mcpEnabled).toBe(
        false,
      );
      // local mode uses a short per-cache runtime dir below the OS temp dir instead
      expect(loadWorkerConfig(workerEnv({ CBM_CACHE_DIR: tooLong })).sandboxMode).toBe('local');
    },
  );

  it('accepts reviewed extra init tools but never dangerous or MCP names', () => {
    expect(
      loadWorkerConfig(workerEnv({ CLAUDE_INIT_EXTRA_TOOLS: 'ToolSearch' })).claudeInitExtraTools,
    ).toEqual(['ToolSearch']);
    for (const bad of ['Bash', 'WebFetch', 'mcp__other__x', 'bad name']) {
      expect(() => loadWorkerConfig(workerEnv({ CLAUDE_INIT_EXTRA_TOOLS: bad }))).toThrow(
        /CLAUDE_INIT_EXTRA_TOOLS/,
      );
    }
  });
});

describe('egress proxy, runner and DB CLI configuration', () => {
  it('requires EGRESS_AUTH_TOKEN in production', () => {
    expect(() => loadEgressProxyConfig({ NODE_ENV: 'production' })).toThrow(/EGRESS_AUTH_TOKEN/);
    expect(
      loadEgressProxyConfig({ NODE_ENV: 'production', EGRESS_AUTH_TOKEN: TOKEN }).egressAuthToken,
    ).toBe(TOKEN);
    expect(loadEgressProxyConfig({}).egressAuthToken).toBeNull();
  });

  it('loads the runner configuration and keeps the sandbox uid range away from the worker uid', () => {
    const env = {
      WORKSPACES_ROOT: abs('workspaces'),
      CLAUDE_HOME_ROOT: abs('claude-home'),
      CBM_CACHE_DIR: abs('cbm'),
    };
    const cfg = loadRunnerConfig(env);
    expect(cfg.app).toBe('runner');
    expect(cfg.runnerUidBase).toBe(20_000);
    expect(cfg.runnerMaxLeases).toBe(64);
    expect(cfg.workerUid).toBe(1000);
    expect(cfg.runnerLeaseTtlMs).toBe(40_000);
    expect(() => loadRunnerConfig({ ...env, RUNNER_UID_BASE: '1000' })).toThrow(/RUNNER_UID_BASE/);
    expect(() => loadRunnerConfig({ ...env, WORKSPACES_ROOT: 'relative' })).toThrow(
      /WORKSPACES_ROOT/,
    );
  });

  it('accepts only quote-free 16..128 character login passwords for bootstrap', () => {
    const base = { DB_USER: 'orc_migrator', DB_PASSWORD: SECRET };
    expect(loadDbCliConfig({ ...base, DB_API_PASSWORD: 'Abcdefgh-1234567' }).dbApiPassword).toBe(
      'Abcdefgh-1234567',
    );
    for (const bad of [
      "Abcdefgh'1234567",
      'Abcdefgh]1234567',
      'Abcdefgh 1234567',
      'Short-1',
      'x'.repeat(129),
    ]) {
      expect(() => loadDbCliConfig({ ...base, DB_WORKER_PASSWORD: bad })).toThrow(
        /DB_WORKER_PASSWORD/,
      );
    }
    expect(SQL_LOGIN_PASSWORD_REGEX.test('N0-Quotes_Or[Brackets]')).toBe(false);
  });
});
