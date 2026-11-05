import { win32 as win32Path } from 'node:path';
import { CLAUDE_AUTH_MODES, type ClaudeAuthMode } from '@orc/shared';
import { UnsafeArgumentError } from './errors.js';

/** Same shape as `Env` in `@orc/shared/node` (not imported: `@orc/security` may only depend on the main entry). */
type EnvSource = Readonly<Record<string, string | undefined>>;

/** §10.3 */
export const CLAUDE_ENV_ALLOWLIST: readonly string[] = Object.freeze([
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
  // ADR-0036 m.4
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
]);

/** ADR-0036 m.4: set on every Claude spawn (and the probe). */
export const CLAUDE_FIXED_ENV: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
});

/** ADR-0036 m.4: must never appear in any child env. */
export const CLAUDE_NEVER_ENV: readonly string[] = Object.freeze([
  'CLAUDE_CODE_SIMPLE',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
]);

/** The only fd number the CLI reads the OAuth token from (ADR-0036 m.4). */
export const CLAUDE_CREDENTIAL_FD = 3;

/**
 * Structurally identical to `ClaudeAuth` in `@orc/shared/node`. Not imported: `@orc/security` may
 * only depend on the `@orc/shared` main entry (dependency rules). The mode comes from `@orc/shared`.
 */
export type ClaudeAuthInput =
  | { readonly mode: Extract<ClaudeAuthMode, 'oauth'>; readonly oauthToken: string }
  | { readonly mode: Extract<ClaudeAuthMode, 'api_key'>; readonly apiKey: string };

export interface ClaudeCredentialEnv {
  /** Variables to merge into the Claude env overrides. */
  readonly env: Record<string, string>;
  /** Token to write to fd 3 (`LaunchSpec.credentialFd`); null when the credential travels in env. */
  readonly credentialFd: string | null;
}

const CREDENTIAL_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
] as const;

function rejectCredential(reason: string): never {
  throw new UnsafeArgumentError('Invalid Claude credential configuration', {
    details: { reason },
  });
}

function assertSecretValue(value: unknown, reason: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    rejectCredential(reason);
  }
}

/**
 * ADR-0036 m.4 credential transport. oauth/posix: `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3`, token
 * returned separately for fd 3 (never in env). oauth/win32: token in env. api_key: key in env.
 * Never returns both credentials; the error carries only a reason, never a value.
 */
export function buildClaudeCredentialEnv(
  auth: ClaudeAuthInput,
  platform: 'posix' | 'win32',
): ClaudeCredentialEnv {
  const input = auth as { mode?: unknown; oauthToken?: unknown; apiKey?: unknown };
  if (!(CLAUDE_AUTH_MODES as readonly unknown[]).includes(input.mode)) {
    rejectCredential('invalid_auth_mode');
  }
  if (input.mode === 'oauth') {
    if (input.apiKey !== undefined && input.apiKey !== '') rejectCredential('credential_conflict');
    assertSecretValue(input.oauthToken, 'invalid_oauth_token');
    if (platform === 'win32') {
      return { env: { CLAUDE_CODE_OAUTH_TOKEN: input.oauthToken }, credentialFd: null };
    }
    return {
      env: { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: String(CLAUDE_CREDENTIAL_FD) },
      credentialFd: input.oauthToken,
    };
  }
  if (input.mode === 'api_key') {
    if (input.oauthToken !== undefined && input.oauthToken !== '') {
      rejectCredential('credential_conflict');
    }
    assertSecretValue(input.apiKey, 'invalid_api_key');
    return { env: { ANTHROPIC_API_KEY: input.apiKey }, credentialFd: null };
  }
  return rejectCredential('invalid_auth_mode');
}

/**
 * B-020 / ADR-0036 m.4: isolated `APPDATA` and `LOCALAPPDATA` for Claude and probe spawns on win32.
 * Other kinds (test, mcp, git) get `{}` so their behaviour is unchanged (ADR 8.6). `home` is the
 * per-workspace HOME (claude) or the probe directory (probe).
 */
export function buildClaudeAppDataEnv(
  kind: 'claude' | 'probe' | 'test' | 'mcp' | 'git',
  home: string,
  platform: 'posix' | 'win32',
): Record<string, string> {
  if (platform !== 'win32' || (kind !== 'claude' && kind !== 'probe')) return {};
  if (typeof home !== 'string' || home.length === 0 || home.includes('\0')) {
    throw new UnsafeArgumentError('Invalid home for isolated AppData', {
      details: { reason: 'invalid_env_value', key: 'APPDATA' },
    });
  }
  return {
    APPDATA: win32Path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: win32Path.join(home, 'AppData', 'Local'),
  };
}

/** Defence in depth: the final env must never carry two credentials, nor the "never set" keys. */
export function assertSingleClaudeCredential(env: Readonly<Record<string, string>>): void {
  const upper = new Set(Object.keys(env).map((k) => k.toUpperCase()));
  for (const key of CLAUDE_NEVER_ENV) if (upper.has(key)) rejectCredential('env_forbidden');
  assertNoCredentialConflict(env);
}

function assertNoCredentialConflict(env: Readonly<Record<string, string>>): void {
  const upper = new Set(Object.keys(env).map((k) => k.toUpperCase()));
  let present = 0;
  if (upper.has('ANTHROPIC_API_KEY')) present += 1;
  if (
    upper.has('CLAUDE_CODE_OAUTH_TOKEN') ||
    upper.has('CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR')
  ) {
    present += 1;
  }
  if (
    upper.has('CLAUDE_CODE_OAUTH_TOKEN') &&
    upper.has('CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR')
  ) {
    present += 1;
  }
  if (present > 1) rejectCredential('credential_conflict');
}

/** Probe env must carry no credential variable and no fd 3 (ADR-0036 m.4). */
export function assertNoClaudeCredential(env: Readonly<Record<string, string>>): void {
  const upper = new Set(Object.keys(env).map((k) => k.toUpperCase()));
  for (const key of CREDENTIAL_ENV_KEYS) if (upper.has(key)) rejectCredential('probe_credential');
}

/** §11.3 */
export const GIT_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  'PATH',
  'HOME',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_GLOBAL',
  'GIT_TERMINAL_PROMPT',
  'GIT_OPTIONAL_LOCKS',
  'LC_ALL',
  'LANG',
]);

/** §13.5 */
export const TEST_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  'PATH',
  'HOME',
  'LANG',
  'TMPDIR',
  'CI',
  'FORCE_COLOR',
  'ORC_ATTEMPT_ID',
]);

/** Variables Windows processes need to start at all; added on win32 only. */
export const WINDOWS_BASE_ENV: readonly string[] = Object.freeze([
  'SystemRoot',
  'SystemDrive',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
]);

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Builds a child-process environment from scratch: copies only `allowlist` keys present in
 * `source` (plus {@link WINDOWS_BASE_ENV} on win32; key lookup is case-insensitive there, output
 * uses the allowlist spelling), then applies `overrides`. Keys absent from the allowlist are never
 * copied from `source`; values containing NUL are skipped (source) or rejected (overrides).
 */
export function buildChildEnv(
  allowlist: readonly string[],
  source: EnvSource,
  overrides: Record<string, string>,
  platform: 'posix' | 'win32',
): Record<string, string> {
  const win = platform === 'win32';
  const keys = win ? [...allowlist, ...WINDOWS_BASE_ENV] : [...allowlist];
  const env: Record<string, string> = {};
  const outputKeyByFold = new Map<string, string>();

  const sourceByFold = new Map<string, string>();
  if (win) {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'string' && !sourceByFold.has(key.toUpperCase()))
        sourceByFold.set(key.toUpperCase(), value);
    }
  }

  for (const key of keys) {
    if (!ENV_KEY.test(key)) continue;
    const fold = win ? key.toUpperCase() : key;
    if (outputKeyByFold.has(fold)) continue;
    const value = win
      ? sourceByFold.get(fold)
      : Object.hasOwn(source, key)
        ? source[key]
        : undefined;
    if (typeof value !== 'string' || value.includes('\0')) continue;
    env[key] = value;
    outputKeyByFold.set(fold, key);
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (!ENV_KEY.test(key)) {
      throw new UnsafeArgumentError('Invalid environment variable name in overrides', {
        details: { reason: 'invalid_env_key', key: key.slice(0, 64) },
      });
    }
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new UnsafeArgumentError('Invalid environment variable value in overrides', {
        details: { reason: 'invalid_env_value', key },
      });
    }
    const fold = win ? key.toUpperCase() : key;
    const existing = outputKeyByFold.get(fold);
    if (existing !== undefined && existing !== key) delete env[existing];
    env[key] = value;
    outputKeyByFold.set(fold, key);
  }
  assertNoCredentialConflict(env);
  return env;
}
