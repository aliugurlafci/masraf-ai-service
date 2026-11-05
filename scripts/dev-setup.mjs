#!/usr/bin/env node
// One-time (idempotent) preparation of development mode on the host (installation.md section 12):
// dev passwords in ~/.orc-dev/dev.env, dev SQL Server + Redis containers, database bootstrap/migrate/seed,
// and the worker directories. Passwords are never printed. The admin user is created by the operator.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CliError, REPO_ROOT, run, runCli } from './lib/common.mjs';
import { npmInvocation } from './dev-run.mjs';
import {
  DEV_MSSQL,
  DEV_PASSWORD_KEYS,
  DEV_REDIS,
  buildChildEnv,
  devDir,
  devEnvPath,
  devPaths,
  parseEnvFile,
  serializeEnvFile,
} from './lib/dev-env.mjs';
import { generatePassword } from './generate-secrets.mjs';

const MSSQL_IMAGE = 'mcr.microsoft.com/mssql/server:2022-latest';
const REDIS_IMAGE = 'redis:7.4-alpine';
const READY_TIMEOUT_MS = 180_000;
const step = (msg) => console.log(`[dev:setup] ${msg}`);

/** Returns the existing dev.env values with every missing password generated; writes only on change. */
export function ensureDevEnv(file, generate = generatePassword) {
  const existing = existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {};
  const values = { ...existing };
  let changed = !existsSync(file);
  for (const key of DEV_PASSWORD_KEYS) {
    if (!values[key]) {
      values[key] = generate();
      changed = true;
    }
  }
  if (changed) {
    mkdirSync(devDir(), { recursive: true });
    writeFileSync(file, serializeEnvFile(values), { encoding: 'utf8', mode: 0o600 });
  }
  return { values, created: changed };
}

function docker(args, env) {
  return run('docker', args, { env: env ?? process.env });
}

/** running | stopped | absent */
function containerState(name) {
  const r = docker(['inspect', '-f', '{{.State.Running}}', name]);
  if (r.status !== 0) return 'absent';
  return r.stdout.trim() === 'true' ? 'running' : 'stopped';
}

function ensureContainer(name, runArgs, env) {
  const state = containerState(name);
  if (state === 'running') return step(`${name}: already running`);
  if (state === 'stopped') {
    step(`${name}: starting existing container`);
    const r = docker(['start', name]);
    if (r.status !== 0) throw new CliError(`docker start ${name} failed: ${r.stderr.trim()}`);
    return undefined;
  }
  step(`${name}: creating container`);
  const r = docker(runArgs, env);
  if (r.status !== 0) throw new CliError(`docker run ${name} failed: ${r.stderr.trim().split('\n').slice(-5).join('\n')}`);
  return undefined;
}

async function waitFor(what, probe) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (probe()) return step(`${what}: ready`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new CliError(`${what} did not become ready within ${READY_TIMEOUT_MS / 1000}s (docker logs <container>)`);
}

function runNpm(script, env) {
  const [cmd, prefix] = npmInvocation();
  const r = spawnSync(cmd, [...prefix, 'run', script], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    const tail = `${r.stderr || ''}${r.stdout || ''}`.trim().split('\n').slice(-12).join('\n');
    throw new CliError(`npm run ${script} failed (exit ${r.status}):\n${tail}`);
  }
}

async function main() {
  const file = devEnvPath();
  const { values, created } = ensureDevEnv(file);
  step(created ? `secrets written to ${file}` : `reusing ${file}`);

  const dockerEnv = { ...process.env, MSSQL_SA_PASSWORD: values.DEV_SA_PASSWORD, SQLCMDPASSWORD: values.DEV_SA_PASSWORD };
  if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) {
    throw new CliError('Docker is not reachable; start Docker Desktop first');
  }
  // The password travels through the environment of the docker client (-e NAME), not the command line.
  ensureContainer(
    DEV_MSSQL.container,
    [
      'run', '-d', '--name', DEV_MSSQL.container,
      '-e', 'ACCEPT_EULA=Y', '-e', 'MSSQL_PID=Developer', '-e', 'MSSQL_SA_PASSWORD',
      '-p', `${DEV_MSSQL.host}:${DEV_MSSQL.port}:1433`, MSSQL_IMAGE,
    ],
    dockerEnv,
  );
  ensureContainer(DEV_REDIS.container, [
    'run', '-d', '--name', DEV_REDIS.container, '-p', `${DEV_REDIS.host}:${DEV_REDIS.port}:6379`, REDIS_IMAGE,
    'redis-server', '--maxmemory', '400mb', '--maxmemory-policy', 'noeviction', '--appendonly', 'yes',
  ]);

  await waitFor('redis', () => docker(['exec', DEV_REDIS.container, 'redis-cli', 'ping']).stdout.trim() === 'PONG');
  await waitFor('mssql', () =>
    docker(
      ['exec', '-e', 'SQLCMDPASSWORD', DEV_MSSQL.container, '/opt/mssql-tools18/bin/sqlcmd', '-C', '-S', 'localhost', '-U', 'sa', '-Q', 'SELECT 1', '-b'],
      dockerEnv,
    ).status === 0,
  );

  const paths = devPaths();
  for (const dir of [paths.projects, paths.workspaces, paths.claude, paths.cbmCache, paths.emptyHooks]) {
    mkdirSync(dir, { recursive: true });
  }
  if (process.platform !== 'win32') chmodSync(paths.emptyHooks, 0o555);
  step('directories ready (GIT_HOOKS_DIR must exist and be empty; on Windows it may stay writable)');

  const shellEnv = { ...process.env };
  const bootstrapEnv = buildChildEnv('bootstrap', { shellEnv, devValues: values, paths });
  runNpm('db:bootstrap', bootstrapEnv);
  step('db:bootstrap done');
  const dbEnv = buildChildEnv('db', { shellEnv, devValues: values, paths });
  runNpm('db:migrate', dbEnv);
  step('db:migrate done');
  runNpm('db:seed', dbEnv);
  step('db:seed done');

  console.log('\nNext steps:');
  console.log('  npm run dev:create-admin -- --username admin   (once; asks for the password interactively, twice)');
  console.log('  npm run dev:api  |  npm run dev:worker  |  npm run dev:web   (each in its own terminal)');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) runCli(main);
