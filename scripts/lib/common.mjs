// Shared helpers of the operator scripts (generate-secrets, generate-certs, backup, restore).
// Plain Node (no dependencies); every external command runs with shell:false.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Raised for operator errors: printed without a stack trace, exit code 1. */
export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/** Runs `main` and maps failures to a one-line message plus exit code. */
export function runCli(main) {
  Promise.resolve()
    .then(main)
    .catch((err) => {
      if (err instanceof CliError) {
        console.error(`error: ${err.message}`);
        process.exitCode = err.exitCode;
        return;
      }
      console.error(err);
      process.exitCode = 1;
    });
}

/** Secrets directory: --dir/--secrets-dir > ORC_SECRETS_DIR (as used by docker-compose.yml) > ./secrets. */
export function resolveSecretsDir(option) {
  const raw = option ?? process.env.ORC_SECRETS_DIR ?? './secrets';
  return isAbsolute(raw) ? raw : resolve(REPO_ROOT, raw);
}

/** Reads a secret file the way @orc/shared/node does: exactly one trailing newline removed. */
export function readSecretFile(path) {
  if (!existsSync(path))
    throw new CliError(`secret file ${path} does not exist (npm run secrets:generate)`);
  return readFileSync(path, 'utf8').replace(/\r?\n$/, '');
}

/** SQL Server database names accepted by the scripts (same rule as DB_NAME, contract §4.2). */
export const DB_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

export function assertDbName(name, label = 'database') {
  if (typeof name !== 'string' || !DB_NAME_PATTERN.test(name)) {
    throw new CliError(`${label} name must match ${DB_NAME_PATTERN.source}`);
  }
  return name;
}

/** Synchronous command; returns {status, stdout, stderr}. Never uses a shell. */
export function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd ?? REPO_ROOT,
    input: options.input,
    env: options.env ?? process.env,
    encoding: options.encoding === 'buffer' ? undefined : 'utf8',
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    stdio: options.inherit ? ['ignore', 'inherit', 'inherit'] : 'pipe',
    shell: false,
    windowsHide: true,
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') throw new CliError(`${cmd} not found on PATH`);
    throw result.error;
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Like run() but throws CliError with the stderr tail on a non-zero exit. */
export function runChecked(cmd, args, options = {}) {
  const result = run(cmd, args, options);
  if (result.status !== 0) {
    const tail = String(result.stderr || result.stdout || '')
      .trim()
      .split('\n')
      .slice(-15)
      .join('\n');
    throw new CliError(
      `${options.what ?? `${cmd} ${args[0] ?? ''}`} failed (exit ${result.status})${tail ? `:\n${tail}` : ''}`,
    );
  }
  return result;
}

/** Asynchronous command with a readable stream piped into its stdin (large uploads). */
export function runWithStdinStream(cmd, args, stream, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    child.stdout.resume();
    child.on('error', reject);
    stream.on('error', (err) => {
      child.kill();
      reject(err);
    });
    child.stdin.on('error', () => undefined);
    stream.pipe(child.stdin);
    child.on('close', (status) => {
      if (status === 0) resolvePromise();
      else reject(new CliError(`${options.what ?? cmd} failed (exit ${status}): ${stderr.trim()}`));
    });
  });
}

/**
 * Global `docker compose` arguments from --compose-file (repeatable) and --project-name. Without
 * them docker compose uses ./docker-compose.yml (project `orc`) or COMPOSE_FILE/COMPOSE_PROJECT_NAME.
 */
export function composeArgs(values) {
  const args = ['compose'];
  for (const file of values['compose-file'] ?? []) args.push('-f', file);
  if (values['project-name']) args.push('-p', values['project-name']);
  return args;
}

export const COMPOSE_OPTIONS = {
  'compose-file': { type: 'string', multiple: true },
  'project-name': { type: 'string' },
};

/** Fails early with a clear message when the mssql service is not running. */
export function assertServiceRunning(compose, service) {
  const result = runChecked('docker', [...compose, 'ps', '--status', 'running', '--services'], {
    what: 'docker compose ps',
  });
  const running = result.stdout.split(/\r?\n/).map((s) => s.trim());
  if (!running.includes(service)) {
    throw new CliError(`service "${service}" is not running (npm run compose:up)`);
  }
  return running;
}

/** UTC timestamp usable in file names: 20261103T081500Z. */
export function fileTimestamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}
