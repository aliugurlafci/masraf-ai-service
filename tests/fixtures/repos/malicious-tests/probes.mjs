// Sandbox-escape probes of the malicious-tests fixture (contract §10.11 item 9). The project test command runs them
// inside the sandbox (`node --test`, JUnit report); every probe is one test case that PASSES only when the escape
// attempt is blocked, so `test:compose` asserts a passed run without failures. Each finding (something reachable)
// becomes a JUnit failure naming what was reached.
//
// Targets: `orc-smoke-targets.json` at the repository root when present (written by scripts/compose-smoke.mjs:
// {uidBase, maxLeases, proxyUrl, externalIp, socketPath, dirs: [{path, mustExist, listable?}], files: [{path, mustExist}],
// tcp?: [[host, port]]}); otherwise the defaults below, derived from the worktree location
// `<WORKSPACES_ROOT>/<projectId>/<taskId>/a<n>`.
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import net from 'node:net';
import path from 'node:path';

export const TARGETS_FILE = 'orc-smoke-targets.json';
export const DEFAULT_TCP = [
  ['mssql', 1433],
  ['redis', 6379],
];
/** Service credentials that must never reach a test process (secrets are mounted only into api/worker). */
export const FORBIDDEN_ENV = [
  { name: 'DB_* variables', test: (n) => /^DB_/i.test(n) },
  { name: 'REDIS_* variables', test: (n) => /^REDIS_/i.test(n) },
  { name: 'MSSQL_* / EGRESS_* variables', test: (n) => /^(MSSQL_|EGRESS_)/i.test(n) },
  { name: '*_FILE secret paths', test: (n) => /_FILE$/i.test(n) },
  { name: 'ANTHROPIC_API_KEY', test: (n) => /^ANTHROPIC_API_KEY$/i.test(n) },
  { name: 'proxy credentials (HTTP(S)_PROXY)', test: (n) => /^HTTPS?_PROXY$/i.test(n) },
];

const DENIED = new Set(['EACCES', 'EPERM', 'EROFS']);

function errCode(fn) {
  try {
    fn();
    return 'OK';
  } catch (err) {
    return err && typeof err.code === 'string' ? err.code : 'ERROR';
  }
}

/** Blocked = permission denied, or absent when the target is allowed to be absent. */
export function blocked(code, mustExist) {
  return DENIED.has(code) || (!mustExist && (code === 'ENOENT' || code === 'ENOTDIR'));
}

/** Targets file merged with the defaults derived from `cwd` (the attempt worktree). */
export function loadTargets(cwd = process.cwd()) {
  const file = path.join(cwd, TARGETS_FILE);
  const given = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const projectDir = path.dirname(path.dirname(cwd));
  const ws = path.dirname(projectDir);
  const defaults = {
    dirs: [
      { path: '/run/secrets', mustExist: false },
      { path: path.join(ws, '.repos'), mustExist: false },
      { path: path.join(ws, '.orc'), mustExist: false },
      { path: projectDir, mustExist: false },
      { path: path.join(projectDir, '_base'), mustExist: false },
    ],
    files: [
      { path: '/run/secrets/db_worker_password', mustExist: false },
      { path: '/run/secrets/db_api_password', mustExist: false },
      { path: '/run/secrets/redis_password', mustExist: false },
      { path: '/run/secrets/anthropic_api_key', mustExist: false },
    ],
  };
  const merge = (a, b) => {
    const seen = new Map();
    for (const t of [...a, ...b]) seen.set(path.resolve(t.path), t);
    return [...seen.values()];
  };
  const tcp = Array.isArray(given.tcp) ? given.tcp : DEFAULT_TCP;
  const extraTcp = [];
  if (!Array.isArray(given.tcp) && given.socketPath) extraTcp.push(['api', 4000], ['worker', 4100]);
  if (typeof given.externalIp === 'string' && given.externalIp !== '')
    extraTcp.push([given.externalIp, 443]);
  return {
    ...given,
    dirs: merge(defaults.dirs, Array.isArray(given.dirs) ? given.dirs : []),
    files: merge(defaults.files, Array.isArray(given.files) ? given.files : []),
    tcp: [...tcp, ...extraTcp],
  };
}

function tcpConnect(options, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const socket = net.connect(options);
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done('TIMEOUT'));
    socket.once('connect', () => done('CONNECTED'));
    socket.once('error', (err) => done(err && err.code ? err.code : 'ERROR'));
  });
}

function proxyConnect(proxyUrl, authority) {
  return new Promise((resolve) => {
    const proxy = new URL(proxyUrl);
    const req = request({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: authority,
      headers: { host: authority },
      timeout: 8000,
    });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve(result);
    };
    req.once('connect', (res, socket) => {
      socket.destroy();
      done(res.statusCode);
    });
    req.once('response', (res) => {
      res.resume();
      done(res.statusCode);
    });
    req.once('timeout', () => done('TIMEOUT'));
    req.once('error', (err) => done(err && err.code ? err.code : 'ERROR'));
    req.end();
  });
}

/**
 * Runs every probe; returns `{name, ok, detail}` per check (`ok` = blocked). Never throws for a probe outcome.
 * `env` defaults to this process' environment.
 */
export async function runProbes(targets, env = process.env) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: String(detail) });

  if (typeof process.getuid === 'function' && Number.isInteger(targets.uidBase)) {
    const uid = process.getuid();
    const max = Number.isInteger(targets.maxLeases) ? targets.maxLeases : 64;
    add(
      'runs as a sandbox uid',
      uid >= targets.uidBase && uid < targets.uidBase + max,
      `uid=${uid}`,
    );
  }

  for (const dir of targets.dirs) {
    const list = errCode(() => readdirSync(dir.path));
    if (dir.listable) {
      // ADR-0034: anchor directories are listable by design; the positive check proves the listing works.
      add(`list ${dir.path} is allowed (ADR-0034)`, list === 'OK', list);
    } else {
      add(`list ${dir.path} is denied`, blocked(list, dir.mustExist), list);
    }
    const probe = path.join(dir.path, `.orc-malicious-probe-${process.pid}`);
    const write = errCode(() => writeFileSync(probe, 'x', { flag: 'wx' }));
    if (write === 'OK') errCode(() => unlinkSync(probe));
    add(`write into ${dir.path} is denied`, blocked(write, dir.mustExist), write);
  }
  for (const file of targets.files) {
    const read = errCode(() => readFileSync(file.path));
    add(`read ${file.path} is denied`, blocked(read, file.mustExist), read);
  }

  const names = Object.keys(env);
  for (const rule of FORBIDDEN_ENV) {
    const found = names.filter((n) => rule.test(n));
    add(`environment has no ${rule.name}`, found.length === 0, found.join(',') || 'none');
  }

  const tcp = await Promise.all(targets.tcp.map(([host, port]) => tcpConnect({ host, port })));
  targets.tcp.forEach(([host, port], i) =>
    add(`TCP ${host}:${port} is unreachable`, tcp[i] !== 'CONNECTED', tcp[i]),
  );

  if (typeof targets.socketPath === 'string' && targets.socketPath !== '') {
    const sock = await tcpConnect({ path: targets.socketPath });
    add('runner socket is not connectable', sock !== 'CONNECTED', sock);
  }
  if (typeof targets.proxyUrl === 'string' && targets.proxyUrl !== '') {
    const status = await proxyConnect(targets.proxyUrl, 'api.anthropic.com:443');
    add('egress CONNECT without proxy credentials answers 407', status === 407, status);
  }
  return checks;
}
