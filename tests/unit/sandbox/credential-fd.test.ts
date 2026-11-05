// ADR-0036 m.4/m.8 credential transport through @orc/sandbox (contract §10.11 item 5): the runner
// client sends `credentialFd {b64}`, the server decodes it for the lease manager, which hands it to
// the launch (fd 3); only kind `claude` with `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3` is accepted;
// the value reaches no log line, no error frame and no lease state. Local launcher: same rules,
// passed to spawnSupervised (real fd 3 on POSIX; rejected on win32).
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Writable, type Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, type Logger } from '@orc/logger';
import {
  createLeaseManager,
  createLocalLauncher,
  createMemoryLeaseStateStore,
  createRunnerClient,
  createRunnerServer,
  CREDENTIAL_FD_ENV_KEY,
  type LeaseStateStore,
} from '@orc/sandbox';
import { OrcError } from '@orc/shared';
import { ATTEMPT_ID, fakeLaunch, socketPair, waitFor } from '../../helpers/sandbox/fakes';
import { makeRoots, type SandboxRoots } from '../../helpers/sandbox/roots';

const IS_WIN = process.platform === 'win32';
const NODE = process.execPath;
const ENV = { PATH: process.env.PATH ?? '' };
// Deliberately not `sk-ant-oat…`: logger redaction must not be what keeps the value out of the logs.
const SECRET = 'fd3-credential-TESTONLY-7f3a9c1e5b2d4f6a8c0e';
const SECRET_B64 = Buffer.from(SECRET, 'utf8').toString('base64');
const FD_ENV = { ...ENV, [CREDENTIAL_FD_ENV_KEY]: '3' };
const CAPS = { ok: false, uidSwitch: false, chown: false, kill: false, prlimit: false, procfs: false };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function captureLogger(): { logger: Logger; text: () => string } {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  const logger = createLogger({ service: 'runner', level: 'trace', version: 'test', env: 'test', destination });
  return { logger, text: () => chunks.join('') };
}

function roots(): SandboxRoots {
  const r = makeRoots();
  cleanups.push(() => r.cleanup());
  return r;
}

function expectNoSecret(text: string): void {
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(SECRET_B64);
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

function runnerHarness(store: LeaseStateStore = createMemoryLeaseStateStore()) {
  const r = roots();
  const log = captureLogger();
  const launch = fakeLaunch();
  const manager = createLeaseManager({
    roots: r.roots,
    workerUid: 1000,
    workerGid: 1000,
    uidBase: 20000,
    maxLeases: 4,
    leaseTtlMs: 40_000,
    killGraceMs: 100,
    limits: { nproc: 512, nofile: 4096, fsizeBytes: 2 ** 31 },
    identity: 'none',
    prlimitPath: null,
    logger: log.logger,
    stateStore: store,
    launch,
  });
  const server = createRunnerServer({
    socketPath: join(r.base, 'unused.sock'),
    manager,
    hello: { uidBase: 20000, maxLeases: 4, leaseTtlMs: 40_000, caps: CAPS },
    logger: log.logger,
    maxConnections: 16,
    socketGroup: null,
    killGraceMs: 100,
    exitDrainMs: 100,
  });
  /** Every byte the client wrote to the runner, per connection. */
  const wire: Buffer[][] = [];
  const connect = (): Duplex => {
    const [s, c] = socketPair();
    const parts: Buffer[] = [];
    wire.push(parts);
    s.on('data', (d: Buffer) => parts.push(d));
    server.handleConnection(s);
    return c;
  };
  const client = createRunnerClient({ socketPath: 'unused', connect, logger: log.logger });
  cleanups.push(async () => {
    await client.close();
    await manager.close();
  });
  const a = r.attemptPaths('t-cred');
  const acquire = () =>
    client.acquire({
      key: `attempt-${ATTEMPT_ID}`,
      attemptId: ATTEMPT_ID,
      workerId: 'w1',
      paths: [a.worktree, a.meta, a.home, a.cache],
    });
  /** Raw spawn frame straight to the server (bypasses the client's own pre-check). */
  const rawSpawn = async (frame: object): Promise<string> => {
    const [s, c] = socketPair();
    const parts: Buffer[] = [];
    let closed = false;
    c.on('data', (d: Buffer) => parts.push(d));
    c.on('close', () => {
      closed = true;
    });
    c.on('error', () => undefined);
    server.handleConnection(s);
    c.write(`${JSON.stringify(frame)}\n`);
    await waitFor(() => closed, 5000);
    return Buffer.concat(parts).toString('utf8');
  };
  return { r, a, log, launch, manager, client, wire, acquire, rawSpawn };
}

describe('runner client -> server -> lease manager (in-memory socket)', () => {
  it('sends credentialFd {b64}, the launch gets the decoded value; env and logs never carry it', async () => {
    const store = createMemoryLeaseStateStore();
    const h = runnerHarness(store);
    const lease = await h.acquire();
    const proc = await h.client.spawn(lease, {
      kind: 'claude',
      cmd: NODE,
      args: ['-v'],
      cwd: h.a.worktree,
      env: FD_ENV,
      credentialFd: SECRET,
    });
    const frame = JSON.parse(Buffer.concat(h.wire.at(-1) ?? []).toString('utf8').split('\n')[0] ?? 'null') as {
      type: string;
      kind: string;
      env: Record<string, string>;
      credentialFd?: { b64: string };
    };
    expect(frame).toMatchObject({ type: 'spawn', kind: 'claude', credentialFd: { b64: SECRET_B64 } });
    expect(Object.keys(frame.credentialFd ?? {})).toEqual(['b64']);
    expect(frame.env).toEqual(FD_ENV);
    expect(h.launch.calls).toHaveLength(1);
    expect(h.launch.calls[0]).toMatchObject({ env: FD_ENV, credentialFd: SECRET });
    expect(Object.values(h.launch.calls[0]?.env ?? {})).not.toContain(SECRET);

    h.launch.procs[0]?.exit(0);
    expect((await proc.exited).exitCode).toBe(0);
    expectNoSecret(JSON.stringify(await store.list()));
    await lease.release();
    expectNoSecret(h.log.text());
  });

  it('a spawn without credentialFd carries no such field', async () => {
    const h = runnerHarness();
    const lease = await h.acquire();
    const proc = await h.client.spawn(lease, {
      kind: 'claude',
      cmd: NODE,
      args: ['-v'],
      cwd: h.a.worktree,
      env: { ...ENV, ANTHROPIC_API_KEY: 'k' },
    });
    const line = Buffer.concat(h.wire.at(-1) ?? []).toString('utf8').split('\n')[0] ?? '';
    expect(line).not.toContain('credentialFd');
    expect(h.launch.calls[0]).not.toHaveProperty('credentialFd');
    h.launch.procs[0]?.exit(0);
    await proc.exited;
    await lease.release();
  });

  it('the client refuses a misrouted credential before it reaches the socket', async () => {
    const h = runnerHarness();
    const lease = await h.acquire();
    const sent = h.wire.length;
    for (const spec of [
      { kind: 'test' as const, env: ENV },
      { kind: 'mcp' as const, env: ENV },
      { kind: 'claude' as const, env: ENV },
    ]) {
      const e = await rejection(
        h.client.spawn(lease, { ...spec, cmd: NODE, args: ['-v'], cwd: h.a.worktree, credentialFd: SECRET }),
      );
      expect([e.code, e.details?.reason]).toEqual(['unsafe_argument', 'env_rejected']);
      expectNoSecret(JSON.stringify({ m: e.message, d: e.details }));
    }
    expect(h.wire.length).toBe(sent);
    expect(h.launch.calls).toHaveLength(0);
    await lease.release();
  });

  it('the runner rejects credentialFd for test and mcp, without fd 3, and two credentials (env_rejected)', async () => {
    const h = runnerHarness();
    const lease = await h.acquire();
    const base = {
      v: 1,
      type: 'spawn',
      leaseId: lease.id,
      argv: [NODE, '-v'],
      cwd: h.a.worktree,
      limits: {},
    };
    const cases: object[] = [
      { ...base, kind: 'test', env: ENV, credentialFd: { b64: SECRET_B64 } },
      { ...base, kind: 'mcp', env: ENV, credentialFd: { b64: SECRET_B64 } },
      { ...base, kind: 'test', env: FD_ENV, credentialFd: { b64: SECRET_B64 } },
      { ...base, kind: 'claude', env: ENV, credentialFd: { b64: SECRET_B64 } },
      { ...base, kind: 'claude', env: { ...ENV, [CREDENTIAL_FD_ENV_KEY]: '4' }, credentialFd: { b64: SECRET_B64 } },
      { ...base, kind: 'claude', env: FD_ENV },
      { ...base, kind: 'claude', env: { ...FD_ENV, ANTHROPIC_API_KEY: SECRET }, credentialFd: { b64: SECRET_B64 } },
      { ...base, kind: 'claude', env: { ...FD_ENV, CLAUDE_CODE_OAUTH_TOKEN: SECRET }, credentialFd: { b64: SECRET_B64 } },
      { ...base, kind: 'claude', env: { ...ENV, ANTHROPIC_API_KEY: SECRET, CLAUDE_CODE_OAUTH_TOKEN: SECRET } },
      // Not UTF-8 after decoding.
      { ...base, kind: 'claude', env: FD_ENV, credentialFd: { b64: Buffer.from([0xff, 0xfe]).toString('base64') } },
    ];
    for (const frame of cases) {
      const text = await h.rawSpawn(frame);
      const reply = JSON.parse(text.trim()) as { type: string; code: string; reason?: string };
      expect(reply, JSON.stringify(frame)).toMatchObject({
        type: 'error',
        code: 'unsafe_argument',
        reason: 'env_rejected',
      });
      expectNoSecret(text);
    }
    // Oversized: a schema violation (protocol error), still without echoing the payload.
    const big = Buffer.alloc(4097, 0x41).toString('base64');
    const text = await h.rawSpawn({ ...base, kind: 'claude', env: FD_ENV, credentialFd: { b64: big } });
    expect(JSON.parse(text.trim())).toMatchObject({ type: 'error', code: 'validation_failed', reason: 'protocol' });
    expect(text).not.toContain(big);
    expect(h.launch.calls).toHaveLength(0);
    await lease.release();
    expectNoSecret(h.log.text());
    expect(h.log.text()).not.toContain(big);
  });
});

describe('local launcher credentialFd', () => {
  const localLease = async (platform?: 'posix' | 'win32') => {
    const r = roots();
    const a = r.attemptPaths('t-local');
    const log = captureLogger();
    const launcher = createLocalLauncher({
      logger: log.logger,
      killGraceMs: 500,
      ...(platform === undefined ? {} : { platform }),
    });
    cleanups.push(() => launcher.close());
    const lease = await launcher.acquire({
      key: `attempt-${ATTEMPT_ID}`,
      attemptId: ATTEMPT_ID,
      workerId: 'w1',
      paths: [a.worktree, a.meta],
    });
    return { a, launcher, lease, log };
  };

  it('applies the runner rules before spawning', async () => {
    const { a, launcher, lease, log } = await localLease();
    for (const spec of [
      { kind: 'test' as const, env: ENV, credentialFd: SECRET },
      { kind: 'mcp' as const, env: ENV, credentialFd: SECRET },
      { kind: 'claude' as const, env: ENV, credentialFd: SECRET },
      { kind: 'claude' as const, env: FD_ENV },
      { kind: 'claude' as const, env: { ...FD_ENV, ANTHROPIC_API_KEY: SECRET }, credentialFd: SECRET },
    ]) {
      const e = await rejection(launcher.spawn(lease, { ...spec, cmd: NODE, args: ['-v'], cwd: a.worktree }));
      expect([e.code, e.details?.reason]).toEqual(['unsafe_argument', 'env_rejected']);
      expectNoSecret(JSON.stringify({ m: e.message, d: e.details }));
    }
    expect(await launcher.listLeases()).toMatchObject([{ pids: [] }]);
    expectNoSecret(log.text());
  });

  it('win32: the fd path is unsupported (spawnSupervised refuses before spawning)', async () => {
    const { a, launcher, lease } = await localLease('win32');
    const e = await rejection(
      launcher.spawn(lease, {
        kind: 'claude',
        cmd: NODE,
        args: ['-v'],
        cwd: a.worktree,
        env: FD_ENV,
        credentialFd: SECRET,
      }),
    );
    expect([e.code, e.details?.reason]).toEqual(['process_spawn_failed', 'credential_fd_unsupported']);
    expectNoSecret(JSON.stringify({ m: e.message, d: e.details }));
    expect(await launcher.listLeases()).toMatchObject([{ pids: [] }]);
  });

  it.skipIf(IS_WIN)('POSIX: the child reads the value on fd 3 to EOF; its env never carries it', async () => {
    const { a, launcher, lease, log } = await localLease();
    const script = [
      'const fs = require("fs");',
      'const v = fs.readFileSync(3);',
      'const sha = require("crypto").createHash("sha256").update(v).digest("hex");',
      'const inEnv = Object.values(process.env).some((x) => x.includes(v.toString()));',
      'process.stdout.write(JSON.stringify({ sha, len: v.length, inEnv, fdVar: process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR }));',
    ].join('\n');
    const proc = await launcher.spawn(lease, {
      kind: 'claude',
      cmd: NODE,
      args: ['-e', script],
      cwd: a.worktree,
      env: FD_ENV,
      credentialFd: SECRET,
    });
    const out: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    expect((await proc.exited).exitCode).toBe(0);
    await waitFor(() => out.length > 0, 2000);
    expect(JSON.parse(Buffer.concat(out).toString('utf8'))).toEqual({
      sha: createHash('sha256').update(SECRET).digest('hex'),
      len: Buffer.byteLength(SECRET),
      inEnv: false,
      fdVar: '3',
    });
    expectNoSecret(log.text());
  });
});
