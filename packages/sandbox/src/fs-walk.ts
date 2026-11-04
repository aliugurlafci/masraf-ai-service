// Lease handoff / reclaim / measure walks (contract §10.11 item 3). Every entry is examined with
// lstat; symbolic links are never followed: they are re-owned with lchown and never chmod-ed
// (chmod would act on the link target).
import { chmod, lchown, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { LeaseMeasurement } from '@orc/shared/node';

export interface WalkStats {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isFile(): boolean;
  mode: number;
  size: number;
}

/** Filesystem primitives used by the walks; injectable so the logic is testable without root. */
export interface WalkFs {
  lstat(p: string): Promise<WalkStats>;
  readdir(p: string): Promise<string[]>;
  lchown(p: string, uid: number, gid: number): Promise<void>;
  chmod(p: string, mode: number): Promise<void>;
}

export const nodeWalkFs: WalkFs = {
  lstat: (p) => lstat(p),
  readdir: (p) => readdir(p),
  lchown: (p, uid, gid) => lchown(p, uid, gid),
  chmod: (p, mode) => chmod(p, mode),
};

const errno = (e: unknown): string | undefined =>
  e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : undefined;

/** `u+X` semantics: execute for directories and for files with any execute bit. */
const userX = (mode: number, isDir: boolean): number => (isDir || (mode & 0o111) !== 0 ? 0o100 : 0);

/**
 * Handoff mode `u+rwX,go-rwx`. setuid/setgid/sticky bits are always cleared, so nothing in a
 * leased tree can carry privileges across the uid boundary.
 */
export function handoffMode(mode: number, isDir: boolean): number {
  return (mode & 0o700) | 0o600 | userX(mode, isDir);
}

/**
 * Reclaim mode `u+rwX`, additionally `go-rwx` and no special bits: unleased trees are private to
 * the worker uid again (contract §10.11 item 4: unleased worktrees, `.meta`, homes, caches 0700).
 */
export function reclaimMode(mode: number, isDir: boolean): number {
  return handoffMode(mode, isDir);
}

export interface OwnershipWalkOptions {
  uid: number;
  gid: number;
  mode: (mode: number, isDir: boolean) => number;
  /** false => only count entries (no identity switching on this host). */
  apply: boolean;
}

/**
 * Re-owns `root` and everything below it (pre-order, iterative). Entries that disappear during the
 * walk are skipped; a missing root returns 0 entries. Directories reached through symlinks are
 * never entered.
 */
export async function chownTree(
  root: string,
  opts: OwnershipWalkOptions,
  fs: WalkFs = nodeWalkFs,
): Promise<{ entries: number }> {
  const stack: string[] = [root];
  let entries = 0;
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let st: WalkStats;
    try {
      st = await fs.lstat(current);
    } catch (e) {
      if (errno(e) === 'ENOENT') continue;
      throw e;
    }
    entries++;
    const isDir = st.isDirectory();
    if (opts.apply) {
      await ignoreEnoent(fs.lchown(current, opts.uid, opts.gid));
      if (!st.isSymbolicLink()) {
        await ignoreEnoent(fs.chmod(current, opts.mode(st.mode & 0o7777, isDir)));
      }
    }
    if (isDir) {
      let names: string[];
      try {
        names = await fs.readdir(current);
      } catch (e) {
        if (errno(e) === 'ENOENT' || errno(e) === 'ENOTDIR') continue;
        throw e;
      }
      for (const name of names) stack.push(path.join(current, name));
    }
  }
  return { entries };
}

async function ignoreEnoent(p: Promise<void>): Promise<void> {
  try {
    await p;
  } catch (e) {
    if (errno(e) !== 'ENOENT') throw e;
  }
}

/**
 * Size of a leased tree: lstat walk without following links, bytes = sizes of all non-directory
 * entries, `.git` link files skipped (as GitManager.measureSize). Stops with `truncated: true`
 * once more than `maxEntries` entries were seen.
 */
export async function measureTree(
  root: string,
  maxEntries: number,
  fs: Pick<WalkFs, 'lstat' | 'readdir'> = nodeWalkFs,
): Promise<LeaseMeasurement> {
  const stack: string[] = [root];
  let bytes = 0;
  let entries = 0;
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let st: WalkStats;
    try {
      st = await fs.lstat(current);
    } catch (e) {
      if (errno(e) === 'ENOENT') continue;
      throw e;
    }
    if (current !== root && path.basename(current) === '.git' && st.isFile()) continue;
    entries++;
    if (entries > maxEntries) return { bytes, entries: maxEntries, truncated: true };
    if (st.isDirectory()) {
      let names: string[];
      try {
        names = await fs.readdir(current);
      } catch (e) {
        if (errno(e) === 'ENOENT' || errno(e) === 'ENOTDIR') continue;
        throw e;
      }
      for (const name of names) stack.push(path.join(current, name));
    } else {
      bytes += st.size;
    }
  }
  return { bytes, entries, truncated: false };
}
