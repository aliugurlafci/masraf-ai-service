// Request validation shared by the runner server and the local launcher (contract §10.11 items 3, 5, 6).
import { realpath as fsRealpath } from 'node:fs/promises';
import path from 'node:path';
import {
  assertSafeArgv,
  assertSingleClaudeCredential,
  CLAUDE_CREDENTIAL_FD,
  CLAUDE_ENV_ALLOWLIST,
  realpathWithin,
  TEST_ENV_ALLOWLIST,
} from '@orc/security';
import { isOrcError } from '@orc/shared';
import type { LaunchKind, LaunchLimits } from '@orc/shared/node';
import { runnerError } from './errors';
import {
  ENV_KEY_REGEX,
  LEASE_KEY_REGEX,
  MAX_CREDENTIAL_FD_BYTES,
  type CredentialFdFrame,
} from './protocol';

/** codebase-memory-mcp variables (contract §10.11 item 5). */
export const MCP_ENV_KEYS: readonly string[] = Object.freeze([
  'CBM_CACHE_DIR',
  'CBM_ALLOWED_ROOT',
  'CBM_LOG_LEVEL',
]);
/**
 * Accepted only for kind `mcp`: codebase-memory-mcp v0.12.0 coordinates through one daemon per
 * runtime dir and refuses to start while that daemon serves another `CBM_CACHE_DIR`, so every cache
 * gets its own runtime dir (runner mode: inside the lease, see `validateSpawnEnvPaths`).
 */
export const MCP_ONLY_ENV_KEYS: readonly string[] = Object.freeze(['CBM_RUNTIME_DIR']);
/**
 * Accepted only for kind `claude` (contract §10.11 item 5, ADR-0036 m.4): test and MCP processes
 * stay offline and never see a credential. Kept in sync with `CLAUDE_ENV_ALLOWLIST` of
 * `@orc/security` (every credential, proxy and `CLAUDE_CODE_DISABLE_*` key there is listed here;
 * enforced by `tests/unit/sandbox/validation.test.ts`).
 */
export const CLAUDE_ONLY_ENV_KEYS: readonly string[] = Object.freeze([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
]);
/** The env variable naming the credential fd; its only accepted value is `3` (ADR-0036 m.4). */
export const CREDENTIAL_FD_ENV_KEY = 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR';

const CLAUDE_ONLY = new Set(CLAUDE_ONLY_ENV_KEYS);
/** Environment values that name a directory the child writes to (kind `mcp`). */
const PATH_VALUED_ENV_KEYS: readonly string[] = MCP_ONLY_ENV_KEYS;
const ALL_KEYS: readonly string[] = Object.freeze([
  ...new Set([...CLAUDE_ENV_ALLOWLIST, ...TEST_ENV_ALLOWLIST, ...MCP_ENV_KEYS]),
]);

/** Environment keys a child of `kind` may receive (`extra` = host additions, e.g. win32 base env). */
export function allowedEnvKeys(kind: LaunchKind, extra: readonly string[] = []): Set<string> {
  const keys = new Set<string>();
  for (const k of ALL_KEYS) if (kind === 'claude' || !CLAUDE_ONLY.has(k)) keys.add(k);
  if (kind === 'mcp') for (const k of MCP_ONLY_ENV_KEYS) keys.add(k);
  for (const k of extra) keys.add(k);
  return keys;
}

/** Throws `unsafe_argument` (reason `env_rejected`) naming the first offending key; values are never echoed. */
export function validateSpawnEnv(
  kind: LaunchKind,
  env: Readonly<Record<string, string>>,
  extra: readonly string[] = [],
): void {
  const allowed = allowedEnvKeys(kind, extra);
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY_REGEX.test(key)) {
      throw runnerError('unsafe_argument', 'env_rejected', 'Invalid environment variable name');
    }
    if (!allowed.has(key)) {
      throw runnerError(
        'unsafe_argument',
        'env_rejected',
        `Environment variable ${key} is not allowed for kind ${kind}`,
      );
    }
    if (typeof value !== 'string' || value.includes('\0')) {
      throw runnerError('unsafe_argument', 'env_rejected', `Invalid value for ${key}`);
    }
    if (PATH_VALUED_ENV_KEYS.includes(key) && !path.isAbsolute(value)) {
      throw runnerError('unsafe_argument', 'env_rejected', `${key} must be an absolute path`);
    }
  }
  assertOneCredential(env);
}

/**
 * ADR-0036 m.1/m.4: an env never carries `ANTHROPIC_API_KEY` together with any
 * `CLAUDE_CODE_OAUTH_TOKEN*` (nor both OAuth variables), nor a "never set" key. Only the rule is
 * named; the security error (and with it any detail) is not attached as the cause.
 */
function assertOneCredential(env: Readonly<Record<string, string>>): void {
  try {
    assertSingleClaudeCredential(env);
  } catch (e) {
    const reason = isOrcError(e) ? e.details?.reason : undefined;
    throw runnerError(
      'unsafe_argument',
      'env_rejected',
      reason === 'env_forbidden'
        ? 'Environment carries a forbidden Claude variable'
        : 'Environment carries more than one Claude credential',
    );
  }
}

/**
 * Credential delivered on fd 3 (contract §10.11 item 5, ADR-0036 m.4); runner and local launcher.
 * Throws `unsafe_argument` (reason `env_rejected`); the value and its length are never echoed.
 * - `credentialFd` only for kind `claude` and only when the env names fd 3
 *   (`CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3`); 1..4096 bytes, no NUL;
 * - conversely the fd variable is never accepted without a `credentialFd`, so a child never reads
 *   whatever else might be open as fd 3.
 */
export function validateSpawnCredential(
  kind: LaunchKind,
  env: Readonly<Record<string, string>>,
  credentialFd: string | undefined,
): void {
  const named = Object.hasOwn(env, CREDENTIAL_FD_ENV_KEY);
  if (credentialFd === undefined) {
    if (named) {
      throw runnerError(
        'unsafe_argument',
        'env_rejected',
        `${CREDENTIAL_FD_ENV_KEY} requires a credentialFd`,
      );
    }
    return;
  }
  if (kind !== 'claude') {
    throw runnerError(
      'unsafe_argument',
      'env_rejected',
      `credentialFd is not allowed for kind ${kind}`,
    );
  }
  if (!named || env[CREDENTIAL_FD_ENV_KEY] !== String(CLAUDE_CREDENTIAL_FD)) {
    throw runnerError(
      'unsafe_argument',
      'env_rejected',
      `credentialFd requires ${CREDENTIAL_FD_ENV_KEY}=${CLAUDE_CREDENTIAL_FD}`,
    );
  }
  if (
    typeof credentialFd !== 'string' ||
    credentialFd.length === 0 ||
    credentialFd.includes('\0') ||
    Buffer.byteLength(credentialFd, 'utf8') > MAX_CREDENTIAL_FD_BYTES
  ) {
    throw runnerError('unsafe_argument', 'env_rejected', 'Invalid credentialFd');
  }
}

/** Client side: `credentialFd {b64}` of the `spawn` frame. */
export function encodeCredentialFd(value: string): CredentialFdFrame {
  return { b64: Buffer.from(value, 'utf8').toString('base64') };
}

/** Runner side: the decoded credential; bytes that are not valid UTF-8 are rejected (`env_rejected`). */
export function decodeCredentialFd(frame: CredentialFdFrame): string {
  const bytes = Buffer.from(frame.b64, 'base64');
  const value = bytes.toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(bytes)) {
    bytes.fill(0);
    throw runnerError('unsafe_argument', 'env_rejected', 'Invalid credentialFd');
  }
  bytes.fill(0);
  return value;
}

/**
 * Runner side: every path-valued variable (`CBM_RUNTIME_DIR`) must resolve inside a leased path, so
 * a sandbox child never coordinates through a directory of another lease or of the runner.
 */
export async function validateSpawnEnvPaths(
  env: Readonly<Record<string, string>>,
  leasePaths: readonly string[],
  realpath: (p: string) => Promise<string> = (p) => fsRealpath(p),
): Promise<void> {
  for (const key of PATH_VALUED_ENV_KEYS) {
    const value = env[key];
    if (value === undefined) continue;
    try {
      await resolveInLease(value, leasePaths, realpath, 'path_rejected');
    } catch (e) {
      throw runnerError(
        'path_escape',
        'env_rejected',
        `${key} must be an existing directory inside a leased path`,
        e,
      );
    }
  }
}

/** Non-empty argv with a non-empty executable, then `assertSafeArgv` (POSIX budget). */
export function validateSpawnArgv(argv: readonly string[]): void {
  if (argv.length < 1 || typeof argv[0] !== 'string' || argv[0].length === 0) {
    throw runnerError('unsafe_argument', 'argv_rejected', 'argv must name an executable');
  }
  try {
    assertSafeArgv(argv, { platform: 'posix' });
  } catch (e) {
    const message = isOrcError(e) ? e.message : 'Unsafe argv';
    throw runnerError('unsafe_argument', 'argv_rejected', message, e);
  }
}

export function validateLeaseKey(key: string): void {
  if (!LEASE_KEY_REGEX.test(key)) {
    throw runnerError(
      'validation_failed',
      'path_rejected',
      'Lease key must be attempt-<uuid>, op-<uuid>, op-probe-<workerId> or op-mcp-probe-<workerId>',
    );
  }
}

/** Same filesystem root (`/`; win32: drive, UNC `\\server\share\`, `\\?\` or `\\.\` namespace; case-insensitive). */
function sameRoot(a: string, b: string): boolean {
  const ra = path.parse(a).root;
  const rb = path.parse(b).root;
  return path.sep === '\\' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/** True when `child` equals `parent` or lies below it (separator boundary; case-insensitive on win32). */
export function isPathInside(parent: string, child: string): boolean {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  // win32 `path.relative` drops leading separators before comparing, so the UNC path `\\C:\x\y`
  // (server `C:`) would count as inside `C:\x`. Paths on different roots never nest.
  if (!sameRoot(p, c)) return false;
  const rel = path.relative(p, c);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

export function pathsOverlap(a: string, b: string): boolean {
  return isPathInside(a, b) || isPathInside(b, a);
}

function relSegments(root: string, target: string): string[] {
  return path
    .relative(root, target)
    .split(path.sep)
    .filter((s) => s.length > 0);
}

/** One-level lease path: the probe homes `<CLAUDE_HOME_ROOT>/probe` and `<CBM_CACHE_DIR>/probe` (§10.9, §11.1). */
export const PROBE_DIR_NAME = 'probe';

/**
 * Structural rule for leasable paths: at least two levels below a root (`<projectId>/_base`,
 * `w/<workspaceId>`, ...) or exactly the dedicated probe dir `<root>/probe`, and never inside a dot
 * directory of the root (`.repos`, `.orc`), so the traverse-only structure dirs and the worker's
 * private state can never be handed to a sandbox uid.
 */
function assertLeasableShape(root: string, target: string, probeAllowed: boolean): void {
  const segs = relSegments(root, target);
  if (probeAllowed && segs.length === 1 && segs[0] === PROBE_DIR_NAME) return;
  if (segs.length < 2) {
    throw runnerError(
      'path_escape',
      'path_rejected',
      'Lease path must lie at least two levels below its root',
    );
  }
  if (segs[0]?.startsWith('.')) {
    throw runnerError(
      'path_escape',
      'path_rejected',
      'Lease path must not be inside a dot directory',
    );
  }
}

export interface ResolveLeasePathsDeps {
  realpathWithin?: (root: string, ...segments: string[]) => Promise<string>;
  realpath?: (p: string) => Promise<string>;
  /**
   * Roots whose one-level `probe` dir may be leased (CLAUDE_HOME_ROOT, CBM_CACHE_DIR); default: every root.
   * The runner passes only those two, so `<WORKSPACES_ROOT>/probe` is never handed to a sandbox uid.
   */
  probeRoots?: readonly string[];
}

/**
 * Validates and canonicalizes lease paths: absolute, inside one of `roots` (most specific root
 * wins), `realpathWithin` (rejects symlink escapes and missing paths), structural rule, no overlap
 * between the request's own paths. Returns the real paths in request order.
 */
export async function resolveLeasePaths(
  paths: readonly string[],
  roots: readonly string[],
  deps: ResolveLeasePathsDeps = {},
): Promise<string[]> {
  const within = deps.realpathWithin ?? realpathWithin;
  const real = deps.realpath ?? ((p: string) => fsRealpath(p));
  const sortedRoots = [...roots].map((r) => path.resolve(r)).sort((a, b) => b.length - a.length);
  const probeRoots = (deps.probeRoots ?? roots).map((r) => path.resolve(r));
  const out: string[] = [];
  for (const p of paths) {
    if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) {
      throw runnerError('path_escape', 'path_rejected', 'Lease path must be absolute');
    }
    const lexical = path.resolve(p);
    const root = sortedRoots.find((r) => isPathInside(r, lexical));
    if (root === undefined) {
      throw runnerError('path_escape', 'path_rejected', 'Lease path is outside the runner roots');
    }
    const probeAllowed = probeRoots.some((r) => isPathInside(r, root) && isPathInside(root, r));
    assertLeasableShape(root, lexical, probeAllowed);
    let resolved: string;
    let realRoot: string;
    try {
      resolved = await within(root, ...relSegments(root, lexical));
      realRoot = await real(root);
    } catch (e) {
      const code =
        e instanceof Error && 'code' in e ? (e as NodeJS.ErrnoException).code : undefined;
      const message =
        code === 'ENOENT' || code === 'ENOTDIR'
          ? 'Lease path does not exist'
          : 'Lease path escapes its root';
      throw runnerError('path_escape', 'path_rejected', message, e);
    }
    assertLeasableShape(realRoot, resolved, probeAllowed);
    out.push(resolved);
  }
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      if (pathsOverlap(out[i] as string, out[j] as string)) {
        throw runnerError(
          'path_escape',
          'path_rejected',
          'Lease paths must not overlap each other',
        );
      }
    }
  }
  return out;
}

/**
 * `target` must resolve (realpath) inside one of the lease's paths; returns the real path.
 * Used for spawn `cwd` (reason `cwd_rejected`) and `lease_measure` paths (reason `path_rejected`).
 */
export async function resolveInLease(
  target: string,
  leasePaths: readonly string[],
  realpath: (p: string) => Promise<string> = (p) => fsRealpath(p),
  reason: 'cwd_rejected' | 'path_rejected' = 'cwd_rejected',
): Promise<string> {
  const label = reason === 'cwd_rejected' ? 'cwd' : 'Path';
  if (typeof target !== 'string' || !path.isAbsolute(target) || target.includes('\0')) {
    throw runnerError('path_escape', reason, `${label} must be absolute`);
  }
  let real: string;
  try {
    real = await realpath(target);
  } catch (e) {
    throw runnerError('path_escape', reason, `${label} does not exist`, e);
  }
  if (!leasePaths.some((lp) => isPathInside(lp, real))) {
    throw runnerError('path_escape', reason, `${label} is not inside a leased path`);
  }
  return real;
}

export interface EffectiveLimits {
  nproc: number;
  nofile: number;
  fsizeBytes: number;
}

/** Requested limits may only lower the runner ceilings (RUNNER_NPROC / NOFILE / FSIZE_BYTES). */
export function effectiveLimits(
  requested: LaunchLimits | undefined,
  ceilings: EffectiveLimits,
): EffectiveLimits {
  const pick = (r: number | undefined, c: number): number =>
    r !== undefined && Number.isInteger(r) && r > 0 ? Math.min(r, c) : c;
  return {
    nproc: pick(requested?.nproc, ceilings.nproc),
    nofile: pick(requested?.nofile, ceilings.nofile),
    fsizeBytes: pick(requested?.fsizeBytes, ceilings.fsizeBytes),
  };
}

/** `prlimit --nproc=N --nofile=N --fsize=N --core=0 -- <argv>` (contract §10.11 item 6). */
export function buildPrlimitCommand(
  prlimitPath: string,
  limits: EffectiveLimits,
  argv: readonly string[],
): { cmd: string; args: string[] } {
  return {
    cmd: prlimitPath,
    args: [
      `--nproc=${limits.nproc}`,
      `--nofile=${limits.nofile}`,
      `--fsize=${limits.fsizeBytes}`,
      '--core=0',
      '--',
      ...argv,
    ],
  };
}
