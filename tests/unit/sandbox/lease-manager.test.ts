import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLeaseManager,
  createMemoryLeaseStateStore,
  type LeaseManagerOptions,
} from '@orc/sandbox';
import { OrcError } from '@orc/shared';
import {
  ATTEMPT_ID,
  ATTEMPT_ID_2,
  OP_ID,
  fakeLaunch,
  fakeProcessTable,
  manualClock,
  recordingFs,
  silentLogger,
} from '../../helpers/sandbox/fakes';
import { makeRoots, type SandboxRoots } from '../../helpers/sandbox/roots';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function setup(over: Partial<LeaseManagerOptions> = {}, fsOpts = {}) {
  const r = makeRoots();
  cleanups.push(() => r.cleanup());
  const fs = recordingFs(fsOpts);
  const table = fakeProcessTable();
  const store = createMemoryLeaseStateStore();
  const launch = fakeLaunch();
  const clock = manualClock();
  let n = 0;
  const m = createLeaseManager({
    roots: r.roots,
    workerUid: 1000,
    workerGid: 1000,
    uidBase: 20000,
    maxLeases: 2,
    leaseTtlMs: 40_000,
    killGraceMs: 100,
    limits: { nproc: 512, nofile: 4096, fsizeBytes: 2 ** 31 },
    identity: 'switch',
    prlimitPath: '/usr/bin/prlimit',
    logger: silentLogger(),
    stateStore: store,
    processTable: table,
    fs,
    launch,
    now: clock.now,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    sleep: (ms) => {
      clock.advance(ms);
      return Promise.resolve();
    },
    killForceWaitMs: 500,
    ...over,
  });
  return { r, fs, table, store, launch, clock, m };
}

const attemptReq = (r: SandboxRoots, task = 't1', id = ATTEMPT_ID) => {
  const a = r.attemptPaths(task);
  return {
    a,
    req: {
      key: `attempt-${id}`,
      attemptId: id,
      workerId: 'worker-1',
      paths: [a.worktree, a.meta, a.home, a.cache],
    },
  };
};

async function reason(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OrcError);
    return (e as OrcError).details?.reason as string | undefined;
  }
  return 'resolved';
}

describe('lease lifecycle (identity switch, injected fakes)', () => {
  it('acquire hands every path to a pool uid and persists state', async () => {
    const { r, fs, store, m } = setup();
    const { a, req } = attemptReq(r);
    const info = await m.acquire(req);
    expect(info).toMatchObject({
      key: req.key,
      attemptId: ATTEMPT_ID,
      workerId: 'worker-1',
      uid: 20000,
      pids: [],
      expiresAt: '2026-11-02T10:00:40.000Z',
    });
    const owned = fs.calls.filter((c) => c.op === 'lchown');
    expect(owned.every((c) => c.uid === 20000 && c.gid === 20000)).toBe(true);
    for (const p of [a.worktree, join(a.worktree, 'src', 'index.ts'), a.meta, a.home, a.cache]) {
      expect(owned.map((c) => c.path)).toContain(p);
    }
    expect(store.entries.get(info.id)).toMatchObject({ uid: 20000, paths: req.paths });
    expect(m.list().map((l) => l.id)).toEqual([info.id]);
  });

  it('overlap, duplicate key and pool exhaustion are busy', async () => {
    const { r, m } = setup();
    const { a, req } = attemptReq(r);
    await m.acquire(req);
    expect(await reason(m.acquire({ ...req, key: `attempt-${ATTEMPT_ID_2}` }))).toBe('busy');
    expect(
      await reason(
        m.acquire({
          key: `op-${OP_ID}`,
          attemptId: null,
          workerId: 'w',
          paths: [join(a.worktree, 'src')],
        }),
      ),
    ).toBe('busy');
    const second = attemptReq(r, 't2', ATTEMPT_ID_2);
    expect(await reason(m.acquire({ ...second.req, key: req.key }))).toBe('busy');
    const ok = await m.acquire(second.req);
    expect(ok.uid).toBe(20001);
    const third = r.attemptPaths('t3');
    const err = await m
      .acquire({ key: `op-${OP_ID}`, attemptId: null, workerId: 'w', paths: [third.worktree] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrcError);
    expect((err as OrcError).code).toBe('process_spawn_failed');
    expect((err as OrcError).details?.reason).toBe('busy');
  });

  it('rejects invalid keys and paths before allocating', async () => {
    const { r, m } = setup();
    const { req } = attemptReq(r);
    expect(await reason(m.acquire({ ...req, key: 'attempt-x' }))).toBe('path_rejected');
    expect(await reason(m.acquire({ ...req, paths: [r.ws] }))).toBe('path_rejected');
    expect(await reason(m.acquire({ ...req, paths: [join(r.ws, '.repos', 'p1.git')] }))).toBe(
      'path_rejected',
    );
    expect(m.list()).toEqual([]);
  });

  it('probe leases: op-probe-/op-mcp-probe-<workerId> over the probe homes, never <WORKSPACES_ROOT>/probe', async () => {
    const r = makeRoots();
    cleanups.push(() => r.cleanup());
    for (const root of [r.ws, r.claudeHome, r.cbm]) mkdirSync(join(root, 'probe'), { recursive: true });
    const { m } = setup({ roots: r.roots, probeRoots: [r.claudeHome, r.cbm] });
    const probe = { attemptId: null, workerId: 'worker-1' };
    const cli = await m.acquire({ ...probe, key: 'op-probe-worker-1', paths: [join(r.claudeHome, 'probe')] });
    const mcp = await m.acquire({ ...probe, key: 'op-mcp-probe-worker-1', paths: [join(r.cbm, 'probe')] });
    expect([cli.key, mcp.key]).toEqual(['op-probe-worker-1', 'op-mcp-probe-worker-1']);
    expect(
      await reason(m.acquire({ ...probe, key: 'op-probe-worker-2', paths: [join(r.ws, 'probe')] })),
    ).toBe('path_rejected');
    expect(await reason(m.acquire({ ...probe, key: 'op-probe-bad/id', paths: [join(r.cbm, 'probe')] }))).toBe(
      'path_rejected',
    );
    await m.release(cli.id);
    await m.release(mcp.id);
    expect(m.list()).toEqual([]);
  });

  it('renew extends the TTL; an expired lease is fenced and released by the reaper', async () => {
    const { r, clock, store, fs, table, m } = setup();
    const { req } = attemptReq(r);
    const info = await m.acquire(req);
    clock.advance(30_000);
    expect((await m.renew(info.id)).expiresAt).toBe('2026-11-02T10:01:10.000Z');
    table.add(555, 20000);
    clock.advance(40_001);
    expect(await reason(m.renew(info.id))).toBe('lease_expired');
    await m.reapExpired();
    expect(m.list()).toEqual([]);
    expect(store.entries.size).toBe(0);
    expect(table.procs.size).toBe(0);
    const reclaimed = fs.calls.filter((c) => c.op === 'lchown' && c.uid === 1000);
    expect(reclaimed.length).toBeGreaterThan(0);
    expect(reclaimed.every((c) => c.gid === 1000)).toBe(true);
    expect(await reason(m.spawn(info.id, spawnInput(req.paths[0] as string)))).toBe(
      'lease_expired',
    );
  });

  it('release kills every process of the lease uid, reclaims and is idempotent', async () => {
    const { r, store, fs, table, m } = setup();
    const { req } = attemptReq(r);
    const info = await m.acquire(req);
    table.add(10, 20000); // e.g. a setsid escape not tracked as a session
    table.add(11, 20000, ['SIGKILL']);
    table.add(12, 30000);
    const before = fs.calls.length;
    const res = await m.release(info.id);
    expect(res.reclaimed).toBe(true);
    expect(res.kill).toMatchObject({ graceful: false, forced: true, survivors: [] });
    expect(table.procs.has(12)).toBe(true);
    expect(store.entries.size).toBe(0);
    expect(
      fs.calls
        .slice(before)
        .filter((c) => c.op === 'lchown')
        .every((c) => c.uid === 1000),
    ).toBe(true);
    const callsAfter = fs.calls.length;
    expect(await m.release(info.id)).toEqual({
      kill: { graceful: true, forced: false, survivors: [], durationMs: 0 },
      reclaimed: true,
    });
    expect(fs.calls.length).toBe(callsAfter);
    // uid and paths are free again
    expect((await m.acquire(req)).uid).toBe(20001);
  });

  it('survivors keep the lease (paths blocked) until a retry succeeds', async () => {
    const { r, table, store, m } = setup();
    const { req } = attemptReq(r);
    const info = await m.acquire(req);
    table.add(77, 20000, []);
    const res = await m.release(info.id);
    expect(res).toMatchObject({ reclaimed: false, kill: { survivors: [77] } });
    expect(m.list().map((l) => l.id)).toEqual([info.id]);
    expect(store.entries.has(info.id)).toBe(true);
    expect(await reason(m.acquire({ ...req, key: `attempt-${ATTEMPT_ID_2}` }))).toBe('busy');
    table.procs.clear();
    await m.reapExpired();
    expect(m.list()).toEqual([]);
    expect(store.entries.size).toBe(0);
  });

  it('a failed handoff rolls back: no lease, no state, uid free', async () => {
    const { r, store, fs, m } = setup(
      {},
      { failLchownOn: (p: string, uid: number) => uid !== 1000 && p.endsWith('ws-t1') },
    );
    const { req } = attemptReq(r);
    await expect(m.acquire(req)).rejects.toThrow();
    expect(m.list()).toEqual([]);
    expect(store.entries.size).toBe(0);
    // the paths handed off before the failure were reclaimed to the worker uid
    const wt = req.paths[0] as string;
    const wtCalls = fs.calls.filter((c) => c.op === 'lchown' && c.path === wt);
    expect(wtCalls.map((c) => c.uid)).toEqual([20000, 1000]);
    // both pool uids (maxLeases 2) are available again
    expect((await m.acquire(attemptReq(r, 't2', ATTEMPT_ID_2).req)).uid).toBe(20001);
    const t3 = r.attemptPaths('t3');
    expect(
      (
        await m.acquire({
          key: `op-${OP_ID}`,
          attemptId: null,
          workerId: 'w',
          paths: [t3.worktree],
        })
      ).uid,
    ).toBe(20000);
  });
});

const spawnInput = (cwd: string) => ({
  kind: 'test' as const,
  argv: ['npm', 'test'],
  cwd,
  env: { PATH: '/usr/bin', HOME: '/home/x', CI: '1' },
});

describe('spawn validation', () => {
  it('wraps argv in prlimit and runs under the lease uid', async () => {
    const { r, launch, m } = setup();
    const { a, req } = attemptReq(r);
    const info = await m.acquire(req);
    const { proc, uid } = await m.spawn(info.id, {
      ...spawnInput(join(a.worktree, 'src')),
      limits: { nproc: 64, nofile: 1_000_000 },
    });
    expect(uid).toBe(20000);
    expect(launch.calls[0]).toMatchObject({
      cmd: '/usr/bin/prlimit',
      args: ['--nproc=64', '--nofile=4096', `--fsize=${2 ** 31}`, '--core=0', '--', 'npm', 'test'],
      cwd: join(a.worktree, 'src'),
      uid: 20000,
      gid: 20000,
    });
    expect(m.list()[0]?.pids).toEqual([proc.pid]);
    launch.procs[0]?.exit(0);
    await proc.exited;
    await new Promise((res) => setImmediate(res));
    expect(m.list()[0]?.pids).toEqual([]);
  });

  it('rejects env, argv and cwd violations', async () => {
    const { r, launch, m } = setup();
    const { a, req } = attemptReq(r);
    const info = await m.acquire(req);
    const base = spawnInput(a.worktree);
    expect(
      await reason(m.spawn(info.id, { ...base, env: { ...base.env, ANTHROPIC_API_KEY: 'k' } })),
    ).toBe('env_rejected');
    expect(
      await reason(m.spawn(info.id, { ...base, kind: 'mcp', env: { HTTPS_PROXY: 'http://p' } })),
    ).toBe('env_rejected');
    expect(await reason(m.spawn(info.id, { ...base, env: { DB_PASSWORD: 'x' } }))).toBe(
      'env_rejected',
    );
    expect(await reason(m.spawn(info.id, { ...base, argv: ['node', 'a\0'] }))).toBe(
      'argv_rejected',
    );
    expect(await reason(m.spawn(info.id, { ...base, cwd: r.ws }))).toBe('cwd_rejected');
    expect(await reason(m.spawn(info.id, { ...base, cwd: join(r.ws, '.repos') }))).toBe(
      'cwd_rejected',
    );
    expect(
      await reason(
        m.spawn('00000000-0000-4000-8000-00000000ffff', { ...base, kind: 'claude', env: {} }),
      ),
    ).toBe('lease_expired');
    // MCP runtime dir: kind mcp only and inside the lease (the cache dir of the attempt lease).
    expect(
      await reason(m.spawn(info.id, { ...base, kind: 'mcp', env: { CBM_RUNTIME_DIR: r.base } })),
    ).toBe('env_rejected');
    expect(
      await reason(m.spawn(info.id, { ...base, kind: 'test', env: { CBM_RUNTIME_DIR: a.cache } })),
    ).toBe('env_rejected');
    expect(launch.calls).toHaveLength(0);
    await m.spawn(info.id, { ...base, kind: 'mcp', env: { CBM_CACHE_DIR: a.cache, CBM_RUNTIME_DIR: a.cache } });
    expect(launch.calls).toHaveLength(1);
    await m.spawn(info.id, {
      ...base,
      kind: 'claude',
      env: { ...base.env, ANTHROPIC_API_KEY: 'k', HTTPS_PROXY: 'http://u:p@egress:3128' },
    });
    expect(launch.calls).toHaveLength(2);
  });

  it('identity none: no ownership changes, uid null, release stops sessions', async () => {
    const { r, fs, launch, m } = setup({
      identity: 'none',
      processTable: undefined,
      prlimitPath: null,
    });
    const { a, req } = attemptReq(r);
    const info = await m.acquire(req);
    expect(info.uid).toBeNull();
    expect(fs.calls).toEqual([]);
    const { proc, uid } = await m.spawn(info.id, spawnInput(a.worktree));
    expect(uid).toBeNull();
    expect(launch.calls[0]).toMatchObject({ cmd: 'npm', args: ['test'], uid: null, gid: null });
    const res = await m.release(info.id);
    expect(res.reclaimed).toBe(true);
    expect(launch.procs[0]?.stops).toEqual([{ graceMs: 100 }]);
    await proc.exited;
  });
});

describe('restart recovery and shutdown', () => {
  it('releases persisted leases, drops invalid state and kills stray sandbox processes', async () => {
    const { r, store, table, fs, m } = setup({ maxLeases: 4 });
    const a = r.attemptPaths('t9');
    await store.write({
      v: 1,
      id: '11111111-1111-4111-8111-111111111111',
      key: `attempt-${ATTEMPT_ID}`,
      attemptId: ATTEMPT_ID,
      workerId: 'w',
      uid: 20002,
      gid: 20002,
      paths: [a.worktree, '/etc'],
      acquiredAt: '2026-11-02T09:00:00.000Z',
    });
    await store.write({
      v: 1,
      id: '22222222-2222-4222-8222-222222222222',
      key: `attempt-${ATTEMPT_ID_2}`,
      attemptId: ATTEMPT_ID_2,
      workerId: 'w',
      uid: 1000,
      gid: 1000,
      paths: [a.meta],
      acquiredAt: '2026-11-02T09:00:00.000Z',
    });
    table.add(900, 20002);
    table.add(901, 20003);
    table.add(902, 1000);
    const report = await m.recoverStale();
    expect(report).toEqual({
      released: 1,
      failed: 0,
      invalidStateFiles: 1,
      strayProcessesKilled: 1,
    });
    expect(store.entries.size).toBe(0);
    expect([...table.procs.keys()]).toEqual([902]);
    const paths = fs.calls.filter((c) => c.op === 'lchown').map((c) => c.path);
    expect(paths).toContain(a.worktree);
    expect(paths.some((p) => p === '/etc' || p.startsWith(a.meta))).toBe(false);
    expect(m.list()).toEqual([]);
  });

  it('close releases every lease and refuses new work', async () => {
    const { r, store, m } = setup();
    await m.acquire(attemptReq(r).req);
    await m.close();
    expect(m.list()).toEqual([]);
    expect(store.entries.size).toBe(0);
    expect(await reason(m.acquire(attemptReq(r, 't2', ATTEMPT_ID_2).req))).toBe('closed');
  });
});
