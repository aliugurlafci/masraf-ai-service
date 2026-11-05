#!/usr/bin/env node
// Starts a development process with the configuration of ~/.orc-dev/dev.env (installation.md section 12).
//
//   node scripts/dev-run.mjs api            npm run dev --workspace @orc/api      (tsx watch)
//   node scripts/dev-run.mjs worker         npm run dev --workspace @orc/worker   (tsx watch)
//   node scripts/dev-run.mjs create-admin [-- --username <u>]   npm run db:create-admin (prompts for the password)
//
// Variables already set in the shell win over dev.env and the built-in defaults. Run `npm run dev:setup` first.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, CliError, runCli } from './lib/common.mjs';
import { buildChildEnv, devEnvPath, devPaths, parseEnvFile } from './lib/dev-env.mjs';

const TARGETS = {
  api: { profileName: 'api', npmArgs: ['run', 'dev', '--workspace', '@orc/api'] },
  worker: { profileName: 'worker', npmArgs: ['run', 'dev', '--workspace', '@orc/worker'] },
  'create-admin': { profileName: 'db', npmArgs: ['run', 'db:create-admin'], forwardArgs: true },
};
const GRACE_MS = 8000;

/** npm is a JS CLI: run it with this Node binary (no shell, no npm.cmd). */
export function npmInvocation(env = process.env) {
  const fromEnv = env.npm_execpath;
  if (fromEnv && /npm-cli\.c?js$/.test(fromEnv) && existsSync(fromEnv)) return [process.execPath, [fromEnv]];
  const nodeDir = dirname(process.execPath);
  for (const candidate of [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]) {
    if (existsSync(candidate)) return [process.execPath, [candidate]];
  }
  if (process.platform === 'win32') throw new CliError('npm-cli.js not found next to node.exe');
  return ['npm', []];
}

function killTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

async function main() {
  const [name, ...rest] = process.argv.slice(2);
  const target = TARGETS[name];
  if (!target) throw new CliError(`usage: dev-run.mjs <${Object.keys(TARGETS).join('|')}> [args]`);
  const file = devEnvPath();
  if (!existsSync(file)) {
    throw new CliError(`${file} not found. Run \`npm run dev:setup\` first (it creates the dev database, Redis and secrets).`);
  }
  const devValues = parseEnvFile(readFileSync(file, 'utf8'));
  let env;
  try {
    env = buildChildEnv(target.profileName, { shellEnv: process.env, devValues, paths: devPaths() });
  } catch (err) {
    throw new CliError(`${err.message}; rerun \`npm run dev:setup\``);
  }
  const [cmd, prefix] = npmInvocation();
  const args = [...prefix, ...target.npmArgs, ...(target.forwardArgs && rest.length > 0 ? ['--', ...rest] : [])];
  const child = spawn(cmd, args, {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
    shell: false,
    windowsHide: false,
    detached: process.platform !== 'win32',
  });
  let stopping = false;
  const stop = (force) => {
    if (stopping && !force) return;
    stopping = true;
    if (force) {
      killTree(child);
      return;
    }
    // Ctrl+C reaches the whole console process group on Windows; others need an explicit signal.
    if (process.platform !== 'win32') {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    setTimeout(() => killTree(child), GRACE_MS).unref();
  };
  process.on('SIGINT', () => stop(false));
  process.on('SIGTERM', () => stop(process.platform === 'win32'));
  process.on('SIGBREAK', () => stop(true));
  process.on('SIGHUP', () => stop(true));
  child.on('error', (err) => {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    killTree(child); // stragglers of the tsx watch tree
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) runCli(main);
