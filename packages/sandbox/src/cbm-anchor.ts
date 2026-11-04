// codebase-memory-mcp cache anchors (ADR-0034, Proposed; contract §10.11 items 3-4, §11.1, §12.1).
//
// codebase-memory-mcp v0.12.0 resolves CBM_CACHE_DIR and CBM_RUNTIME_DIR and then walks each from `/`,
// opening every component with O_RDONLY|O_DIRECTORY|O_NOFOLLOW and rejecting any component owned by
// neither root nor the invoking uid; it exits 1 before the MCP handshake ("could not load saved runtime
// settings" / "secure daemon endpoint could not be created"). The traverse-only structure directories
// of §10.11 item 4 (0711, owned by the worker uid) fail both checks for a sandbox uid, so every
// runner-mode MCP server died. The runner (root, CAP_CHOWN/CAP_FOWNER) therefore anchors the
// structure directories above the leased caches, `<CBM_CACHE_DIR>` and `<CBM_CACHE_DIR>/{p,w}`:
// owner root (trusted by codebase-memory-mcp), group = worker gid with write (the worker creates and
// removes the per-scope cache directories), others r-x (codebase-memory-mcp must open them), sticky
// (only an entry's owner may rename or delete it, so the worker group can neither swap the root-owned
// structure directories nor a lease-owned cache while it is leased). Per-scope caches keep 0700 of
// the worker or of the lease uid: a sandbox uid can list the GUID-named entries but read or write only
// its own leased cache.
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { OrcError } from '@orc/shared';

/** `root:<WORKER_GID>` `drwxrwxr-t` (sticky, group-writable, world-readable/traversable). */
export const CBM_ANCHOR_MODE = 0o1775;
/** Structure directories below CBM_CACHE_DIR whose children are the per-scope caches (§11.1). */
export const CBM_ANCHOR_SUBDIRS: readonly string[] = Object.freeze(['p', 'w']);

export interface AnchorDirStats {
  isDirectory(): boolean;
  uid: number;
  gid: number;
  mode: number;
}

/** An open directory; ownership and mode change through the descriptor (fchown/fchmod, no path race). */
export interface AnchorDirHandle {
  stat(): Promise<AnchorDirStats>;
  chown(uid: number, gid: number): Promise<void>;
  chmod(mode: number): Promise<void>;
  close(): Promise<void>;
}

/** Filesystem primitives of the anchoring; injectable so the logic is testable without root. */
export interface AnchorFs {
  /** Opens an existing directory, never following a symlink in the last component (ELOOP/ENOTDIR). */
  openDir(p: string): Promise<AnchorDirHandle>;
  /** Non-recursive mkdir; EEXIST is handled by the caller. */
  mkdir(p: string, mode: number): Promise<void>;
}

export function nodeAnchorFs(): AnchorFs {
  const { O_DIRECTORY, O_NOFOLLOW, O_RDONLY } = constants;
  return {
    async openDir(p) {
      if (O_DIRECTORY === undefined || O_NOFOLLOW === undefined) {
        throw new OrcError(
          'config_invalid',
          'O_DIRECTORY/O_NOFOLLOW are unavailable on this platform',
        );
      }
      const fh = await open(p, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      return {
        stat: () => fh.stat(),
        chown: (uid, gid) => fh.chown(uid, gid),
        chmod: (mode) => fh.chmod(mode),
        close: () => fh.close(),
      };
    },
    async mkdir(p, mode) {
      await mkdir(p, { mode });
    },
  };
}

export interface CbmAnchorOptions {
  /** Canonical (realpath) CBM_CACHE_DIR. */
  root: string;
  /** Group of the anchors: the worker gid (creates and removes per-scope caches). */
  workerGid: number;
}

export interface CbmAnchorResult {
  path: string;
  created: boolean;
  /** Ownership/mode before anchoring (null when created now). */
  before: { uid: number; gid: number; mode: number } | null;
  changed: boolean;
}

const errno = (e: unknown): string | undefined =>
  e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : undefined;

async function anchorOne(
  fs: AnchorFs,
  dir: string,
  gid: number,
  created: boolean,
): Promise<CbmAnchorResult> {
  let fh: AnchorDirHandle;
  try {
    fh = await fs.openDir(dir);
  } catch (e) {
    throw new OrcError(
      'config_invalid',
      `codebase-memory-mcp cache anchor ${dir} is not a plain directory`,
      {
        cause: e,
        details: { path: dir, reason: errno(e) ?? 'open_failed' },
      },
    );
  }
  try {
    const st = await fh.stat();
    if (!st.isDirectory()) {
      throw new OrcError(
        'config_invalid',
        `codebase-memory-mcp cache anchor ${dir} is not a directory`,
        {
          details: { path: dir },
        },
      );
    }
    const before = { uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 };
    const changed = before.uid !== 0 || before.gid !== gid || before.mode !== CBM_ANCHOR_MODE;
    if (changed) {
      // chmod after chown: chown may clear mode bits, the final mode must be exact.
      await fh.chown(0, gid);
      await fh.chmod(CBM_ANCHOR_MODE);
    }
    return { path: dir, created, before: created ? null : before, changed };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/**
 * Anchors `<root>` and `<root>/{p,w}` as `root:<workerGid>` mode 1775, creating the subdirectories when
 * missing. Idempotent (runner start, every restart). Never follows symlinks; a symlink or non-directory
 * at an anchor path is a configuration error.
 */
export async function anchorCbmCacheDirs(
  o: CbmAnchorOptions,
  fs: AnchorFs = nodeAnchorFs(),
): Promise<CbmAnchorResult[]> {
  if (!path.isAbsolute(o.root)) {
    throw new OrcError('config_invalid', 'CBM_CACHE_DIR must be absolute', {
      details: { path: o.root },
    });
  }
  if (!Number.isInteger(o.workerGid) || o.workerGid <= 0) {
    throw new OrcError('config_invalid', 'Anchor group must be the (non-root) worker gid', {
      details: { gid: o.workerGid },
    });
  }
  const results: CbmAnchorResult[] = [await anchorOne(fs, o.root, o.workerGid, false)];
  for (const name of CBM_ANCHOR_SUBDIRS) {
    const dir = path.join(o.root, name);
    let created = false;
    try {
      await fs.mkdir(dir, CBM_ANCHOR_MODE);
      created = true;
    } catch (e) {
      if (errno(e) !== 'EEXIST') throw e;
    }
    results.push(await anchorOne(fs, dir, o.workerGid, created));
  }
  return results;
}
