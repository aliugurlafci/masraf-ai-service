// Shared setup of the opt-in claude-live suite (contract §18.1 claude-live row, §10, §15 F2): the REAL Claude Code
// CLI driven through @orc/claude-runner with the local launcher, inside a temp layout identical to the fake-claude
// integration tests. ADR-0036: the default auth mode is oauth (`CLAUDE_LIVE_AUTH_MODE=api_key` selects the API key);
// the argv is the hardened non-bare one in both modes. HOME/CLAUDE_CONFIG_DIR are the isolated per-workspace temp
// dirs (§10.3), so nothing of the developer's own Claude configuration (credentials, hooks, plugins, MCP servers)
// is visible to it. The credential is taken ONLY from the environment (`CLAUDE_CODE_OAUTH_TOKEN`, or the file at
// the absolute path `CLAUDE_CODE_OAUTH_TOKEN_FILE`; `ANTHROPIC_API_KEY` for api_key) and never printed or stored.
// Only ever imported by tests/claude-live/*.test.ts, which only run under `npm run test:claude-live`.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSecretRegistry } from '@orc/security';
import type { SecretRegistry } from '@orc/security';
import { CBM_MCP_SERVER_NAME, createClaudeRunner } from '@orc/claude-runner';
import type { ClaudeRunner, ClaudeRunRequest } from '@orc/claude-runner';
import type { ClaudeAuth, LaunchLease } from '@orc/shared/node';
import { aliveProcesses, createTempDir, waitFor } from '../helpers/common';
import type { TempDir } from '../helpers/common';
import { ATTEMPT_ID, WORKSPACE_ID, createRunnerLayout, fakeAuth, fakeRunnerConfig, makeRunRequest } from '../helpers/claude/fake-claude';
import type { RunnerLayout } from '../helpers/claude/fake-claude';
import { createTestLocalLauncher } from '../helpers/claude/local-launcher';
import type { TestLocalLauncher } from '../helpers/claude/local-launcher';
import { silentLogger } from '../helpers/claude/memory-process';
import { FAKE_CBM_PATH } from '../helpers/mcp/support';

/** Model of the tiny real runs (cheapest alias by default). */
export const LIVE_MODEL = process.env['CLAUDE_LIVE_MODEL'] ?? 'haiku';

export type LiveAuthMode = 'oauth' | 'api_key';

function resolveLiveAuthMode(raw: string | undefined): LiveAuthMode {
  if (raw === undefined || raw === '') return 'oauth';
  if (raw === 'oauth' || raw === 'api_key') return raw;
  throw new Error('CLAUDE_LIVE_AUTH_MODE must be oauth or api_key');
}

function readTokenFile(file: string | undefined): string | null {
  if (file === undefined || file === '') return null;
  if (!path.isAbsolute(file) || !existsSync(file)) throw new Error('CLAUDE_CODE_OAUTH_TOKEN_FILE must be an absolute path to an existing file');
  const text = readFileSync(file, 'utf8').trim();
  return text.length > 0 ? text : null;
}

/** Default oauth (ADR-0036). */
export const LIVE_AUTH_MODE: LiveAuthMode = resolveLiveAuthMode(process.env['CLAUDE_LIVE_AUTH_MODE']);
/** The real credential for the selected mode, or null when none is configured (model-calling tests then skip). */
export const LIVE_CREDENTIAL: string | null =
  LIVE_AUTH_MODE === 'oauth'
    ? ((process.env['CLAUDE_CODE_OAUTH_TOKEN'] ?? '') !== '' ? (process.env['CLAUDE_CODE_OAUTH_TOKEN'] ?? null) : readTokenFile(process.env['CLAUDE_CODE_OAUTH_TOKEN_FILE']))
    : ((process.env['ANTHROPIC_API_KEY'] ?? '') !== '' ? (process.env['ANTHROPIC_API_KEY'] ?? null) : null);
export const HAS_CREDENTIAL = LIVE_CREDENTIAL !== null;
/** Auth input of the runner: the real credential, else the dummy token (probe-only tests never reach the API). */
export const LIVE_AUTH: ClaudeAuth =
  LIVE_CREDENTIAL === null
    ? fakeAuth('oauth')
    : LIVE_AUTH_MODE === 'oauth'
      ? { mode: 'oauth', oauthToken: LIVE_CREDENTIAL }
      : { mode: 'api_key', apiKey: LIVE_CREDENTIAL };

/** Resolves the installed CLI: CLAUDE_LIVE_BIN, else CLAUDE_BIN, else `claude` on PATH (spawned without a shell). */
export function resolveClaudeBin(env: NodeJS.ProcessEnv = process.env): string {
  for (const key of ['CLAUDE_LIVE_BIN', 'CLAUDE_BIN']) {
    const v = env[key];
    if (v !== undefined && v.length > 0) {
      if (!path.isAbsolute(v) || !existsSync(v)) throw new Error(`${key} must be an absolute path to the Claude CLI: ${v}`);
      return v;
    }
  }
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  for (const dir of (env['PATH'] ?? env['Path'] ?? '').split(path.delimiter)) {
    if (dir.length === 0) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        if (candidate.endsWith('.cmd')) {
          throw new Error(`Claude CLI resolved to a .cmd shim (${candidate}); spawn without a shell needs the native binary: set CLAUDE_LIVE_BIN`);
        }
        return candidate;
      }
    }
  }
  throw new Error('Claude CLI not found on PATH; set CLAUDE_LIVE_BIN to its absolute path');
}

export interface LiveEnv {
  readonly dir: TempDir;
  readonly layout: RunnerLayout;
  readonly launcher: TestLocalLauncher;
  readonly lease: LaunchLease;
  readonly secrets: SecretRegistry;
  readonly runner: ClaudeRunner;
  readonly auth: ClaudeAuth;
  readonly bin: string;
  /** Request for this layout (session, tools and MCP as the orchestrator would build them). */
  request(o: {
    prompt: string;
    mcp?: boolean;
    deadlineMs?: number;
    maxBudgetUsd?: number | null;
    agentAllowedTools?: readonly string[];
  }): ClaudeRunRequest;
  /** Writes `.meta/mcp.json` with the single allow-listed server (fake-cbm, no network, no index needed). */
  writeMcpConfig(o?: { script?: string; env?: Record<string, string> }): Promise<void>;
  /** Releases the lease, asserts no spawned process survives and removes the temp dir. */
  close(): Promise<{ alive: number[] }>;
}

export async function createLiveEnv(): Promise<LiveEnv> {
  const bin = resolveClaudeBin();
  const dir = await createTempDir('orc-claude-live-');
  const layout = await createRunnerLayout(dir.path);
  const launcher = createTestLocalLauncher();
  const lease = await launcher.acquire({
    key: `attempt-${ATTEMPT_ID}`,
    attemptId: ATTEMPT_ID,
    workerId: 'worker-live-1',
    paths: [layout.worktree, layout.metaDir],
  });
  const secrets = createSecretRegistry();
  if (LIVE_CREDENTIAL !== null) secrets.add(LIVE_CREDENTIAL);
  const extraTools = (process.env['CLAUDE_INIT_EXTRA_TOOLS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const runner = createClaudeRunner(
    // Production reviewed-extension table (no injection): validateInit re-verifies it against the real CLI.
    fakeRunnerConfig(
      layout,
      {
        bin,
        binPrefixArgs: [],
        auth: LIVE_AUTH,
        initTimeoutMs: 120_000,
        killGraceMs: 5_000,
        workerId: 'worker-live-1',
        initExtraTools: extraTools,
      },
      { injectExtensions: false },
    ),
    { logger: silentLogger(), secrets, launcher },
  );
  const cacheDir = path.join(layout.cbmCacheRoot, 'w', WORKSPACE_ID);

  return {
    dir,
    layout,
    launcher,
    lease,
    secrets,
    runner,
    auth: LIVE_AUTH,
    bin,
    request(o) {
      const base = makeRunRequest(layout, {
        lease,
        prompt: o.prompt,
        mcp: o.mcp ?? false,
        deadlineMs: o.deadlineMs ?? 300_000,
        maxBudgetUsd: o.maxBudgetUsd ?? 0.5,
        agentAllowedTools: o.agentAllowedTools ?? ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
      });
      return { ...base, model: LIVE_MODEL };
    },
    async writeMcpConfig(o = {}) {
      await mkdir(cacheDir, { recursive: true });
      const config = {
        mcpServers: {
          [CBM_MCP_SERVER_NAME]: {
            type: 'stdio',
            command: process.execPath,
            args: [o.script ?? FAKE_CBM_PATH],
            // api_key mode: the platform scrubs the key for the MCP child with an empty value (ADR-0036 Decision 7).
            env: {
              CBM_ALLOWED_ROOT: layout.worktree,
              CBM_CACHE_DIR: cacheDir,
              ...(LIVE_AUTH_MODE === 'api_key' ? { ANTHROPIC_API_KEY: '' } : {}),
              ...(o.env ?? {}),
            },
          },
        },
      };
      await writeFile(layout.mcpConfigPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    },
    async close() {
      const pids = launcher.launches.map((l) => l.proc.pid);
      await lease.release();
      await launcher.close();
      await waitFor(() => aliveProcesses(pids).length === 0, { timeoutMs: 15_000, description: 'claude processes to exit' }).catch(
        () => undefined,
      );
      const alive = aliveProcesses(pids);
      await dir.cleanup();
      return { alive };
    },
  };
}
