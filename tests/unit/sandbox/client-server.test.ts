// Runner client <-> server over in-memory socket pairs (all platforms): real lease manager in
// identity `none`, real child processes (node, leader-only stop), no prlimit.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLeaseManager,
  createMemoryLeaseStateStore,
  createRunnerClient,
  createRunnerServer,
  isRunnerDisconnected,
  MAX_FRAME_BYTES,
  type LeaseManager,
  type RunnerClient,
  type RunnerDisconnectInfo,
  type RunnerServer,
} from '@orc/sandbox';
import { OrcError } from '@orc/shared';
import { isProcessAlive, type SupervisedProcess } from '@orc/shared/node';
import {
  ATTEMPT_ID,
  ATTEMPT_ID_2,
  leaderOnlyLaunch,
  silentLogger,
  socketPair,
  waitFor,
} from '../../helpers/sandbox/fakes';
import { makeRoots, type SandboxRoots } from '../../helpers/sandbox/roots';

const NODE = process.execPath;
const ENV = { PATH: process.env.PATH ?? '' };
const CAPS = {
  ok: false,
  uidSwitch: false,
  chown: false,
  kill: false,
  prlimit: false,
  procfs: false,
};

let r: SandboxRoots;
let manager: LeaseManager;
let server: RunnerServer;
let client: RunnerClient;
const serverSides: Duplex[] = [];
const disconnects: RunnerDisconnectInfo[] = [];

const connect = (): Duplex => {
  const [s, c] = socketPair();
  serverSides.push(s);
  server.handleConnection(s);
  return c;
};

beforeAll(() => {
  r = makeRoots();
  manager = createLeaseManager({
    roots: r.roots,
    workerUid: 1000,
    workerGid: 1000,
    uidBase: 20000,
    maxLeases: 8,
    leaseTtlMs: 40_000,
    killGraceMs: 500,
    limits: { nproc: 512, nofile: 4096, fsizeBytes: 2 ** 31 },
    identity: 'none',
    prlimitPath: null,
    logger: silentLogger(),
    stateStore: createMemoryLeaseStateStore(),
    launch: leaderOnlyLaunch,
  });
  server = createRunnerServer({
    socketPath: join(r.base, 'unused.sock'),
    manager,
    hello: { uidBase: 20000, maxLeases: 8, leaseTtlMs: 40_000, caps: CAPS },
    logger: silentLogger(),
    maxConnections: 16,
    socketGroup: null,
    killGraceMs: 500,
    exitDrainMs: 500,
  });
  client = createRunnerClient({
    socketPath: 'unused',
    connect,
    onDisconnect: (i) => disconnects.push(i),
  });
});

afterAll(async () => {
  await client.close();
  await manager.close();
  r.cleanup();
});

const collect = (s: NodeJS.ReadableStream): Promise<Buffer> =>
  new Promise((resolve) => {
    const parts: Buffer[] = [];
    s.on('data', (d: Buffer) => parts.push(d));
    s.on('end', () => resolve(Buffer.concat(parts)));
  });

async function rawExchange(payload: string | Buffer): Promise<{ text: string; closed: boolean }> {
  const [s, c] = socketPair();
  server.handleConnection(s);
  const parts: Buffer[] = [];
  let closed = false;
  c.on('data', (d: Buffer) => parts.push(d));
  c.on('close', () => {
    closed = true;
  });
  c.on('error', () => undefined);
  c.write(payload);
  await waitFor(() => closed, 5000);
  return { text: Buffer.concat(parts).toString('utf8'), closed };
}

async function orcReason(p: Promise<unknown>): Promise<[string, unknown]> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OrcError);
    return [(e as OrcError).code, (e as OrcError).details?.reason];
  }
  return ['resolved', undefined];
}

describe('runner protocol round trip (in-memory socket)', () => {
  it('hello', async () => {
    expect(await client.hello()).toEqual({
      protocol: 1,
      uidBase: 20000,
      maxLeases: 8,
      leaseTtlMs: 40_000,
      caps: CAPS,
    });
  });

  it('acquire, spawn with stdin/stdout/stderr/exit, list, measure, release', async () => {
    const a = r.attemptPaths('t1');
    const lease = await client.acquire({
      key: `attempt-${ATTEMPT_ID}`,
      attemptId: ATTEMPT_ID,
      workerId: 'worker-1',
      paths: [a.worktree, a.meta],
    });
    expect(lease.uid).toBeNull();
    const proc = await client.spawn(lease, {
      kind: 'test',
      cmd: NODE,
      args: [
        '-e',
        'process.stdin.on("data", d => process.stdout.write("in:" + d)); process.stdin.on("end", () => { process.stderr.write("err"); setTimeout(() => process.exit(3), 50); })',
      ],
      cwd: a.worktree,
      env: ENV,
    });
    expect(proc.pid).toBeGreaterThan(0);
    const listed = await client.listLeases();
    expect(listed.find((l) => l.id === lease.id)?.pids).toContain(proc.pid);
    const out = collect(proc.stdout);
    const err = collect(proc.stderr);
    proc.stdin.write('hello');
    proc.stdin.end();
    expect(await proc.exited).toEqual({ exitCode: 3, signal: null });
    expect((await out).toString()).toBe('in:hello');
    expect((await err).toString()).toBe('err');
    expect(isRunnerDisconnected(proc)).toBe(false);

    const m = await lease.measure(a.worktree, 1000);
    expect(m).toMatchObject({ truncated: false });
    expect(m.entries).toBeGreaterThan(2);
    expect(await orcReason(lease.measure(r.ws, 10))).toEqual(['path_escape', 'path_rejected']);

    await lease.renew();
    const released = await lease.release();
    expect(released.reclaimed).toBe(true);
    expect(await lease.release()).toBe(released);
    expect(await orcReason(lease.renew())).toEqual(['process_spawn_failed', 'lease_expired']);
  });

  it('streams large output intact across frames', async () => {
    const a = r.attemptPaths('t-big');
    const lease = await client.acquire({
      key: `attempt-${ATTEMPT_ID_2}`,
      attemptId: ATTEMPT_ID_2,
      workerId: 'w',
      paths: [a.worktree],
    });
    const size = 3 * 1024 * 1024 + 17;
    const proc = await client.spawn(lease, {
      kind: 'mcp',
      cmd: NODE,
      args: ['-e', `process.stdout.write(Buffer.alloc(${size}, 120))`],
      cwd: a.worktree,
      env: ENV,
    });
    const out = await collect(proc.stdout);
    expect((await proc.exited).exitCode).toBe(0);
    expect(out.length).toBe(size);
    expect(out.every((b) => b === 120)).toBe(true);
    await lease.release();
  });

  it('stop terminates a running child and reports a KillResult', async () => {
    const a = r.attemptPaths('t-stop');
    const lease = await client.acquire({
      key: `attempt-${ATTEMPT_ID}`,
      attemptId: ATTEMPT_ID,
      workerId: 'w',
      paths: [a.worktree],
    });
    const proc = await client.spawn(lease, {
      kind: 'test',
      cmd: NODE,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: a.worktree,
      env: ENV,
    });
    // A fractional grace period must still be a valid frame (not a protocol violation that drops
    // the connection and reports the leader as a survivor).
    const k = await proc.stop({ graceMs: 300.5 });
    expect(k.survivors).toEqual([]);
    expect(await proc.stop({ graceMs: 300.5 })).toBe(k);
    const exit = await proc.exited;
    expect(exit.exitCode === 0).toBe(false);
    expect(await waitFor(() => !isProcessAlive(proc.pid), 5000)).toBe(true);
    await lease.release();
  }, 30_000);

  it('maps runner errors: busy, env, cwd', async () => {
    const a = r.attemptPaths('t-err');
    const lease = await client.acquire({
      key: `attempt-${ATTEMPT_ID}`,
      attemptId: ATTEMPT_ID,
      workerId: 'w',
      paths: [a.worktree],
    });
    expect(
      await orcReason(
        client.acquire({
          key: `attempt-${ATTEMPT_ID_2}`,
          attemptId: ATTEMPT_ID_2,
          workerId: 'w',
          paths: [join(a.worktree, 'src')],
        }),
      ),
    ).toEqual(['process_spawn_failed', 'busy']);
    const spec = { kind: 'test' as const, cmd: NODE, args: ['-v'], cwd: a.worktree, env: ENV };
    expect(
      await orcReason(client.spawn(lease, { ...spec, env: { ...ENV, ANTHROPIC_API_KEY: 'k' } })),
    ).toEqual(['unsafe_argument', 'env_rejected']);
    expect(await orcReason(client.spawn(lease, { ...spec, cwd: a.meta }))).toEqual([
      'path_escape',
      'cwd_rejected',
    ]);
    await lease.release();
  });

  it('a dropped connection stops the child and resolves exited as disconnected', async () => {
    const a = r.attemptPaths('t-drop');
    const lease = await client.acquire({
      key: `attempt-${ATTEMPT_ID}`,
      attemptId: ATTEMPT_ID,
      workerId: 'w',
      paths: [a.worktree],
    });
    const proc: SupervisedProcess = await client.spawn(lease, {
      kind: 'claude',
      cmd: NODE,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: a.worktree,
      env: ENV,
    });
    serverSides[serverSides.length - 1]?.destroy();
    expect(await proc.exited).toEqual({ exitCode: null, signal: null });
    expect(isRunnerDisconnected(proc)).toBe(true);
    expect(disconnects).toContainEqual({ leaseId: lease.id, pid: proc.pid });
    expect(await waitFor(() => !isProcessAlive(proc.pid), 10_000)).toBe(true);
    expect((await proc.stop({ graceMs: 10 })).survivors).toEqual([proc.pid]);
    await lease.release();
  }, 30_000);
});

describe('protocol violations close the connection', () => {
  it('unknown type', async () => {
    const res = await rawExchange('{"v":1,"type":"exec","argv":["sh"]}\n');
    expect(res.closed).toBe(true);
    expect(JSON.parse(res.text.trim())).toMatchObject({ type: 'error', reason: 'protocol' });
  });

  it('unknown field', async () => {
    const res = await rawExchange('{"v":1,"type":"hello","admin":true}\n');
    expect(res.closed).toBe(true);
    expect(JSON.parse(res.text.trim())).toMatchObject({
      type: 'error',
      code: 'validation_failed',
      reason: 'protocol',
    });
  });

  it('oversized frame', async () => {
    const res = await rawExchange(Buffer.alloc(MAX_FRAME_BYTES + 1, 0x61));
    expect(res.closed).toBe(true);
    expect(res.text).toContain('size limit');
  });

  it('one request per connection: a second request is never served', async () => {
    const res = await rawExchange('{"v":1,"type":"lease_list"}\n{"v":1,"type":"hello"}\n');
    expect(res.closed).toBe(true);
    const frames = res.text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string });
    expect(frames).toHaveLength(1);
    expect(frames.map((f) => f.type)).not.toContain('hello_ok');
  });

  it('session frame before any request', async () => {
    const res = await rawExchange('{"v":1,"type":"stdin","b64":"aGk="}\n');
    expect(res.closed).toBe(true);
  });

  it('invalid lease paths', async () => {
    mkdirSync(join(r.ws, 'p1', 'x'), { recursive: true });
    expect(
      await orcReason(
        client.acquire({
          key: `attempt-${ATTEMPT_ID}`,
          attemptId: ATTEMPT_ID,
          workerId: 'w',
          paths: [r.base],
        }),
      ),
    ).toEqual(['path_escape', 'path_rejected']);
  });
});
