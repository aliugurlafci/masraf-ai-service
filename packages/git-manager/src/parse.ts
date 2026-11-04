// Parsers for git plumbing output (contract §11.4, §11.5). Pure functions.
import type { ChangeType, ChangedFileInput, CommitInfo } from '@orc/shared';

const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function isFullSha(s: string): boolean {
  return FULL_SHA.test(s);
}

/** `git version 2.45.1[.windows.1]` => [major, minor] or null. */
export function parseGitVersion(stdout: string): { text: string; major: number; minor: number } | null {
  const m = /git version (\d+)\.(\d+)(?:\.\d+)?\S*/.exec(stdout);
  if (!m) return null;
  return { text: m[0].slice('git version '.length), major: Number(m[1]), minor: Number(m[2]) };
}

/**
 * Splits NUL-terminated tokens. The element after the final NUL is '' for complete output and a
 * partial token for truncated output; either way it is dropped. A record whose later tokens are
 * missing is discarded by the record parsers.
 */
function nulTokens(buf: Buffer): string[] {
  const tokens = buf.toString('utf8').split('\0');
  tokens.pop();
  return tokens;
}

export interface NameStatusEntry {
  status: string;
  changeType: ChangeType;
  similarity: number | null;
  path: string;
  oldPath: string | null;
}

function changeTypeOf(letter: string): ChangeType {
  switch (letter) {
    case 'A':
    case 'M':
    case 'D':
    case 'R':
    case 'C':
    case 'T':
      return letter;
    default:
      return 'M';
  }
}

/** `diff --name-status -M -z`: `S\0path\0` or `Rnnn\0old\0new\0`. Keeps the first `maxFiles` entries. */
export function parseNameStatusZ(
  buf: Buffer,
  maxFiles: number,
  stdoutTruncated: boolean,
): { entries: NameStatusEntry[]; total: number; truncated: boolean } {
  const tokens = nulTokens(buf);
  const entries: NameStatusEntry[] = [];
  let total = 0;
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i++] ?? '';
    if (status === '') continue;
    const letter = status.charAt(0);
    let path: string | undefined;
    let oldPath: string | null = null;
    if (letter === 'R' || letter === 'C') {
      const from = tokens[i++];
      path = tokens[i++];
      if (from === undefined) break;
      oldPath = from;
    } else {
      path = tokens[i++];
    }
    if (path === undefined) break;
    total += 1;
    if (entries.length >= maxFiles) continue;
    const score = /^[RC](\d{1,3})$/.exec(status);
    entries.push({
      status,
      changeType: changeTypeOf(letter),
      similarity: score ? Math.min(100, Number(score[1])) : null,
      path,
      oldPath,
    });
  }
  return { entries, total, truncated: stdoutTruncated || total > entries.length };
}

export interface NumstatEntry {
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

/** `diff --numstat -M -z`: `a\td\tpath\0` or `a\td\t\0old\0new\0`; `-\t-` => binary. Keyed by new path. */
export function parseNumstatZ(buf: Buffer): Map<string, NumstatEntry> {
  const tokens = nulTokens(buf);
  const out = new Map<string, NumstatEntry>();
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i++] ?? '';
    if (head === '') continue;
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(head);
    if (!m) continue;
    let path = m[3] ?? '';
    if (path === '') {
      const from = tokens[i++];
      const to = tokens[i++];
      if (from === undefined || to === undefined) break;
      path = to;
    }
    const binary = m[1] === '-' && m[2] === '-';
    out.set(path, {
      additions: binary || m[1] === '-' ? null : Number(m[1]),
      deletions: binary || m[2] === '-' ? null : Number(m[2]),
      binary,
    });
  }
  return out;
}

const DIFF_HEADER = Buffer.from('diff --git ', 'utf8');
const NL_DIFF_HEADER = Buffer.from('\ndiff --git ', 'utf8');

/** Splits `git diff --patch` output on `^diff --git `; each chunk keeps its header line. */
export function splitPatch(buf: Buffer): Buffer[] {
  const starts: number[] = [];
  if (buf.length >= DIFF_HEADER.length && buf.subarray(0, DIFF_HEADER.length).equals(DIFF_HEADER)) {
    starts.push(0);
  }
  let from = 0;
  for (;;) {
    const idx = buf.indexOf(NL_DIFF_HEADER, from);
    if (idx < 0) break;
    starts.push(idx + 1);
    from = idx + 1;
  }
  const chunks: Buffer[] = [];
  for (let k = 0; k < starts.length; k++) {
    chunks.push(buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length));
  }
  return chunks;
}

/** Largest prefix of `buf` of at most `maxBytes` bytes that does not cut a UTF-8 sequence. */
export function utf8SafePrefix(buf: Buffer, maxBytes: number): Buffer {
  if (buf.length <= maxBytes) return buf;
  let end = Math.max(0, maxBytes);
  // Step back over continuation bytes (10xxxxxx) so the cut lands on a character boundary.
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end);
}

/**
 * Assembles NewChangedFile rows (§11.5). Patch chunks are assigned in name-status order; a type
 * change (T) is emitted by git as a deletion + creation pair, so it consumes two chunks.
 */
export function assembleChangedFiles(input: {
  entries: readonly NameStatusEntry[];
  numstat: ReadonlyMap<string, NumstatEntry>;
  patchChunks: readonly Buffer[];
  patchStdoutTruncated: boolean;
  perFileMaxBytes: number;
}): ChangedFileInput[] {
  const out: ChangedFileInput[] = [];
  let idx = 0;
  const lastChunk = input.patchChunks.length - 1;
  for (const e of input.entries) {
    const take = e.changeType === 'T' ? 2 : 1;
    const parts = input.patchChunks.slice(idx, idx + take);
    const usedLast = idx + take - 1 >= lastChunk;
    idx += take;
    const stat = input.numstat.get(e.path);
    const isBinary = stat?.binary ?? false;
    let patch: string | null = null;
    let patchBytes = 0;
    let patchTruncated: boolean;
    if (parts.length === 0) {
      patchTruncated = true;
    } else {
      const full = parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts);
      patchBytes = full.length;
      const complete = parts.length === take && !(input.patchStdoutTruncated && usedLast);
      if (full.length > input.perFileMaxBytes) {
        patch = utf8SafePrefix(full, input.perFileMaxBytes).toString('utf8');
        patchTruncated = true;
      } else {
        patch = full.toString('utf8');
        patchTruncated = !complete;
      }
    }
    out.push({
      path: e.path,
      oldPath: e.changeType === 'R' || e.changeType === 'C' ? e.oldPath : null,
      changeType: e.changeType,
      similarity: e.similarity,
      additions: isBinary ? null : (stat?.additions ?? null),
      deletions: isBinary ? null : (stat?.deletions ?? null),
      isBinary,
      patchBytes,
      patchTruncated,
      patch,
    });
  }
  return out;
}

/** `log --format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e`. Returns null for a malformed record. */
export function parseLog(buf: Buffer): CommitInfo[] | null {
  const out: CommitInfo[] = [];
  for (const raw of buf.toString('utf8').split('\x1e')) {
    const rec = raw.replace(/^\r?\n/, '');
    if (rec.trim() === '') continue;
    const fields = rec.split('\x1f');
    if (fields.length < 5) return null;
    const [sha, authorName, authorEmail, date] = fields as [string, string, string, string];
    if (!isFullSha(sha)) return null;
    const at = new Date(date);
    if (Number.isNaN(at.getTime())) return null;
    out.push({
      sha,
      authorName,
      authorEmail,
      authoredAt: at.toISOString(),
      subject: fields.slice(4).join('\x1f'),
    });
  }
  return out;
}

export interface WorktreeListEntry {
  worktree: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

/** `worktree list --porcelain -z`: NUL-terminated attributes, an empty attribute ends an entry. */
export function parseWorktreeList(buf: Buffer): WorktreeListEntry[] {
  const out: WorktreeListEntry[] = [];
  let cur: WorktreeListEntry | null = null;
  for (const token of buf.toString('utf8').split('\0')) {
    if (token === '') {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    const sp = token.indexOf(' ');
    const key = sp < 0 ? token : token.slice(0, sp);
    const value = sp < 0 ? '' : token.slice(sp + 1);
    if (key === 'worktree') {
      if (cur) out.push(cur);
      cur = {
        worktree: value,
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (!cur) continue;
    if (key === 'HEAD') cur.head = value;
    else if (key === 'branch') cur.branch = value;
    else if (key === 'detached') cur.detached = true;
    else if (key === 'bare') cur.bare = true;
    else if (key === 'locked') cur.locked = true;
    else if (key === 'prunable') cur.prunable = true;
  }
  if (cur) out.push(cur);
  return out;
}

/** `merge-tree --write-tree --name-only --no-messages -z`: `<tree>\0<path>\0...` (paths deduplicated). */
export function parseMergeTree(buf: Buffer): { tree: string; conflicts: string[] } {
  const tokens = buf.toString('utf8').split('\0');
  const tree = (tokens[0] ?? '').trim();
  const conflicts: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens.slice(1)) {
    if (t === '' || seen.has(t)) continue;
    seen.add(t);
    conflicts.push(t);
  }
  return { tree, conflicts };
}

/** `for-each-ref --format=%(refname:lstrip=3)%00%(objectname) refs/remotes/origin/` (symref HEAD skipped). */
export function parseBranchList(buf: Buffer): { name: string; sha: string }[] {
  const out: { name: string; sha: string }[] = [];
  for (const line of buf.toString('utf8').split('\n')) {
    if (line === '') continue;
    const nul = line.indexOf('\0');
    if (nul <= 0) continue;
    const name = line.slice(0, nul);
    const sha = line.slice(nul + 1).trim();
    if (name === 'HEAD' || !isFullSha(sha)) continue;
    out.push({ name, sha });
  }
  return out;
}
