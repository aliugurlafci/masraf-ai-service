// Runner-loss adapter (contract §10.11 item 5): a real runner client against a real runner server (identity `none`)
// over in-memory socket pairs; the "runner" drops connections or restarts (all leases forgotten) during an attempt.
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLeaseManager,
  createMemoryLeaseStateStore,
  createRunnerClient,
  createRunnerServer,
  type LeaseManager,
  type RunnerServer,
  type SandboxLauncher,
} from '@orc/sandbox';
import { OrcError } from '@orc/shared';
import type { LaunchLease } from '@orc/shared/node';
import { createRunnerLossMonitor, isRunnerLossError } from '../../../apps/worker/src/launcher';
import type { RunnerLossMonitor } from '../../../apps/worker/src/launcher';
import {
  ATTEMPT_ID,
  leaderOnlyLaunch,
  OP_ID,
  silentLogger,
  socketPair,
  waitFor,
} from '../../helpers/sandbox/fakes';
import { makeRoots, type SandboxRoots } from '../../helpers/sandbox/roots';

const NODE = process.execPath;
const ENV = { PATH: process.env.PATH ?? '' };
const LONG = ['-e', 'setInterval(() => {}, 1000)'];
const CAPS = {
  ok: true,
  uidSwitch: false,
  chown: false,
  kill: false,
  prlimit: false,
  procfs: false,
};

interface Runner {
  manager: LeaseManager;
  server: RunnerServer;
}

let r: SandboxRoots;
let runner: Runner;
let down = false;
let serverSides: Duplex[] = [];
let lost: { attemptId: string; cause: string }[];
let monitor: RunnerLossMonitor;
let launcher: SandboxLauncher;

function startRunner(): Runner {
  const manager = createLeaseManager({
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
  const server = createRunnerServer({
    socketPath: join(r.base, 'unused.sock'),
    manager,
    hello: { uidBase: 20000, maxLeases: 8, leaseTtlMs: 40_000, caps: CAPS },
    logger: silentLogger(),
    maxConnections: 16,
    socketGroup: null,
    killGraceMs: 500,
    exitDrainMs: 500,
  });
  return { manager, server };
}

/** Runner crash + restart: every connection drops, the new instance knows no lease (state released at startup). */
async function restartRunner(): Promise<void> {
  for (const s of serverSides) s.destroy();
  serverSides = [];
  await runner.manager.close();
  runner = startRunner();
}

beforeEach(() => {
  r = makeRoots('orc-runner-loss-');
  runner = startRunner();
  down = false;
  lost = [];
  monitor = createRunnerLossMonitor({
    logger: silentLogger(),
    onAttemptLost: (attemptId, cause) => lost.push({ attemptId, cause }),
  });
  const client = createRunnerClient({
    socketPath: 'unused',
    requestTimeoutMs: 5000,
    connect: () => {
      if (down) throw Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' });
      const [s, c] = socketPair();
      serverSides.push(s);
      runner.server.handleConnection(s);
      return c;
    },
    onDisconnect: (i) => monitor.onDisconnect(i),
  });
  launcher = monitor.wrap(client);
});

afterEach(async () => {
  await launcher.close();
  await runner.manager.close();
  serverSides = [];
  r.cleanup();
});

async function attemptLease(): Promise<{ lease: LaunchLease; worktree: string }> {
  const a = r.attemptPaths('t1');
  const lease = await launcher.acquire({
    key: `attempt-${ATTEMPT_ID}`,
    attemptId: ATTEMPT_ID,
    workerId: 'w1',
    paths: [a.worktree, a.meta, a.home, a.cache],
  });
  return { lease, worktree: a.worktree };
}

describe('runner-loss adapter (§10.11 item 5)', () => {
  it('a spawn connection dropped by the runner reports the attempt as lost', async () => {
    const { lease, worktree } = await attemptLease();
    expect(monitor.attemptOf(lease.id)).toBe(ATTEMPT_ID);
    const proc = await launcher.spawn(lease, {
      kind: 'claude',
      cmd: NODE,
      args: LONG,
      cwd: worktree,
      env: ENV,
    });
    for (const s of serverSides) s.destroy();
    await expect(proc.exited).resolves.toEqual({ exitCode: null, signal: null });
    expect(lost).toEqual([{ attemptId: ATTEMPT_ID, cause: 'disconnect' }]);
  });

  it('a runner restart: the forgotten lease reports the attempt as lost on its next use', async () => {
    const { lease, worktree } = await attemptLease();
    const proc = await launcher.spawn(lease, {
      kind: 'test',
      cmd: NODE,
      args: LONG,
      cwd: worktree,
      env: ENV,
    });
    await restartRunner();
    await expect(proc.exited).resolves.toEqual({ exitCode: null, signal: null });
    expect(lost).toEqual([{ attemptId: ATTEMPT_ID, cause: 'disconnect' }]);
    lost = [];
    const measured = await lease.measure(worktree, 1000).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isRunnerLossError(measured)).toBe(true);
    const spawned = await launcher
      .spawn(lease, { kind: 'test', cmd: NODE, args: ['-e', '0'], cwd: worktree, env: ENV })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isRunnerLossError(spawned)).toBe(true);
    expect(lost).toEqual([
      { attemptId: ATTEMPT_ID, cause: 'runner_error' },
      { attemptId: ATTEMPT_ID, cause: 'runner_error' },
    ]);
    // The renewal failure is the pipeline's signal (heartbeat hook); the adapter only passes it through.
    await expect(lease.renew()).rejects.toBeInstanceOf(OrcError);
  });

  it('an unreachable runner during acquire reports the attempt; op and probe leases are never attempts', async () => {
    down = true;
    await expect(attemptLease()).rejects.toSatisfy(isRunnerLossError);
    expect(lost).toEqual([{ attemptId: ATTEMPT_ID, cause: 'runner_error' }]);
    lost = [];
    down = false;
    const a = r.attemptPaths('t2');
    const op = await launcher.acquire({
      key: `op-${OP_ID}`,
      attemptId: null,
      workerId: 'w1',
      paths: [a.cache],
    });
    const probe = await launcher.acquire({
      key: 'op-probe-w1',
      attemptId: null,
      workerId: 'w1',
      paths: [a.home],
    });
    const proc = await launcher.spawn(op, {
      kind: 'mcp',
      cmd: NODE,
      args: LONG,
      cwd: a.cache,
      env: ENV,
    });
    for (const s of serverSides) s.destroy();
    await proc.exited;
    expect(lost).toEqual([]);
    await probe.release().catch(() => undefined);
  });

  it('request errors that are not runner failures (busy, validation) and a released lease are not reported', async () => {
    const { lease, worktree } = await attemptLease();
    await expect(
      launcher.spawn(lease, {
        kind: 'test',
        cmd: NODE,
        args: ['-e', '0'],
        cwd: worktree,
        env: { DB_PASSWORD: 'x' },
      }),
    ).rejects.toBeInstanceOf(OrcError);
    await expect(attemptLease()).rejects.toBeInstanceOf(OrcError);
    expect(lost).toEqual([]);
    await lease.release();
    expect(monitor.attemptOf(lease.id)).toBeNull();
    await restartRunner();
    expect(lost).toEqual([]);
  });

  it('closing the launcher (worker shutdown) drops sessions without reporting a loss', async () => {
    const { lease, worktree } = await attemptLease();
    const proc = await launcher.spawn(lease, {
      kind: 'claude',
      cmd: NODE,
      args: LONG,
      cwd: worktree,
      env: ENV,
    });
    await launcher.close();
    await proc.exited;
    await waitFor(() => serverSides.every((s) => s.destroyed), 5000);
    expect(lost).toEqual([]);
  });
});
