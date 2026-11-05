// Zod-validated configuration (contract §2.2, §16). Node-only.
// Output shape: `db` / `redis` nested (DatabaseConfig / RedisConfig compatible), every other key is the
// camelCase of its env name (e.g. SSE_MAX_PER_USER -> sseMaxPerUser); unset optional values are `null`.
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  CLAUDE_AUTH_MODES,
  NODE_ENVS,
  TASK_TEXT_MAX_BYTES,
  type ClaudeAuthMode,
  type NodeEnv,
} from '../constants';
import { OrcError, type OrcErrorOptions } from '../errors';

export type Env = Readonly<Record<string, string | undefined>>;
export type AppName = 'api' | 'worker' | 'egress-proxy' | 'db-cli' | 'runner' | 'test';

/** 'config_invalid'; the message lists keys and issues, never values. */
export class ConfigError extends OrcError {
  constructor(message: string, options?: OrcErrorOptions) {
    super('config_invalid', message, options);
  }
}

/** 'db_name_guard' */
export class DbNameGuardError extends OrcError {
  constructor(message: string, options?: OrcErrorOptions) {
    super('db_name_guard', message, options);
  }
}

function errnoCode(e: unknown): string {
  return e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : 'unknown error';
}

const isSet = (v: string | undefined): v is string => v !== undefined && v !== '';

function stripOneTrailingNewline(s: string): string {
  if (s.endsWith('\r\n')) return s.slice(0, -2);
  if (s.endsWith('\n')) return s.slice(0, -1);
  return s;
}

/**
 * For each key K in secretKeys: if K_FILE is set the value is the file content with ONE trailing
 * \n or \r\n removed. K and K_FILE both set -> ConfigError. File unreadable -> ConfigError.
 * Empty strings count as unset. K_FILE entries of secret keys are not copied to the result.
 */
export function readEnvWithFiles(
  env: Env,
  secretKeys: readonly string[],
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  const problems: { key: string; message: string }[] = [];
  for (const key of secretKeys) {
    const fileKey = `${key}_FILE`;
    const filePath = env[fileKey];
    delete out[fileKey];
    if (!isSet(filePath)) continue;
    if (isSet(env[key])) {
      problems.push({ key, message: `${key} and ${fileKey} are both set` });
      continue;
    }
    try {
      out[key] = stripOneTrailingNewline(readFile(filePath));
    } catch (e) {
      problems.push({ key: fileKey, message: `${fileKey} could not be read (${errnoCode(e)})` });
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration: ${problems.map((p) => p.message).join('; ')}`, {
      details: { issues: problems },
    });
  }
  return out;
}

/** Reads secrets (`_FILE`), treats empty strings as unset, validates with `schema`. */
export function loadConfig<S extends z.ZodType>(
  schema: S,
  opts: { app: AppName; env?: Env; secretKeys: readonly string[] },
): z.output<S> {
  const merged = readEnvWithFiles(opts.env ?? process.env, opts.secretKeys);
  const normalized: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(merged)) normalized[k] = v === '' ? undefined : v;
  const result = schema.safeParse(normalized);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      key: i.path.length > 0 ? i.path.map((p) => String(p)).join('.') : '(root)',
      code: i.code,
      message: i.message,
    }));
    throw new ConfigError(
      `Invalid ${opts.app} configuration: ${issues.map((i) => `${i.key}: ${i.message}`).join('; ')}`,
      { details: { app: opts.app, issues } },
    );
  }
  return result.data;
}

/** test => name MUST end with "_test"; production|development => name MUST NOT end with "_test" (case-insensitive). */
export function assertDbNameForEnv(nodeEnv: NodeEnv, dbName: string): void {
  if (!(NODE_ENVS as readonly string[]).includes(nodeEnv)) {
    throw new DbNameGuardError(`Unknown NODE_ENV "${String(nodeEnv)}"`);
  }
  const name = dbName.trim().toLowerCase();
  if (name.length === 0) throw new DbNameGuardError('Database name is empty');
  const isTestDb = name.endsWith('_test');
  if (nodeEnv === 'test' && !isTestDb) {
    throw new DbNameGuardError(
      `NODE_ENV=test requires a database name ending in "_test" (got "${dbName}")`,
    );
  }
  if (nodeEnv !== 'test' && isTestDb) {
    throw new DbNameGuardError(
      `NODE_ENV=${nodeEnv} must not use a test database (got "${dbName}")`,
    );
  }
}

/** Keys that accept `<KEY>_FILE`. DB_CA_CERT is not secret but is mounted as a file the same way. */
export const SECRET_ENV_KEYS: Readonly<Record<AppName, readonly string[]>> = Object.freeze({
  api: Object.freeze(['DB_PASSWORD', 'REDIS_PASSWORD', 'DB_CA_CERT']),
  worker: Object.freeze([
    'DB_PASSWORD',
    'REDIS_PASSWORD',
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'EGRESS_PROXY_TOKEN',
    'DB_CA_CERT',
  ]),
  'egress-proxy': Object.freeze(['EGRESS_AUTH_TOKEN']),
  runner: Object.freeze([]),
  'db-cli': Object.freeze([
    'DB_PASSWORD',
    'DB_CA_CERT',
    'REDIS_PASSWORD',
    'MSSQL_SA_PASSWORD',
    'DB_MIGRATOR_PASSWORD',
    'DB_API_PASSWORD',
    'DB_WORKER_PASSWORD',
    'DB_BACKUP_PASSWORD',
    'ORC_ADMIN_PASSWORD',
  ]),
  test: Object.freeze(['DB_PASSWORD', 'REDIS_PASSWORD', 'MSSQL_SA_PASSWORD']),
});

// ---- env field builders ------------------------------------------------------------

const text = () => z.string().trim().min(1);
const textD = (d: string) => text().default(d);
const int = (d: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .trim()
    .regex(/^-?\d+$/, 'Expected an integer')
    .transform(Number)
    .pipe(z.int().min(min).max(max))
    .default(d);
const bool = (d: boolean) =>
  z.stringbool({ truthy: ['true', '1'], falsy: ['false', '0'] }).default(d);
const port = (d: number) => int(d, 1, 65_535);
const list = () =>
  z.string().transform((s) =>
    s
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
  );
const jsonStringArray = () =>
  z
    .string()
    .transform((s, ctx): unknown => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Expected a JSON array of strings' });
        return z.NEVER;
      }
    })
    .pipe(z.array(z.string()).max(64))
    .default([]);
const absPath = () => text().refine((p) => isAbsolute(p), 'Expected an absolute path');
const httpUrl = () =>
  z
    .string()
    .trim()
    .pipe(z.url({ protocol: /^https?$/ }));
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** Proxy credential / token charset (used inside a proxy URL: no encoding needed). */
const proxyToken = () =>
  z.string().regex(/^[A-Za-z0-9_-]{24,256}$/, 'Expected 24..256 base64url characters');

/**
 * Passwords embedded in `CREATE/ALTER LOGIN` by `orc-db bootstrap` (§4.2): no quote, bracket,
 * backslash, `$` or whitespace characters, 16..128 chars (QUOTENAME/escaping limits).
 */
export const SQL_LOGIN_PASSWORD_REGEX = /^[A-Za-z0-9!#%*+,./:;=?@^_~-]{16,128}$/;
const sqlLoginPassword = () =>
  z
    .string()
    .regex(SQL_LOGIN_PASSWORD_REGEX, 'Expected 16..128 chars of A-Z a-z 0-9 !#%*+,./:;=?@^_~-')
    .optional();

/** Tool names that may never be whitelisted as extra init tools (§10.6). */
const FORBIDDEN_EXTRA_INIT_TOOLS: ReadonlySet<string> = new Set([
  'Bash',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'NotebookEdit',
]);

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

const HOST_PATTERN =
  /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

// ---- shapes -----------------------------------------------------------------------------

const baseShape = {
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  LOG_PRETTY: bool(false),
  APP_VERSION: textD('0.0.0-dev'),
};

function commonShape(poolMaxDefault: number) {
  return {
    ...baseShape,
    DB_HOST: textD('127.0.0.1'),
    DB_PORT: port(1433),
    DB_NAME: text()
      .regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/, 'Expected a plain SQL identifier')
      .default('orchestrator'),
    DB_USER: text(),
    DB_PASSWORD: z.string().min(1),
    DB_ENCRYPT: bool(true),
    DB_TRUST_SERVER_CERTIFICATE: bool(false),
    /** PEM CA bundle that signed the SQL Server certificate (§16.1, ADR-0026); via DB_CA_CERT_FILE. */
    DB_CA_CERT: z
      .string()
      .refine((v) => v.includes('-----BEGIN CERTIFICATE-----'), 'Expected a PEM certificate')
      .optional(),
    DB_POOL_MIN: int(0, 0, 1000),
    DB_POOL_MAX: int(poolMaxDefault, 1, 1000),
    DB_CONNECT_TIMEOUT_MS: int(15_000, 100),
    DB_REQUEST_TIMEOUT_MS: int(30_000, 100),
    REDIS_HOST: textD('127.0.0.1'),
    REDIS_PORT: port(6379),
    REDIS_DB: int(0, 0, 255),
    REDIS_PASSWORD: z.string().min(1).optional(),
    REDIS_PREFIX: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_-]{1,31}$/, 'Expected /^[a-z][a-z0-9_-]{1,31}$/')
      .default('orc'),
  };
}

type CommonShape = ReturnType<typeof commonShape>;
type CommonEnv = z.output<z.ZodObject<CommonShape>>;
type BaseEnv = z.output<z.ZodObject<typeof baseShape>>;

const apiShape = {
  API_HOST: textD('127.0.0.1'),
  API_PORT: port(4000),
  PUBLIC_ORIGIN: httpUrl().optional(),
  TRUST_PROXY: int(0, 0, 32),
  COOKIE_SECURE: bool(true),
  SESSION_IDLE_TTL_SECONDS: int(7200, 60),
  SESSION_ABSOLUTE_TTL_SECONDS: int(43_200, 60),
  PASSWORD_SCRYPT_N: int(131_072, 16_384, 131_072),
  PASSWORD_HASH_CONCURRENCY: int(2, 1, 16),
  LOGIN_MAX_FAILURES: int(5, 1),
  LOGIN_LOCK_SECONDS: int(900, 1),
  LOGIN_IP_MAX: int(20, 1),
  LOGIN_IP_WINDOW_SECONDS: int(900, 1),
  JSON_BODY_LIMIT_BYTES: int(262_144, 1024),
  SSE_MAX_PER_USER: int(10, 1),
  SSE_MAX_PER_PROCESS: int(200, 1),
  SSE_HEARTBEAT_MS: int(15_000, 1000),
  SSE_SESSION_RECHECK_MS: int(60_000, 1000),
  SSE_MAX_DURATION_MS: int(3_600_000, 1000),
  SSE_DB_POLL_MS: int(1000, 100),
  SSE_MAX_BUFFER_BYTES: int(1_048_576, 1024),
  IDEMPOTENCY_TTL_SECONDS: int(86_400, 60),
  TASK_PROMPT_MAX_CHARS: int(32_000, 1, TASK_TEXT_MAX_BYTES),
  TASK_MAX_ATTEMPTS: int(10, 1, 1000),
  CLAUDE_MAX_TIMEOUT_SECONDS: int(14_400, 60, 86_400),
  CLAUDE_ALLOWED_MODELS: list().pipe(
    z.array(z.string().max(100)).min(1, 'At least one model is required'),
  ),
  CLAUDE_DEFAULT_MODEL: text().max(100),
  QUEUE_JOB_ATTEMPTS: int(3, 1, 100),
  QUEUE_BACKOFF_MS: int(5000, 0),
  MCP_ENABLED: bool(true),
  OPENAPI_ENABLED: bool(true),
  SWAGGER_UI_ENABLED: bool(true),
  SHUTDOWN_TIMEOUT_MS: int(15_000, 0),
};

// ---- codebase-memory-mcp daemon socket (runner mode) -------------------------------------------

/**
 * codebase-memory-mcp v0.12.0 (Linux) binds its daemon socket at
 * `<CBM_RUNTIME_DIR>/cbm-daemon-<uid>/cbm-<16 hex>.sock`; in runner mode CBM_RUNTIME_DIR is the leased scope
 * cache `<CBM_CACHE_DIR>/{p,w}/<GUID>` (§12.1). An AF_UNIX path holds at most 107 bytes + NUL (sun_path[108]);
 * a longer one fails with "secure daemon endpoint could not be created" (measured in the worker image: a 64-byte
 * runtime dir works and 65 bytes fail for 5-digit uids). The win32 binary uses no socket below the runtime dir.
 */
export const CBM_SOCKET_PATH_MAX_BYTES = 107;
/** Smallest sandbox uid the runner accepts (RUNNER_UID_BASE minimum). */
export const SANDBOX_UID_MIN = 1000;

const CBM_SCOPE_DIR_BYTES = '/w/'.length + 36;
const CBM_SOCKET_NAME_BYTES = '/cbm-'.length + 16 + '.sock'.length;

/** Bytes of the daemon socket path of a per-scope cache below `cacheRoot` for sandbox uid `uid`. */
export function cbmSocketPathBytes(cacheRoot: string, uid: number): number {
  const root = cacheRoot.length > 1 ? cacheRoot.replace(/\/+$/, '') : cacheRoot;
  return (
    Buffer.byteLength(root, 'utf8') +
    CBM_SCOPE_DIR_BYTES +
    `/cbm-daemon-${uid}`.length +
    CBM_SOCKET_NAME_BYTES
  );
}

/**
 * null when the daemon socket of every scope cache fits for sandbox uids up to `maxUid`, else the problem
 * (lengths only; the path itself is not echoed).
 */
export function cbmSocketPathProblem(cacheRoot: string, maxUid: number): string | null {
  const bytes = cbmSocketPathBytes(cacheRoot, maxUid);
  if (bytes <= CBM_SOCKET_PATH_MAX_BYTES) return null;
  const maxRootBytes = CBM_SOCKET_PATH_MAX_BYTES - cbmSocketPathBytes('', maxUid);
  return (
    `Too long for the codebase-memory-mcp daemon socket <CBM_CACHE_DIR>/w/<GUID>/cbm-daemon-<uid>/cbm-<16 hex>.sock: ` +
    `${bytes} bytes with ${String(maxUid).length}-digit sandbox uids, the AF_UNIX limit is ` +
    `${CBM_SOCKET_PATH_MAX_BYTES}; use at most ${maxRootBytes} bytes`
  );
}

/**
 * Long-lived subscription token from `claude setup-token` (ADR-0036): `sk-ant-oat`, two digits, `-`, then
 * 20..500 URL-safe characters. `scripts/lib/claude-credentials.mjs` copies this expression verbatim
 * (a unit test asserts equality).
 */
export const CLAUDE_OAUTH_TOKEN_REGEX = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,500}$/;

/** Claude credential inputs (ADR-0036). Not camelized: the output is `claudeAuth`, a union on the mode. */
const claudeAuthShape = {
  CLAUDE_AUTH_MODE: z.enum(CLAUDE_AUTH_MODES).default('oauth'),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /** Removed by ADR-0036; parsed only so that a leftover setting fails loudly. */
  CLAUDE_BARE: z.string().optional(),
};

/** Claude credentials as the worker passes them to the runner config (ADR-0036 Decision 1). */
export type ClaudeAuth =
  | { readonly mode: Extract<ClaudeAuthMode, 'oauth'>; readonly oauthToken: string }
  | { readonly mode: Extract<ClaudeAuthMode, 'api_key'>; readonly apiKey: string };

const OAUTH_TOKEN_PREFIX = 'sk-ant-oat';

/** Credential problems as [key, message]; messages name keys only, never values. */
function claudeAuthProblems(e: z.output<z.ZodObject<typeof claudeAuthShape>>): {
  problems: [string, string][];
  auth: ClaudeAuth | null;
} {
  const problems: [string, string][] = [];
  if (e.CLAUDE_BARE !== undefined) problems.push(['CLAUDE_BARE', 'Removed by ADR-0036; unset it']);
  if (e.CLAUDE_AUTH_MODE === 'oauth') {
    if (e.ANTHROPIC_API_KEY !== undefined) {
      problems.push(['ANTHROPIC_API_KEY', 'Must not be set when CLAUDE_AUTH_MODE=oauth']);
    }
    const token = e.CLAUDE_CODE_OAUTH_TOKEN;
    if (token === undefined) {
      problems.push(['CLAUDE_CODE_OAUTH_TOKEN', 'Required when CLAUDE_AUTH_MODE=oauth']);
    } else if (!CLAUDE_OAUTH_TOKEN_REGEX.test(token)) {
      problems.push(['CLAUDE_CODE_OAUTH_TOKEN', 'Does not match the sk-ant-oat token format']);
    }
    if (problems.length > 0 || token === undefined) return { problems, auth: null };
    return { problems, auth: { mode: 'oauth', oauthToken: token } };
  }
  if (e.CLAUDE_CODE_OAUTH_TOKEN !== undefined) {
    problems.push(['CLAUDE_CODE_OAUTH_TOKEN', 'Must not be set when CLAUDE_AUTH_MODE=api_key']);
  }
  const key = e.ANTHROPIC_API_KEY;
  if (key === undefined) {
    problems.push(['ANTHROPIC_API_KEY', 'Required when CLAUDE_AUTH_MODE=api_key']);
  } else if (key.startsWith(OAUTH_TOKEN_PREFIX)) {
    problems.push(['ANTHROPIC_API_KEY', 'Holds an OAuth token; use CLAUDE_AUTH_MODE=oauth']);
  }
  if (problems.length > 0 || key === undefined) return { problems, auth: null };
  return { problems, auth: { mode: 'api_key', apiKey: key } };
}

const workerShape = {
  WORKER_ID: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{1,128}$/, 'Expected /^[A-Za-z0-9._-]{1,128}$/')
    .optional(),
  WORKER_CONCURRENCY: int(2, 1, 16),
  WORKER_HEALTH_HOST: textD('127.0.0.1'),
  WORKER_HEALTH_PORT: port(4100),
  HEARTBEAT_INTERVAL_MS: int(10_000, 1000),
  QUOTA_CHECK_EVERY_N_HEARTBEATS: int(6, 1),
  ATTEMPT_STALE_MS: int(60_000, 1000),
  MAX_AUTO_RECOVERIES: int(2, 0, 100),
  SHUTDOWN_TIMEOUT_MS: int(30_000, 0),
  ORPHAN_SWEEP_INTERVAL_MS: int(60_000, 1000),
  QUEUE_JOB_ATTEMPTS: int(3, 1, 100),
  QUEUE_BACKOFF_MS: int(5000, 0),
  PROJECTS_ROOT: absPath(),
  WORKSPACES_ROOT: absPath(),
  CLAUDE_HOME_ROOT: absPath(),
  CBM_CACHE_DIR: absPath(),
  WORKSPACE_MAX_BYTES: int(2_147_483_648, 1),
  WORKSPACES_MIN_FREE_BYTES: int(5_368_709_120, 0),
  WORKSPACE_SIZE_SCAN_MAX_ENTRIES: int(500_000, 1),
  WORKSPACE_RETENTION_HOURS: int(72, 0),
  BRANCH_RETENTION_DAYS: int(14, 0),
  LOG_RETENTION_DAYS: int(30, 1),
  GITOPS_RETENTION_DAYS: int(30, 1),
  MCPOPS_RETENTION_DAYS: int(90, 1),
  RETENTION_BATCH_SIZE: int(5000, 1, 100_000),
  LOG_FLUSH_INTERVAL_MS: int(500, 10),
  LOG_FLUSH_BYTES: int(16_384, 1),
  LOG_BUFFER_MAX_BYTES: int(8_388_608, 1),
  DB_WRITE_RETRY_WINDOW_MS: int(30_000, 0),
  PATCH_RETENTION_DAYS: int(90, 1),
  ARTIFACT_CAPTURE_TIMEOUT_MS: int(60_000, 0),
  GIT_BIN: textD('git'),
  GIT_OP_TIMEOUT_MS: int(120_000, 1000),
  GIT_FETCH_TIMEOUT_MS: int(300_000, 1000),
  ORC_GIT_AUTHOR_NAME: textD('Orc Orchestrator'),
  ORC_GIT_AUTHOR_EMAIL: textD('orc@localhost'),
  CHANGED_FILE_PATCH_MAX_BYTES: int(262_144, 1),
  PATCH_EXPORT_MAX_BYTES: int(52_428_800, 1),
  DIFF_MAX_FILES: int(5000, 1),
  COMMITS_MAX: int(500, 1),
  CLAUDE_BIN: textD('claude'),
  CLAUDE_BIN_PREFIX_ARGS: jsonStringArray(),
  CLAUDE_KILL_GRACE_MS: int(10_000, 0),
  CLAUDE_INIT_TIMEOUT_MS: int(60_000, 1000),
  CLAUDE_MAX_TIMEOUT_SECONDS: int(14_400, 60, 86_400),
  CLAUDE_MAX_OUTPUT_BYTES: int(52_428_800, 1),
  CLAUDE_MAX_LINE_BYTES: int(4_194_304, 1024),
  PROMPT_MAX_BYTES: int(131_072, 1),
  PROMPT_CLAUDE_MD_MAX_BYTES: int(16_384, 0),
  HTTPS_PROXY: httpUrl().optional(),
  HTTP_PROXY: httpUrl().optional(),
  NO_PROXY: textD('localhost,127.0.0.1'),
  EGRESS_PROXY_TOKEN: proxyToken().optional(),
  SANDBOX_MODE: z.enum(['runner', 'local']).optional(),
  RUNNER_SOCKET_PATH: absPath().default('/run/orc-runner/runner.sock'),
  GIT_HOOKS_DIR: absPath().default('/opt/orc/git/empty-hooks'),
  CLAUDE_INIT_EXTRA_TOOLS: list()
    .pipe(z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'Expected a tool name')).max(16))
    .default([]),
  MCP_ENABLED: bool(true),
  MCP_REQUIRED: bool(false),
  CODEBASE_MEMORY_MCP_BIN: textD('codebase-memory-mcp'),
  CODEBASE_MEMORY_MCP_BIN_PREFIX_ARGS: jsonStringArray(),
  CBM_LOG_LEVEL: textD('warn'),
  MCP_CONNECT_TIMEOUT_MS: int(30_000, 1000),
  MCP_CALL_TIMEOUT_MS: int(30_000, 1000),
  MCP_INDEX_TIMEOUT_MS: int(900_000, 1000),
  MCP_DETECT_TIMEOUT_MS: int(120_000, 1000),
  MCP_RESULT_MAX_BYTES: int(262_144, 1024),
  TEST_OUTPUT_MAX_BYTES: int(10_485_760, 1),
  JUNIT_MAX_BYTES: int(20_971_520, 1),
  JUNIT_MAX_CASES: int(5000, 1),
  TEST_KILL_GRACE_MS: int(5000, 0),
};

const egressShape = {
  EGRESS_HOST: textD('0.0.0.0'),
  EGRESS_PORT: port(3128),
  EGRESS_ALLOWED_HOSTS: list()
    .transform((hosts) => hosts.map((h) => h.toLowerCase()))
    .pipe(
      z.array(z.string().max(253).regex(HOST_PATTERN, 'Expected a host name or *.domain')).min(1),
    )
    .default(['api.anthropic.com']),
  EGRESS_ALLOWED_PORTS: list()
    .pipe(
      z
        .array(
          z
            .string()
            .regex(/^\d{1,5}$/, 'Expected a port number')
            .transform(Number)
            .pipe(z.int().min(1).max(65_535)),
        )
        .min(1),
    )
    .default([443]),
  EGRESS_DENY_PRIVATE_IPS: bool(true),
  EGRESS_CONNECT_TIMEOUT_MS: int(10_000, 100),
  EGRESS_IDLE_TIMEOUT_MS: int(600_000, 1000),
  EGRESS_MAX_CONNECTIONS: int(256, 1),
  EGRESS_AUTH_TOKEN: proxyToken().optional(),
};

const dbCliShape = {
  MSSQL_SA_PASSWORD: z.string().min(1).optional(),
  DB_MIGRATOR_PASSWORD: sqlLoginPassword(),
  DB_API_PASSWORD: sqlLoginPassword(),
  DB_WORKER_PASSWORD: sqlLoginPassword(),
  DB_BACKUP_PASSWORD: sqlLoginPassword(),
  ORC_ADMIN_PASSWORD: z.string().min(1).optional(),
  CLAUDE_DEFAULT_MODEL: text().max(100).optional(),
  BACKUP_DIR: textD('/var/opt/mssql/backups'),
};

const runnerShape = {
  RUNNER_SOCKET_PATH: absPath().default('/run/orc-runner/runner.sock'),
  RUNNER_STATE_DIR: absPath().default('/run/orc-runner/state'),
  WORKSPACES_ROOT: absPath(),
  CLAUDE_HOME_ROOT: absPath(),
  CBM_CACHE_DIR: absPath(),
  WORKER_UID: int(1000, 1, 2_147_483_646),
  WORKER_GID: int(1000, 1, 2_147_483_646),
  RUNNER_UID_BASE: int(20_000, SANDBOX_UID_MIN, 2_000_000_000),
  RUNNER_MAX_LEASES: int(64, 1, 1024),
  RUNNER_NPROC: int(512, 16, 1_000_000),
  RUNNER_NOFILE: int(4096, 64, 1_048_576),
  RUNNER_FSIZE_BYTES: int(2_147_483_648, 1_048_576),
  RUNNER_KILL_GRACE_MS: int(10_000, 0),
  RUNNER_LEASE_TTL_MS: int(40_000, 5000),
  RUNNER_MAX_CONNECTIONS: int(256, 1),
};

// ---- output mapping -----------------------------------------------------------------------

type CamelCase<S extends string> = S extends `${infer H}_${infer T}`
  ? `${Lowercase<H>}${Capitalize<CamelCase<T>>}`
  : Lowercase<S>;
type Camelized<E> = {
  -readonly [K in keyof E as K extends string ? CamelCase<K> : never]-?: undefined extends E[K]
    ? Exclude<E[K], undefined> | null
    : E[K];
};

function camelCase(key: string): string {
  return key.toLowerCase().replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/** Picks the keys of `shape` from `env` and camel-cases them; undefined -> null. */
function camelize<S extends z.ZodRawShape>(
  shape: S,
  env: z.output<z.ZodObject<S>>,
): Camelized<z.output<z.ZodObject<S>>> {
  const source = env as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) out[camelCase(key)] = source[key] ?? null;
  return out as Camelized<z.output<z.ZodObject<S>>>;
}

function baseOut(e: BaseEnv) {
  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    /** LOG_PRETTY is honored only in development. */
    logPretty: e.LOG_PRETTY && e.NODE_ENV === 'development',
    appVersion: e.APP_VERSION,
  };
}

type DbAppName = 'orc-api' | 'orc-worker' | 'orc-db-cli' | 'orc-test';

function commonOut(e: CommonEnv, appName: DbAppName) {
  return {
    ...baseOut(e),
    db: {
      host: e.DB_HOST,
      port: e.DB_PORT,
      database: e.DB_NAME,
      user: e.DB_USER,
      password: e.DB_PASSWORD,
      encrypt: e.DB_ENCRYPT,
      trustServerCertificate: e.DB_TRUST_SERVER_CERTIFICATE,
      caCert: e.DB_CA_CERT ?? null,
      poolMin: e.DB_POOL_MIN,
      poolMax: e.DB_POOL_MAX,
      connectTimeoutMs: e.DB_CONNECT_TIMEOUT_MS,
      requestTimeoutMs: e.DB_REQUEST_TIMEOUT_MS,
      appName,
    },
    redis: {
      host: e.REDIS_HOST,
      port: e.REDIS_PORT,
      password: e.REDIS_PASSWORD ?? null,
      db: e.REDIS_DB,
      prefix: e.REDIS_PREFIX,
    },
  };
}

type Problem = readonly [key: string, message: string];

function commonProblems(e: CommonEnv, requireRedisPassword: boolean): Problem[] {
  const p: Problem[] = [];
  if (e.DB_POOL_MIN > e.DB_POOL_MAX) p.push(['DB_POOL_MIN', 'Must not exceed DB_POOL_MAX']);
  if (e.NODE_ENV === 'production' && !e.DB_ENCRYPT) {
    p.push(['DB_ENCRYPT', 'Must be true when NODE_ENV=production']);
  }
  if (e.NODE_ENV === 'production' && e.DB_TRUST_SERVER_CERTIFICATE) {
    p.push([
      'DB_TRUST_SERVER_CERTIFICATE',
      'true is allowed only in development/test (use DB_CA_CERT)',
    ]);
  }
  if (requireRedisPassword && e.NODE_ENV === 'production' && e.REDIS_PASSWORD === undefined) {
    p.push(['REDIS_PASSWORD', 'Required when NODE_ENV=production']);
  }
  return p;
}

function report(
  ctx: Pick<z.core.$RefinementCtx, 'addIssue'>,
  problems: readonly Problem[],
): boolean {
  for (const [key, message] of problems) ctx.addIssue({ code: 'custom', path: [key], message });
  return problems.length > 0;
}

const isPowerOfTwo = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;

// ---- app schemas --------------------------------------------------------------------------

export const ApiConfigSchema = z.object({ ...commonShape(10), ...apiShape }).transform((e, ctx) => {
  const p = commonProblems(e, true);
  if (e.NODE_ENV === 'production' && e.PUBLIC_ORIGIN === undefined) {
    p.push(['PUBLIC_ORIGIN', 'Required when NODE_ENV=production']);
  }
  if (
    e.PUBLIC_ORIGIN !== undefined &&
    new URL(e.PUBLIC_ORIGIN).origin !== e.PUBLIC_ORIGIN.replace(/\/+$/, '')
  ) {
    p.push(['PUBLIC_ORIGIN', 'Must be an origin (scheme://host[:port]) without path']);
  }
  if (e.NODE_ENV === 'production' && e.PUBLIC_ORIGIN !== undefined) {
    const url = new URL(e.PUBLIC_ORIGIN);
    if (url.protocol !== 'https:' && !LOOPBACK_HOSTS.has(url.hostname)) {
      p.push([
        'PUBLIC_ORIGIN',
        'Must use https when NODE_ENV=production (except localhost, 127.0.0.1, [::1])',
      ]);
    }
  }
  if (e.NODE_ENV === 'production' && !e.COOKIE_SECURE) {
    p.push(['COOKIE_SECURE', 'false is allowed only in development/test']);
  }
  if (!isPowerOfTwo(e.PASSWORD_SCRYPT_N)) p.push(['PASSWORD_SCRYPT_N', 'Must be a power of two']);
  if (e.SESSION_IDLE_TTL_SECONDS > e.SESSION_ABSOLUTE_TTL_SECONDS) {
    p.push(['SESSION_IDLE_TTL_SECONDS', 'Must not exceed SESSION_ABSOLUTE_TTL_SECONDS']);
  }
  if (!e.CLAUDE_ALLOWED_MODELS.includes(e.CLAUDE_DEFAULT_MODEL)) {
    p.push(['CLAUDE_DEFAULT_MODEL', 'Must be one of CLAUDE_ALLOWED_MODELS']);
  }
  if (report(ctx, p)) return z.NEVER;
  return {
    app: 'api' as const,
    ...commonOut(e, 'orc-api'),
    ...camelize(apiShape, e),
    publicOrigin:
      e.PUBLIC_ORIGIN === undefined ? 'http://127.0.0.1:5173' : new URL(e.PUBLIC_ORIGIN).origin,
  };
});
export type ApiConfig = z.output<typeof ApiConfigSchema>;

export const WorkerConfigSchema = z
  .object({ ...commonShape(5), ...workerShape, ...claudeAuthShape })
  .transform((e, ctx) => {
    const p = commonProblems(e, true);
    const workerId = e.WORKER_ID ?? hostname();
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(workerId)) {
      p.push(['WORKER_ID', 'Host name is not a valid worker id; set WORKER_ID']);
    }
    const credentials = claudeAuthProblems(e);
    p.push(...credentials.problems);
    if (e.NODE_ENV === 'production' && e.HTTPS_PROXY === undefined) {
      p.push(['HTTPS_PROXY', 'Required when NODE_ENV=production']);
    }
    if (e.PROMPT_MAX_BYTES < TASK_TEXT_MAX_BYTES + 32_768) {
      p.push([
        'PROMPT_MAX_BYTES',
        `Must be >= ${TASK_TEXT_MAX_BYTES + 32_768} (TASK_TEXT_MAX_BYTES + 32768)`,
      ]);
    }
    if (e.MCP_REQUIRED && !e.MCP_ENABLED) p.push(['MCP_REQUIRED', 'Requires MCP_ENABLED=true']);
    if (e.LOG_FLUSH_BYTES > e.LOG_BUFFER_MAX_BYTES) {
      p.push(['LOG_FLUSH_BYTES', 'Must not exceed LOG_BUFFER_MAX_BYTES']);
    }
    // Self-fencing (§14.3): a worker stops its processes once its last successful DB heartbeat is
    // older than ATTEMPT_STALE_MS - 2 * HEARTBEAT_INTERVAL_MS, before stale recovery may start.
    const selfFenceAfterMs = e.ATTEMPT_STALE_MS - 2 * e.HEARTBEAT_INTERVAL_MS;
    if (selfFenceAfterMs < e.HEARTBEAT_INTERVAL_MS) {
      p.push(['ATTEMPT_STALE_MS', 'Must be >= 3 * HEARTBEAT_INTERVAL_MS']);
    }
    if (e.DB_WRITE_RETRY_WINDOW_MS >= selfFenceAfterMs) {
      p.push([
        'DB_WRITE_RETRY_WINDOW_MS',
        'Must be < ATTEMPT_STALE_MS - 2 * HEARTBEAT_INTERVAL_MS',
      ]);
    }
    if (e.SHUTDOWN_TIMEOUT_MS <= e.CLAUDE_KILL_GRACE_MS + 10_000) {
      p.push(['SHUTDOWN_TIMEOUT_MS', 'Must be > CLAUDE_KILL_GRACE_MS + 10000']);
    }
    const sandboxMode = e.SANDBOX_MODE ?? (e.NODE_ENV === 'production' ? 'runner' : 'local');
    if (e.NODE_ENV === 'production' && sandboxMode !== 'runner') {
      p.push(['SANDBOX_MODE', 'Must be runner when NODE_ENV=production']);
    }
    if (e.NODE_ENV === 'production' && e.EGRESS_PROXY_TOKEN === undefined) {
      p.push(['EGRESS_PROXY_TOKEN', 'Required when NODE_ENV=production']);
    }
    // Runner mode: the leased cache is CBM_RUNTIME_DIR. Checked for the shortest possible sandbox uid here; the
    // worker re-checks with the runner's real uid range after `hello`.
    if (sandboxMode === 'runner' && e.MCP_ENABLED && process.platform !== 'win32') {
      const socket = cbmSocketPathProblem(e.CBM_CACHE_DIR, SANDBOX_UID_MIN);
      if (socket !== null) p.push(['CBM_CACHE_DIR', socket]);
    }
    for (const tool of e.CLAUDE_INIT_EXTRA_TOOLS) {
      if (FORBIDDEN_EXTRA_INIT_TOOLS.has(tool) || tool.startsWith('mcp__')) {
        p.push(['CLAUDE_INIT_EXTRA_TOOLS', `${tool} may not be whitelisted`]);
      }
    }
    if (report(ctx, p) || credentials.auth === null) return z.NEVER;
    return {
      app: 'worker' as const,
      ...commonOut(e, 'orc-worker'),
      ...camelize(workerShape, e),
      claudeAuth: credentials.auth,
      workerId,
      sandboxMode,
      selfFenceAfterMs,
    };
  });
export type WorkerConfig = z.output<typeof WorkerConfigSchema>;

export const EgressProxyConfigSchema = z
  .object({ ...baseShape, ...egressShape })
  .transform((e, ctx) => {
    if (
      e.NODE_ENV === 'production' &&
      e.EGRESS_AUTH_TOKEN === undefined &&
      report(ctx, [['EGRESS_AUTH_TOKEN', 'Required when NODE_ENV=production']])
    ) {
      return z.NEVER;
    }
    return {
      app: 'egress-proxy' as const,
      ...baseOut(e),
      ...camelize(egressShape, e),
    };
  });
export type EgressProxyConfig = z.output<typeof EgressProxyConfigSchema>;

/** The DB CLI does not use Redis, so REDIS_PASSWORD is never required for it. */
export const DbCliConfigSchema = z
  .object({ ...commonShape(10), ...dbCliShape })
  .transform((e, ctx) => {
    if (report(ctx, commonProblems(e, false))) return z.NEVER;
    return {
      app: 'db-cli' as const,
      ...commonOut(e, 'orc-db-cli'),
      ...camelize(dbCliShape, e),
    };
  });
export type DbCliConfig = z.output<typeof DbCliConfigSchema>;

/** Execution sandbox launcher (§10.11). No DB/Redis settings: the runner never reaches them. */
export const RunnerConfigSchema = z.object({ ...baseShape, ...runnerShape }).transform((e, ctx) => {
  const p: Problem[] = [];
  const first = e.RUNNER_UID_BASE;
  const last = e.RUNNER_UID_BASE + e.RUNNER_MAX_LEASES - 1;
  if (e.WORKER_UID >= first && e.WORKER_UID <= last) {
    p.push(['RUNNER_UID_BASE', 'Sandbox uid range must not contain WORKER_UID']);
  }
  if (e.WORKER_GID >= first && e.WORKER_GID <= last) {
    p.push(['RUNNER_UID_BASE', 'Sandbox uid range must not contain WORKER_GID']);
  }
  if (report(ctx, p)) return z.NEVER;
  return {
    app: 'runner' as const,
    ...baseOut(e),
    ...camelize(runnerShape, e),
  };
});
export type RunnerConfig = z.output<typeof RunnerConfigSchema>;

// ---- loaders (loadConfig + assertDbNameForEnv) -------------------------------------------

export function loadApiConfig(env?: Env): ApiConfig {
  const cfg = loadConfig(ApiConfigSchema, { app: 'api', env, secretKeys: SECRET_ENV_KEYS.api });
  assertDbNameForEnv(cfg.nodeEnv, cfg.db.database);
  return cfg;
}

export function loadWorkerConfig(env?: Env): WorkerConfig {
  const cfg = loadConfig(WorkerConfigSchema, {
    app: 'worker',
    env,
    secretKeys: SECRET_ENV_KEYS.worker,
  });
  assertDbNameForEnv(cfg.nodeEnv, cfg.db.database);
  return cfg;
}

export function loadEgressProxyConfig(env?: Env): EgressProxyConfig {
  return loadConfig(EgressProxyConfigSchema, {
    app: 'egress-proxy',
    env,
    secretKeys: SECRET_ENV_KEYS['egress-proxy'],
  });
}

export function loadRunnerConfig(env?: Env): RunnerConfig {
  return loadConfig(RunnerConfigSchema, { app: 'runner', env, secretKeys: SECRET_ENV_KEYS.runner });
}

export function loadDbCliConfig(env?: Env): DbCliConfig {
  const cfg = loadConfig(DbCliConfigSchema, {
    app: 'db-cli',
    env,
    secretKeys: SECRET_ENV_KEYS['db-cli'],
  });
  assertDbNameForEnv(cfg.nodeEnv, cfg.db.database);
  return cfg;
}
