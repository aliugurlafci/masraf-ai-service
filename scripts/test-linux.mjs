#!/usr/bin/env node
// `npm run test:linux`: runs the POSIX/Linux-only test suites (contract §18.2 "Windows": process groups, the
// /proc marker sweep, Unix-socket runner protocol, root-only uid switching) inside the production base image
// node:24.18.0-bookworm-slim, as root, against the SAME loopback test containers the host uses (mssql-test
// 127.0.0.1:14331, redis-test 127.0.0.1:16380; start them with `npm run infra:test:up`). The container image is
// the base image plus git (built once as orc-test-linux:24.18.0-git-cbm<CBM_VERSION>). tests/integration/worker/** run as uid 1000
// (production worker uid; root bypasses the GIT_HOOKS_DIR read-only check); everything else
// runs as root.
//
// - The repository is bind-mounted at /work; node_modules (and every nested node_modules the lockfile has) are
//   NAMED Docker volumes, so the host's (Windows) node_modules are never seen or modified. `npm ci` runs in the
//   container only when package-lock.json, the Node version or the architecture changed.
// - Inside the container a TCP relay listens on 127.0.0.1:14331/16380 and forwards to host.docker.internal, so
//   the global-infra loopback guard (tests/setup/test-env.ts) stays intact and nothing else is reachable.
// - The container is removed on exit (also on Ctrl+C).
//
//   npm run test:linux                       default Linux-only files (unit + integration projects)
//   npm run test:linux -- <vitest args>      e.g. `-- tests/integration/worker` or `-- --project unit`
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IMAGE = 'node:24.18.0-bookworm-slim';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTAINER_ROOT = '/work';
const VOLUME_PREFIX = 'orc-test-linux';
const RELAY_PORTS = [14331, 16380];
const UPSTREAM_HOST = 'host.docker.internal';
const CBM_BIN = '/usr/local/bin/codebase-memory-mcp';
/** Single source of truth: `ARG CBM_VERSION=` of the `cbm` stage in docker/Dockerfile. */
export function readCbmVersion(dockerfileText) {
  const m = /^ARG CBM_VERSION=(\S+)\s*$/m.exec(dockerfileText);
  if (!m) throw new Error('ARG CBM_VERSION not found in docker/Dockerfile');
  return m[1];
}
const CBM_VERSION = readCbmVersion(readFileSync(path.join(ROOT, 'docker', 'Dockerfile'), 'utf8'));
const CBM_IMAGE = `orc-cbm:${CBM_VERSION}`;
const TEST_IMAGE = `orc-test-linux:24.18.0-git-cbm${CBM_VERSION}`;
const STAMP_FILE = 'node_modules/.orc-test-linux.stamp';

/** Files whose POSIX/Linux branches are skipped on the Windows dev host. */
export const DEFAULT_TARGETS = [
  '--project',
  'unit',
  '--project',
  'integration',
  '--project',
  'security',
  'tests/integration/sandbox/',
  'tests/integration/claude-runner/',
  'tests/integration/git-manager/foreign-owner.test.ts',
  'tests/integration/mcp-manager/mcp-real.test.ts',
  'tests/unit/security/paths.test.ts',
  // Run as root: they switch sandbox uids and probe capabilities (not part of the uid-1000 worker run).
  'tests/security/claude-credential-leak.test.ts',
  'tests/security/claude-env.test.ts',
  'tests/security/sandbox-escape.test.ts',
  'tests/unit/runner/',
  'tests/unit/sandbox/',
  'tests/unit/shared/',
];

function log(message) {
  console.log(`[test:linux] ${message}`);
}

function fail(message, code = 1) {
  console.error(`[test:linux] ${message}`);
  process.exit(code);
}

/** `<dir>/node_modules` directories below the root that the lockfile installs (they must be volumes too). */
export function nestedNodeModules(lockText) {
  const lock = JSON.parse(lockText);
  const dirs = new Set();
  for (const key of Object.keys(lock.packages ?? {})) {
    const m = /^(.+?)\/node_modules\//.exec(key);
    if (m && m[1] !== 'node_modules' && !m[1].startsWith('node_modules/')) dirs.add(`${m[1]}/node_modules`);
  }
  return [...dirs].sort();
}

function volumeName(dir) {
  return `${VOLUME_PREFIX}-${dir.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}`;
}

/** The base image plus git (the worker/git-manager integration tests drive real git); built once, then cached. */
function ensureTestImage() {
  if (docker(['image', 'inspect', TEST_IMAGE]).status === 0) return;
  // The pinned, checksum-verified codebase-memory-mcp comes from the production Dockerfile's `cbm` stage (linux/amd64 only).
  log(`building ${CBM_IMAGE} (docker/Dockerfile --target cbm)`);
  const cbm = docker(['build', '-f', 'docker/Dockerfile', '--target', 'cbm', '-t', CBM_IMAGE, '.'], { cwd: ROOT, stdio: 'inherit' });
  if (cbm.status !== 0) fail(`docker build ${CBM_IMAGE} failed (the CBM release asset exists for linux/amd64 only)`);
  log(`building ${TEST_IMAGE} (${IMAGE} + git + codebase-memory-mcp ${CBM_VERSION})`);
  const dockerfile = `FROM ${IMAGE}\nRUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*\nCOPY --from=${CBM_IMAGE} /out/codebase-memory-mcp ${CBM_BIN}\n`;
  const r = docker(['build', '-t', TEST_IMAGE, '-'], { input: dockerfile, stdio: ['pipe', 'inherit', 'inherit'] });
  if (r.status !== 0) fail(`docker build ${TEST_IMAGE} failed`);
}

function docker(args, opts = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', shell: false, windowsHide: true, ...opts });
}

// ---------------------------------------------------------------------------------------------------- host side

function runOnHost(vitestArgs) {
  const version = docker(['version', '--format', '{{.Server.Os}}']);
  if (version.status !== 0) fail(`docker is not available: ${(version.stderr || version.error?.message || '').trim()}`);
  if (version.stdout.trim() !== 'linux') fail(`the Docker engine must run Linux containers (got ${version.stdout.trim()})`);
  if (docker(['image', 'inspect', IMAGE]).status !== 0) {
    log(`pulling ${IMAGE}`);
    if (docker(['pull', IMAGE], { stdio: 'inherit' }).status !== 0) fail(`docker pull ${IMAGE} failed`);
  }
  ensureTestImage();
  const lockText = readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8');
  const volumes = [['node_modules', volumeName('node_modules')], ...nestedNodeModules(lockText).map((d) => [d, volumeName(d)])];
  const name = `${VOLUME_PREFIX}-${process.pid}`;
  const flagEnv = ['ORC_TEST_REAP', 'ORC_TEST_LEAK_STRICT'].flatMap((k) => {
    const v = process.env[k];
    if (v === undefined) return [];
    if (v !== '0' && v !== '1') fail(`${k} must be "0" or "1" (got ${JSON.stringify(v)})`);
    return ['-e', `${k}=${v}`];
  });
  const passEnv = ['ORC_TEST_SA_PASSWORD', 'ORC_TEST_REDIS_PASSWORD', 'NPM_CONFIG_REGISTRY'].filter(
    (k) => (process.env[k] ?? '').length > 0,
  );
  const args = [
    'run',
    '--rm',
    '--init',
    '--name',
    name,
    '--user',
    '0:0',
    '--add-host',
    `${UPSTREAM_HOST}:host-gateway`,
    '-v',
    `${ROOT}:${CONTAINER_ROOT}`,
    ...volumes.flatMap(([dir, vol]) => ['-v', `${vol}:${CONTAINER_ROOT}/${dir}`]),
    '-w',
    CONTAINER_ROOT,
    '-e',
    'CI=1',
    '-e',
    `ORC_TEST_LINUX_UPSTREAM=${UPSTREAM_HOST}`,
    '-e',
    `CODEBASE_MEMORY_MCP_BIN=${CBM_BIN}`,
    '-e',
    'ORC_REQUIRE_CBM=1',
    ...passEnv.flatMap((k) => ['-e', k]),
    ...flagEnv,
    TEST_IMAGE,
    'node',
    'scripts/test-linux.mjs',
    '--in-container',
    ...vitestArgs,
  ];
  log(`running in ${IMAGE} as root (container ${name}; volumes ${volumes.map(([, v]) => v).join(', ')})`);
  const child = spawn('docker', args, { stdio: 'inherit', shell: false, windowsHide: true });
  let interrupted = false;
  const stop = () => {
    if (interrupted) return;
    interrupted = true;
    log('interrupted: removing the container');
    docker(['rm', '-f', name]);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('error', (e) => fail(`failed to start docker: ${e.message}`));
  child.on('exit', (code, signal) => {
    if (signal) fail(`docker terminated by signal ${signal}`);
    process.exit(code ?? 1);
  });
}

// ----------------------------------------------------------------------------------------------- container side

function installDependencies() {
  const lock = readFileSync(path.join(CONTAINER_ROOT, 'package-lock.json'));
  const stamp = createHash('sha256').update(lock).update(process.version).update(process.arch).digest('hex');
  const stampPath = path.join(CONTAINER_ROOT, STAMP_FILE);
  if (existsSync(stampPath) && readFileSync(stampPath, 'utf8').trim() === stamp) {
    log('node_modules volume is up to date');
    return;
  }
  log('installing dependencies into the node_modules volume (npm ci)');
  const r = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { stdio: 'inherit', shell: false, cwd: CONTAINER_ROOT });
  if (r.status !== 0) fail(`npm ci failed with exit code ${String(r.status)}`);
  writeFileSync(stampPath, `${stamp}\n`);
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const s = createConnection({ host, port });
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(3000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** 127.0.0.1:<port> -> <upstream>:<port>, so the loopback-only test config works unchanged in the container. */
function startRelay(upstream, port) {
  const sockets = new Set();
  const server = createServer((client) => {
    const target = createConnection({ host: upstream, port });
    sockets.add(client);
    sockets.add(target);
    const close = () => {
      client.destroy();
      target.destroy();
      sockets.delete(client);
      sockets.delete(target);
    };
    client.on('error', close);
    target.on('error', close);
    client.on('close', close);
    target.on('close', close);
    client.pipe(target);
    target.pipe(client);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () =>
      resolve({
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      }),
    );
  });
}

/** Worker integration tests assert the production uid (1000); root would bypass the read-only hooks dir check. */
const UNPRIVILEGED = { uid: 1000, gid: 1000 };
const WORKER_TESTS = 'tests/integration/worker';

/**
 * Splits vitest args into the root run (sandbox uid switching, claude-runner) and the unprivileged worker run.
 * No args: the default set as root minus the worker dir, plus the worker dir as uid 1000.
 */
export function splitTargets(vitestArgs) {
  if (vitestArgs.length === 0) {
    return { rootArgs: [...DEFAULT_TARGETS, '--exclude', `${WORKER_TESTS}/**`], workerArgs: [WORKER_TESTS] };
  }
  const isWorker = (a) => !a.startsWith('-') && a.replaceAll('\\', '/').replace(/^\.\//, '').startsWith(WORKER_TESTS);
  const worker = vitestArgs.filter(isWorker);
  if (worker.length === 0) return { rootArgs: vitestArgs, workerArgs: null };
  const rest = vitestArgs.filter((a) => !isWorker(a));
  const hasRootTargets = rest.some((a) => !a.startsWith('-'));
  return { rootArgs: hasRootTargets ? rest : null, workerArgs: worker };
}

function runVitest(args, user) {
  const env = { ...process.env, NO_COLOR: '1' };
  if (user) {
    env['HOME'] = '/tmp/orc-test-home';
    mkdirSync(env['HOME'], { recursive: true });
    chownSync(env['HOME'], user.uid, user.gid);
    // vite/vitest write their config bundle and caches below node_modules (a root-owned named volume).
    for (const d of ['.vite-temp', '.vite', '.vitest']) {
      const dir = path.join(CONTAINER_ROOT, 'node_modules', d);
      mkdirSync(dir, { recursive: true });
      chownSync(dir, user.uid, user.gid);
    }
  }
  log(`node ${process.version} ${process.arch}, uid ${String(user?.uid ?? process.getuid?.())}; vitest run ${args.join(' ')}`);
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...args], {
    cwd: CONTAINER_ROOT,
    stdio: 'inherit',
    shell: false,
    env,
    ...(user ? { uid: user.uid, gid: user.gid } : {}),
  });
  return new Promise((resolve) => {
    child.on('error', (e) => {
      console.error(`[test:linux] failed to start vitest: ${e.message}`);
      resolve(1);
    });
    child.on('exit', (c, signal) => resolve(signal ? 1 : (c ?? 1)));
  });
}

async function runInContainer(vitestArgs) {
  if (process.platform !== 'linux') fail('--in-container is only valid inside the Linux test container');
  installDependencies();
  const upstream = process.env['ORC_TEST_LINUX_UPSTREAM'] ?? UPSTREAM_HOST;
  const relays = [];
  for (const port of RELAY_PORTS) {
    if (!(await canConnect(upstream, port))) {
      log(`WARNING: ${upstream}:${port} is not reachable; start the test containers with \`npm run infra:test:up\``);
    }
    relays.push(await startRelay(upstream, port));
  }
  const { rootArgs, workerArgs } = splitTargets(vitestArgs);
  let code = 0;
  if (rootArgs) code = await runVitest(rootArgs, null);
  if (workerArgs) code = (await runVitest(workerArgs, UNPRIVILEGED)) || code;
  await Promise.all(relays.map((r) => r.close()));
  process.exit(code);
}

const argv = process.argv.slice(2);
if (argv[0] === '--in-container') {
  await runInContainer(argv.slice(1));
} else {
  runOnHost(argv[0] === '--' ? argv.slice(1) : argv);
}
