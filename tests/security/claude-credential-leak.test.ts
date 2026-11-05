// ADR-0036 Decisions 4, 8 and 11 (B-017 wave 3, B-018, Opus K10(b)): the Claude OAuth credential and its base64
// transport form (`spawn.credentialFd {b64}`) never leave the credential path. Covered surfaces:
// - runner protocol: error replies and runner logs for malformed, oversized and misrouted `credentialFd` frames;
// - worker configuration: ConfigError message, details, stack and its log line;
// - runner disk state: lease state files written around a credential spawn and the startup recovery;
// - @orc/logger: runner logger (no registry) and worker logger (registry filled by createClaudeRunner), including
//   base64 forms at a non-zero offset (the credential embedded in a larger encoded payload);
// - Linux: environ, cmdline and fds of Claude (fake) and of an `@@fake exec` child, and the runner refusing a
//   misrouted credential before anything is spawned.
// Two dummy values are used: an `sk-ant-oat01-` token the logger patterns know, and a probe value no masking
// pattern matches, so a clean output proves the value was never written rather than masked.
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable, type Duplex } from 'node:stream';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  buildClaudeArgv,
  buildClaudeLaunchEnv,
  createClaudeRunner,
  type ClaudeRunnerConfig,
} from '@orc/claude-runner';
import { createLogger, serializeError, type Logger } from '@orc/logger';
import { createSecretRegistry, type SecretRegistry } from '@orc/security';
import {
  createDefaultLaunch,
  createFileLeaseStateStore,
  createLeaseManager,
  createLocalLauncher,
  createRunnerClient,
  createRunnerServer,
  CREDENTIAL_FD_ENV_KEY,
  MAX_CREDENTIAL_FD_BYTES,
  MAX_FRAME_BYTES,
  type LaunchProcessFn,
  type LeaseManager,
  type RunnerClient,
} from '@orc/sandbox';
import { OrcError } from '@orc/shared';
import {
  ConfigError,
  loadWorkerConfig,
  type Env,
  type LaunchLease,
  type SupervisedProcess,
} from '@orc/shared/node';
import {
  ATTEMPT_ID as RUN_ATTEMPT_ID,
  createRunnerLayout,
  fakeRunnerConfig,
  makeRunRequest,
  recordingHandlers,
  systemSubtype,
  type RunnerLayout,
} from '../helpers/claude/fake-claude';
import { ATTEMPT_ID, fakeLaunch, socketPair, waitFor } from '../helpers/sandbox/fakes';
import { makeRoots, type SandboxRoots } from '../helpers/sandbox/roots';

const IS_WIN = process.platform === 'win32';
const NODE = process.execPath;

/** Matches CLAUDE_OAUTH_TOKEN_REGEX; the logger's `sk-ant-oat` patterns know this shape. */
const TOKEN = 'sk-ant-oat01-SecLeakK10b_q7Vx2mR9tW4zN8bC1dF6hJ3lP5sY0uA-TESTONLY';
/** No masking pattern matches this value: a clean output means it was never written. */
const PROBE = 'credprobe.TESTONLY.5e1c9a7f3b2d8064aa1f.K10b';

interface Needle {
  readonly name: string;
  readonly value: string;
}
const TOKEN_N: Needle = { name: 'token', value: TOKEN };
const PROBE_N: Needle = { name: 'probe', value: PROBE };
const BOTH: readonly Needle[] = [TOKEN_N, PROBE_N];

const ENV = { PATH: process.env.PATH ?? '/usr/bin' };
const FD_ENV = { ...ENV, [CREDENTIAL_FD_ENV_KEY]: '3' };
const CAPS = { ok: false, uidSwitch: false, chown: false, kill: false, prlimit: false, procfs: false };
const MANAGER_BASE = {
  workerUid: 1000,
  workerGid: 1000,
  uidBase: 20000,
  maxLeases: 4,
  leaseTtlMs: 40_000,
  killGraceMs: 500,
  limits: { nproc: 512, nofile: 4096, fsizeBytes: 2 ** 31 },
  identity: 'none' as const,
  prlimitPath: null,
};

function b64(value: string | Buffer): string {
  return (typeof value === 'string' ? Buffer.from(value, 'utf8') : value).toString('base64');
}

/**
 * The part of `encoding(<offset bytes> + value)` that depends on `value` only: base64 groups that lie entirely
 * inside the value. Any text holding the value's encoding at a byte offset with the same remainder mod 3 holds it.
 */
function encodedCore(value: string, offset: 0 | 1 | 2, encoding: 'base64' | 'base64url'): string {
  const bytes = Buffer.from(value, 'utf8');
  const encoded = Buffer.concat([Buffer.alloc(offset, 0x78), bytes]).toString(encoding);
  const first = Math.ceil(offset / 3);
  const last = Math.floor((offset + bytes.length) / 3);
  return encoded.slice(first * 4, last * 4);
}

function leakForms(n: Needle): { label: string; text: string }[] {
  const out = [
    { label: `${n.name}:plain`, text: n.value },
    { label: `${n.name}:uri`, text: encodeURIComponent(n.value) },
    { label: `${n.name}:json`, text: JSON.stringify(n.value).slice(1, -1) },
    { label: `${n.name}:hex`, text: Buffer.from(n.value, 'utf8').toString('hex') },
  ];
  for (const offset of [0, 1, 2] as const) {
    for (const encoding of ['base64', 'base64url'] as const) {
      out.push({ label: `${n.name}:${encoding}@${offset}`, text: encodedCore(n.value, offset, encoding) });
    }
  }
  return out;
}

/** Labels of every form of `needles` found in `text` (never the values themselves). */
function findLeaks(text: string, needles: readonly Needle[] = BOTH): string[] {
  const found = new Set<string>();
  for (const n of needles) {
    for (const f of leakForms(n)) if (f.text.length >= 12 && text.includes(f.text)) found.add(f.label);
  }
  return [...found];
}

function capture(service: 'runner' | 'worker', secrets?: SecretRegistry): { logger: Logger; text: () => string } {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
  const logger = createLogger({
    service,
    level: 'trace',
    version: 'test',
    env: 'test',
    destination,
    ...(secrets === undefined ? {} : { secrets }),
  });
  return { logger, text: () => chunks.join('') };
}

const silent = (): Logger => createLogger({ service: 'test', level: 'silent', version: 'test', env: 'test' });

/** Every file name and file content below `dir` (the runner's disk footprint). */
function readTree(dir: string): string {
  const parts: string[] = [];
  for (const rel of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    parts.push(rel);
    const p = join(dir, rel);
    if (lstatSync(p).isFile()) parts.push(readFileSync(p).toString('latin1'));
  }
  return parts.join('\n');
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function roots(): SandboxRoots {
  const r = makeRoots('orc-sec-cred-');
  cleanups.push(() => r.cleanup());
  return r;
}

interface RunnerHarness {
  manager: LeaseManager;
  client: RunnerClient;
  runnerLog: () => string;
  clientLog: () => string;
  /** Writes `payload` on a fresh runner connection and returns everything the runner answered. */
  raw(payload: string): Promise<string>;
}

/** Runner server + lease manager (file state store) behind an in-memory socket, and the worker's runner client. */
function runnerHarness(o: { roots: readonly string[]; stateDir: string; launch: LaunchProcessFn }): RunnerHarness {
  const runnerLog = capture('runner');
  const clientLog = capture('worker');
  const manager = createLeaseManager({
    ...MANAGER_BASE,
    roots: o.roots,
    logger: runnerLog.logger,
    stateStore: createFileLeaseStateStore(o.stateDir),
    launch: o.launch,
  });
  const server = createRunnerServer({
    socketPath: join(o.stateDir, 'unused.sock'),
    manager,
    hello: { uidBase: 20000, maxLeases: 4, leaseTtlMs: 40_000, caps: CAPS },
    logger: runnerLog.logger,
    maxConnections: 16,
    socketGroup: null,
    killGraceMs: 500,
    exitDrainMs: 100,
  });
  const connect = (): Duplex => {
    const [s, c] = socketPair();
    server.handleConnection(s);
    return c;
  };
  const client = createRunnerClient({ socketPath: 'unused', connect, logger: clientLog.logger });
  cleanups.push(async () => {
    await client.close();
    await manager.close();
  });
  const raw = async (payload: string): Promise<string> => {
    const [s, c] = socketPair();
    const parts: Buffer[] = [];
    let closed = false;
    c.on('data', (d: Buffer) => parts.push(d));
    c.on('close', () => {
      closed = true;
    });
    c.on('error', () => undefined);
    server.handleConnection(s);
    c.write(payload);
    expect(await waitFor(() => closed, 10_000), 'runner closed the connection').toBe(true);
    return Buffer.concat(parts).toString('utf8');
  };
  return { manager, client, runnerLog: runnerLog.text, clientLog: clientLog.text, raw };
}

function countingLaunch(inner: LaunchProcessFn): LaunchProcessFn & { credentials: (string | undefined)[] } {
  const credentials: (string | undefined)[] = [];
  const fn: LaunchProcessFn = (cmd, args, o) => {
    credentials.push(o.credentialFd);
    return inner(cmd, args, o);
  };
  return Object.assign(fn, { credentials });
}

interface ErrorReply {
  type: string;
  code: string;
  reason?: string;
}

function singleErrorFrame(text: string, where: string): ErrorReply {
  const lines = text.split('\n').filter((l) => l.length > 0);
  expect(lines, where).toHaveLength(1);
  const reply = JSON.parse(lines[0] ?? 'null') as ErrorReply;
  expect(reply.type, where).toBe('error');
  return reply;
}

async function rejection(p: Promise<unknown>): Promise<OrcError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OrcError);
    return e as OrcError;
  }
  throw new Error('expected a rejection');
}

/** Every surface of an error a caller could print or log. */
function errorSurfaces(e: OrcError): Record<string, string> {
  return {
    message: e.message,
    stack: e.stack ?? '',
    details: JSON.stringify(e.details ?? {}),
    inspect: inspect(e, { depth: 20 }),
    serialized: JSON.stringify(serializeError(e)),
  };
}

describe('leak detector (self-check)', () => {
  it('finds the plain value and its base64 forms at every byte offset, and nothing in unrelated text', () => {
    for (const n of BOTH) {
      expect(findLeaks(`x ${n.value} y`, [n])).toContain(`${n.name}:plain`);
      for (const [prefix, offset] of [['', 0], ['a', 1], ['ab', 2], ['abc', 0], ['{"chunk":"', 1]] as const) {
        const enc = b64(`${prefix}${n.value}\n`);
        expect(findLeaks(`frame ${enc} end`, [n]), `${n.name}@${prefix.length}`).toContain(`${n.name}:base64@${offset}`);
      }
      expect(findLeaks(Buffer.from(`--${n.value}`).toString('base64url'), [n])).toContain(`${n.name}:base64url@2`);
    }
    expect(findLeaks(`${'[REDACTED] '.repeat(20)}${b64('unrelated text without the credential')}`)).toEqual([]);
  });
});

describe('runner protocol: refused credentialFd frames never echo the credential (ADR-0036 m.4, m.8)', () => {
  interface FrameCase {
    name: string;
    line: string;
    code: string;
    reason: string;
    needles: readonly Needle[];
  }
  const PROTOCOL = ['validation_failed', 'protocol'] as const;
  const ENV_REJECTED = ['unsafe_argument', 'env_rejected'] as const;

  function spawnCases(leaseId: string, cwd: string, outside: string): FrameCase[] {
    const base = { v: 1, type: 'spawn', leaseId, kind: 'claude', argv: [NODE, '-v'], cwd, env: FD_ENV, limits: {} };
    const tokenB64 = b64(TOKEN);
    const cases: FrameCase[] = [];
    const add = (
      name: string,
      over: Record<string, unknown>,
      [code, reason]: readonly [string, string],
      payloads: readonly string[] = [],
    ): void => {
      cases.push({
        name,
        line: `${JSON.stringify({ ...base, ...over })}\n`,
        code,
        reason,
        needles: [...BOTH, ...payloads.map((value, i) => ({ name: `payload${i}`, value }))],
      });
    };
    // 1. Invalid base64 (schema violation, the payload is never echoed).
    add('b64 with a non-alphabet character', { credentialFd: { b64: `${tokenB64}*` } }, PROTOCOL, [`${tokenB64}*`]);
    add('b64 with broken padding', { credentialFd: { b64: `${tokenB64}=` } }, PROTOCOL, [`${tokenB64}=`]);
    add('b64 missing its first character', { credentialFd: { b64: tokenB64.slice(1) } }, PROTOCOL, [tokenB64.slice(1)]);
    add('b64 with leading whitespace', { credentialFd: { b64: ` ${tokenB64}` } }, PROTOCOL);
    add('the raw token instead of base64', { credentialFd: { b64: TOKEN } }, PROTOCOL);
    add('the raw token instead of the {b64} object', { credentialFd: TOKEN }, PROTOCOL);
    add('the probe value instead of the {b64} object', { credentialFd: PROBE }, PROTOCOL);
    add('an extra field next to b64', { credentialFd: { b64: tokenB64, value: PROBE } }, PROTOCOL);
    add('a field other than b64', { credentialFd: { value: TOKEN } }, PROTOCOL);
    add('an array instead of the {b64} object', { credentialFd: [tokenB64, b64(PROBE)] }, PROTOCOL);
    // 2. Larger than 4096 decoded bytes.
    const over4096 = b64(Buffer.from(TOKEN.repeat(70)).subarray(0, MAX_CREDENTIAL_FD_BYTES + 1));
    add('4097 decoded bytes (b64 length within the cap)', { credentialFd: { b64: over4096 } }, PROTOCOL, [over4096]);
    const overB64 = b64(`${TOKEN}${PROBE}`.repeat(60));
    add('b64 longer than the 4 KiB cap', { credentialFd: { b64: overB64 } }, PROTOCOL);
    // 3. Wrong kind (only `claude` may carry a credential; `git` is not a launch kind at all).
    add('kind test with credentialFd', { kind: 'test', env: ENV, credentialFd: { b64: tokenB64 } }, ENV_REJECTED);
    add('kind test with credentialFd and the fd variable', { kind: 'test', credentialFd: { b64: tokenB64 } }, ENV_REJECTED);
    add('kind mcp with credentialFd', { kind: 'mcp', env: ENV, credentialFd: { b64: b64(PROBE) } }, ENV_REJECTED);
    add('kind mcp with credentialFd and the fd variable', { kind: 'mcp', credentialFd: { b64: tokenB64 } }, ENV_REJECTED);
    add('kind git with credentialFd', { kind: 'git', credentialFd: { b64: tokenB64 } }, PROTOCOL);
    add('kind test with the token in its env', { kind: 'test', env: { ...ENV, CLAUDE_CODE_OAUTH_TOKEN: TOKEN } }, ENV_REJECTED);
    add('kind mcp with the probe as API key', { kind: 'mcp', env: { ...ENV, ANTHROPIC_API_KEY: PROBE } }, ENV_REJECTED);
    // 4. credentialFd without the fd variable naming 3 (and the variable without a credential).
    add('claude without the fd variable', { env: ENV, credentialFd: { b64: tokenB64 } }, ENV_REJECTED);
    for (const fd of ['4', '03', '3 ', '']) {
      add(`claude with fd variable "${fd}"`, { env: { ...ENV, [CREDENTIAL_FD_ENV_KEY]: fd }, credentialFd: { b64: b64(PROBE) } }, ENV_REJECTED);
    }
    add('claude with the fd variable but no credentialFd', {}, ENV_REJECTED);
    // 5. Two credentials together (and a "never set" credential variable).
    add('fd credential + ANTHROPIC_API_KEY', { env: { ...FD_ENV, ANTHROPIC_API_KEY: PROBE }, credentialFd: { b64: tokenB64 } }, ENV_REJECTED);
    add('fd credential + CLAUDE_CODE_OAUTH_TOKEN', { env: { ...FD_ENV, CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, credentialFd: { b64: b64(PROBE) } }, ENV_REJECTED);
    add('ANTHROPIC_API_KEY + CLAUDE_CODE_OAUTH_TOKEN in env', { env: { ...ENV, ANTHROPIC_API_KEY: PROBE, CLAUDE_CODE_OAUTH_TOKEN: TOKEN } }, ENV_REJECTED);
    add('fd credential + ANTHROPIC_AUTH_TOKEN', { env: { ...FD_ENV, ANTHROPIC_AUTH_TOKEN: PROBE }, credentialFd: { b64: tokenB64 } }, ENV_REJECTED);
    // Decoded, but not UTF-8.
    const notUtf8 = b64(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TOKEN)]));
    add('credential bytes that are not UTF-8', { credentialFd: { b64: notUtf8 } }, ENV_REJECTED, [notUtf8]);
    // Valid credential, refused after decoding: the decoded value must be dropped without a trace.
    add('unknown lease', { leaseId: randomUUID(), credentialFd: { b64: tokenB64 } }, ['process_spawn_failed', 'lease_expired']);
    add('cwd outside the lease', { cwd: outside, credentialFd: { b64: tokenB64 } }, ['path_escape', 'cwd_rejected']);
    add('argv with NUL', { argv: [NODE, '-e\0x'], credentialFd: { b64: tokenB64 } }, ['unsafe_argument', 'argv_rejected']);
    return cases;
  }

  function acquired(h: RunnerHarness, a: ReturnType<SandboxRoots['attemptPaths']>): Promise<LaunchLease> {
    return h.client.acquire({
      key: `attempt-${ATTEMPT_ID}`,
      attemptId: ATTEMPT_ID,
      workerId: 'w1',
      paths: [a.worktree, a.meta, a.home, a.cache],
    });
  }

  it('every malformed, oversized or misrouted spawn frame gets an error frame without the token, the probe or their base64', async () => {
    const r = roots();
    const launch = countingLaunch(fakeLaunch());
    const h = runnerHarness({ roots: r.roots, stateDir: join(r.base, 'runner-state'), launch });
    const a = r.attemptPaths('t-proto');
    const lease = await acquired(h, a);
    const cases = spawnCases(lease.id, a.worktree, r.base);
    for (const c of cases) {
      const text = await h.raw(c.line);
      const reply = singleErrorFrame(text, c.name);
      expect([reply.code, reply.reason], c.name).toEqual([c.code, c.reason]);
      expect(findLeaks(text, c.needles), `${c.name}: reply`).toEqual([]);
    }
    expect(launch.credentials, 'nothing was launched').toEqual([]);
    await lease.release();
    expect(findLeaks(h.runnerLog()), 'runner log').toEqual([]);
    // The refusals were logged (unsafe_argument is a 500 in the catalogue, hence "failed"), only without the value.
    expect(h.runnerLog()).toMatch(/runner spawn (rejected|failed)/);
  });

  it('a frame that is not JSON or exceeds the 1 MiB frame limit is refused without echoing the credential', async () => {
    const r = roots();
    const launch = countingLaunch(fakeLaunch());
    const h = runnerHarness({ roots: r.roots, stateDir: join(r.base, 'runner-state'), launch });
    const a = r.attemptPaths('t-frame');
    const lease = await acquired(h, a);
    const frame = { v: 1, type: 'spawn', leaseId: lease.id, kind: 'claude', argv: [NODE, '-v'], cwd: a.worktree, limits: {} };
    const truncated = JSON.stringify({ ...frame, env: { ...FD_ENV, ANTHROPIC_API_KEY: PROBE }, credentialFd: { b64: b64(TOKEN) } }).slice(0, -1);
    const repeats = Math.ceil(MAX_FRAME_BYTES / TOKEN.length) + 16;
    const oversized = JSON.stringify({ ...frame, env: FD_ENV, credentialFd: { b64: b64(TOKEN.repeat(repeats)) } });
    expect(oversized.length).toBeGreaterThan(MAX_FRAME_BYTES);
    for (const [name, line] of [
      ['not JSON (SyntaxError would quote the input)', `${truncated}\n`],
      ['larger than MAX_FRAME_BYTES', `${oversized}\n`],
      ['larger than MAX_FRAME_BYTES, no newline', oversized],
    ] as const) {
      const text = await h.raw(line);
      expect(singleErrorFrame(text, name), name).toMatchObject({ code: 'validation_failed', reason: 'protocol' });
      expect(findLeaks(text), `${name}: reply`).toEqual([]);
    }
    expect(launch.credentials).toEqual([]);
    await lease.release();
    expect(findLeaks(h.runnerLog()), 'runner log').toEqual([]);
  });

  it('worker side: a credential refused by the client or by the runner leaves no trace in the error or the client log', async () => {
    const r = roots();
    const launch = countingLaunch(fakeLaunch());
    const h = runnerHarness({ roots: r.roots, stateDir: join(r.base, 'runner-state'), launch });
    const a = r.attemptPaths('t-client');
    const lease = await acquired(h, a);
    const spec = { cmd: NODE, args: ['-v'], cwd: a.worktree };
    const refused: [string, OrcError, string][] = [];
    for (const credential of [TOKEN, PROBE]) {
      // Refused by the client before the socket (wrong kind, no fd variable, two credentials).
      for (const [name, kind, env] of [
        ['test kind', 'test', ENV],
        ['mcp kind', 'mcp', ENV],
        ['no fd variable', 'claude', ENV],
        ['two credentials', 'claude', { ...FD_ENV, ANTHROPIC_API_KEY: PROBE }],
      ] as const) {
        const e = await rejection(h.client.spawn(lease, { ...spec, kind, env, credentialFd: credential }));
        refused.push([name, e, 'env_rejected']);
      }
      // Accepted by the client, refused by the runner after decoding.
      const outside = await rejection(h.client.spawn(lease, { ...spec, cwd: r.base, kind: 'claude', env: FD_ENV, credentialFd: credential }));
      refused.push(['cwd outside the lease', outside, 'cwd_rejected']);
    }
    await lease.release();
    const released = await rejection(h.client.spawn(lease, { ...spec, kind: 'claude', env: FD_ENV, credentialFd: TOKEN }));
    refused.push(['released lease', released, 'lease_expired']);
    for (const [name, e, reason] of refused) {
      expect(e.details?.['reason'], name).toBe(reason);
      for (const [where, text] of Object.entries(errorSurfaces(e))) expect(findLeaks(text), `${name}: ${where}`).toEqual([]);
    }
    expect(launch.credentials).toEqual([]);
    expect(findLeaks(h.clientLog()), 'client (worker) log').toEqual([]);
    expect(findLeaks(h.runnerLog()), 'runner log').toEqual([]);
  });
});

describe('runner disk state: lease state files and startup recovery (contract §10.11 item 3, ADR-0036 m.4)', () => {
  it('a live lease with credential spawns, a crashed runner and its recovery leave no credential on disk or in logs', async () => {
    const r = roots();
    // RUNNER_STATE_DIR below the same base, so one scan covers the state files and every lease root.
    const stateDir = join(r.base, 'runner-state');
    const inner = fakeLaunch();
    const launch = countingLaunch(inner);
    const h = runnerHarness({ roots: r.roots, stateDir, launch });
    const a = r.attemptPaths('t-state');
    const lease = await h.client.acquire({
      key: `attempt-${ATTEMPT_ID}`,
      attemptId: ATTEMPT_ID,
      workerId: 'w1',
      paths: [a.worktree, a.meta, a.home, a.cache],
    });
    const procs: SupervisedProcess[] = [];
    for (const credential of [TOKEN, PROBE]) {
      procs.push(
        await h.client.spawn(lease, { kind: 'claude', cmd: NODE, args: ['-v'], cwd: a.worktree, env: FD_ENV, credentialFd: credential }),
      );
    }
    // The decoded credential reached the launch (so it passed through the lease manager)...
    expect(launch.credentials).toEqual([TOKEN, PROBE]);
    // ...while the lease state file (`<RUNNER_STATE_DIR>/leases/<id>.json`) exists and holds no trace of it.
    expect(readdirSync(join(stateDir, 'leases'))).toEqual([`${lease.id}.json`]);
    const live = readTree(r.base);
    expect(live).toContain(lease.id);
    expect(findLeaks(live), 'disk while the children run').toEqual([]);

    // Runner crash: a new instance recovers from the same state directory (startup recoverStale).
    const recoveryLog = capture('runner');
    const recovered = createLeaseManager({
      ...MANAGER_BASE,
      roots: r.roots,
      logger: recoveryLog.logger,
      stateStore: createFileLeaseStateStore(stateDir),
      launch,
    });
    cleanups.push(() => recovered.close());
    const report = await recovered.recoverStale();
    expect(report).toMatchObject({ released: 1, failed: 0, invalidStateFiles: 0 });
    expect(readdirSync(join(stateDir, 'leases'))).toEqual([]);
    expect(findLeaks(readTree(r.base)), 'disk after recovery').toEqual([]);
    expect(recoveryLog.text()).toMatch(/runner lease recovery finished/);
    expect(findLeaks(recoveryLog.text()), 'recovery log').toEqual([]);

    for (const p of inner.procs) p.exit(0);
    for (const p of procs) await p.exited;
    await lease.release();
    expect(findLeaks(readTree(r.base)), 'disk after release').toEqual([]);
    expect(findLeaks(h.runnerLog()), 'runner log').toEqual([]);
    expect(findLeaks(h.clientLog()), 'client log').toEqual([]);
  });
});

describe('worker ConfigError: messages and details name keys, never values (ADR-0036 Decision 1)', () => {
  let dir = '';
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'orc-sec-cfg-')));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const abs = (name: string): string => join(dir, name);
  const file = (name: string, content: string): string => {
    const p = abs(name);
    writeFileSync(p, content);
    return p;
  };
  const oauthEnv = (extra: Env = {}): Env => ({
    NODE_ENV: 'development',
    DB_USER: 'orc_worker',
    DB_PASSWORD: 'db-password-SEC-cred-0001',
    PROJECTS_ROOT: abs('projects'),
    WORKSPACES_ROOT: abs('workspaces'),
    CLAUDE_HOME_ROOT: abs('claude-home'),
    CBM_CACHE_DIR: abs('cbm'),
    WORKER_ID: 'worker-1',
    CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
    ...extra,
  });
  const apiKeyEnv = (extra: Env = {}): Env => ({
    ...oauthEnv(),
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    CLAUDE_AUTH_MODE: 'api_key',
    ANTHROPIC_API_KEY: PROBE,
    ...extra,
  });
  const nearMiss = TOKEN.replace('oat01-', 'oat1-');
  const tooLong = `${TOKEN}${'x'.repeat(480)}`;

  it('the fixtures are valid in both modes (each case below fails only because of its injected value)', () => {
    expect(loadWorkerConfig(oauthEnv()).claudeAuth).toEqual({ mode: 'oauth', oauthToken: TOKEN });
    expect(loadWorkerConfig(apiKeyEnv()).claudeAuth).toEqual({ mode: 'api_key', apiKey: PROBE });
  });

  it.each([
    ['oauth: token that is not a token', () => oauthEnv({ CLAUDE_CODE_OAUTH_TOKEN: PROBE }), 'CLAUDE_CODE_OAUTH_TOKEN', BOTH],
    ['oauth: near-miss token (one digit)', () => oauthEnv({ CLAUDE_CODE_OAUTH_TOKEN: nearMiss }), 'CLAUDE_CODE_OAUTH_TOKEN', [{ name: 'near-miss', value: nearMiss }]],
    ['oauth: token with trailing whitespace', () => oauthEnv({ CLAUDE_CODE_OAUTH_TOKEN: `${TOKEN} ` }), 'CLAUDE_CODE_OAUTH_TOKEN', BOTH],
    ['oauth: token longer than 500 characters', () => oauthEnv({ CLAUDE_CODE_OAUTH_TOKEN: tooLong }), 'CLAUDE_CODE_OAUTH_TOKEN', [TOKEN_N, { name: 'long', value: tooLong }]],
    ['oauth: invalid token from CLAUDE_CODE_OAUTH_TOKEN_FILE', () => oauthEnv({ CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN_FILE: file('bad-token.txt', `${PROBE}\n`) }), 'CLAUDE_CODE_OAUTH_TOKEN', BOTH],
    ['oauth: token and CLAUDE_CODE_OAUTH_TOKEN_FILE both set', () => oauthEnv({ CLAUDE_CODE_OAUTH_TOKEN_FILE: file('token.txt', `${TOKEN}\n`) }), 'CLAUDE_CODE_OAUTH_TOKEN_FILE', BOTH],
    ['oauth: ANTHROPIC_API_KEY together with the token', () => oauthEnv({ ANTHROPIC_API_KEY: PROBE }), 'ANTHROPIC_API_KEY', BOTH],
    ['oauth: ANTHROPIC_API_KEY_FILE together with the token', () => oauthEnv({ ANTHROPIC_API_KEY_FILE: file('key.txt', PROBE) }), 'ANTHROPIC_API_KEY', BOTH],
    ['api_key: the OAuth token as ANTHROPIC_API_KEY', () => apiKeyEnv({ ANTHROPIC_API_KEY: TOKEN }), 'ANTHROPIC_API_KEY', BOTH],
    ['api_key: a key starting with sk-ant-oat', () => apiKeyEnv({ ANTHROPIC_API_KEY: `sk-ant-oat${PROBE}` }), 'ANTHROPIC_API_KEY', BOTH],
    ['api_key: an sk-ant-oat key from ANTHROPIC_API_KEY_FILE', () => apiKeyEnv({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_API_KEY_FILE: file('oat-key.txt', `${TOKEN}\r\n`) }), 'ANTHROPIC_API_KEY', BOTH],
    ['api_key: CLAUDE_CODE_OAUTH_TOKEN together with the key', () => apiKeyEnv({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN }), 'CLAUDE_CODE_OAUTH_TOKEN', BOTH],
    ['api_key: CLAUDE_CODE_OAUTH_TOKEN_FILE together with the key', () => apiKeyEnv({ CLAUDE_CODE_OAUTH_TOKEN_FILE: file('token-api.txt', TOKEN) }), 'CLAUDE_CODE_OAUTH_TOKEN', BOTH],
    ['the token pasted into CLAUDE_AUTH_MODE', () => oauthEnv({ CLAUDE_AUTH_MODE: TOKEN }), 'CLAUDE_AUTH_MODE', BOTH],
    ['the token pasted into CLAUDE_BARE', () => oauthEnv({ CLAUDE_BARE: TOKEN }), 'CLAUDE_BARE', BOTH],
  ] as const)('%s', (_name, env, key, needles: readonly Needle[]) => {
    let caught: unknown = null;
    try {
      loadWorkerConfig(env());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const e = caught as ConfigError;
    expect(e.code).toBe('config_invalid');
    expect(e.message).toContain(key);
    expect(e.cause).toBeUndefined();
    const log = capture('worker');
    log.logger.fatal({ err: e, details: e.details }, 'invalid worker configuration');
    for (const [where, text] of Object.entries({ ...errorSurfaces(e), log: log.text() })) {
      expect(findLeaks(text, needles), where).toEqual([]);
    }
  });
});

describe('@orc/logger: credential masking (ADR-0036 m.8, Opus K10(b))', () => {
  describe('runner logger (no secret registry, as apps/runner/src/main.ts)', () => {
    it('masks the plain token in msg, string fields, nested fields, arrays, child bindings and errors', () => {
      const { logger, text } = capture('runner');
      logger.info(`spawn with ${TOKEN}`);
      logger.info({ note: TOKEN, nested: { deep: { value: `x${TOKEN}y` } }, list: [TOKEN] }, 'fields');
      logger.error({ err: new Error(`failed: ${TOKEN}`) }, 'err field');
      logger.error(new Error(`direct ${TOKEN}`));
      logger.child({ binding: TOKEN }).info('child');
      expect(text()).toContain('[REDACTED]');
      expect(findLeaks(text(), [TOKEN_N])).toEqual([]);
    });

    it('censors credentialFd (with its b64 payload) and CLAUDE_CODE_OAUTH_TOKEN* keys at any depth', () => {
      const { logger, text } = capture('runner');
      const probeB64 = b64(PROBE);
      logger.info({ frame: { v: 1, type: 'spawn', kind: 'claude', credentialFd: { b64: probeB64 } } }, 'frame');
      logger.info({ request: { credentialFd: PROBE } }, 'raw credentialFd');
      logger.info({ spec: { env: { CLAUDE_CODE_OAUTH_TOKEN: PROBE, CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3' } } }, 'env');
      logger.info({ a: { b: { c: { d: { e: { f: { credentialFd: { b64: probeB64 } } } } } } } }, 'deep');
      logger.info({ frames: [{ credentialFd: { b64: probeB64 } }, { env: { CLAUDE_CODE_OAUTH_TOKEN: PROBE } }] }, 'array');
      logger.info({ CLAUDE_CODE_OAUTH_TOKEN: PROBE, claude_code_oauth_token_file: PROBE }, 'top level');
      logger.child({ credentialFd: { b64: probeB64 } }).info('child');
      expect(findLeaks(text(), [PROBE_N])).toEqual([]);
    });

    it('masks the base64 form (offset 0) in msg, string fields and child bindings', () => {
      const { logger, text } = capture('runner');
      const enc = b64(TOKEN);
      logger.info(`frame b64 ${enc}`);
      logger.info({ payload: enc, nested: { list: [enc], json: `{"b64":"${enc}"}` } }, 'fields');
      logger.child({ payload: enc }).info('child');
      expect(findLeaks(text(), [TOKEN_N])).toEqual([]);
    });

    it('masks the base64 form (offset 0) inside error messages and stacks', () => {
      const { logger, text } = capture('runner');
      const enc = b64(TOKEN);
      logger.error({ err: new Error(`bad frame ${enc}`) }, 'err field');
      logger.error(new Error(`bad frame ${enc}`));
      logger.warn({ err: { type: 'Error', message: `bad frame ${enc}` } }, 'serialized error');
      expect(findLeaks(text(), [TOKEN_N])).toEqual([]);
    });

    it('masks base64 forms at a non-zero offset (the token inside a larger encoded payload)', () => {
      const { logger, text } = capture('runner');
      for (const prefix of ['x', 'xy', '{"chunk":"', 'stdout: ']) {
        const enc = b64(`${prefix}${TOKEN}\n`);
        logger.info(`stdout frame ${enc}`);
        logger.info({ frame: { v: 1, type: 'stdout', b64: enc } }, 'frame');
        logger.error({ err: new Error(`bad chunk ${enc}`) }, 'err');
      }
      expect(findLeaks(text(), [TOKEN_N])).toEqual([]);
    });
  });

  describe('worker logger (registry filled by createClaudeRunner, as apps/worker)', () => {
    function workerRegistry(auth: ClaudeRunnerConfig['auth']): SecretRegistry {
      const secrets = createSecretRegistry();
      const launcher = createLocalLauncher({ logger: silent() });
      cleanups.push(() => launcher.close());
      const root = IS_WIN ? 'C:\\orc' : '/srv/orc';
      createClaudeRunner(
        {
          bin: 'claude',
          binPrefixArgs: [],
          claudeHomeRoot: join(root, 'claude-home'),
          auth,
          proxy: { https: null, http: null, noProxy: null, token: null },
          killGraceMs: 10_000,
          initTimeoutMs: 60_000,
          maxOutputBytes: 52_428_800,
          maxLineBytes: 4_194_304,
          cbmCacheRoot: join(root, 'cbm-cache'),
          platform: IS_WIN ? 'win32' : 'posix',
          workerId: 'worker-1',
          initExtraTools: [],
        },
        { logger: silent(), secrets, launcher },
      );
      return secrets;
    }
    const MODES = [
      ['oauth token', { mode: 'oauth', oauthToken: TOKEN }, TOKEN_N],
      ['api key (unmasked probe value)', { mode: 'api_key', apiKey: PROBE }, PROBE_N],
    ] as const;

    it.each(MODES)('%s: plain and offset-0 base64 forms are masked in msg, fields, bindings and errors', (_name, auth, needle) => {
      const { logger, text } = capture('worker', workerRegistry(auth));
      for (const value of [needle.value, b64(needle.value)]) {
        logger.info(`credential ${value}`);
        logger.info({ v: value, n: { m: [`<${value}>`] } }, 'fields');
        logger.error({ err: new Error(`e ${value}`) }, 'err');
        logger.error(new Error(`direct ${value}`));
        logger.child({ b: value }).info('child');
      }
      expect(findLeaks(text(), [needle])).toEqual([]);
    });

    it.each(MODES)('%s: base64 forms at a non-zero offset are masked', (_name, auth, needle) => {
      const { logger, text } = capture('worker', workerRegistry(auth));
      for (const prefix of ['x', 'xy', '{"chunk":"']) {
        const enc = b64(`${prefix}${needle.value}\n`);
        logger.info(`stdout frame ${enc}`);
        logger.info({ frame: { type: 'stdout', b64: enc } }, 'frame');
        logger.error({ err: new Error(`bad chunk ${enc}`) }, 'err');
      }
      expect(findLeaks(text(), [needle])).toEqual([]);
    });
  });
});

/** Written by the `@@fake exec` child: its own and its parent's (Claude's) environ and fds, and every readable process. */
const EXEC_REPORT_SCRIPT = [
  "const fs = require('fs');",
  "const read = (p) => { try { return fs.readFileSync(p).toString('base64'); } catch (e) { return 'ERR:' + (e && e.code); } };",
  "const fds = (pid) => { try { return fs.readdirSync('/proc/' + pid + '/fd').map((n) => { try { return fs.readlinkSync('/proc/' + pid + '/fd/' + n); } catch (e) { return 'ERR:' + (e && e.code); } }); } catch (e) { return ['ERR:' + (e && e.code)]; } };",
  "const all = fs.readdirSync('/proc').filter((n) => /^[0-9]+$/.test(n)).map((pid) => ({ pid: Number(pid), environ: read('/proc/' + pid + '/environ'), cmdline: read('/proc/' + pid + '/cmdline') }));",
  "fs.writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, ppid: process.ppid, self: { environ: read('/proc/self/environ'), fds: fds('self') }, parent: { environ: read('/proc/' + process.ppid + '/environ'), fds: fds(process.ppid) }, all }));",
  "process.stdout.write('reported');",
].join(' ');

interface ProcDump {
  pid: number;
  environ: string;
  cmdline: string;
}
interface ExecReport {
  pid: number;
  ppid: number;
  self: { environ: string; fds: string[] };
  parent: { environ: string; fds: string[] };
  all: ProcDump[];
}

function decodeDump(value: string, where: string): string {
  expect(value.startsWith('ERR:'), `${where} readable (${value.slice(0, 20)})`).toBe(false);
  return Buffer.from(value, 'base64').toString('latin1');
}

/** pids of readable processes whose environ or cmdline holds any form of `needles` (Linux). */
function procsHolding(needles: readonly Needle[]): number[] {
  const out: number[] = [];
  for (const pid of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    let text = '';
    for (const part of ['environ', 'cmdline']) {
      try {
        text += readFileSync(`/proc/${pid}/${part}`).toString('latin1');
      } catch {
        // exited or not readable
      }
    }
    if (findLeaks(text, needles).length > 0) out.push(Number(pid));
  }
  return out;
}

describe.skipIf(IS_WIN)('Linux: Claude and its children never see the credential (fd 3 transport, ADR-0036 m.4/m.11)', () => {
  async function linuxRunner(): Promise<{ layout: RunnerLayout; h: RunnerHarness; lease: LaunchLease; launches: () => number }> {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'orc-sec-cred-linux-')));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const layout = await createRunnerLayout(base);
    const launch = countingLaunch(createDefaultLaunch());
    const h = runnerHarness({
      roots: [layout.workspacesRoot, layout.claudeHomeRoot, layout.cbmCacheRoot],
      stateDir: join(base, 'runner-state'),
      launch,
    });
    const lease = await h.client.acquire({
      key: `attempt-${RUN_ATTEMPT_ID}`,
      attemptId: RUN_ATTEMPT_ID,
      workerId: 'worker-test-1',
      paths: [layout.worktree, layout.metaDir],
    });
    cleanups.push(async () => {
      await lease.release();
    });
    return { layout, h, lease, launches: () => launch.credentials.length };
  }

  it.each([
    ['worker ClaudeRunner -> runner, sk-ant-oat token', 'claude-runner', TOKEN],
    ['runner client spawn, unmasked probe value', 'client', PROBE],
  ] as const)('%s: not in the environ, cmdline or fds of Claude, of its exec child or of any process', async (_name, path, credential) => {
    const { layout, h, lease } = await linuxRunner();
    const reportPath = join(layout.worktree, 'exec-report.json');
    const directives = ['@@fake echo-env', '@@fake echo-fds', `@@fake exec ${JSON.stringify([NODE, '-e', EXEC_REPORT_SCRIPT, reportPath])}`];
    const request = makeRunRequest(layout, { lease, directives });
    const workerLog = capture('worker');
    const lines: string[] = [];
    const stderr: string[] = [];
    let claudePid: number;
    if (path === 'claude-runner') {
      const runner = createClaudeRunner(fakeRunnerConfig(layout, { auth: { mode: 'oauth', oauthToken: credential } }), {
        logger: workerLog.logger,
        secrets: createSecretRegistry(),
        launcher: h.client,
      });
      const { handlers, rec } = recordingHandlers();
      const res = await runner.run(request, handlers);
      expect(res.outcome).toBe('success');
      expect(res.init).toMatchObject({ apiKeySource: 'none' });
      lines.push(...rec.lines.map((l) => l.raw));
      stderr.push(...rec.stderr);
      claudePid = rec.spawn?.pid ?? 0;
      expect(rec.lines.some((l) => systemSubtype(l.parsed) === 'fake_exec')).toBe(true);
    } else {
      // The production env builder with the probe value (the CLI only needs a non-empty fd 3 payload).
      const cfg = fakeRunnerConfig(layout, { auth: { mode: 'oauth', oauthToken: credential } });
      const built = buildClaudeLaunchEnv(cfg, request, process.env);
      expect(built.credentialFd).toBe(credential);
      expect(Object.values(built.env).join('\n')).not.toContain(credential);
      const proc = await h.client.spawn(lease, {
        kind: 'claude',
        cmd: cfg.bin,
        args: [...cfg.binPrefixArgs, ...buildClaudeArgv(request, { platform: 'posix' })],
        cwd: request.cwd,
        env: built.env,
        credentialFd: credential,
      });
      claudePid = proc.pid;
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let ended = 0;
      proc.stdout.on('data', (d: Buffer) => out.push(d));
      proc.stderr.on('data', (d: Buffer) => err.push(d));
      proc.stdout.on('end', () => {
        ended += 1;
      });
      proc.stderr.on('end', () => {
        ended += 1;
      });
      proc.stdin.end(request.stdinPrompt);
      expect((await proc.exited).exitCode).toBe(0);
      await waitFor(() => ended === 2, 5000);
      lines.push(...Buffer.concat(out).toString('utf8').split('\n').filter((l) => l.length > 0));
      stderr.push(Buffer.concat(err).toString('utf8'));
    }
    const event = (subtype: string): Record<string, unknown> => {
      const raw = lines.find((l) => l.includes(`"subtype":"${subtype}"`));
      expect(raw, subtype).toBeDefined();
      return JSON.parse(raw ?? '{}') as Record<string, unknown>;
    };
    expect(event('fake_env')).toMatchObject({ authSource: 'oauth_fd', hasOauthToken: false, hasOauthFdVar: true, hasApiKey: false });
    const identity = event('fake_fds')['credentialFdTarget'];
    expect(identity).toMatch(/^(pipe|socket):\[\d+\]$/);
    expect(event('fake_exec')).toMatchObject({ exitCode: 0, stdout: 'reported' });

    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as ExecReport;
    expect(report.ppid, 'the exec child is a direct child of Claude').toBe(claudePid);
    const claudeEnviron = decodeDump(report.parent.environ, 'Claude environ');
    const childEnviron = decodeDump(report.self.environ, 'exec child environ');
    expect(claudeEnviron).toContain(`${CREDENTIAL_FD_ENV_KEY}=3\0`);
    expect(claudeEnviron).not.toContain('CLAUDE_CODE_OAUTH_TOKEN=');
    expect(childEnviron).toContain(`ORC_ATTEMPT_ID=${RUN_ATTEMPT_ID}`);
    expect(findLeaks(claudeEnviron), 'Claude environ').toEqual([]);
    expect(findLeaks(childEnviron), 'exec child environ').toEqual([]);
    expect(report.parent.fds.length).toBeGreaterThan(2);
    expect(report.parent.fds, 'Claude fds after the read').not.toContain(identity);
    expect(report.self.fds.length).toBeGreaterThan(2);
    expect(report.self.fds, 'exec child fds').not.toContain(identity);
    expect(report.all.map((p) => p.pid)).toEqual(expect.arrayContaining([report.pid, claudePid, process.pid]));
    const holding = report.all
      .filter((p) => {
        const text = ['environ', 'cmdline']
          .map((k) => {
            const v = k === 'environ' ? p.environ : p.cmdline;
            return v.startsWith('ERR:') ? '' : Buffer.from(v, 'base64').toString('latin1');
          })
          .join('\n');
        return findLeaks(text).length > 0;
      })
      .map((p) => p.pid);
    expect(holding, 'processes whose environ/cmdline held the credential during the run').toEqual([]);

    expect(findLeaks(lines.join('\n')), 'Claude stdout').toEqual([]);
    expect(findLeaks(stderr.join('\n')), 'Claude stderr').toEqual([]);
    expect(findLeaks(readTree(layout.root)), 'disk (worktree, homes, runner state)').toEqual([]);
    expect(findLeaks(h.runnerLog()), 'runner log').toEqual([]);
    expect(findLeaks(h.clientLog()), 'client log').toEqual([]);
    expect(findLeaks(workerLog.text()), 'worker (claude-runner) log').toEqual([]);
  });

  it('the runner refuses credentialFd for test and mcp and two credentials; nothing is spawned and no process holds the value', async () => {
    const { layout, h, lease, launches } = await linuxRunner();
    const base = { v: 1, type: 'spawn', leaseId: lease.id, argv: [NODE, '-e', 'setTimeout(() => {}, 5000)'], cwd: layout.worktree, limits: {} };
    for (const [name, frame] of [
      ['test + credentialFd', { ...base, kind: 'test', env: ENV, credentialFd: { b64: b64(TOKEN) } }],
      ['mcp + credentialFd', { ...base, kind: 'mcp', env: ENV, credentialFd: { b64: b64(PROBE) } }],
      ['test + fd variable + credentialFd', { ...base, kind: 'test', env: FD_ENV, credentialFd: { b64: b64(TOKEN) } }],
      ['claude: fd credential + ANTHROPIC_API_KEY', { ...base, kind: 'claude', env: { ...FD_ENV, ANTHROPIC_API_KEY: PROBE }, credentialFd: { b64: b64(TOKEN) } }],
      ['claude: fd credential + CLAUDE_CODE_OAUTH_TOKEN', { ...base, kind: 'claude', env: { ...FD_ENV, CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, credentialFd: { b64: b64(PROBE) } }],
      ['claude: both credentials in env', { ...base, kind: 'claude', env: { ...ENV, ANTHROPIC_API_KEY: PROBE, CLAUDE_CODE_OAUTH_TOKEN: TOKEN } }],
    ] as const) {
      const text = await h.raw(`${JSON.stringify(frame)}\n`);
      expect(singleErrorFrame(text, name), name).toMatchObject({ code: 'unsafe_argument', reason: 'env_rejected' });
      expect(findLeaks(text), `${name}: reply`).toEqual([]);
    }
    expect(launches(), 'no child was launched').toBe(0);
    expect(procsHolding(BOTH), 'processes holding the value').toEqual([]);
    expect(findLeaks(h.runnerLog()), 'runner log').toEqual([]);
    expect(findLeaks(readTree(layout.root)), 'disk').toEqual([]);
  });
});
