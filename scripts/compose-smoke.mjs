#!/usr/bin/env node
// Pre-release gate `npm run test:compose` (contract §18.5, §10.11 item 9, §19; requirements §15/§16).
//
//   node scripts/compose-smoke.mjs [--keep] [--no-build] [--project-name <name>]
//        [--https-port <port>] [--http-port <port>] [--fork-bomb <n>] [--external-ip <ip>]
//
// Brings up the full production topology (docker-compose.yml) with docker-compose.smoke.yml, which
// makes the runner execute the read-only mounted fake CLI (tests/fixtures/fake-claude) instead of
// Claude Code, and then proves end to end:
//   1. every service healthy (`up --wait`), web HTTPS + /health/ready, 8080 -> 301, worker, runner
//      and egress-proxy health endpoints;
//   2. `orc-db create-admin`, login over the web TLS endpoint (certificate verified against the
//      generated local CA), project registration of a generated sample repository, MCP index status;
//   3. a task through POST /tasks with SSE followed until `end`: completed, diff, changed files,
//      test results, logs in MSSQL, session, events;
//   4. cancel and timeout (no sandbox process left behind);
//   5. sandbox-escape probes in the Claude stage (`@@fake exec`) and in the test stage (fixture
//      tests/fixtures/repos/malicious-tests when present, otherwise the same probes generated here):
//      sandbox uid, /run/secrets, mssql/redis/api/worker/external TCP, runner socket, sibling
//      worktree, mirrors, .orc, claude-home, cbm-cache, environment, egress CONNECT 407/403;
//   6. `@@fake fork-bomb` bounded by RUNNER_NPROC while worker and runner stay healthy;
//   7. every container user non-root except the runner launcher; worker `id -u` = 1000; runner
//      children inside the sandbox uid range; no direct internet route from api, worker, runner;
//   8. backup (scripts/backup.mjs) and the documented restore (scripts/restore.mjs) into
//      orchestrator_restore_check with matching row counts of Tasks, TaskLogs and AuditLogs.
// Secrets, certificates and sample repositories are generated into a temporary directory (dummy
// Anthropic key; real secrets are never read). Images are tagged ORC_IMAGE_TAG=smoke. The stack is
// removed with `down -v` at the end; --keep keeps containers' volumes and the temporary directory.
//
// Fixture convention for tests/fixtures/repos/malicious-tests: its files are committed as a
// repository; `orc-smoke-targets.json` (probe targets: sibling paths, uid range, proxy URL) is
// added at its root; `fixture.json` may set {"testCommand": [...], "junitReportPath": "..."}
// (default: node --test with the JUnit reporter). Each probe is a test that passes only when the
// escape attempt is blocked, so the gate requires a passed test run without failures.
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { CliError, REPO_ROOT, run, runChecked, runCli } from './lib/common.mjs';
import { sqlcmd } from './lib/mssql.mjs';

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.smoke.yml'];
const FAKE_CLI_VERSION = '2.1.316';
const RUNNER_UID_BASE = 20000;
const RUNNER_MAX_LEASES = 64;
const RUNNER_NPROC = 512;
const WORKER_UID = 1000;
const LIVE_DB = 'orchestrator';
const RESTORE_CHECK_DB = 'orchestrator_restore_check';
const COUNTED_TABLES = ['Tasks', 'TaskLogs', 'AuditLogs'];
const SETTLED = new Set(['completed', 'failed', 'timed_out', 'cancelled', 'blocked']);
const MALICIOUS_FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'repos', 'malicious-tests');
const DEFAULT_TEST_COMMAND = [
  'node',
  '--test',
  '--test-reporter=junit',
  '--test-reporter-destination=junit.xml',
];
const OPENSSL_IMAGE = 'mcr.microsoft.com/mssql/server:2022-latest';
const PATHS = {
  workspaces: '/var/lib/orc/workspaces',
  claudeHome: '/var/lib/orc/claude',
  cbmCache: '/var/lib/orc/cbm-cache',
  runnerSocketDir: '/run/orc-runner',
};

// ---------------------------------------------------------------------------------------------
// Probes executed INSIDE the sandbox (as a lease uid). Serialized with Function.prototype.toString,
// so the function must stay self-contained (dynamic imports only, no outer references).
// targets: { uidBase, maxLeases, workerGid, proxyUrl, externalIp, socketPath,
//            dirs: [{path, mustExist, listable?}], files: [{path, mustExist}] }
// dirs: every entry must refuse writes; `listable: true` marks anchor directories whose listing is
// allowed by design (ADR-0034: <CBM_CACHE_DIR>, p/, w/ are 1775 root:<WORKER_GID>). For those the
// list check is a positive one ("is allowed") instead of "denied".
// ---------------------------------------------------------------------------------------------
async function sandboxProbes(targets, stage) {
  const fs = await import('node:fs');
  const net = await import('node:net');
  const http = await import('node:http');
  const path = await import('node:path');
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: String(detail) });
  const errCode = (fn) => {
    try {
      fn();
      return 'OK';
    } catch (err) {
      return err && typeof err.code === 'string' ? err.code : 'ERROR';
    }
  };
  const denied = (code) => code === 'EACCES' || code === 'EPERM' || code === 'EROFS';

  const uid = process.getuid();
  const gid = process.getgid();
  add(
    `${stage}: uid inside the sandbox range`,
    uid >= targets.uidBase && uid < targets.uidBase + targets.maxLeases,
    `uid=${uid}`,
  );
  add(`${stage}: primary gid equals uid`, gid === uid, `gid=${gid}`);
  const groups = process.getgroups().filter((g) => g !== gid);
  add(`${stage}: no supplementary groups`, groups.length === 0, groups.join(',') || 'none');

  const secrets = errCode(() => fs.readdirSync('/run/secrets'));
  add(
    `${stage}: /run/secrets absent or unreadable`,
    secrets === 'ENOENT' || denied(secrets),
    secrets,
  );

  for (const dir of targets.dirs) {
    const list = errCode(() => fs.readdirSync(dir.path));
    if (dir.listable) {
      // ADR-0034: anchor directories are listable by design; the positive check proves the listing works.
      add(`${stage}: list ${dir.path} is allowed (ADR-0034)`, list === 'OK', list);
    } else {
      add(
        `${stage}: list ${dir.path} denied`,
        denied(list) || (!dir.mustExist && list === 'ENOENT'),
        list,
      );
    }
    const probeFile = path.join(dir.path, `.orc-smoke-probe-${process.pid}`);
    const write = errCode(() => fs.writeFileSync(probeFile, 'x', { flag: 'wx' }));
    if (write === 'OK') errCode(() => fs.unlinkSync(probeFile));
    add(
      `${stage}: write into ${dir.path} denied`,
      denied(write) || (!dir.mustExist && write === 'ENOENT'),
      write,
    );
  }
  for (const file of targets.files) {
    const read = errCode(() => fs.readFileSync(file.path));
    add(
      `${stage}: read ${file.path} denied`,
      denied(read) || (!file.mustExist && read === 'ENOENT'),
      read,
    );
  }

  const names = Object.keys(process.env);
  const forbidden = names.filter(
    (n) =>
      /^(DB_|REDIS_|MSSQL_|EGRESS_)/i.test(n) ||
      /_FILE$/i.test(n) ||
      (stage !== 'claude' && /^(ANTHROPIC_API_KEY|HTTPS?_PROXY)$/i.test(n)),
  );
  add(
    `${stage}: environment carries no service credentials`,
    forbidden.length === 0,
    forbidden.join(',') || 'none',
  );

  const connect = (options) =>
    new Promise((resolve) => {
      const socket = net.connect(options);
      const done = (result) => {
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(4000, () => done('TIMEOUT'));
      socket.once('connect', () => done('CONNECTED'));
      socket.once('error', (err) => done(err && err.code ? err.code : 'ERROR'));
    });
  const tcpTargets = [
    ['mssql', 1433],
    ['redis', 6379],
    ['api', 4000],
    ['worker', 4100],
    [targets.externalIp, 443],
  ];
  const tcpResults = await Promise.all(tcpTargets.map(([host, port]) => connect({ host, port })));
  tcpTargets.forEach(([host, port], i) =>
    add(`${stage}: TCP ${host}:${port} unreachable`, tcpResults[i] !== 'CONNECTED', tcpResults[i]),
  );
  const sock = await connect({ path: targets.socketPath });
  add(`${stage}: runner socket not connectable`, sock !== 'CONNECTED', sock);

  const proxyConnect = (proxyUrl, authority, credentials) =>
    new Promise((resolve) => {
      const proxy = new URL(proxyUrl);
      const headers = { host: authority };
      if (credentials) {
        headers['proxy-authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
      }
      const req = http.request({
        host: proxy.hostname,
        port: Number(proxy.port || 80),
        method: 'CONNECT',
        path: authority,
        headers,
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
  const noAuth = await proxyConnect(targets.proxyUrl, 'api.anthropic.com:443', null);
  add(`${stage}: egress CONNECT without proxy credentials answers 407`, noAuth === 407, noAuth);
  if (stage === 'claude') {
    const raw = process.env.HTTPS_PROXY || process.env.https_proxy || '';
    if (raw === '') {
      add('claude: proxy URL with credentials present', false, 'HTTPS_PROXY missing');
    } else {
      const url = new URL(raw);
      const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
      const other = await proxyConnect(
        `${url.protocol}//${url.host}`,
        'example.com:443',
        credentials,
      );
      add('claude: egress CONNECT to a non-allow-listed host answers 403', other === 403, other);
    }
  }
  return { stage, uid, checks };
}

// ---------------------------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------------------------
const startedAt = Date.now();
const passed = [];

function log(message) {
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(0).padStart(4, ' ');
  console.log(`[smoke ${seconds}s] ${message}`);
}

function ok(message) {
  passed.push(message);
  log(`ok   ${message}`);
}

function assert(condition, message) {
  if (!condition) throw new CliError(`ASSERTION FAILED: ${message}`);
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function waitFor(what, fn, { timeoutMs, intervalMs = 2000 }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last.done) return last.value;
    if (Date.now() > deadline) {
      throw new CliError(
        `timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}${last.detail ? ` (${last.detail})` : ''}`,
      );
    }
    await sleep(intervalMs);
  }
}

function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function parseJsonLines(text) {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  if (trimmed.startsWith('[')) return JSON.parse(trimmed);
  return trimmed
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------------------------
// Docker Compose helpers
// ---------------------------------------------------------------------------------------------
function makeCompose(projectName) {
  const base = ['compose', ...COMPOSE_FILES.flatMap((f) => ['-f', f]), '-p', projectName];
  const compose = (args, options = {}) =>
    runChecked('docker', [...base, ...args], { what: `docker compose ${args[0]}`, ...options });
  compose.base = base;
  return compose;
}

function listContainers(compose) {
  return parseJsonLines(compose(['ps', '-a', '--format', 'json']).stdout).map((c) => ({
    id: c.ID,
    service: c.Service,
    state: c.State,
    name: c.Name,
  }));
}

/** Processes of a running container: [{uid, pid, comm}] (docker top runs ps in the engine host). */
function containerProcesses(containerId) {
  const out = runChecked('docker', ['top', containerId, '-o', 'uid,pid,comm'], {
    what: 'docker top',
  }).stdout;
  return out
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 3 && /^\d+$/.test(cols[0]))
    .map((cols) => ({ uid: Number(cols[0]), pid: Number(cols[1]), comm: cols.slice(2).join(' ') }));
}

function serviceContainerId(compose, service) {
  const container = listContainers(compose).find(
    (c) => c.service === service && c.state === 'running',
  );
  if (!container) throw new CliError(`service ${service} is not running`);
  return container.id;
}

function sandboxProcesses(compose) {
  return containerProcesses(serviceContainerId(compose, 'runner')).filter((p) => p.uid !== 0);
}

function containerHealth(containerId) {
  return runChecked('docker', [
    'inspect',
    '-f',
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
    containerId,
  ]).stdout.trim();
}

function assertContainerUsers(compose, label) {
  const containers = listContainers(compose);
  assert(containers.length > 0, 'no containers found');
  for (const c of containers) {
    if (c.state !== 'running') {
      const user = runChecked('docker', ['inspect', '-f', '{{.Config.User}}', c.id]).stdout.trim();
      assert(
        c.service === 'runner' || !['', '0', 'root', '0:0'].includes(user),
        `${c.name} (${c.state}) is configured to run as root (user "${user}")`,
      );
      continue;
    }
    const processes = containerProcesses(c.id);
    assert(processes.length > 0, `docker top returned no processes for ${c.name}`);
    for (const p of processes) {
      if (c.service === 'runner') {
        if (p.uid === 0) {
          assert(
            ['docker-init', 'node', 'MainThread'].includes(p.comm),
            `runner root process is not the launcher: pid ${p.pid} ${p.comm}`,
          );
        } else {
          assert(
            p.uid >= RUNNER_UID_BASE && p.uid < RUNNER_UID_BASE + RUNNER_MAX_LEASES,
            `runner child pid ${p.pid} (${p.comm}) runs as uid ${p.uid}, outside ${RUNNER_UID_BASE}..${RUNNER_UID_BASE + RUNNER_MAX_LEASES - 1}`,
          );
        }
      } else {
        assert(p.uid !== 0, `${c.name}: pid ${p.pid} (${p.comm}) runs as root`);
      }
    }
  }
  ok(
    `${label}: every container runs non-root except the runner launcher (${containers.length} containers)`,
  );
}

function assertNoDirectInternet(compose, externalIp) {
  const code = [
    "const s=require('node:net').connect({host:process.argv[1],port:443});",
    'const d=(r)=>{s.destroy();process.stdout.write(r);};',
    "s.setTimeout(4000,()=>d('TIMEOUT'));s.once('connect',()=>d('CONNECTED'));",
    "s.once('error',(e)=>d(e.code||'ERROR'));",
  ].join('');
  for (const service of ['api', 'worker', 'runner']) {
    const result = compose(['exec', '-T', service, 'node', '-e', code, externalIp]).stdout.trim();
    assert(result !== 'CONNECTED', `${service} reached ${externalIp}:443 directly`);
    ok(`${service} has no direct route to ${externalIp}:443 (${result})`);
  }
}

// ---------------------------------------------------------------------------------------------
// HTTPS client for the web TLS endpoint (CA-verified) with session cookie and CSRF token
// ---------------------------------------------------------------------------------------------
function createClient({ port, ca, origin }) {
  const state = { cookie: null, csrf: null };

  function send(method, path, { body, headers = {}, accept = 'application/json' } = {}) {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const finalHeaders = {
      host: `localhost:${port}`,
      accept,
      'x-request-id': `smoke-${randomUUID()}`,
      ...headers,
    };
    if (state.cookie) finalHeaders.cookie = state.cookie;
    if (payload) {
      finalHeaders['content-type'] = 'application/json';
      finalHeaders['content-length'] = String(payload.length);
    }
    if (!['GET', 'HEAD'].includes(method)) {
      finalHeaders.origin = origin;
      if (state.csrf) finalHeaders['x-csrf-token'] = state.csrf;
    }
    return new Promise((resolvePromise, reject) => {
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port,
          servername: 'localhost',
          ca,
          method,
          path,
          headers: finalHeaders,
          timeout: 60000,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            if (/json/.test(String(res.headers['content-type'] ?? '')) && text !== '') {
              try {
                json = JSON.parse(text);
              } catch {
                json = null;
              }
            }
            resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, text, json });
          });
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`${method} ${path} timed out`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async function call(method, path, options = {}) {
    const res = await send(method, path, options);
    const expected = options.expect ?? [200];
    if (!expected.includes(res.status)) {
      throw new CliError(
        `${method} ${path} answered ${res.status} (expected ${expected.join('/')}): ${res.text.slice(0, 600)}`,
      );
    }
    return res;
  }

  async function login(username, password) {
    const res = await call('POST', '/api/v1/auth/login', { body: { username, password } });
    const setCookie = [res.headers['set-cookie'] ?? []].flat();
    const session = setCookie
      .map((c) => c.split(';')[0])
      .find((c) => c.startsWith('__Host-orc_sid='));
    assert(session, 'login did not set the __Host-orc_sid cookie (COOKIE_SECURE must be true)');
    assert(typeof res.json?.csrfToken === 'string', 'login response has no csrfToken');
    state.cookie = session;
    state.csrf = res.json.csrfToken;
    return res.json;
  }

  /**
   * Reads GET /tasks/:id/stream until `end` (reconnecting with Last-Event-ID) or 204.
   * Returns {events, end} where end is the `end` payload or null after a 204.
   */
  async function followStream(taskId, { timeoutMs }) {
    const deadline = Date.now() + timeoutMs;
    const events = [];
    let lastEventId = null;
    for (;;) {
      if (Date.now() > deadline) throw new CliError(`SSE of task ${taskId} did not end in time`);
      const outcome = await new Promise((resolvePromise, reject) => {
        const headers = {
          host: `localhost:${port}`,
          accept: 'text/event-stream',
          cookie: state.cookie,
        };
        if (lastEventId) headers['last-event-id'] = lastEventId;
        const req = httpsRequest(
          {
            host: '127.0.0.1',
            port,
            servername: 'localhost',
            ca,
            method: 'GET',
            path: `/api/v1/tasks/${taskId}/stream`,
            headers,
          },
          (res) => {
            if (res.statusCode === 204) {
              res.resume();
              resolvePromise({ kind: 'no-content' });
              return;
            }
            if (res.statusCode !== 200) {
              res.resume();
              reject(new CliError(`SSE of task ${taskId} answered ${res.statusCode}`));
              return;
            }
            res.setEncoding('utf8');
            res.on('error', () => undefined);
            let buffer = '';
            let finished = false;
            const idle = setInterval(() => {
              if (Date.now() > deadline) req.destroy();
            }, 1000);
            res.on('data', (chunk) => {
              buffer += chunk;
              const blocks = buffer.split(/\r?\n\r?\n/);
              buffer = blocks.pop() ?? '';
              for (const block of blocks) {
                const event = { id: null, type: 'message', data: '' };
                for (const line of block.split(/\r?\n/)) {
                  if (line.startsWith('id:')) event.id = line.slice(3).trim();
                  else if (line.startsWith('event:')) event.type = line.slice(6).trim();
                  else if (line.startsWith('data:')) event.data += line.slice(5).trim();
                }
                if (event.data === '') continue;
                if (event.id) lastEventId = event.id;
                let data;
                try {
                  data = JSON.parse(event.data);
                } catch {
                  data = null;
                }
                events.push({ type: event.type, id: event.id, data });
                if (event.type === 'end' && !finished) {
                  finished = true;
                  clearInterval(idle);
                  req.destroy();
                  resolvePromise({ kind: 'end', data });
                }
              }
            });
            res.on('close', () => {
              clearInterval(idle);
              if (!finished) resolvePromise({ kind: 'closed' });
            });
          },
        );
        req.on('error', (err) => {
          if (err && err.code === 'ECONNRESET') resolvePromise({ kind: 'closed' });
          else reject(err);
        });
        req.end();
      });
      if (outcome.kind === 'end') return { events, end: outcome.data };
      if (outcome.kind === 'no-content') return { events, end: null };
      await sleep(1000);
    }
  }

  return { send, call, login, followStream };
}

// ---------------------------------------------------------------------------------------------
// Repositories generated for the smoke run
// ---------------------------------------------------------------------------------------------
function git(cwd, args, hooksDir) {
  runChecked(
    'git',
    [
      '-c',
      'core.autocrlf=false',
      '-c',
      'commit.gpgsign=false',
      '-c',
      `core.hooksPath=${hooksDir}`,
      '-c',
      'user.name=Orc Smoke',
      '-c',
      'user.email=smoke@localhost',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd, what: `git ${args[0]}` },
  );
}

function makeTreeReadable(dir) {
  if (process.platform === 'win32') return;
  chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) makeTreeReadable(full);
    else if (entry.isFile()) chmodSync(full, 0o644);
  }
}

function writeRepo(projectsDir, name, files, hooksDir) {
  const dir = join(projectsDir, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  git(dir, ['init', '-q', '.'], hooksDir);
  git(dir, ['add', '-A'], hooksDir);
  git(dir, ['commit', '-q', '-m', `${name}: initial commit`], hooksDir);
  makeTreeReadable(dir);
  return dir;
}

const SAMPLE_FILES = {
  'package.json': `${JSON.stringify({ name: 'orc-smoke-sample', private: true, version: '1.0.0', type: 'module' }, null, 2)}\n`,
  '.gitignore': 'junit.xml\n',
  'CLAUDE.md': '# Smoke sample\n\nTiny repository generated by scripts/compose-smoke.mjs.\n',
  'src/math.mjs': 'export function add(a, b) {\n  return a + b;\n}\n',
  'test/math.test.mjs':
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.mjs';\n\ntest('add', () => {\n  assert.equal(add(2, 3), 5);\n});\n",
};

const GREETING_SOURCE = 'export function greet(name) {\n  return `Hello, ${name}!`;\n}\n';
const GREETING_TEST =
  "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from '../src/greeting.mjs';\n\ntest('greet', () => {\n  assert.equal(greet('orc'), 'Hello, orc!');\n});\n";

function probeTestFile() {
  return [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    '',
    "const targets = JSON.parse(readFileSync(new URL('./orc-smoke-targets.json', import.meta.url), 'utf8'));",
    `const sandboxProbes = ${sandboxProbes.toString()};`,
    "const report = await sandboxProbes(targets, 'test');",
    'for (const check of report.checks) {',
    '  test(check.name, () => assert.ok(check.ok, `${check.name}: ${check.detail}`));',
    '}',
    '',
  ].join('\n');
}

/** Probe repository: the malicious-tests fixture when present, otherwise generated probes. */
function writeProbeRepo(projectsDir, targets, hooksDir) {
  const files = {
    '.gitignore': 'junit.xml\n',
    'orc-smoke-targets.json': `${JSON.stringify(targets, null, 2)}\n`,
  };
  let testCommand = DEFAULT_TEST_COMMAND;
  let junitReportPath = 'junit.xml';
  let source = 'generated probes';
  const dir = join(projectsDir, 'smoke-probes');
  if (existsSync(MALICIOUS_FIXTURE) && statSync(MALICIOUS_FIXTURE).isDirectory()) {
    source = 'tests/fixtures/repos/malicious-tests';
    cpSync(MALICIOUS_FIXTURE, dir, {
      recursive: true,
      filter: (src) => !/[\\/]\.git([\\/]|$)/.test(src.slice(MALICIOUS_FIXTURE.length)),
    });
    const manifest = join(dir, 'fixture.json');
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
      if (Array.isArray(parsed.testCommand)) testCommand = parsed.testCommand;
      if (parsed.junitReportPath === null || typeof parsed.junitReportPath === 'string') {
        junitReportPath = parsed.junitReportPath;
      }
    }
  } else {
    files['probes.test.mjs'] = probeTestFile();
  }
  writeRepo(projectsDir, 'smoke-probes', files, hooksDir);
  return { testCommand, junitReportPath, source };
}

// ---------------------------------------------------------------------------------------------
// API flows
// ---------------------------------------------------------------------------------------------
async function createProject(api, body) {
  const res = await api.call('POST', '/api/v1/projects', {
    body,
    headers: { 'idempotency-key': `smoke-project-${randomUUID()}` },
    expect: [201],
  });
  const project = res.json;
  const ready = await waitFor(
    `project ${body.name} to become ready`,
    async () => {
      const p = (await api.call('GET', `/api/v1/projects/${project.id}`)).json;
      if (p.status === 'invalid')
        throw new CliError(`project ${body.name} is invalid: ${p.statusDetail}`);
      return { done: p.status === 'ready', value: p, detail: p.status };
    },
    { timeoutMs: 300000 },
  );
  ok(`project ${body.name} registered and ready (head ${String(ready.headSha).slice(0, 12)})`);
  return ready;
}

async function waitForIndex(api, projectId, name) {
  const status = await waitFor(
    `MCP index of ${name}`,
    async () => {
      const s = (await api.call('GET', `/api/v1/projects/${projectId}/index-status`)).json;
      if (s.lastOperation && s.lastOperation.status === 'failed' && !s.activeOperation) {
        throw new CliError(
          `project index of ${name} failed: ${s.lastOperation.errorCode} ${s.lastOperation.errorMessage}`,
        );
      }
      return {
        done: s.lastSuccessfulOperation !== null && s.activeOperation === null,
        value: s,
        detail: s.activeOperation ? s.activeOperation.status : 'no operation yet',
      };
    },
    { timeoutMs: 600000, intervalMs: 3000 },
  );
  assert(status.mcpEnabled === true, 'index status reports MCP disabled');
  assert(
    typeof status.nodeCount === 'number' && status.nodeCount > 0,
    `index of ${name} has no nodes`,
  );
  ok(
    `codebase-memory-mcp index of ${name}: ${status.nodeCount} nodes, ${status.edgeCount} edges, indexedAt ${status.indexedAt}`,
  );
  return status;
}

async function submitTask(api, body) {
  const res = await api.call('POST', '/api/v1/tasks', {
    body,
    headers: { 'idempotency-key': `smoke-task-${randomUUID()}` },
    expect: [202],
  });
  assert(
    String(res.headers.location ?? '').endsWith(`/tasks/${res.json.id}`),
    'POST /tasks without Location',
  );
  return res.json;
}

async function getTask(api, taskId) {
  return (await api.call('GET', `/api/v1/tasks/${taskId}`)).json;
}

async function waitForStatus(api, taskId, statuses, timeoutMs) {
  return waitFor(
    `task ${taskId} to reach ${statuses.join('/')}`,
    async () => {
      const detail = await getTask(api, taskId);
      const status = detail.task.status;
      if (SETTLED.has(status) && !statuses.includes(status)) {
        throw new CliError(
          `task ${taskId} settled as ${status} (${detail.task.statusReason}: ${detail.task.statusDetail})`,
        );
      }
      return { done: statuses.includes(status), value: detail, detail: status };
    },
    { timeoutMs, intervalMs: 1000 },
  );
}

async function claudeLog(api, taskId) {
  return (
    await api.call('GET', `/api/v1/tasks/${taskId}/logs?stream=claude&format=text&limit=1000`, {
      accept: 'text/plain',
    })
  ).text;
}

function findSystemEvent(logText, subtype) {
  for (const line of logText.split(/\r?\n/)) {
    if (!line.includes(subtype)) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'system' && parsed.subtype === subtype) return parsed;
    } catch {
      // not a complete JSON line
    }
  }
  return null;
}

async function waitNoSandboxProcesses(compose, label) {
  await waitFor(
    `no sandbox processes after ${label}`,
    async () => {
      const left = sandboxProcesses(compose);
      return {
        done: left.length === 0,
        value: null,
        detail: left.map((p) => `${p.uid}:${p.comm}`).join(' '),
      };
    },
    { timeoutMs: 120000, intervalMs: 2000 },
  );
  ok(`no sandbox process left after ${label}`);
}

function assertSandboxChildrenInRange(compose, label) {
  const children = sandboxProcesses(compose);
  assert(children.length > 0, `${label}: no sandbox child process found in the runner`);
  for (const p of children) {
    assert(
      p.uid >= RUNNER_UID_BASE && p.uid < RUNNER_UID_BASE + RUNNER_MAX_LEASES,
      `${label}: runner child ${p.pid} (${p.comm}) runs as uid ${p.uid}`,
    );
  }
  ok(
    `${label}: ${children.length} runner children, all inside uid ${RUNNER_UID_BASE}..${RUNNER_UID_BASE + RUNNER_MAX_LEASES - 1}`,
  );
}

async function assertServicesHealthy(compose, label, timeoutMs = 180000) {
  for (const service of ['worker', 'runner']) {
    await waitFor(
      `${service} healthy (${label})`,
      async () => {
        const containers = listContainers(compose).filter((c) => c.service === service);
        const states = containers.map((c) =>
          c.state === 'running' ? containerHealth(c.id) : c.state,
        );
        return {
          done: states.length > 0 && states.every((s) => s === 'healthy'),
          value: null,
          detail: states.join(','),
        };
      },
      { timeoutMs, intervalMs: 3000 },
    );
  }
  compose([
    'exec',
    '-T',
    'worker',
    'node',
    '/opt/orc/healthcheck.mjs',
    'http://127.0.0.1:4100/health/ready',
  ]);
  compose(['exec', '-T', 'runner', 'node', 'dist/runner.js', 'healthcheck']);
  ok(`${label}: worker ready and runner answering hello`);
}

// ---------------------------------------------------------------------------------------------
// Backup and restore verification (docs/operations/backup-restore.md)
// ---------------------------------------------------------------------------------------------
function tableCounts(compose, database) {
  const sql = [
    'SET NOCOUNT ON;',
    ...COUNTED_TABLES.map(
      (t) => `SELECT CONCAT(N'rows ${t}=', COUNT_BIG(*)) FROM [${database}].orc.[${t}];`,
    ),
    'GO',
    '',
  ].join('\n');
  const counts = {};
  for (const line of sqlcmd(compose.base, {
    login: 'sa',
    sql,
    what: `row counts of ${database}`,
  })) {
    const match = /^rows (\w+)=(\d+)$/.exec(line.trim());
    if (match) counts[match[1]] = Number(match[2]);
  }
  for (const t of COUNTED_TABLES)
    assert(Number.isInteger(counts[t]), `no row count for ${database}.orc.${t}`);
  return counts;
}

function dropRestoreCheck(compose) {
  sqlcmd(compose.base, {
    login: 'sa',
    what: `DROP DATABASE ${RESTORE_CHECK_DB}`,
    sql: [
      `IF DB_ID(N'${RESTORE_CHECK_DB}') IS NOT NULL`,
      'BEGIN',
      `  ALTER DATABASE [${RESTORE_CHECK_DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;`,
      `  DROP DATABASE [${RESTORE_CHECK_DB}];`,
      'END',
      'GO',
      '',
    ].join('\n'),
  });
}

function backupAndRestore(compose, secretsDir) {
  const composeOptions = [
    ...COMPOSE_FILES.flatMap((f) => ['--compose-file', f]),
    '--project-name',
    compose.base[compose.base.length - 1],
  ];
  const before = tableCounts(compose, LIVE_DB);
  const backup = runChecked(
    process.execPath,
    ['scripts/backup.mjs', '--database', LIVE_DB, '--secrets-dir', secretsDir, ...composeOptions],
    { what: 'scripts/backup.mjs' },
  ).stdout;
  const after = tableCounts(compose, LIVE_DB);
  const fileName = /--from (\S+\.bak)/.exec(backup)?.[1];
  assert(fileName, `backup.mjs printed no backup file name:\n${backup}`);
  ok(`backup ${fileName} written by orc_backup (WITH CHECKSUM)`);

  runChecked(
    process.execPath,
    [
      'scripts/restore.mjs',
      '--from',
      fileName,
      '--database',
      RESTORE_CHECK_DB,
      '--force',
      ...composeOptions,
    ],
    { what: 'scripts/restore.mjs' },
  );
  try {
    const restored = tableCounts(compose, RESTORE_CHECK_DB);
    for (const t of COUNTED_TABLES) {
      assert(
        restored[t] >= before[t] && restored[t] <= after[t],
        `${RESTORE_CHECK_DB}.orc.${t} has ${restored[t]} rows, live had ${before[t]}..${after[t]} around the backup`,
      );
    }
    assert(
      restored.Tasks > 0 && restored.TaskLogs > 0 && restored.AuditLogs > 0,
      'restored tables are empty',
    );
    ok(
      `restore into ${RESTORE_CHECK_DB} matches live row counts (${COUNTED_TABLES.map((t) => `${t}=${restored[t]}`).join(', ')})`,
    );
  } finally {
    dropRestoreCheck(compose);
  }
}

// ---------------------------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------------------------
async function smoke(ctx) {
  const { compose, values, tmpRoot, secretsDir, projectsDir, hooksDir, httpsPort, httpPort } = ctx;
  const externalIp = values['external-ip'];

  // 1. Render + preflight + start.
  runChecked(
    process.execPath,
    [
      'scripts/compose-check.mjs',
      ...COMPOSE_FILES.flatMap((f) => ['--compose-file', f]),
      '--project-name',
      values['project-name'],
    ],
    { what: 'scripts/compose-check.mjs' },
  );
  ok('compose config renders and every secret file is valid (compose-check)');
  log('docker compose up --wait (first run builds the images; this takes a while) ...');
  ctx.started = true;
  compose(
    ['up', '-d', ...(values['no-build'] ? [] : ['--build']), '--wait', '--wait-timeout', '1500'],
    { inherit: true },
  );
  ok('docker compose up --wait: all services healthy, db-bootstrap and migrator completed');

  const ca = readFileSync(join(secretsDir, 'web_ca_cert.pem'));
  const origin = `https://localhost:${httpsPort}`;
  const api = createClient({ port: httpsPort, ca, origin });

  // 2. Health and readiness.
  const live = await api.call('GET', '/health/live');
  assert(
    String(live.headers['strict-transport-security'] ?? '').includes('max-age=31536000'),
    'no HSTS header',
  );
  const webReady = await api.call('GET', '/health/ready');
  assert(webReady.json?.status === 'ok', `web /health/ready: ${webReady.text}`);
  const apiReady = await api.call('GET', '/api/v1/health/ready');
  assert(apiReady.json?.status === 'ok', `api /health/ready: ${apiReady.text}`);
  ok('web HTTPS (TLS verified against the local CA, HSTS) and api readiness through nginx');
  const redirect = await new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: httpPort, path: '/', headers: { host: 'localhost' } },
      (res) => {
        res.resume();
        resolvePromise({ status: res.statusCode, location: String(res.headers.location ?? '') });
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert(
    redirect.status === 301 && redirect.location.startsWith('https://'),
    `plain HTTP answered ${redirect.status} ${redirect.location}`,
  );
  ok('plain HTTP 8080 only redirects to HTTPS (301)');
  compose([
    'exec',
    '-T',
    'egress-proxy',
    'node',
    '/opt/orc/healthcheck.mjs',
    'http://127.0.0.1:3128/healthz',
  ]);
  await assertServicesHealthy(compose, 'startup', 60000);

  // 3. Users and network isolation of the containers.
  const workerUid = compose(['exec', '-T', 'worker', 'id', '-u']).stdout.trim();
  assert(workerUid === String(WORKER_UID), `worker runs as uid ${workerUid}`);
  ok(`worker runs as uid ${WORKER_UID}`);
  assertContainerUsers(compose, 'startup');
  assertNoDirectInternet(compose, externalIp);

  // 4. Admin user and login.
  const adminPassword = randomBytes(24).toString('base64url');
  compose(
    [
      '--profile',
      'tools',
      'run',
      '--rm',
      '--no-deps',
      '-T',
      'db-cli',
      'create-admin',
      '--username',
      'smokeadmin',
      '--display-name',
      'Smoke Admin',
    ],
    { input: `${adminPassword}\n` },
  );
  ok('orc-db create-admin (password over stdin)');
  const me = await api.login('smokeadmin', adminPassword);
  assert(
    Array.isArray(me.permissions) && me.permissions.includes('project:create'),
    'admin lacks project:create',
  );
  ok('login over HTTPS: __Host-orc_sid cookie and CSRF token issued');

  const workers = (await api.call('GET', '/api/v1/system/workers')).json;
  assert(
    workers.some(
      (w) => w.status !== 'offline' && String(w.cliVersion ?? '').includes(FAKE_CLI_VERSION),
    ),
    `no live worker reporting CLI ${FAKE_CLI_VERSION}: ${JSON.stringify(workers).slice(0, 400)}`,
  );
  await api.call('GET', '/api/v1/system/queue');
  ok('system/workers and system/queue answer; worker probed the (fake) CLI through the runner');

  const agents = (await api.call('GET', '/api/v1/agents')).json;
  const agent = agents.find((a) => a.isActive && !a.isManager) ?? agents.find((a) => a.isActive);
  assert(agent, 'no active agent (seed)');
  assert(agent.maxTimeoutSeconds >= 60, `agent ${agent.name} maxTimeoutSeconds < 60`);

  // 5. Sample project + index status.
  writeRepo(projectsDir, 'smoke-sample', SAMPLE_FILES, hooksDir);
  const sample = await createProject(api, {
    name: 'smoke-sample',
    description: 'generated by scripts/compose-smoke.mjs',
    repoPath: 'smoke-sample',
    testCommand: DEFAULT_TEST_COMMAND,
    junitReportPath: 'junit.xml',
    testTimeoutSeconds: 300,
    defaultAgentId: agent.id,
    autoIndex: true,
  });
  await waitForIndex(api, sample.id, 'smoke-sample');

  // 6. Task lifecycle with SSE.
  const task1 = await submitTask(api, {
    projectId: sample.id,
    title: 'smoke: add greeting module',
    prompt: [
      'Add a greeting module with a unit test.',
      '@@fake text smoke: writing greeting module',
      `@@fake write src/greeting.mjs ${b64(GREETING_SOURCE)}`,
      `@@fake write test/greeting.test.mjs ${b64(GREETING_TEST)}`,
    ].join('\n'),
    timeoutSeconds: Math.min(900, agent.maxTimeoutSeconds),
  });
  const stream1 = await api.followStream(task1.id, { timeoutMs: 600000 });
  assert(
    stream1.end?.status === 'completed',
    `task 1 ended as ${stream1.end?.status} (${stream1.end?.reason})`,
  );
  const types = new Set(stream1.events.map((e) => e.type));
  assert(
    types.has('status') && types.has('claude'),
    `SSE lacked status/claude events: ${[...types].join(',')}`,
  );
  assert(
    stream1.events.some(
      (e) =>
        e.type === 'claude' &&
        String(e.data?.text ?? '').includes('smoke: writing greeting module'),
    ),
    'SSE did not carry the assistant text of the fake CLI',
  );
  ok(
    `task submitted through the web TLS endpoint; SSE delivered ${stream1.events.length} events until end=completed`,
  );

  const detail1 = await getTask(api, task1.id);
  assert(detail1.task.status === 'completed', `task 1 status ${detail1.task.status}`);
  const attempt1 = detail1.currentAttempt;
  assert(attempt1 && attempt1.workspaceId, 'task 1 has no attempt workspace');
  const changed = (await api.call('GET', `/api/v1/tasks/${task1.id}/changed-files`)).json;
  assert(
    changed.some((f) => f.path === 'src/greeting.mjs'),
    `changed files: ${changed.map((f) => f.path).join(', ')}`,
  );
  const diff = (await api.call('GET', `/api/v1/tasks/${task1.id}/diff?limit=50`)).json;
  const greetingDiff = diff.items.find((f) => f.path === 'src/greeting.mjs');
  assert(
    greetingDiff && String(greetingDiff.patch ?? '').includes('greet'),
    'diff of src/greeting.mjs missing',
  );
  const rawDiff = await api.call('GET', `/api/v1/tasks/${task1.id}/diff`, {
    accept: 'text/x-diff',
  });
  assert(rawDiff.text.includes('diff --git'), 'text/x-diff body is not a unified diff');
  await api.call('GET', `/api/v1/tasks/${task1.id}/patch`, { accept: 'application/x-patch' });
  ok(`changed files (${changed.length}), paged diff, unified diff and patch download`);
  const runs = (await api.call('GET', `/api/v1/tasks/${task1.id}/tests`)).json;
  const run1 = runs.find((r) => r.status === 'passed');
  assert(
    run1 && run1.total >= 2 && run1.failed === 0 && run1.errored === 0,
    `test runs: ${JSON.stringify(runs).slice(0, 600)}`,
  );
  const results = (
    await api.call('GET', `/api/v1/tasks/${task1.id}/tests/${run1.id}/results?limit=500`)
  ).json;
  assert(results.items.length >= 2, 'test results not stored');
  ok(
    `test run passed in the sandbox: ${run1.passed}/${run1.total} (JUnit parsed: ${run1.reportParsed})`,
  );
  const claudeText1 = await claudeLog(api, task1.id);
  assert(claudeText1.includes('smoke: writing greeting module'), 'TaskLogs lack the Claude output');
  const events1 = (await api.call('GET', `/api/v1/tasks/${task1.id}/events?limit=100`)).json;
  assert(
    events1.items.some((e) => e.type === 'status_changed'),
    'no status_changed task events',
  );
  const session1 = (await api.call('GET', `/api/v1/tasks/${task1.id}/session`)).json;
  assert(
    String(session1.cliVersion ?? '').includes(FAKE_CLI_VERSION),
    `session: ${JSON.stringify(session1).slice(0, 300)}`,
  );
  await api.call('GET', `/api/v1/tasks/${task1.id}/merge-check`, { expect: [200, 404] });
  ok(`logs stored in MSSQL, task events, Claude session (CLI ${session1.cliVersion})`);
  // Impact analysis runs in the sandbox without git (ADR-0035): seeded with the worker's diff.
  const impact = (await api.call('GET', `/api/v1/tasks/${task1.id}/impact`)).json;
  assert(
    impact.status === 'succeeded',
    `impact analysis ${impact.status}: ${impact.errorCode ?? ''} ${String(impact.errorMessage ?? '').slice(0, 300)}`,
  );
  const impactResult = impact.result ?? {};
  assert(
    impactResult.source === 'worker_diff' &&
      Array.isArray(impactResult.changed_files) &&
      impactResult.changed_files.includes('src/greeting.mjs') &&
      Array.isArray(impactResult.seeds) &&
      impactResult.seeds.some((s) => String(s.qn ?? '').endsWith('.greet')),
    `impact result: ${JSON.stringify(impactResult).slice(0, 600)}`,
  );
  ok(
    `impact analysis succeeded in the sandbox: ${impactResult.changed_files.length} changed files, ${impactResult.seed_total} seeds, ${impactResult.impacted_total} impacted symbols`,
  );
  const indexAfter = (await api.call('GET', `/api/v1/projects/${sample.id}/index-status`)).json;
  assert(indexAfter.lastSuccessfulOperation, 'index status lost after the task');
  ok(`index-status endpoint: ${indexAfter.indexName}, stale=${indexAfter.stale}`);

  // 7. Cancel (while the fake CLI hangs inside the sandbox).
  const cancelTask = await submitTask(api, {
    projectId: sample.id,
    title: 'smoke: cancel',
    prompt: ['Wait for cancellation.', '@@fake text smoke: waiting for cancel', '@@fake hang'].join(
      '\n',
    ),
    timeoutSeconds: Math.min(900, agent.maxTimeoutSeconds),
  });
  await waitForStatus(api, cancelTask.id, ['running'], 300000);
  await waitFor(
    'the fake CLI to start in the runner',
    async () => ({ done: sandboxProcesses(compose).length > 0, value: null }),
    { timeoutMs: 60000, intervalMs: 1000 },
  );
  assertSandboxChildrenInRange(compose, 'running task');
  assertContainerUsers(compose, 'running task');
  const cancelRes = await api.call('POST', `/api/v1/tasks/${cancelTask.id}/cancel`, {
    body: { reason: 'smoke cancel' },
    expect: [200, 202],
  });
  const cancelStream = await api.followStream(cancelTask.id, { timeoutMs: 300000 });
  const cancelled = await getTask(api, cancelTask.id);
  assert(cancelled.task.status === 'cancelled', `cancel ended as ${cancelled.task.status}`);
  ok(`cancel (${cancelRes.status}) -> cancelled${cancelStream.end ? ' (SSE end)' : ''}`);
  await waitNoSandboxProcesses(compose, 'cancel');

  // 8. Timeout.
  const timeoutTask = await submitTask(api, {
    projectId: sample.id,
    title: 'smoke: timeout',
    prompt: [
      'Hang until the timeout.',
      '@@fake text smoke: waiting for timeout',
      '@@fake hang',
    ].join('\n'),
    timeoutSeconds: 60,
  });
  const timeoutStream = await api.followStream(timeoutTask.id, { timeoutMs: 600000 });
  const timedOut = await getTask(api, timeoutTask.id);
  assert(timedOut.task.status === 'timed_out', `timeout task ended as ${timedOut.task.status}`);
  assert(timedOut.task.statusReason === 'timeout', `timeout reason ${timedOut.task.statusReason}`);
  ok(`timeout (60 s) -> timed_out${timeoutStream.end ? ' (SSE end)' : ''}`);
  await waitNoSandboxProcesses(compose, 'timeout');

  // 9. Sandbox-escape probes (Claude stage via @@fake exec, test stage via the probe repository).
  const ws = PATHS.workspaces;
  const sibling = `${ws}/${sample.id}/${task1.id}/a${attempt1.attemptNumber}`;
  const targets = {
    uidBase: RUNNER_UID_BASE,
    maxLeases: RUNNER_MAX_LEASES,
    workerGid: WORKER_UID,
    proxyUrl: 'http://egress-proxy:3128',
    externalIp,
    socketPath: `${PATHS.runnerSocketDir}/runner.sock`,
    dirs: [
      { path: ws, mustExist: true },
      { path: `${ws}/.repos`, mustExist: true },
      { path: `${ws}/.orc`, mustExist: true },
      { path: `${ws}/${sample.id}`, mustExist: true },
      { path: `${ws}/${sample.id}/_base`, mustExist: true },
      { path: sibling, mustExist: true },
      { path: `${sibling}.meta`, mustExist: false },
      { path: `${PATHS.claudeHome}/w`, mustExist: true },
      { path: `${PATHS.claudeHome}/w/${attempt1.workspaceId}`, mustExist: false },
      { path: `${PATHS.claudeHome}/probe`, mustExist: false },
      // ADR-0034: p/ and w/ are 1775 root:<WORKER_GID> anchors, listable but not writable.
      { path: `${PATHS.cbmCache}/p`, mustExist: true, listable: true },
      { path: `${PATHS.cbmCache}/w`, mustExist: true, listable: true },
      { path: `${PATHS.cbmCache}/p/${sample.id}`, mustExist: false },
      { path: `${PATHS.cbmCache}/w/${attempt1.workspaceId}`, mustExist: false },
      { path: PATHS.runnerSocketDir, mustExist: true },
    ],
    files: [
      { path: `${sibling}/src/math.mjs`, mustExist: true },
      { path: `${sibling}/src/greeting.mjs`, mustExist: true },
      { path: '/run/secrets/db_worker_password', mustExist: false },
      { path: '/run/secrets/claude_oauth_token', mustExist: false },
      { path: '/run/secrets/anthropic_api_key', mustExist: false },
      // The runner has no projects mount (the image only carries an empty mount point).
      { path: '/var/lib/orc/projects/smoke-sample/src/math.mjs', mustExist: false },
    ],
  };
  const probeRepo = writeProbeRepo(projectsDir, targets, hooksDir);
  const probes = await createProject(api, {
    name: 'smoke-probes',
    description: `sandbox-escape probes (${probeRepo.source})`,
    repoPath: 'smoke-probes',
    testCommand: probeRepo.testCommand,
    junitReportPath: probeRepo.junitReportPath,
    testTimeoutSeconds: 300,
    defaultAgentId: agent.id,
    autoIndex: true,
  });
  await waitForIndex(api, probes.id, 'smoke-probes');
  const execArgv = [
    '/usr/local/bin/node',
    '-e',
    [
      `const sandboxProbes = ${sandboxProbes.toString()};`,
      "sandboxProbes(JSON.parse(process.argv[1]), 'claude').then((r) => {",
      '  const failed = r.checks.filter((c) => !c.ok).slice(0, 20);',
      '  process.stdout.write(JSON.stringify({ uid: r.uid, total: r.checks.length, failed }));',
      '});',
    ].join('\n'),
    JSON.stringify(targets),
  ];
  const probeTask = await submitTask(api, {
    projectId: probes.id,
    title: 'smoke: sandbox-escape probes',
    prompt: ['Run the sandbox probes.', `@@fake exec ${JSON.stringify(execArgv)}`].join('\n'),
    timeoutSeconds: Math.min(900, agent.maxTimeoutSeconds),
  });
  const probeStream = await api.followStream(probeTask.id, { timeoutMs: 600000 });
  const probeLog = await claudeLog(api, probeTask.id);
  const execEvent = findSystemEvent(probeLog, 'fake_exec');
  assert(
    execEvent,
    `no fake_exec event in the probe task log (task ended ${probeStream.end?.status})`,
  );
  assert(
    execEvent.exitCode === 0,
    `claude-stage probe exited ${execEvent.exitCode}: ${execEvent.stderr}`,
  );
  let claudeReport;
  try {
    claudeReport = JSON.parse(execEvent.stdout);
  } catch {
    throw new CliError(
      `claude-stage probe output is not JSON: ${String(execEvent.stdout).slice(0, 500)}`,
    );
  }
  assert(
    claudeReport.failed.length === 0,
    `claude-stage sandbox escapes NOT blocked: ${JSON.stringify(claudeReport.failed)}`,
  );
  ok(
    `claude-stage sandbox probes: ${claudeReport.total} checks blocked as uid ${claudeReport.uid}`,
  );
  const probeDetail = await getTask(api, probeTask.id);
  const probeRuns = (await api.call('GET', `/api/v1/tasks/${probeTask.id}/tests`)).json;
  const probeRun = probeRuns[probeRuns.length - 1];
  assert(probeRun, `no test run for the probe task (status ${probeDetail.task.status})`);
  if (probeRun.status !== 'passed' || probeRun.failed > 0 || probeRun.errored > 0) {
    const failedCases = (
      await api.call(
        'GET',
        `/api/v1/tasks/${probeTask.id}/tests/${probeRun.id}/results?status=failed&limit=500`,
      )
    ).json;
    throw new CliError(
      `test-stage sandbox probes failed (${probeRun.status}, ${probeRun.failed} failed): ${failedCases.items.map((r) => `${r.name}: ${String(r.failureMessage ?? r.message ?? '').slice(0, 200)}`).join(' | ')}`,
    );
  }
  assert(probeRun.total > 0, 'test-stage probe run has no test cases');
  assert(probeDetail.task.status === 'completed', `probe task ended as ${probeDetail.task.status}`);
  ok(
    `test-stage sandbox probes (${probeRepo.source}): ${probeRun.passed}/${probeRun.total} passed`,
  );

  // 10. Process limits.
  const forkCount = Number(values['fork-bomb']);
  const forkTask = await submitTask(api, {
    projectId: sample.id,
    title: 'smoke: fork bomb',
    prompt: ['Process limit probe.', `@@fake fork-bomb ${forkCount}`].join('\n'),
    timeoutSeconds: Math.min(900, agent.maxTimeoutSeconds),
  });
  let maxPerUid = 0;
  const forkOutcome = await waitFor(
    'fork-bomb report or settle',
    async () => {
      try {
        const perUid = new Map();
        for (const p of sandboxProcesses(compose)) perUid.set(p.uid, (perUid.get(p.uid) ?? 0) + 1);
        for (const count of perUid.values()) maxPerUid = Math.max(maxPerUid, count);
      } catch {
        // runner restarting (memory limit); the settle path below covers it
      }
      const report = findSystemEvent(await claudeLog(api, forkTask.id), 'fake_fork');
      if (report) return { done: true, value: { report } };
      const status = (await getTask(api, forkTask.id)).task.status;
      return { done: SETTLED.has(status), value: { report: null, status }, detail: status };
    },
    { timeoutMs: 300000, intervalMs: 2000 },
  );
  assert(
    maxPerUid <= RUNNER_NPROC,
    `a lease uid ran ${maxPerUid} processes (> RUNNER_NPROC ${RUNNER_NPROC})`,
  );
  if (forkOutcome.report) {
    const { spawned, errors } = forkOutcome.report;
    assert(
      spawned < RUNNER_NPROC && errors > 0,
      `fork bomb spawned ${spawned} children with ${errors} errors`,
    );
    ok(
      `fork bomb bounded: ${spawned} of ${forkCount} children spawned, ${errors} refused (RUNNER_NPROC ${RUNNER_NPROC}); max ${maxPerUid} processes per uid`,
    );
  } else {
    assert(
      forkOutcome.status === 'failed',
      `fork-bomb task settled as ${forkOutcome.status} without a report`,
    );
    ok(
      `fork bomb bounded by the runner memory limit: attempt failed before reporting; max ${maxPerUid} processes per uid`,
    );
  }
  const forkState = (await getTask(api, forkTask.id)).task.status;
  if (!SETTLED.has(forkState)) {
    await api.call('POST', `/api/v1/tasks/${forkTask.id}/cancel`, {
      body: { reason: 'smoke fork bomb' },
      expect: [200, 202, 409],
    });
  }
  const forkSettled = await waitForStatus(
    api,
    forkTask.id,
    ['cancelled', 'failed', 'timed_out'],
    300000,
  );
  ok(`fork-bomb attempt settled as ${forkSettled.task.status}`);
  await assertServicesHealthy(compose, 'after fork bomb');
  await waitNoSandboxProcesses(compose, 'fork bomb');

  // 11. Backup + restore check, final checks.
  backupAndRestore(compose, secretsDir);
  assertContainerUsers(compose, 'end of run');
  const finalReady = await api.call('GET', '/api/v1/health/ready');
  assert(finalReady.json?.status === 'ok', 'api not ready at the end of the run');
  ok('api still ready at the end of the run');
  log(`temporary directory: ${tmpRoot}`);
}

function printDiagnostics(compose) {
  for (const service of ['api', 'worker', 'runner', 'egress-proxy']) {
    const result = run('docker', [...compose.base, 'logs', '--no-color', '--tail', '60', service]);
    console.error(`----- docker compose logs --tail 60 ${service} -----`);
    console.error(String(result.stdout || '').trimEnd());
    console.error(String(result.stderr || '').trimEnd());
  }
}

function teardown(ctx) {
  if (ctx.tornDown) return;
  ctx.tornDown = true;
  if (ctx.started) {
    log(ctx.values.keep ? 'docker compose down (volumes kept: --keep)' : 'docker compose down -v');
    const args = [...ctx.compose.base, '--profile', 'tools', 'down', '--remove-orphans'];
    if (!ctx.values.keep) args.push('-v');
    spawnSync('docker', args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    });
  }
  if (ctx.tmpRoot && existsSync(ctx.tmpRoot)) {
    if (ctx.values.keep) {
      log(
        `kept ${ctx.tmpRoot} (secrets of the kept volumes; delete it after \`docker compose -p ${ctx.values['project-name']} down -v\`)`,
      );
    } else {
      rmSync(ctx.tmpRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      keep: { type: 'boolean', default: false },
      'no-build': { type: 'boolean', default: false },
      'project-name': { type: 'string', default: 'orc-smoke' },
      'https-port': { type: 'string', default: '18443' },
      'http-port': { type: 'string', default: '18088' },
      'fork-bomb': { type: 'string', default: '2000' },
      'external-ip': { type: 'string', default: '1.1.1.1' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(
      'usage: node scripts/compose-smoke.mjs [--keep] [--no-build] [--project-name <name>]\n' +
        '         [--https-port <port>] [--http-port <port>] [--fork-bomb <n>] [--external-ip <ip>]',
    );
    return;
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(values['project-name'])) {
    throw new CliError('--project-name must be a valid compose project name');
  }
  for (const name of ['https-port', 'http-port', 'fork-bomb']) {
    if (!/^\d{1,5}$/.test(values[name]) || Number(values[name]) < 1) {
      throw new CliError(`--${name} must be a positive integer`);
    }
  }
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(values['external-ip']))
    throw new CliError('--external-ip must be an IPv4 address');

  runChecked('docker', ['version', '--format', '{{.Server.Os}}'], { what: 'docker version' });
  runChecked('git', ['--version'], { what: 'git --version' });
  const project = values['project-name'];
  const volumes = runChecked('docker', [
    'volume',
    'ls',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${project}`,
  ]).stdout.trim();
  const containers = runChecked('docker', [
    'ps',
    '-aq',
    '--filter',
    `label=com.docker.compose.project=${project}`,
  ]).stdout.trim();
  if (volumes !== '' || containers !== '') {
    throw new CliError(
      `compose project "${project}" already has containers or volumes (an earlier --keep run?); ` +
        `remove them with: docker compose -p ${project} down -v`,
    );
  }

  const tmpRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'orc-smoke-')));
  const ctx = {
    values,
    tmpRoot,
    secretsDir: join(tmpRoot, 'secrets'),
    projectsDir: join(tmpRoot, 'projects'),
    hooksDir: join(tmpRoot, 'git-hooks'),
    httpsPort: Number(values['https-port']),
    httpPort: Number(values['http-port']),
    compose: makeCompose(project),
    started: false,
    tornDown: false,
  };
  const onSignal = (signal) => {
    log(`${signal}: tearing down`);
    teardown(ctx);
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    mkdirSync(ctx.projectsDir, { recursive: true });
    mkdirSync(ctx.hooksDir, { recursive: true });
    makeTreeReadable(ctx.projectsDir);
    if (process.platform !== 'win32') chmodSync(tmpRoot, 0o755);

    // Compose interpolation for docker-compose.yml + docker-compose.smoke.yml (and for the
    // backup/restore scripts started below).
    for (const name of [
      'COMPOSE_FILE',
      'COMPOSE_PROJECT_NAME',
      'COMPOSE_PROFILES',
      'WEB_BIND_ADDRESS',
    ]) {
      delete process.env[name];
    }
    Object.assign(process.env, {
      ORC_SECRETS_DIR: ctx.secretsDir,
      ORC_PROJECTS_DIR: ctx.projectsDir,
      ORC_IMAGE_TAG: process.env.ORC_SMOKE_IMAGE_TAG ?? 'smoke',
      ORC_SMOKE_HTTPS_PORT: String(ctx.httpsPort),
      ORC_SMOKE_HTTP_PORT: String(ctx.httpPort),
      PUBLIC_ORIGIN: `https://localhost:${ctx.httpsPort}`,
      WEB_SERVER_NAME: 'localhost',
      DB_NAME: LIVE_DB,
      MCP_ENABLED: 'true',
      WORKER_CONCURRENCY: '2',
    });

    // Secrets + certificates for this run only; the Claude OAuth token is a generated dummy value (CLAUDE_AUTH_MODE=oauth)
    // (the fake CLI never contacts the API).
    if (run('docker', ['image', 'inspect', OPENSSL_IMAGE]).status !== 0) {
      log(`pulling ${OPENSSL_IMAGE} (openssl for generate-certs) ...`);
      runChecked('docker', ['pull', OPENSSL_IMAGE], { inherit: true, what: 'docker pull' });
    }
    runChecked(
      process.execPath,
      ['scripts/generate-secrets.mjs', '--dir', ctx.secretsDir, '--claude-oauth-token-stdin'],
      {
        input: `sk-ant-oat01-${randomBytes(24).toString('hex')}\n`,
        what: 'scripts/generate-secrets.mjs',
      },
    );
    ok('secrets and TLS material generated into a temporary directory');

    await smoke(ctx);
    log(`PASSED: ${passed.length} checks in ${((Date.now() - startedAt) / 1000).toFixed(0)} s`);
  } catch (err) {
    if (ctx.started) printDiagnostics(ctx.compose);
    log(`FAILED after ${passed.length} passed checks`);
    throw err;
  } finally {
    teardown(ctx);
  }
}

runCli(main);
