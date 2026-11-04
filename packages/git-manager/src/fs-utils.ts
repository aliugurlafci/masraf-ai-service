// Filesystem helpers: bounded lstat walks, directory modes, guarded removal (contract §11.6, §11.7).
import { chmod, lstat, mkdir, readdir, realpath, rm, rmdir, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import type { HostPlatform } from '@orc/shared/node';

const STAT_BATCH = 64;

export function errnoOf(e: unknown): string | undefined {
  return e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : undefined;
}

export async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await lstat(p);
  } catch (e) {
    if (errnoOf(e) === 'ENOENT' || errnoOf(e) === 'ENOTDIR') return null;
    throw e;
  }
}

/** Normalized comparison key of an absolute path (case-insensitive on win32). */
export function pathKey(p: string, platform: HostPlatform): string {
  let r = path.resolve(p);
  const root = path.parse(r).root;
  while (r.length > root.length && (r.endsWith('/') || r.endsWith('\\'))) r = r.slice(0, -1);
  return platform === 'win32' ? r.toLowerCase() : r;
}

/** Lexical comparison first, then via realpath of both (8.3 names, symlinked roots). */
export async function samePath(a: string, b: string, platform: HostPlatform): Promise<boolean> {
  if (pathKey(a, platform) === pathKey(b, platform)) return true;
  try {
    const [ra, rb] = await Promise.all([realpath(a), realpath(b)]);
    return pathKey(ra, platform) === pathKey(rb, platform);
  } catch {
    return false;
  }
}

/** mkdir -p with an exact mode on POSIX for the directories this call creates or names. */
export async function ensureDirMode(dir: string, mode: number, platform: HostPlatform): Promise<void> {
  await mkdir(dir, { recursive: true, mode });
  if (platform === 'posix') await chmod(dir, mode);
}

export interface SizeResult {
  bytes: number;
  entries: number;
  truncated: boolean;
}

/**
 * Bounded lstat walk (§11.6): never follows symlinks (Dirent types come from readdir), skips the
 * root-level '.git' file, counts every entry and the lstat size of every non-directory.
 * More than `maxEntries` entries => `truncated: true` (treated as over quota by callers).
 */
export async function measureTree(root: string, maxEntries: number): Promise<SizeResult> {
  const top = await lstatOrNull(root);
  if (top === null) return { bytes: 0, entries: 0, truncated: false };
  if (!top.isDirectory()) return { bytes: top.size, entries: 1, truncated: false };
  let bytes = 0;
  let entries = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (errnoOf(e) === 'ENOENT' || errnoOf(e) === 'ENOTDIR') continue;
      throw e;
    }
    const files: string[] = [];
    for (const d of dirents) {
      if (dir === root && d.name === '.git' && !d.isDirectory()) continue;
      entries += 1;
      if (entries > maxEntries) return { bytes, entries, truncated: true };
      const full = path.join(dir, d.name);
      if (d.isDirectory()) stack.push(full);
      else files.push(full);
    }
    for (let i = 0; i < files.length; i += STAT_BATCH) {
      const sizes = await Promise.all(
        files.slice(i, i + STAT_BATCH).map(async (f) => (await lstatOrNull(f))?.size ?? 0),
      );
      for (const s of sizes) bytes += s;
    }
  }
  return { bytes, entries, truncated: false };
}

/** chmod -R u+rwX without following symlinks (directories are fixed before being listed). */
export async function chmodUserRwx(root: string): Promise<void> {
  const top = await lstatOrNull(root);
  if (top === null || top.isSymbolicLink()) return;
  if (!top.isDirectory()) {
    await chmod(root, (top.mode & 0o7777) | 0o600).catch(() => undefined);
    return;
  }
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    const st = await lstatOrNull(dir);
    if (st === null || st.isSymbolicLink() || !st.isDirectory()) continue;
    await chmod(dir, (st.mode & 0o7777) | 0o700).catch(() => undefined);
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      const full = path.join(dir, d.name);
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        stack.push(full);
        continue;
      }
      const fst = await lstatOrNull(full);
      if (fst === null || fst.isSymbolicLink()) continue;
      await chmod(full, (fst.mode & 0o7777) | 0o600).catch(() => undefined);
    }
  }
}

/**
 * Removes `target` without ever following a link: a symlink/junction is unlinked itself (the
 * directory it points to is untouched); a directory is made writable (u+rwX) and removed.
 */
export async function removeNoFollow(target: string): Promise<void> {
  const st = await lstatOrNull(target);
  if (st === null) return;
  if (st.isSymbolicLink()) {
    try {
      await unlink(target);
    } catch (e) {
      // Windows directory junctions/symlinks are removed with rmdir (target untouched).
      if (errnoOf(e) === 'EPERM' || errnoOf(e) === 'EISDIR') await rmdir(target);
      else if (errnoOf(e) !== 'ENOENT') throw e;
    }
    return;
  }
  if (st.isDirectory()) {
    await chmodUserRwx(target);
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return;
  }
  await rm(target, { force: true });
}
