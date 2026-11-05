// Claude child environment (contract §10.3): built from scratch, nothing else is inherited.
import { posix, win32 } from 'node:path';
import { GUID_REGEX, OrcError } from '@orc/shared';
import type { Env, HostPlatform } from '@orc/shared/node';
import {
  assertNoClaudeCredential,
  assertSingleClaudeCredential,
  buildChildEnv,
  buildClaudeAppDataEnv,
  buildClaudeCredentialEnv,
  CLAUDE_ENV_ALLOWLIST,
  CLAUDE_FIXED_ENV,
  UnsafeArgumentError,
  WINDOWS_BASE_ENV,
} from '@orc/security';
import { CLAUDE_MARKER_ENV } from './constants';
import type { ClaudeRunnerConfig, ClaudeRunRequest } from './types';

/** Variables whose values come from the worker environment; every other key is set explicitly. */
const INHERITED_KEYS: readonly string[] = Object.freeze(['PATH', 'CLAUDE_CODE_GIT_BASH_PATH']);

function pathFor(platform: HostPlatform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

/** `http://orc:<token>@host:port` (credentials replaced, no trailing slash added). */
export function proxyUrlWithToken(url: string, token: string | null): string {
  if (token === null || token.length === 0) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OrcError('config_invalid', 'Invalid proxy URL', { details: { key: 'HTTPS_PROXY' } });
  }
  parsed.username = 'orc';
  parsed.password = token;
  const text = parsed.toString();
  return text.endsWith('/') && !url.endsWith('/') && parsed.pathname === '/'
    ? text.slice(0, -1)
    : text;
}

function allowedKeys(platform: HostPlatform): Set<string> {
  const keys = platform === 'win32' ? [...CLAUDE_ENV_ALLOWLIST, ...WINDOWS_BASE_ENV] : CLAUDE_ENV_ALLOWLIST;
  return new Set(keys.map((k) => (platform === 'win32' ? k.toUpperCase() : k)));
}

/** Defense in depth: every key of the final env must be allowlisted (§10.3). */
export function assertClaudeEnv(env: Record<string, string>, platform: HostPlatform): void {
  const allowed = allowedKeys(platform);
  for (const key of Object.keys(env)) {
    if (!allowed.has(platform === 'win32' ? key.toUpperCase() : key)) {
      throw new UnsafeArgumentError('Environment variable not allowed for Claude', {
        details: { reason: 'env_not_allowed', key },
      });
    }
  }
}

function workspaceDirs(
  cfg: ClaudeRunnerConfig,
  workspaceId: string,
): { home: string; config: string } {
  if (!GUID_REGEX.test(workspaceId)) {
    throw new UnsafeArgumentError('Invalid workspace id', { details: { reason: 'invalid_id' } });
  }
  const p = pathFor(cfg.platform);
  const base = p.resolve(cfg.claudeHomeRoot, 'w', workspaceId);
  return { home: p.join(base, 'home'), config: p.join(base, 'config') };
}

/** Env of a Claude spawn plus the credential that travels on fd 3 (`LaunchSpec.credentialFd`). */
export interface ClaudeLaunchEnv {
  env: Record<string, string>;
  /** oauth on POSIX: the token for fd 3 (never in env); otherwise null. */
  credentialFd: string | null;
}

/**
 * §10.3 values for an attempt run (ADR-0036 Decision 4): the credential per auth mode and platform
 * (oauth/posix: `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3` + token for fd 3; oauth/win32: token in env;
 * api_key: key in env), the fixed memory/CLAUDE.md switches, and on win32 the per-workspace AppData
 * (B-020). Never both credentials.
 */
export function buildClaudeLaunchEnv(
  cfg: ClaudeRunnerConfig,
  r: ClaudeRunRequest,
  source: Env,
): ClaudeLaunchEnv {
  if (!GUID_REGEX.test(r.attemptId)) {
    throw new UnsafeArgumentError('Invalid attempt id', { details: { reason: 'invalid_id' } });
  }
  const p = pathFor(cfg.platform);
  const dirs = workspaceDirs(cfg, r.workspaceId);
  const credential = buildClaudeCredentialEnv(cfg.auth, cfg.platform);
  const overrides: Record<string, string> = {
    HOME: dirs.home,
    CLAUDE_CONFIG_DIR: dirs.config,
    LANG: 'C.UTF-8',
    TMPDIR: r.tmpDir,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...CLAUDE_FIXED_ENV,
    CBM_CACHE_DIR: r.mcp?.cacheDir ?? p.resolve(cfg.cbmCacheRoot, 'w', r.workspaceId),
    CBM_ALLOWED_ROOT: r.cwd,
    [CLAUDE_MARKER_ENV]: r.attemptId,
    ...credential.env,
  };
  if (cfg.platform === 'win32') {
    overrides.USERPROFILE = dirs.home;
    overrides.TEMP = r.tmpDir;
    overrides.TMP = r.tmpDir;
    Object.assign(overrides, buildClaudeAppDataEnv('claude', dirs.home, cfg.platform));
  }
  if (cfg.proxy.https !== null && cfg.proxy.https.length > 0) {
    overrides.HTTPS_PROXY = proxyUrlWithToken(cfg.proxy.https, cfg.proxy.token);
  }
  if (cfg.proxy.http !== null && cfg.proxy.http.length > 0) overrides.HTTP_PROXY = cfg.proxy.http;
  if (cfg.proxy.noProxy !== null && cfg.proxy.noProxy.length > 0) {
    overrides.NO_PROXY = cfg.proxy.noProxy;
  }
  const env = buildChildEnv(INHERITED_KEYS, source, overrides, cfg.platform);
  assertClaudeEnv(env, cfg.platform);
  assertSingleClaudeCredential(env);
  return { env, credentialFd: credential.credentialFd };
}

/** §10.3 env of an attempt run (the fd 3 credential, if any, is returned by {@link buildClaudeLaunchEnv}). */
export function buildClaudeEnv(
  cfg: ClaudeRunnerConfig,
  r: ClaudeRunRequest,
  source: Env,
): Record<string, string> {
  return buildClaudeLaunchEnv(cfg, r, source).env;
}

/**
 * §10.9: allowlisted env without any credential variable, without fd 3 and without proxy credentials;
 * on win32 the AppData layout below the probe directory (B-020).
 */
export function buildProbeEnv(
  cfg: ClaudeRunnerConfig,
  probeDir: string,
  source: Env,
): Record<string, string> {
  const overrides: Record<string, string> = {
    HOME: probeDir,
    CLAUDE_CONFIG_DIR: probeDir,
    LANG: 'C.UTF-8',
    TMPDIR: probeDir,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...CLAUDE_FIXED_ENV,
  };
  if (cfg.platform === 'win32') {
    overrides.USERPROFILE = probeDir;
    overrides.TEMP = probeDir;
    overrides.TMP = probeDir;
    Object.assign(overrides, buildClaudeAppDataEnv('probe', probeDir, cfg.platform));
  }
  const env = buildChildEnv(INHERITED_KEYS, source, overrides, cfg.platform);
  assertClaudeEnv(env, cfg.platform);
  assertNoClaudeCredential(env);
  return env;
}
