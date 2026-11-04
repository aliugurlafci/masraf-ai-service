// codebase-memory-mcp cache anchors (ADR-0034): <CBM_CACHE_DIR> and <CBM_CACHE_DIR>/{p,w} become
// root:<workerGid> 1775 so a sandbox uid can open every ancestor of its leased cache (O_RDONLY) and
// each ancestor is root-owned, which codebase-memory-mcp v0.12.0 requires before it starts.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CBM_ANCHOR_MODE,
  anchorCbmCacheDirs,
  type AnchorDirHandle,
  type AnchorFs,
} from '@orc/sandbox';

interface Entry {
  kind: 'dir' | 'file' | 'symlink';
  uid: number;
  gid: number;
  mode: number;
}

const ROOT = '/var/lib/orc/cbm-cache';
const P = join(ROOT, 'p');
const W = join(ROOT, 'w');
const WORKER = 1000;

function errnoError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** In-memory POSIX-like tree; records every ownership/mode change made through a descriptor. */
function memFs(initial: Record<string, Entry>): {
  fs: AnchorFs;
  tree: Map<string, Entry>;
  ops: string[];
  open: () => number;
} {
  const tree = new Map(Object.entries(initial));
  const ops: string[] = [];
  let openCount = 0;
  const fs: AnchorFs = {
    openDir(p) {
      const e = tree.get(p);
      if (e === undefined) return Promise.reject(errnoError('ENOENT'));
      if (e.kind === 'symlink') return Promise.reject(errnoError('ELOOP'));
      if (e.kind !== 'dir') return Promise.reject(errnoError('ENOTDIR'));
      openCount++;
      const h: AnchorDirHandle = {
        stat: () =>
          Promise.resolve({
            isDirectory: () => e.kind === 'dir',
            uid: e.uid,
            gid: e.gid,
            mode: 0o40000 | e.mode,
          }),
        chown: (uid, gid) => {
          ops.push(`chown ${p} ${uid}:${gid}`);
          e.uid = uid;
          e.gid = gid;
          return Promise.resolve();
        },
        chmod: (mode) => {
          ops.push(`chmod ${p} ${mode.toString(8)}`);
          e.mode = mode;
          return Promise.resolve();
        },
        close: () => {
          openCount--;
          return Promise.resolve();
        },
      };
      return Promise.resolve(h);
    },
    mkdir(p, mode) {
      if (tree.has(p)) return Promise.reject(errnoError('EEXIST'));
      // Created by the runner (root) with the umask 022 applied.
      tree.set(p, { kind: 'dir', uid: 0, gid: 0, mode: mode & ~0o022 });
      ops.push(`mkdir ${p}`);
      return Promise.resolve();
    },
  };
  return { fs, tree, ops, open: () => openCount };
}

const traverseOnly = (): Entry => ({ kind: 'dir', uid: WORKER, gid: WORKER, mode: 0o711 });

describe('anchorCbmCacheDirs', () => {
  it('re-owns the traverse-only layout of the worker to root:<workerGid> 1775', async () => {
    const m = memFs({ [ROOT]: traverseOnly(), [P]: traverseOnly(), [W]: traverseOnly() });
    const res = await anchorCbmCacheDirs({ root: ROOT, workerGid: WORKER }, m.fs);

    expect(CBM_ANCHOR_MODE).toBe(0o1775);
    for (const p of [ROOT, P, W]) {
      expect(m.tree.get(p)).toEqual({ kind: 'dir', uid: 0, gid: WORKER, mode: 0o1775 });
    }
    expect(res.map((r) => [r.path, r.created, r.changed])).toEqual([
      [ROOT, false, true],
      [P, false, true],
      [W, false, true],
    ]);
    expect(res[0]?.before).toEqual({ uid: WORKER, gid: WORKER, mode: 0o711 });
    // chown strictly before chmod for every anchor; every descriptor closed.
    expect(m.ops).toEqual([
      `chown ${ROOT} 0:${WORKER}`,
      `chmod ${ROOT} 1775`,
      `chown ${P} 0:${WORKER}`,
      `chmod ${P} 1775`,
      `chown ${W} 0:${WORKER}`,
      `chmod ${W} 1775`,
    ]);
    expect(m.open()).toBe(0);
  });

  it('creates missing p/ and w/ and is idempotent', async () => {
    const m = memFs({ [ROOT]: traverseOnly() });
    const first = await anchorCbmCacheDirs({ root: ROOT, workerGid: WORKER }, m.fs);
    expect(first.filter((r) => r.created).map((r) => r.path)).toEqual([P, W]);
    expect(first.find((r) => r.created)?.before).toBeNull();
    expect(m.tree.get(P)).toEqual({ kind: 'dir', uid: 0, gid: WORKER, mode: 0o1775 });

    m.ops.length = 0;
    const second = await anchorCbmCacheDirs({ root: ROOT, workerGid: WORKER }, m.fs);
    expect(second.every((r) => !r.created && !r.changed)).toBe(true);
    expect(m.ops).toEqual([]);
  });

  it('never follows a symlink or accepts a non-directory at an anchor path', async () => {
    const link = memFs({
      [ROOT]: traverseOnly(),
      [P]: { kind: 'symlink', uid: WORKER, gid: WORKER, mode: 0o777 },
    });
    await expect(
      anchorCbmCacheDirs({ root: ROOT, workerGid: WORKER }, link.fs),
    ).rejects.toMatchObject({
      code: 'config_invalid',
      details: { path: P, reason: 'ELOOP' },
    });
    expect(link.tree.get(P)?.uid).toBe(WORKER);

    const file = memFs({
      [ROOT]: traverseOnly(),
      [W]: { kind: 'file', uid: WORKER, gid: WORKER, mode: 0o600 },
    });
    await expect(
      anchorCbmCacheDirs({ root: ROOT, workerGid: WORKER }, file.fs),
    ).rejects.toMatchObject({
      code: 'config_invalid',
      details: { path: W, reason: 'ENOTDIR' },
    });
    expect(file.open()).toBe(0);
  });

  it('requires the root to exist and rejects relative roots and the root group', async () => {
    const empty = memFs({});
    await expect(
      anchorCbmCacheDirs({ root: ROOT, workerGid: WORKER }, empty.fs),
    ).rejects.toMatchObject({
      code: 'config_invalid',
      details: { reason: 'ENOENT' },
    });
    expect(empty.ops).toEqual([]);
    await expect(
      anchorCbmCacheDirs({ root: 'cbm-cache', workerGid: WORKER }, empty.fs),
    ).rejects.toMatchObject({
      code: 'config_invalid',
    });
    await expect(anchorCbmCacheDirs({ root: ROOT, workerGid: 0 }, empty.fs)).rejects.toMatchObject({
      code: 'config_invalid',
    });
  });

  it('propagates unexpected mkdir errors', async () => {
    const m = memFs({ [ROOT]: traverseOnly() });
    const fs: AnchorFs = { ...m.fs, mkdir: () => Promise.reject(errnoError('EROFS')) };
    await expect(anchorCbmCacheDirs({ root: ROOT, workerGid: WORKER }, fs)).rejects.toMatchObject({
      code: 'EROFS',
    });
  });
});
