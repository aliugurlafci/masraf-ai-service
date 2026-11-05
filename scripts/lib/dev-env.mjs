// Development-mode environment of the host apps (docs/operations/installation.md section 12).
// Pure helpers shared by scripts/dev-setup.mjs and scripts/dev-run.mjs; plain Node, no dependencies.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { REPO_ROOT } from './common.mjs';

export const DEV_DB_NAME = 'orchestrator_dev';
export const DEV_MSSQL = { container: 'orc-dev-mssql', host: '127.0.0.1', port: 14330 };
export const DEV_REDIS = { container: 'orc-dev-redis', host: '127.0.0.1', port: 16379 };

/** Generated passwords kept in dev.env (never forwarded to the apps under these names). */
export const DEV_PASSWORD_KEYS = [
  'DEV_SA_PASSWORD',
  'DEV_MIGRATOR_PASSWORD',
  'DEV_API_PASSWORD',
  'DEV_WORKER_PASSWORD',
  'DEV_BACKUP_PASSWORD',
];

/** ~/.orc-dev (ORC_DEV_DIR overrides it; used by tests). */
export function devDir(env = process.env) {
  const raw = env.ORC_DEV_DIR;
  return raw ? resolve(raw) : join(homedir(), '.orc-dev');
}

export function devEnvPath(env = process.env) {
  return join(devDir(env), 'dev.env');
}

/** KEY=VALUE lines; `#` starts a comment only at the beginning of a line (passwords may contain `#`). */
export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = line.slice(eq + 1).trim();
  }
  return out;
}

export function serializeEnvFile(values) {
  const header = [
    '# Orchestrator development secrets and overrides (written by `npm run dev:setup`).',
    '# Keep this file outside the repository. Extra KEY=VALUE lines (for example ANTHROPIC_API_KEY)',
    '# are forwarded to the dev apps; variables already set in the shell win over this file.',
  ];
  return `${header.join('\n')}\n${Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`;
}

/** Configuration shared by every dev process (installation.md section 12 step 2). */
export function baseEnv() {
  return {
    NODE_ENV: 'development',
    DB_HOST: DEV_MSSQL.host,
    DB_PORT: String(DEV_MSSQL.port),
    DB_NAME: DEV_DB_NAME,
    DB_TRUST_SERVER_CERTIFICATE: 'true',
    REDIS_HOST: DEV_REDIS.host,
    REDIS_PORT: String(DEV_REDIS.port),
    LOG_PRETTY: 'true',
    CLAUDE_ALLOWED_MODELS: 'sonnet,opus,haiku',
    CLAUDE_DEFAULT_MODEL: 'sonnet',
  };
}

/** Directories the worker needs (all absolute). */
export function devPaths(env = process.env, repoRoot = REPO_ROOT) {
  const dir = devDir(env);
  return {
    projects: join(repoRoot, 'projects'),
    workspaces: join(repoRoot, 'workspaces'),
    claude: join(dir, 'claude'),
    cbmCache: join(dir, 'cbm-cache'),
    emptyHooks: join(dir, 'empty-hooks'),
  };
}

function need(devValues, key) {
  const v = devValues[key];
  if (typeof v !== 'string' || v === '') throw new Error(`${key} is missing from dev.env`);
  return v;
}

/** Values specific to one profile: api | worker | db (migrator login) | bootstrap (db + sa and login passwords). */
export function profileEnv(profile, devValues, paths) {
  switch (profile) {
    case 'api':
      return { DB_USER: 'orc_api', DB_PASSWORD: need(devValues, 'DEV_API_PASSWORD'), COOKIE_SECURE: 'false' };
    case 'worker':
      return {
        DB_USER: 'orc_worker',
        DB_PASSWORD: need(devValues, 'DEV_WORKER_PASSWORD'),
        PROJECTS_ROOT: paths.projects,
        WORKSPACES_ROOT: paths.workspaces,
        CLAUDE_HOME_ROOT: paths.claude,
        CBM_CACHE_DIR: paths.cbmCache,
        GIT_HOOKS_DIR: paths.emptyHooks,
        CLAUDE_BARE: 'false',
      };
    case 'db':
      return { DB_USER: 'orc_migrator', DB_PASSWORD: need(devValues, 'DEV_MIGRATOR_PASSWORD') };
    case 'bootstrap':
      return {
        DB_USER: 'orc_migrator',
        DB_PASSWORD: need(devValues, 'DEV_MIGRATOR_PASSWORD'),
        MSSQL_SA_PASSWORD: need(devValues, 'DEV_SA_PASSWORD'),
        DB_MIGRATOR_PASSWORD: need(devValues, 'DEV_MIGRATOR_PASSWORD'),
        DB_API_PASSWORD: need(devValues, 'DEV_API_PASSWORD'),
        DB_WORKER_PASSWORD: need(devValues, 'DEV_WORKER_PASSWORD'),
        DB_BACKUP_PASSWORD: need(devValues, 'DEV_BACKUP_PASSWORD'),
      };
    default:
      throw new Error(`unknown dev profile: ${profile}`);
  }
}

/**
 * Environment of a dev process. Precedence, lowest to highest:
 * base defaults < profile values < dev.env extras (DEV_*_PASSWORD keys are never forwarded) < shell.
 */
export function buildChildEnv(profile, { shellEnv, devValues, paths }) {
  const extras = Object.fromEntries(
    Object.entries(devValues).filter(([k]) => !DEV_PASSWORD_KEYS.includes(k)),
  );
  const layered = { ...baseEnv(), ...profileEnv(profile, devValues, paths), ...extras };
  const merged = { ...shellEnv };
  for (const [key, value] of Object.entries(layered)) {
    if (merged[key] === undefined || merged[key] === '') merged[key] = value;
  }
  for (const key of DEV_PASSWORD_KEYS) delete merged[key];
  return merged;
}
