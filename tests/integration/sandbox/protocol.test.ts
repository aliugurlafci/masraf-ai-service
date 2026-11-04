// Runner server <-> client over a real Unix socket (contract §10.11 item 9). POSIX only: win32 has
// no Unix-domain socket file semantics, uid switching, /proc or prlimit. Uid switching runs only as
// root (e.g. inside the Linux container verification).
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, chmodSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDefaultLaunch,
  createFileLeaseStateStore,
  createLeaseManager,
  createProcfsTable,
  createRunnerClient,
  createRunnerServer,
  detectRunnerCaps,
  isRunnerDisconnected,
  MAX_FRAME_BYTES,
  type IdentityMode,
  type LeaseManager,
  type RunnerClient,
  type RunnerServer,
} from '@orc/sandbox';
import { OrcError } from '@orc/shared';
import { isProcessAlive } from '@orc/shared/node';
import {
  ATTEMPT_ID,
  ATTEMPT_ID_2,
  OP_ID,
  silentLogger,
  waitFor,
} from '../../helpers/sandbox/fakes';
import { makeRoots, type SandboxRoots } from '../../helpers/sandbox/roots';

const IS_WIN = process.platform === 'win32';
const IS_ROOT = !IS_WIN && typeof process.getuid === 'function' && process.getuid() === 0;
const NODE = process.execPath;
const ENV = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' };
const UID_BASE = 20000;
const WORKER_UID = 1000;

interface Harness {
  r: SandboxRoots;
  socketPath: string;
  stateDir: string;
  manager: LeaseManager;
  server: RunnerServer;
  client: RunnerClient;
  prlimitPath: string | null;
  close(): Promise<void>;
}

async function startHarness(
  identity: IdentityMode,
  over: { leaseTtlMs?: number } = {},
): Promise<Harness> {
  const r = makeRoots();
  const socketPath = join(r.base, 'sock', 'runner.sock');
  const stateDir = join(r.base, 'state');
  const detected = await detectRunnerCaps();
  const leaseTtlMs = over.leaseTtlMs ?? 40_000;
  const manager = createLeaseManager({
    roots: r.roots,
    workerUid: WORKER_UID,
    workerGid: WORKER_UID,
    uidBase: UID_BASE,
    maxLeases: 4,
    leaseTtlMs,
    killGraceMs: 300,
    limits: { nproc: 512, nofile: 4096, fsizeBytes: 2 ** 31 },
    identity,
    prlimitPath: detected.prlimitPath,
    logger: silentLogger(),
    stateStore: createFileLeaseStateStore(stateDir),
    launch: createDefaultLaunch(),
    ...(identity === 'switch' ? { processTable: createProcfsTable() } : {}),
    ...(over.leaseTtlMs === undefined ? {} : { reapIntervalMs: 50 }),
  });
  await manager.recoverStale();
  const server = createRunnerServer({
    socketPath,
    manager,
    hello: { uidBase: UID_BASE, maxLeases: 4, leaseTtlMs, caps: detected.caps },
    logger: silentLogger(),
    maxConnections: 32,
    socketGroup: identity === 'switch' ? WORKER_UID : null,
    killGraceMs: 300,
    exitDrainMs: 500,
  });
  await server.listen();
  manager.startReaper();
  const client = createRunnerClient({ socketPath, requestTimeoutMs: 10_000 });
  return {
    r,
    socketPath,
    stateDir,
    manager,
    server,
    client,
    prlimitPath: detected.prlimitPath,
    async close() {
      await client.close();
      server.stopAccepting();
      await manager.close();
      await server.close(1000);
      r.cleanup();
    },
  };
}

function rawExchange(
  socketPath: string,
  payload: string | Buffer,
): Promise<{ text: string; closed: boolean }> {
  return new Promise((resolve) => {
    const c = createConnection(socketPath);
    const parts: Buffer[] = [];
    const timer = setTimeout(() => {
      c.destroy();
      resolve({ text: Buffer.concat(parts).toString('utf8'), closed: false });
    }, 5000);
    c.on('data', (d: Buffer) => parts.push(d));
    c.on('error', () => undefined);
    c.on('close', () => {
      clearTimeout(timer);
      resolve({ text: Buffer.concat(parts).toString('utf8'), closed: true });
    });
    c.write(payload);
  });
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

const collect = (s: NodeJS.ReadableStream): Promise<Buffer> =>
  new Promise((resolve) => {
    const parts: Buffer[] = [];
    s.on('data', (d: Buffer) => parts.push(d));
    s.on('end', () => resolve(Buffer.concat(parts)));
  });

const attemptLease = (h: Harness, task: string, id = ATTEMPT_ID) => {
  const a = h.r.attemptPaths(task);
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

describe.skipIf(IS_WIN)(
  'runner over a Unix socket (POSIX only; skipped on win32: no Unix socket files, uid switching, /proc or prlimit)',
  () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startHarness('none');
    });
    afterAll(async () => {
      await h.close();
    });

    it('socket file and directory modes', () => {
      const st = lstatSync(h.socketPath);
      expect(st.isSocket()).toBe(true);
      expect(st.mode & 0o777).toBe(0o660);
      expect(lstatSync(dirname(h.socketPath)).mode & 0o007).toBe(0);
    });

    it('hello reports protocol 1 and the configured lease settings', async () => {
      const hello = await h.client.hello();
      expect(hello).toMatchObject({
        protocol: 1,
        uidBase: UID_BASE,
        maxLeases: 4,
        leaseTtlMs: 40_000,
      });
      expect(hello.caps.procfs).toBe(process.platform === 'linux');
    });

    it('acquire persists a state file; spawn streams stdin/stdout/stderr/exit; release removes it', async () => {
      const { a, req } = attemptLease(h, 't-rt');
      const lease = await h.client.acquire(req);
      const stateFile = join(h.stateDir, 'leases', `${lease.id}.json`);
      expect(existsSync(stateFile)).toBe(true);
      expect(lstatSync(stateFile).mode & 0o077).toBe(0);
      expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toMatchObject({
        v: 1,
        id: lease.id,
        key: req.key,
      });

      const proc = await h.client.spawn(lease, {
        kind: 'test',
        cmd: NODE,
        args: [
          '-e',
          'process.stdin.on("data", d => process.stdout.write("in:" + d)); process.stdin.on("end", () => { process.stderr.write("err"); process.exitCode = 4; })',
        ],
        cwd: a.worktree,
        env: ENV,
      });
      expect(proc.pgid).toBe(proc.pid);
      const out = collect(proc.stdout);
      const err = collect(proc.stderr);
      proc.stdin.write('ping');
      proc.stdin.end();
      expect(await proc.exited).toEqual({ exitCode: 4, signal: null });
      expect((await out).toString()).toBe('in:ping');
      expect((await err).toString()).toBe('err');
      expect(isRunnerDisconnected(proc)).toBe(false);

      const listed = await h.client.listLeases();
      expect(listed.map((l) => l.id)).toContain(lease.id);
      const m = await lease.measure(a.worktree, 1000);
      expect(m.truncated).toBe(false);
      expect(m.entries).toBeGreaterThan(2);

      const rel = await lease.release();
      expect(rel.reclaimed).toBe(true);
      expect(existsSync(stateFile)).toBe(false);
      expect((await h.client.listLeases()).map((l) => l.id)).not.toContain(lease.id);
    });

    it('stop kills the whole process group', async () => {
      const { a, req } = attemptLease(h, 't-stop');
      const lease = await h.client.acquire(req);
      const proc = await h.client.spawn(lease, {
        kind: 'test',
        cmd: NODE,
        args: [
          '-e',
          'const c = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); process.stdout.write(String(c.pid) + "\\n"); setInterval(() => {}, 1000);',
        ],
        cwd: a.worktree,
        env: ENV,
      });
      const line = await new Promise<string>((resolve) => {
        proc.stdout.once('data', (d: Buffer) => resolve(d.toString().trim()));
      });
      const grandchild = Number(line);
      expect(isProcessAlive(grandchild)).toBe(true);
      const k = await proc.stop({ graceMs: 500 });
      expect(k.survivors).toEqual([]);
      const exit = await proc.exited;
      expect(exit.exitCode === 0 && exit.signal === null).toBe(false);
      expect(await waitFor(() => !isProcessAlive(grandchild), 5000)).toBe(true);
      expect((await lease.release()).reclaimed).toBe(true);
    });

    it('wraps every child in prlimit with the effective limits', async (ctx) => {
      if (h.prlimitPath === null || process.platform !== 'linux') {
        ctx.skip();
        return;
      }
      const { a, req } = attemptLease(h, 't-limits');
      const lease = await h.client.acquire(req);
      const proc = await h.client.spawn(lease, {
        kind: 'test',
        cmd: NODE,
        args: [
          '-e',
          'process.stdout.write(require("fs").readFileSync("/proc/self/limits", "utf8"))',
        ],
        cwd: a.worktree,
        env: ENV,
        limits: { nofile: 1024 },
      });
      const out = (await collect(proc.stdout)).toString();
      expect((await proc.exited).exitCode).toBe(0);
      expect(out).toMatch(/Max open files\s+1024\s+1024/);
      expect(out).toMatch(/Max core file size\s+0\s+0/);
      expect(out).toMatch(/Max processes\s+512\s+512/);
      expect(out).toMatch(/Max file size\s+2147483648\s+2147483648/);
      await lease.release();
    });

    it('rejects env, argv, cwd and path violations with typed errors', async () => {
      const { a, req } = attemptLease(h, 't-val');
      const lease = await h.client.acquire(req);
      const spec = { kind: 'test' as const, cmd: NODE, args: ['-v'], cwd: a.worktree, env: ENV };
      expect(
        await orcReason(
          h.client.spawn(lease, { ...spec, env: { ...ENV, ANTHROPIC_API_KEY: 'k' } }),
        ),
      ).toEqual(['unsafe_argument', 'env_rejected']);
      expect(
        await orcReason(
          h.client.spawn(lease, { ...spec, env: { ...ENV, HTTPS_PROXY: 'http://p:1' } }),
        ),
      ).toEqual(['unsafe_argument', 'env_rejected']);
      expect(
        await orcReason(h.client.spawn(lease, { ...spec, env: { ...ENV, DB_PASSWORD: 'x' } })),
      ).toEqual(['unsafe_argument', 'env_rejected']);
      expect(
        (await orcReason(h.client.spawn(lease, { ...spec, args: ['-e', 'a\u0000b'] })))[1],
      ).toBe('argv_rejected');
      expect(await orcReason(h.client.spawn(lease, { ...spec, cwd: h.r.ws }))).toEqual([
        'path_escape',
        'cwd_rejected',
      ]);
      // claude may carry the API key and proxy settings.
      const claude = await h.client.spawn(lease, {
        ...spec,
        kind: 'claude',
        env: { ...ENV, ANTHROPIC_API_KEY: 'k', HTTPS_PROXY: 'http://p:1', NO_PROXY: 'localhost' },
      });
      expect((await claude.exited).exitCode).toBe(0);

      // Symlink escaping the roots.
      const link = join(h.r.ws, 'p1', 'escape');
      symlinkSync('/etc', link);
      expect(
        await orcReason(
          h.client.acquire({ key: `op-${OP_ID}`, attemptId: null, workerId: 'w', paths: [link] }),
        ),
      ).toEqual(['path_escape', 'path_rejected']);
      expect(
        await orcReason(
          h.client.acquire({ key: `op-${OP_ID}`, attemptId: null, workerId: 'w', paths: ['/etc'] }),
        ),
      ).toEqual(['path_escape', 'path_rejected']);
      // Overlap with the live lease (nested path) and the same key.
      expect(
        await orcReason(
          h.client.acquire({
            key: `attempt-${ATTEMPT_ID_2}`,
            attemptId: ATTEMPT_ID_2,
            workerId: 'w',
            paths: [join(a.worktree, 'src')],
          }),
        ),
      ).toEqual(['process_spawn_failed', 'busy']);
      const other = h.r.attemptPaths('t-val-2');
      expect(await orcReason(h.client.acquire({ ...req, paths: [other.worktree] }))).toEqual([
        'process_spawn_failed',
        'busy',
      ]);
      await lease.release();
    });

    it('a dropped spawn connection stops the child', async () => {
      const { a, req } = attemptLease(h, 't-drop');
      const lease = await h.client.acquire(req);
      const conn = createConnection(h.socketPath);
      const firstLine = new Promise<string>((resolve, reject) => {
        let buf = '';
        conn.on('data', (d: Buffer) => {
          buf += d.toString('utf8');
          const nl = buf.indexOf('\n');
          if (nl >= 0) resolve(buf.slice(0, nl));
        });
        conn.on('error', reject);
      });
      conn.write(
        `${JSON.stringify({
          v: 1,
          type: 'spawn',
          leaseId: lease.id,
          kind: 'test',
          argv: [NODE, '-e', 'setInterval(() => {}, 1000)'],
          cwd: a.worktree,
          env: ENV,
          limits: {},
        })}\n`,
      );
      const spawned = JSON.parse(await firstLine) as { type: string; pid: number };
      expect(spawned.type).toBe('spawned');
      // prlimit execs in place, so the pid is the node process.
      expect(isProcessAlive(spawned.pid)).toBe(true);
      conn.destroy();
      expect(await waitFor(() => !isProcessAlive(spawned.pid), 10_000)).toBe(true);
      expect((await lease.release()).reclaimed).toBe(true);
    });

    it('protocol violations close the connection', async () => {
      const unknownType = await rawExchange(h.socketPath, '{"v":1,"type":"exec","argv":["sh"]}\n');
      expect(unknownType.closed).toBe(true);
      expect(JSON.parse(unknownType.text.trim())).toMatchObject({
        type: 'error',
        reason: 'protocol',
      });

      const unknownField = await rawExchange(h.socketPath, '{"v":1,"type":"hello","admin":true}\n');
      expect(unknownField.closed).toBe(true);
      expect(JSON.parse(unknownField.text.trim())).toMatchObject({
        type: 'error',
        reason: 'protocol',
      });

      const badVersion = await rawExchange(h.socketPath, '{"v":2,"type":"hello"}\n');
      expect(badVersion.closed).toBe(true);
      expect(badVersion.text).toContain('"type":"error"');

      const oversized = await rawExchange(h.socketPath, Buffer.alloc(MAX_FRAME_BYTES + 1, 0x61));
      expect(oversized.closed).toBe(true);
      expect(oversized.text).toContain('size limit');

      const twoRequests = await rawExchange(
        h.socketPath,
        '{"v":1,"type":"lease_list"}\n{"v":1,"type":"hello"}\n',
      );
      expect(twoRequests.closed).toBe(true);
      expect(twoRequests.text.trim().split('\n')).toHaveLength(1);
    });
  },
);

describe.skipIf(IS_WIN)(
  'runner lease fencing and restart recovery (POSIX only; skipped on win32)',
  () => {
    it('an expired lease is released by the runner and its children are stopped', async () => {
      const h = await startHarness('none', { leaseTtlMs: 400 });
      try {
        const { a, req } = attemptLease(h, 't-ttl');
        const lease = await h.client.acquire(req);
        const proc = await h.client.spawn(lease, {
          kind: 'mcp',
          cmd: NODE,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          cwd: a.worktree,
          env: ENV,
        });
        expect(await waitFor(() => !isProcessAlive(proc.pid), 10_000)).toBe(true);
        expect(await waitFor(() => h.manager.list().length === 0, 5000)).toBe(true);
        expect(existsSync(join(h.stateDir, 'leases', `${lease.id}.json`))).toBe(false);
        expect(await orcReason(lease.renew())).toEqual(['process_spawn_failed', 'lease_expired']);
      } finally {
        await h.close();
      }
    });

    it('a restarted runner releases every persisted lease at startup', async () => {
      const r = makeRoots();
      const stateDir = join(r.base, 'state');
      try {
        const make = (): LeaseManager =>
          createLeaseManager({
            roots: r.roots,
            workerUid: WORKER_UID,
            workerGid: WORKER_UID,
            uidBase: UID_BASE,
            maxLeases: 4,
            leaseTtlMs: 40_000,
            killGraceMs: 200,
            limits: { nproc: 512, nofile: 4096, fsizeBytes: 2 ** 31 },
            identity: 'none',
            prlimitPath: null,
            logger: silentLogger(),
            stateStore: createFileLeaseStateStore(stateDir),
          });
        const first = make();
        const a = r.attemptPaths('t-restart');
        const info = await first.acquire({
          key: `attempt-${ATTEMPT_ID}`,
          attemptId: ATTEMPT_ID,
          workerId: 'w',
          paths: [a.worktree, a.meta],
        });
        // Simulated crash: the first instance never releases.
        expect(existsSync(join(stateDir, 'leases', `${info.id}.json`))).toBe(true);
        const second = make();
        const report = await second.recoverStale();
        expect(report).toMatchObject({ released: 1, failed: 0, invalidStateFiles: 0 });
        expect(existsSync(join(stateDir, 'leases', `${info.id}.json`))).toBe(false);
        const again = await second.acquire({
          key: `attempt-${ATTEMPT_ID}`,
          attemptId: ATTEMPT_ID,
          workerId: 'w',
          paths: [a.worktree],
        });
        expect((await second.release(again.id)).reclaimed).toBe(true);
        await second.close();
      } finally {
        r.cleanup();
      }
    });
  },
);

describe.skipIf(!IS_ROOT)(
  'runner uid switching (root only; skipped when not root or on win32)',
  () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startHarness('switch');
    });
    afterAll(async () => {
      await h.close();
    });

    /** Sandbox uids traverse the roots (0711 per §10.11 item 4); mkdtemp creates 0700. */
    const openTraversal = (task: string): void => {
      for (const d of [
        h.r.base,
        h.r.ws,
        join(h.r.ws, 'p1'),
        join(h.r.ws, 'p1', task),
        h.r.claudeHome,
        join(h.r.claudeHome, 'w'),
        h.r.cbm,
        join(h.r.cbm, 'w'),
      ]) {
        chmodSync(d, 0o711);
      }
    };

    it('socket is root:<worker gid> and unreachable for sandbox uids', () => {
      const st = lstatSync(h.socketPath);
      expect(st.mode & 0o777).toBe(0o660);
      expect(st.gid).toBe(WORKER_UID);
      const dir = lstatSync(dirname(h.socketPath));
      expect(dir.mode & 0o777).toBe(0o750);
      expect(dir.gid).toBe(WORKER_UID);
    });

    it('hands off, runs children as the lease uid, kills escaped processes and reclaims', async () => {
      const { a, req } = attemptLease(h, 't-uid');
      openTraversal('t-uid');
      const outside = join(h.r.base, 'outside.txt');
      mkdirSync(join(a.worktree, 'deep'), { recursive: true });
      symlinkSync(outside, join(a.worktree, 'deep', 'link-out'));

      const lease = await h.client.acquire(req);
      expect(lease.uid).toBeGreaterThanOrEqual(UID_BASE);
      expect(lease.uid).toBeLessThan(UID_BASE + 4);
      const uid = lease.uid as number;
      for (const p of [a.worktree, join(a.worktree, 'src', 'index.ts'), a.meta, a.home, a.cache]) {
        const st = lstatSync(p);
        expect([st.uid, st.gid]).toEqual([uid, uid]);
        expect(st.mode & 0o077).toBe(0);
      }
      // The symlink itself is re-owned, its target is never followed.
      expect(lstatSync(join(a.worktree, 'deep', 'link-out')).uid).toBe(uid);

      const proc = await h.client.spawn(lease, {
        kind: 'test',
        cmd: NODE,
        args: [
          '-e',
          [
            'const net = require("net");',
            'const out = { uid: process.getuid(), gid: process.getgid(), groups: process.getgroups() };',
            `const s = net.createConnection(${JSON.stringify(h.socketPath)});`,
            's.on("connect", () => { out.socket = "connected"; s.destroy(); done(); });',
            's.on("error", (e) => { out.socket = e.code; done(); });',
            'function done() {',
            '  const c = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });',
            '  c.unref(); out.escaped = c.pid; process.stdout.write(JSON.stringify(out));',
            '}',
          ].join('\n'),
        ],
        cwd: a.worktree,
        env: ENV,
      });
      const out = JSON.parse((await collect(proc.stdout)).toString()) as {
        uid: number;
        gid: number;
        groups: number[];
        socket: string;
        escaped: number;
      };
      expect((await proc.exited).exitCode).toBe(0);
      expect(out.uid).toBe(uid);
      expect(out.gid).toBe(uid);
      expect(out.groups.every((g) => g === uid)).toBe(true);
      expect(out.socket).toBe('EACCES');
      // The detached (new session) grandchild escaped the process group but not the uid.
      expect(isProcessAlive(out.escaped)).toBe(true);
      expect(h.manager.list().find((l) => l.id === lease.id)?.uid).toBe(uid);

      const rel = await lease.release();
      expect(rel.reclaimed).toBe(true);
      expect(rel.kill.survivors).toEqual([]);
      expect(await waitFor(() => !isProcessAlive(out.escaped), 5000)).toBe(true);
      for (const p of [a.worktree, join(a.worktree, 'src', 'index.ts'), a.meta]) {
        const st = lstatSync(p);
        expect([st.uid, st.gid]).toEqual([WORKER_UID, WORKER_UID]);
        expect(st.mode & 0o700).toBeGreaterThanOrEqual(0o600);
        expect(st.mode & 0o077).toBe(0);
      }
      expect(lstatSync(join(a.worktree, 'deep', 'link-out')).uid).toBe(WORKER_UID);
    });

    it('allocates distinct uids to concurrent leases', async () => {
      const one = attemptLease(h, 't-u1', ATTEMPT_ID);
      const two = attemptLease(h, 't-u2', ATTEMPT_ID_2);
      const l1 = await h.client.acquire(one.req);
      const l2 = await h.client.acquire(two.req);
      expect(l1.uid).not.toBe(l2.uid);
      await l1.release();
      await l2.release();
    });
  },
);
