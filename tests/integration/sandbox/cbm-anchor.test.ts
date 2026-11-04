// codebase-memory-mcp in the runner spawn context (ADR-0034; contract §10.11 items 3-6, §12.1). Linux as
// root only (uid switching); `npm run test:linux` runs it.
//
// codebase-memory-mcp v0.12.0 resolves CBM_CACHE_DIR / CBM_RUNTIME_DIR and opens every ancestor from `/`
// with O_RDONLY|O_DIRECTORY|O_NOFOLLOW, requiring each to be owned by root or the invoking uid; otherwise
// it exits 1 before the MCP handshake ("could not load saved runtime settings"). The tests build the
// traverse-only layout of §10.11 item 4 (CBM_CACHE_DIR and p/ 0711 owned by the worker uid) and spawn
// exactly like the runner: lease manager, uid switch, prlimit, kind `mcp`, the CBM_* environment.
// - The policy probe (a node child replaying that walk) runs on every Linux root host.
// - The real binary (CODEBASE_MEMORY_MCP_BIN, else `codebase-memory-mcp` on PATH) must answer
//   `initialize` once the runner's anchors are in place; skipped only when the binary is absent.
import { accessSync, chmodSync, chownSync, constants, lstatSync, mkdirSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  anchorCbmCacheDirs,
  createDefaultLaunch,
  createFileLeaseStateStore,
  createLeaseManager,
  createProcfsTable,
  detectRunnerCaps,
  type LeaseManager,
} from '@orc/sandbox';
import type { SupervisedProcess } from '@orc/shared/node';
import { OP_ID, silentLogger } from '../../helpers/sandbox/fakes';
import { makeRoots, type SandboxRoots } from '../../helpers/sandbox/roots';

const IS_LINUX_ROOT =
  process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0;
const NODE = process.execPath;
const PATH_ENV = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
const WORKER_UID = 1000;
const UID_BASE = 20000;
const PROJECT_ID = '5e1d2c3b-4a59-4687-9a0b-1c2d3e4f5a6b';
const SIBLING_ID = '6f2e3d4c-5b6a-4798-8b1c-2d3e4f5a6b7c';

function findCbmBinary(): string | null {
  const candidates = [
    process.env.CODEBASE_MEMORY_MCP_BIN ?? '',
    ...PATH_ENV.split(delimiter).map((d) => (d.length > 0 ? join(d, 'codebase-memory-mcp') : '')),
  ].filter((p) => p.length > 0 && isAbsolute(p));
  for (const p of candidates) {
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // next candidate
    }
  }
  return null;
}
const CBM_BIN = IS_LINUX_ROOT ? findCbmBinary() : null;

/** Replays codebase-memory-mcp's private-directory walk for argv[1] as the spawned (sandbox) uid. */
const WALKER = [
  "const fs = require('fs');",
  "const path = require('path');",
  'const uid = process.getuid();',
  'const [target, sibling, structure] = process.argv.slice(1);',
  "const code = (fn) => { try { fn(); return 'OK'; } catch (e) { return e.code || 'ERROR'; } };",
  'const extra = {',
  '  readSibling: code(() => fs.readdirSync(sibling)),',
  "  writeStructure: code(() => fs.writeFileSync(path.join(structure, '.probe'), 'x', { flag: 'wx' })),",
  '};',
  'const real = fs.realpathSync(target);',
  "let cur = '/';",
  "for (const comp of ['', ...real.split('/').filter(Boolean)]) {",
  "  cur = comp === '' ? '/' : path.join(cur, comp);",
  '  let fd;',
  '  try { fd = fs.openSync(cur, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); }',
  '  catch (e) { process.stdout.write(JSON.stringify({ ok: false, uid, path: cur, reason: e.code, ...extra })); process.exit(0); }',
  '  const st = fs.fstatSync(fd);',
  '  fs.closeSync(fd);',
  '  if (st.uid !== 0 && st.uid !== uid) {',
  "    process.stdout.write(JSON.stringify({ ok: false, uid, path: cur, reason: 'owner ' + st.uid, ...extra }));",
  '    process.exit(0);',
  '  }',
  '}',
  'process.stdout.write(JSON.stringify({ ok: true, uid, ...extra }));',
].join('\n');

const collect = (s: NodeJS.ReadableStream): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    s.on('data', (c: Buffer | string) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
    s.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    s.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

interface Layout {
  r: SandboxRoots;
  manager: LeaseManager;
  structure: string;
  cache: string;
  sibling: string;
  close(): Promise<void>;
}

/** §10.11 item 4 as the worker leaves it: roots/p/w 0711 and caches 0700, all owned by the worker uid. */
async function buildLayout(): Promise<Layout> {
  // Short prefix: CBM_RUNTIME_DIR = the cache holds the daemon's Unix socket (sun_path <= 108 bytes); the
  // depth matches production (/var/lib/orc/cbm-cache/p/<guid>).
  const r = makeRoots('oca-');
  // mkdtemp => 0700; the base stands in for /var/lib/orc (root, 0755).
  chmodSync(r.base, 0o755);
  const structure = join(r.cbm, 'p');
  const cache = join(structure, PROJECT_ID);
  const sibling = join(structure, SIBLING_ID);
  for (const d of [structure, join(r.cbm, 'w'), cache, sibling]) mkdirSync(d, { recursive: true });
  for (const d of [r.cbm, structure, join(r.cbm, 'w')]) {
    chownSync(d, WORKER_UID, WORKER_UID);
    chmodSync(d, 0o711);
  }
  for (const d of [cache, sibling]) {
    chownSync(d, WORKER_UID, WORKER_UID);
    chmodSync(d, 0o700);
  }
  const detected = await detectRunnerCaps();
  const manager = createLeaseManager({
    roots: r.roots,
    probeRoots: r.roots.slice(1),
    workerUid: WORKER_UID,
    workerGid: WORKER_UID,
    uidBase: UID_BASE,
    maxLeases: 4,
    leaseTtlMs: 40_000,
    killGraceMs: 300,
    limits: { nproc: 512, nofile: 4096, fsizeBytes: 2 ** 31 },
    identity: 'switch',
    prlimitPath: detected.prlimitPath,
    logger: silentLogger(),
    stateStore: createFileLeaseStateStore(join(r.base, 'state')),
    launch: createDefaultLaunch(),
    processTable: createProcfsTable(),
  });
  await manager.recoverStale();
  return {
    r,
    manager,
    structure,
    cache,
    sibling,
    async close() {
      await manager.close();
      r.cleanup();
    },
  };
}

/** The runner's `mcp` spawn of §12.1 (cwd and CBM_* = the leased scope; runtime dir = cache in runner mode). */
async function spawnMcp(
  l: Layout,
  argv: string[],
): Promise<{ proc: SupervisedProcess; uid: number; leaseId: string }> {
  const lease = await l.manager.acquire({
    key: `op-${OP_ID}`,
    attemptId: null,
    workerId: 'w',
    paths: [l.cache],
  });
  const { proc, uid } = await l.manager.spawn(lease.id, {
    kind: 'mcp',
    argv,
    cwd: l.cache,
    env: {
      PATH: PATH_ENV,
      CBM_CACHE_DIR: l.cache,
      CBM_ALLOWED_ROOT: l.cache,
      CBM_LOG_LEVEL: 'warn',
      CBM_RUNTIME_DIR: l.cache,
    },
  });
  expect(uid).toBe(lease.uid);
  return { proc, uid: uid as number, leaseId: lease.id };
}

interface WalkReport {
  ok: boolean;
  uid: number;
  path?: string;
  reason?: string;
  readSibling: string;
  writeStructure: string;
}

async function walk(l: Layout): Promise<WalkReport> {
  const { proc, uid, leaseId } = await spawnMcp(l, [
    NODE,
    '-e',
    WALKER,
    l.cache,
    l.sibling,
    l.structure,
  ]);
  proc.stdin.end();
  const [out, err] = await Promise.all([collect(proc.stdout), collect(proc.stderr)]);
  expect((await proc.exited).exitCode, err).toBe(0);
  await l.manager.release(leaseId);
  const report = JSON.parse(out) as WalkReport;
  expect(report.uid).toBe(uid);
  return report;
}

const INIT = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'orc-test', version: '1' },
  },
})}\n`;

/** Sends `initialize`; resolves with the first stdout line carrying id 1, or the exit and stderr. */
async function initialize(
  l: Layout,
  bin: string,
): Promise<{ response: unknown; exit: unknown; stderr: string }> {
  const { proc, leaseId } = await spawnMcp(l, [bin]);
  let stdout = '';
  let stderr = '';
  proc.stderr.on('data', (c: Buffer | string) => {
    stderr += c.toString();
  });
  const response = await new Promise<unknown>((resolve) => {
    const timer = setTimeout(() => resolve(null), 30_000);
    proc.stdout.on('data', (c: Buffer | string) => {
      stdout += c.toString();
      const complete = stdout.split('\n').slice(0, -1);
      for (const line of complete) {
        if (!line.includes('"id":1')) continue;
        clearTimeout(timer);
        resolve(JSON.parse(line) as unknown);
        return;
      }
    });
    void proc.exited.then(() => {
      clearTimeout(timer);
      setTimeout(() => resolve(null), 50);
    });
    proc.stdin.write(INIT);
  });
  const exit = response === null ? await proc.exited : null;
  await l.manager.release(leaseId);
  return { response, exit, stderr };
}

describe.skipIf(!IS_LINUX_ROOT)(
  'codebase-memory-mcp cache anchors (Linux root only; ADR-0034)',
  () => {
    let layout: Layout | null = null;
    afterEach(async () => {
      await layout?.close();
      layout = null;
    });

    it('the traverse-only layout fails the ancestor walk of a sandbox uid', async () => {
      layout = await buildLayout();
      const report = await walk(layout);
      expect(report).toMatchObject({ ok: false, path: layout.r.cbm, reason: 'EACCES' });
    });

    it('anchored structure dirs pass the walk while siblings and the structure stay closed', async () => {
      layout = await buildLayout();
      await anchorCbmCacheDirs({ root: layout.r.cbm, workerGid: WORKER_UID });
      for (const d of [layout.r.cbm, layout.structure, join(layout.r.cbm, 'w')]) {
        const st = lstatSync(d);
        expect([st.uid, st.gid, st.mode & 0o7777]).toEqual([0, WORKER_UID, 0o1775]);
      }
      const report = await walk(layout);
      expect(report).toMatchObject({ ok: true, readSibling: 'EACCES', writeStructure: 'EACCES' });
      // Release reclaimed the cache to the worker; the anchors are untouched by lease handoff/reclaim.
      expect(lstatSync(layout.cache).uid).toBe(WORKER_UID);
      expect(lstatSync(layout.structure).uid).toBe(0);
    });

    it.skipIf(CBM_BIN === null)(
      `real codebase-memory-mcp answers initialize only with the anchors (${CBM_BIN ?? 'binary not found'})`,
      async () => {
        const bin = CBM_BIN as string;
        layout = await buildLayout();
        const before = await initialize(layout, bin);
        expect(before.response).toBeNull();
        expect(before.exit).toMatchObject({ exitCode: 1 });
        expect(before.stderr).toContain('could not load saved runtime settings');

        await anchorCbmCacheDirs({ root: layout.r.cbm, workerGid: WORKER_UID });
        const after = await initialize(layout, bin);
        expect(after.response, after.stderr).toMatchObject({
          id: 1,
          result: { serverInfo: { name: 'codebase-memory-mcp' } },
        });
      },
      90_000,
    );
  },
);
