import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useTempDir } from '../../helpers/common';

type Env = Record<string, string | undefined>;
interface DevEnvModule {
  DEV_PASSWORD_KEYS: string[];
  parseEnvFile(text: string): Record<string, string>;
  serializeEnvFile(values: Record<string, string>): string;
  devPaths(env: Env, repoRoot: string): Record<string, string>;
  buildChildEnv(
    profile: string,
    o: { shellEnv: Env; devValues: Record<string, string>; paths: Record<string, string> },
  ): Env;
}
interface DevSetupModule {
  ensureDevEnv(file: string, generate: () => string): { values: Record<string, string>; created: boolean };
}

const root = join(__dirname, '..', '..', '..');
const load = async <T>(rel: string): Promise<T> =>
  (await import(pathToFileURL(join(root, rel)).href)) as T;

const PASSWORDS = {
  DEV_SA_PASSWORD: 'sa#pw',
  DEV_MIGRATOR_PASSWORD: 'mig=pw',
  DEV_API_PASSWORD: 'api-pw',
  DEV_WORKER_PASSWORD: 'wrk-pw',
  DEV_BACKUP_PASSWORD: 'bak-pw',
};

describe('dev environment', () => {
  let lib: DevEnvModule;
  let paths: Record<string, string>;
  beforeEach(async () => {
    lib = await load<DevEnvModule>('scripts/lib/dev-env.mjs');
    paths = lib.devPaths({ ORC_DEV_DIR: resolve('/orc-dev-x') }, resolve('/repo'));
  });

  it('parses KEY=VALUE, keeps # and = inside values, skips comments and junk', () => {
    const parsed = lib.parseEnvFile('# c\r\nA=1\n\nDEV_SA_PASSWORD=ab#c=d\nbad line\n1X=no\n B = spaced \n');
    expect(parsed).toEqual({ A: '1', DEV_SA_PASSWORD: 'ab#c=d', B: 'spaced' });
  });

  it('round-trips through serializeEnvFile', () => {
    expect(lib.parseEnvFile(lib.serializeEnvFile(PASSWORDS))).toEqual(PASSWORDS);
  });

  it('api profile: api login, dev defaults, no dev passwords forwarded', () => {
    const env = lib.buildChildEnv('api', { shellEnv: { PATH: 'p' }, devValues: PASSWORDS, paths });
    expect(env).toMatchObject({
      PATH: 'p',
      NODE_ENV: 'development',
      DB_NAME: 'orchestrator_dev',
      DB_PORT: '14330',
      REDIS_PORT: '16379',
      DB_USER: 'orc_api',
      DB_PASSWORD: 'api-pw',
      COOKIE_SECURE: 'false',
    });
    expect(Object.keys(env).filter((k) => k.startsWith('DEV_'))).toEqual([]);
    expect(env.MSSQL_SA_PASSWORD).toBeUndefined();
  });

  it('worker profile: worker login and directories', () => {
    const env = lib.buildChildEnv('worker', { shellEnv: {}, devValues: PASSWORDS, paths });
    expect(env).toMatchObject({
      DB_USER: 'orc_worker',
      DB_PASSWORD: 'wrk-pw',
      PROJECTS_ROOT: paths.projects,
      WORKSPACES_ROOT: paths.workspaces,
      CLAUDE_HOME_ROOT: paths.claude,
      CBM_CACHE_DIR: paths.cbmCache,
      GIT_HOOKS_DIR: paths.emptyHooks,
      CLAUDE_BARE: 'false',
    });
  });

  it('bootstrap profile carries every login password; db profile only the migrator', () => {
    const boot = lib.buildChildEnv('bootstrap', { shellEnv: {}, devValues: PASSWORDS, paths });
    expect(boot).toMatchObject({
      DB_USER: 'orc_migrator',
      MSSQL_SA_PASSWORD: 'sa#pw',
      DB_MIGRATOR_PASSWORD: 'mig=pw',
      DB_API_PASSWORD: 'api-pw',
      DB_WORKER_PASSWORD: 'wrk-pw',
      DB_BACKUP_PASSWORD: 'bak-pw',
    });
    const db = lib.buildChildEnv('db', { shellEnv: {}, devValues: PASSWORDS, paths });
    expect(db.DB_PASSWORD).toBe('mig=pw');
    expect(db.MSSQL_SA_PASSWORD).toBeUndefined();
  });

  it('precedence: shell > dev.env extras > profile > base', () => {
    const devValues = { ...PASSWORDS, DB_HOST: 'from-file', LOG_PRETTY: 'false', ANTHROPIC_API_KEY: 'k-file' };
    const env = lib.buildChildEnv('api', {
      shellEnv: { DB_HOST: 'from-shell', DB_USER: 'shell-user', ANTHROPIC_API_KEY: '' },
      devValues,
      paths,
    });
    expect(env.DB_HOST).toBe('from-shell');
    expect(env.DB_USER).toBe('shell-user');
    expect(env.LOG_PRETTY).toBe('false');
    expect(env.ANTHROPIC_API_KEY).toBe('k-file');
    expect(env.DB_NAME).toBe('orchestrator_dev');
  });

  it('a missing password raises a clear error', () => {
    expect(() => lib.buildChildEnv('api', { shellEnv: {}, devValues: {}, paths })).toThrow(/DEV_API_PASSWORD/);
  });
});

describe('ensureDevEnv', () => {
  const tmp = useTempDir();
  beforeEach(() => {
    process.env.ORC_DEV_DIR = tmp();
  });
  afterEach(() => {
    delete process.env.ORC_DEV_DIR;
  });

  it('creates once, then reuses and only fills missing passwords', async () => {
    const setup = await load<DevSetupModule>('scripts/dev-setup.mjs');
    const file = join(tmp(), 'dev.env');
    let n = 0;
    const gen = () => `pw${(n += 1)}`;
    const first = setup.ensureDevEnv(file, gen);
    expect(first.created).toBe(true);
    expect(Object.keys(first.values)).toHaveLength(5);
    const text = readFileSync(file, 'utf8');
    const second = setup.ensureDevEnv(file, gen);
    expect(second.created).toBe(false);
    expect(second.values).toEqual(first.values);
    expect(readFileSync(file, 'utf8')).toBe(text);
    writeFileSync(file, text.replace(/^DEV_BACKUP_PASSWORD=.*$/m, ''));
    const third = setup.ensureDevEnv(file, gen);
    expect(third.created).toBe(true);
    expect(third.values.DEV_SA_PASSWORD).toBe(first.values.DEV_SA_PASSWORD);
    expect(third.values.DEV_BACKUP_PASSWORD).not.toBe(first.values.DEV_BACKUP_PASSWORD);
  });
});
