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
]);

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
  return env;
}
