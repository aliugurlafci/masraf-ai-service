// Claude credential rules of the operator scripts (ADR-0036 item 2). Plain Node; values are never returned
// in messages. The OAuth regex is a verbatim copy of CLAUDE_OAUTH_TOKEN_REGEX in @orc/shared (a unit test
// asserts the equality).

export const CLAUDE_AUTH_MODES = ['oauth', 'api_key'];
export const CLAUDE_OAUTH_TOKEN_REGEX = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,500}$/;
export const ANTHROPIC_API_KEY_REGEX = /^[\x21-\x7e]{20,512}$/;
export const OAUTH_TOKEN_PREFIX = 'sk-ant-oat';

export function isOAuthToken(value) {
  return CLAUDE_OAUTH_TOKEN_REGEX.test(value);
}

export function isApiKey(value) {
  return ANTHROPIC_API_KEY_REGEX.test(value) && !value.startsWith(OAUTH_TOKEN_PREFIX);
}

/**
 * Checks the two credential file contents against the selected mode. Exactly one must be non-empty, it must
 * be the one of the mode and it must match that credential's format. Returns problem strings (no values).
 * `oauthToken` / `apiKey` are the file contents without the trailing newline ('' = not configured).
 */
export function evaluateCredentials({ mode, oauthToken, apiKey }) {
  const problems = [];
  if (!CLAUDE_AUTH_MODES.includes(mode)) {
    return [`CLAUDE_AUTH_MODE must be one of ${CLAUDE_AUTH_MODES.join(', ')}`];
  }
  const hasToken = oauthToken !== '';
  const hasKey = apiKey !== '';
  if (hasToken && hasKey) {
    problems.push(
      'claude_oauth_token and anthropic_api_key are both set; exactly one credential file may be non-empty (empty the unused one)',
    );
  }
  if (!hasToken && !hasKey) {
    problems.push(
      mode === 'oauth'
        ? 'claude_oauth_token is empty: run `claude setup-token` and install the token (see secrets/README.md)'
        : 'anthropic_api_key is empty (CLAUDE_AUTH_MODE=api_key)',
    );
  }
  if (mode === 'oauth') {
    if (hasKey && !hasToken) problems.push('CLAUDE_AUTH_MODE=oauth but only anthropic_api_key is set');
    if (hasToken && !isOAuthToken(oauthToken)) {
      problems.push('claude_oauth_token does not match CLAUDE_OAUTH_TOKEN_REGEX (sk-ant-oatNN-...)');
    }
  } else {
    if (hasToken && !hasKey) problems.push('CLAUDE_AUTH_MODE=api_key but only claude_oauth_token is set');
    if (hasKey && !ANTHROPIC_API_KEY_REGEX.test(apiKey)) {
      problems.push('anthropic_api_key does not match 20-512 printable characters');
    } else if (hasKey && apiKey.startsWith(OAUTH_TOKEN_PREFIX)) {
      problems.push('anthropic_api_key holds an OAuth token (sk-ant-oat...); use CLAUDE_AUTH_MODE=oauth');
    }
  }
  return problems;
}

/** uid of the worker container user (docker-compose.yml `user: '1000:1000'`). */
export const WORKER_UID = 1000;

/**
 * Permission warnings for a non-empty credential file (ADR-0036 item 2; Opus K10). Compose bind-mounts the
 * file with its host owner and mode, so the worker (uid 1000) needs to read it while no other local user
 * should: recommended is owner uid 1000 with mode 0400/0600 inside the 0700 secrets directory. Skipped on
 * win32 (POSIX modes are meaningless there) and for empty files (nothing to protect).
 * `stat` is {mode, uid, gid, size} of fs.statSync.
 */
export function credentialPermissionWarnings(name, stat, platform = process.platform) {
  if (platform === 'win32' || stat.size === 0) return [];
  const warnings = [];
  if ((stat.mode & 0o004) !== 0) {
    warnings.push(
      `secret ${name}: world-readable (mode ${(stat.mode & 0o777).toString(8).padStart(4, '0')}); any local user who can reach the file can read the Claude credential. Use chown ${WORKER_UID}:${WORKER_UID} and chmod 0400 or 0600 (keep the secrets directory 0700)`,
    );
  }
  // Can uid/gid 1000 read it? Owner bit 0400 for uid 1000, group bit 0040 for gid 1000, or the world bit
  // (already warned about above). Root-owned 0600 files are unreadable for the worker.
  const ownerCanRead = stat.uid === WORKER_UID && (stat.mode & 0o400) !== 0;
  const groupCanRead = stat.gid === WORKER_UID && (stat.mode & 0o040) !== 0;
  if (!ownerCanRead && !groupCanRead && (stat.mode & 0o004) === 0) {
    warnings.push(
      `secret ${name}: owned by ${stat.uid}:${stat.gid ?? '?'} (mode ${(stat.mode & 0o777).toString(8).padStart(4, '0')}); the worker (uid ${WORKER_UID}) will not be able to read it. Use chown ${WORKER_UID}:${WORKER_UID} and chmod 0400 or 0600`,
    );
  }
  return warnings;
}
