// Worker config mapping onto the Claude runner (ADR-0036 Decision 1) and the startup warnings of
// Decisions 7 and 9.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createClaudeRunner } from '@orc/claude-runner';
import { createSecretRegistry } from '@orc/security';
import { loadWorkerConfig, type Env } from '@orc/shared/node';
import {
  claudeRunnerConfig,
  claudeStartupWarnings,
  mcpManagerConfig,
  orchestratorConfig,
  PTRACE_SCOPE_PATH,
} from '../../../apps/worker/src/config';
import { createMemoryLauncher, silentLogger } from '../../helpers/claude/memory-process';

const dir = mkdtempSync(join(tmpdir(), 'orc-wk-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const OAUTH_TOKEN = `sk-ant-oat01-WORKERUNIT${'0'.repeat(30)}`;
const API_KEY = 'sk-ant-api03-WORKERUNIT000000000000000000000';
const env = (extra: Env = {}): Env => ({
  NODE_ENV: 'development',
  DB_USER: 'orc_worker',
  DB_PASSWORD: 'db-password-worker-unit',
  PROJECTS_ROOT: resolve(dir, 'projects'),
  WORKSPACES_ROOT: resolve(dir, 'workspaces'),
  CLAUDE_HOME_ROOT: resolve(dir, 'claude-home'),
  CBM_CACHE_DIR: resolve(dir, 'cbm'),
  WORKER_ID: 'worker-1',
  ...extra,
});
const oauthConfig = () => loadWorkerConfig(env({ CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN }));
const apiKeyConfig = () => loadWorkerConfig(env({ CLAUDE_AUTH_MODE: 'api_key', ANTHROPIC_API_KEY: API_KEY }));

describe('claudeRunnerConfig (ADR-0036)', () => {
  it.each([
    ['oauth', oauthConfig, { mode: 'oauth', oauthToken: OAUTH_TOKEN }],
    ['api_key', apiKeyConfig, { mode: 'api_key', apiKey: API_KEY }],
  ] as const)('maps claudeAuth (%s) and never a reviewed-extension override', (_mode, load, auth) => {
    const cfg = claudeRunnerConfig(load(), 'posix');
    expect(cfg.auth).toEqual(auth);
    expect(cfg).not.toHaveProperty('bare');
    expect(cfg).not.toHaveProperty('apiKey');
    expect(cfg).not.toHaveProperty('reviewedExtensions');
    // The runner accepts the mapped configuration.
    expect(() =>
      createClaudeRunner(cfg, {
        logger: silentLogger(),
        secrets: createSecretRegistry(),
        launcher: createMemoryLauncher(() => new Error('unused')),
      }),
    ).not.toThrow();
  });
});

describe('ADR-0037 / ADR-0036 Decision 7 mappings', () => {
  const platform = 'posix' as const;

  it('maps MCP_REQUIRED to PipelineConfig.mcpRequired', () => {
    expect(orchestratorConfig(oauthConfig(), platform, null).mcpRequired).toBe(false);
    const required = loadWorkerConfig(env({ CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN, MCP_REQUIRED: 'true' }));
    expect(orchestratorConfig(required, platform, null).mcpRequired).toBe(true);
  });

  it('scrubs ANTHROPIC_API_KEY from the MCP environment only in api_key mode', () => {
    expect(mcpManagerConfig(apiKeyConfig()).claudeEnvScrub).toEqual(['ANTHROPIC_API_KEY']);
    expect(mcpManagerConfig(oauthConfig()).claudeEnvScrub).toBeUndefined();
  });
});

describe('claudeStartupWarnings', () => {
  const read = (value: string) => () => Promise.resolve(value);
  const missing = () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

  it('oauth in runner mode, or local mode off Linux: no warning, ptrace_scope not read', async () => {
    let reads = 0;
    const counting = () => {
      reads += 1;
      return Promise.resolve('0');
    };
    const c = oauthConfig();
    expect(await claudeStartupWarnings({ ...c, sandboxMode: 'runner' }, { osPlatform: 'linux', readPtraceScope: counting })).toEqual([]);
    expect(await claudeStartupWarnings({ ...c, sandboxMode: 'local' }, { osPlatform: 'win32', readPtraceScope: counting })).toEqual([]);
    expect(await claudeStartupWarnings({ ...c, sandboxMode: 'local' }, { osPlatform: 'darwin', readPtraceScope: counting })).toEqual([]);
    expect(reads).toBe(0);
  });

  it('api_key mode warns once (not recommended), on every platform and sandbox mode', async () => {
    const c = apiKeyConfig();
    for (const sandboxMode of ['local', 'runner'] as const) {
      const w = await claudeStartupWarnings({ ...c, sandboxMode }, { osPlatform: 'win32', readPtraceScope: read('1') });
      expect(w.map((x) => x.event)).toEqual(['claude_api_key_mode']);
      expect(w[0]?.message).toContain('not recommended');
      expect(w[0]?.message).not.toContain(API_KEY);
    }
  });

  it.each([
    ['0\n', 0],
    ['garbage', null],
  ] as const)('local mode on Linux warns when ptrace_scope is %j', async (value, scope) => {
    const w = await claudeStartupWarnings(
      { ...oauthConfig(), sandboxMode: 'local' },
      { osPlatform: 'linux', readPtraceScope: read(value) },
    );
    expect(w).toEqual([expect.objectContaining({ event: 'ptrace_scope_unprotected', ptraceScope: scope })]);
  });

  it('local mode on Linux warns when ptrace_scope is missing and not when it is >= 1', async () => {
    const c = { ...oauthConfig(), sandboxMode: 'local' } as const;
    const gone = await claudeStartupWarnings(c, { osPlatform: 'linux', readPtraceScope: missing });
    expect(gone).toEqual([expect.objectContaining({ event: 'ptrace_scope_unprotected', ptraceScope: null })]);
    expect(gone[0]?.message).toContain('missing');
    for (const v of ['1\n', '2', '3']) {
      expect(await claudeStartupWarnings(c, { osPlatform: 'linux', readPtraceScope: read(v) })).toEqual([]);
    }
    expect(PTRACE_SCOPE_PATH).toBe('/proc/sys/kernel/yama/ptrace_scope');
  });

  it('api_key in local mode on Linux with ptrace_scope 0 gives both warnings', async () => {
    const w = await claudeStartupWarnings(
      { ...apiKeyConfig(), sandboxMode: 'local' },
      { osPlatform: 'linux', readPtraceScope: read('0') },
    );
    expect(w.map((x) => x.event)).toEqual(['claude_api_key_mode', 'ptrace_scope_unprotected']);
  });
});
