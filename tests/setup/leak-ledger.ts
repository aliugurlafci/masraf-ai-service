// Leak ledger of the test leak guard (B-005, contract §18.2). Snapshots of the temp root and of the host process
// table, a PURE diff/attribution step and the guarded removal behind ORC_TEST_REAP=1.
//
// Selection rules (an item is only ever a leak if ALL hold):
// - Directory: new in this run (absent from the "before" snapshot, or a different inode), a direct child of
//   realpath(os.tmpdir()) pinned with @orc/security resolveWithin, base name `<prefix from LEAK_DIR_PREFIXES>` + the
//   6 mkdtemp characters, and a real directory by lstat (links are never followed, never listed, never removed).
// - Process: new in this run (pid + start time), carries the absolute path of tests/fixtures/fake-claude/
//   fake-claude.mjs, and is attributable to THIS run: its parent chain reaches the root PID (each parent started no
//   later than its child, so a reused PID never links), or (Windows) its exited parent was a worker of this run that
//   held the PID when the process started, or (Linux) /proc/<pid>/environ carries this run's ORC_TEST_RUN_ID.
//   Windows CIM cannot read another process' environment, so there the PID chain is the only proof.
// Anything else is at most a warning and is never touched.
import { spawn } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWithin } from '@orc/security';
import { z } from 'zod';
import { waitForProcessExit } from '../helpers/common/process';
import { REMOVE_OPTIONS, TEMP_DIR_PREFIX } from '../helpers/common/temp-dir';
import type { DbScan } from './leak-db';
import type { WorkerRecord } from './leak-worker-record';
import { readEnvMarker, scanProcessTable } from './process-table';
import type { ProcessEntry, ProcessScan, StartClock } from './process-table';

/**
 * EXPLICIT list of every temp-dir prefix the tests and their helpers create (K6). Deliberately no `orc-*` pattern:
 * product code makes `orc-cbm-rt-<uid>` below the temp root and the test HOME is `orc-test-home`, neither may ever be
 * a leak. A name is a leak candidate only as `<listed prefix>` + exactly the 6 alphanumeric characters of mkdtemp.
 * tests/unit/architecture/test-prefixes.test.ts keeps this list in sync with the prefixes found in tests/**.
 */
export const LEAK_DIR_PREFIXES: readonly string[] = [
  TEMP_DIR_PREFIX,
  'orc-test-migrations-',
  'orc-test-leak-',
  'orc-wk-',
  'orc-gm-int-',
  'orc-gm-unit-',
  'orc-sandbox-',
  'orc-local-',
  'orc-runner-loss-',
  'orc-claude-runner-',
  'orc-claude-live-',
  'orc-probe-unit-',
  'orc-fake-proc-',
  'orc-malicious-',
  'orc-sec-inject-',
  'orc-sec-path-',
  'orc-sec-paths-',
  'orc-sec-scripts-',
  'orc-sec-sandbox-',
  'orc-shared-config-',
  'orc-shared-proc-',
  'orc-cfg2-',
  'orc-c-',
  'oca-',
];
/** mkdtemp appends exactly 6 characters of [A-Za-z0-9]. */
const MKDTEMP_SUFFIX = /^[A-Za-z0-9]{6}$/;
/** Run-specific marker the guard puts into the environment of this run's workers (and their children). */
export const RUN_ID_ENV = 'ORC_TEST_RUN_ID';
export const FAKE_CLAUDE_PATH = fileURLToPath(
  new URL('../fixtures/fake-claude/fake-claude.mjs', import.meta.url),
);

const MAX_CHAIN_HOPS = 64;
const MAX_TREE_ENTRIES = 50_000;
const MAX_TREE_DEPTH = 32;
const MAX_REPOS_PER_DIR = 16;
const MAX_GITDIR_POINTER_BYTES = 4096;
const GIT_TIMEOUT_MS = 15_000;
const KILL_WAIT_MS = 10_000;
/** A Vitest entry point or worker of any checkout (`.../vitest/vitest.mjs`, `.../vitest/dist/...`). */
const VITEST_ENTRY = /(?:^|[\\/])vitest[\\/]+(?:vitest\.mjs|dist[\\/])/i;
const WINDOWS_TOKEN_BOUNDARY: ReadonlySet<string> = new Set(['', ' ', '\t', '"', "'"]);

export interface LedgerContext {
  readonly runId: string;
  /** The process whose descendants are "this run" (the Vitest main process for the guard). */
  readonly rootPid: number;
  /** realpath(os.tmpdir()). */
  readonly tmpRoot: string;
  readonly platform: NodeJS.Platform;
  /** fake-claude.mjs as an absolute path (lexical and canonical). */
  readonly fakeClaudePaths: readonly string[];
}

export interface TempDirEntry {
  readonly name: string;
  readonly path: string;
  /** lstat inode (bigint as decimal string): a directory recreated under the same name is a different entry. */
  readonly ino: string;
}

export type DirScan =
  | { readonly ok: true; readonly dirs: readonly TempDirEntry[] }
  | { readonly ok: false; readonly reason: string };

export interface MarkedProcess extends ProcessEntry {
  /** Linux only, and only for fake-claude candidates: environ carries this run's ORC_TEST_RUN_ID. */
  readonly runMarker: boolean | null;
}

export type MarkedScan =
  | { readonly ok: true; readonly clock: StartClock; readonly processes: readonly MarkedProcess[] }
  | { readonly ok: false; readonly reason: string };

export interface LeakSnapshot {
  readonly takenAt: string;
  readonly dirs: DirScan;
  readonly processes: MarkedScan;
  /** null when the snapshot was taken without the database. */
  readonly db: DbScan | null;
}

export type Attribution = 'chain' | 'worker-ledger' | 'run-marker';

export interface ProcessNote {
  readonly pid: number;
  readonly ppid: number;
  /** Start key (bigint as decimal string) in the scan's clock. */
  readonly start: string | null;
  readonly commandLine: string;
}

export interface ProcessLeak extends ProcessNote {
  readonly attribution: Attribution;
}

export interface DbDelta {
  readonly table: string;
  readonly before: number;
  readonly after: number;
}

export interface LeakDiff {
  /** New orc-test- directories; certain only when `concurrentRuns` is empty (decided by the caller). */
  readonly dirs: readonly TempDirEntry[];
  readonly ownedProcesses: readonly ProcessLeak[];
  /** New fake-claude processes that cannot be proven to belong to this run: reported, never killed. */
  readonly unattributedProcesses: readonly ProcessNote[];
  readonly db: readonly DbDelta[];
  /** Vitest processes outside this run's process tree seen in either snapshot. */
  readonly concurrentRuns: readonly number[];
  /** A scan that failed is listed here and is NEVER treated as clean. */
  readonly scanUnavailable: readonly string[];
}

export interface TreeInspection {
  /** False when the walk hit a limit or an unreadable/unexpected entry: such a tree is never removed. */
  readonly complete: boolean;
  readonly entries: number;
  readonly links: readonly string[];
  readonly repos: readonly string[];
  /** `.git` pointer files (linked worktrees, submodules) whose target is outside the temp root or unreadable. */
  readonly externalGitdirs: readonly string[];
}

export interface GitDetails {
  readonly repo: string;
  /** Local `orc/task-*` branches. */
  readonly branches: readonly string[];
  /** Linked worktrees (the main worktree excluded). */
  readonly worktrees: readonly string[];
  readonly error: string | null;
}

export interface DirLeakReport {
  readonly path: string;
  readonly inspection: TreeInspection;
  readonly git: readonly GitDetails[];
}

export interface ReapSkip {
  readonly item: string;
  readonly reason: string;
}

export interface ReapOutcome {
  readonly removedDirs: readonly string[];
  readonly killedPids: readonly number[];
  readonly skipped: readonly ReapSkip[];
}

const RunIdSchema = z.uuid();

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createLedgerContext(options: {
  readonly runId: string;
  readonly rootPid: number;
}): Promise<LedgerContext> {
  const runId = RunIdSchema.parse(options.runId);
  const rootPid = z.number().int().positive().parse(options.rootPid);
  const tmpRoot = await realpath(tmpdir());
  const paths = new Set<string>([FAKE_CLAUDE_PATH]);
  try {
    paths.add(await realpath(FAKE_CLAUDE_PATH));
  } catch {
    // The lexical path alone (the fixture is part of the repository; a missing file only narrows matching).
  }
  return { runId, rootPid, tmpRoot, platform: process.platform, fakeClaudePaths: [...paths] };
}

// ---- directories ----------------------------------------------------------------------------------------------

/** `<listed prefix><6 mkdtemp characters>`, a single path segment. */
export function isLeakDirName(name: string): boolean {
  if (/[\\/:\0]/.test(name) || name.trim() !== name) return false;
  return LEAK_DIR_PREFIXES.some(
    (prefix) => name.startsWith(prefix) && MKDTEMP_SUFFIX.test(name.slice(prefix.length)),
  );
}

/** `name` pinned below `root` with resolveWithin; null unless it is a leak-dir name and a DIRECT child of root. */
export function pinLeakDir(root: string, name: string): string | null {
  if (!isLeakDirName(name)) return null;
  let resolved: string;
  try {
    resolved = resolveWithin(root, name);
  } catch {
    return null;
  }
  return path.dirname(resolved) === path.resolve(root) && path.basename(resolved) === name
    ? resolved
    : null;
}

/** True when `target` (absolute) lies inside `root`, checked with resolveWithin. */
export function isInsideRoot(root: string, target: string): boolean {
  if (!path.isAbsolute(target)) return false;
  const relative = path.relative(root, target);
  if (relative === '') return true;
  try {
    resolveWithin(root, relative);
    return true;
  } catch {
    return false;
  }
}

async function lstatOrNull(target: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(target, { bigint: true });
  } catch {
    return null;
  }
}

/** Real (non-link) orc-test- directories directly below `tmpRoot`. */
export async function scanTempDirs(tmpRoot: string): Promise<DirScan> {
  let names: string[];
  try {
    names = await readdir(tmpRoot);
  } catch (error) {
    return { ok: false, reason: `temp root is not readable: ${errorText(error)}` };
  }
  const dirs: TempDirEntry[] = [];
  for (const name of names) {
    const dir = pinLeakDir(tmpRoot, name);
    if (dir === null) continue;
    const info = await lstatOrNull(dir);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) continue;
    dirs.push({ name, path: dir, ino: info.ino.toString() });
  }
  return { ok: true, dirs };
}

// ---- processes ------------------------------------------------------------------------------------------------

function normalizeWindows(text: string): string {
  return text.replaceAll('/', '\\').toLowerCase();
}

/** `needle` occurs in `line` as a whole token (bounded by start/end, whitespace or quotes). */
function containsToken(line: string, needle: string): boolean {
  if (needle === '') return false;
  for (let from = 0; ;) {
    const at = line.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : line.charAt(at - 1);
    const after = line.charAt(at + needle.length);
    if (WINDOWS_TOKEN_BOUNDARY.has(before) && WINDOWS_TOKEN_BOUNDARY.has(after)) return true;
    from = at + 1;
  }
}

/** Linux: an argv element equals one of `paths`; Windows: the command line contains one of them as a token. */
export function carriesPath(
  entry: Pick<ProcessEntry, 'argv' | 'commandLine'>,
  paths: readonly string[],
  platform: NodeJS.Platform,
): boolean {
  if (entry.argv !== null) return entry.argv.some((arg) => paths.includes(arg));
  if (platform !== 'win32') return false;
  const line = normalizeWindows(entry.commandLine);
  return paths.some((p) => containsToken(line, normalizeWindows(p)));
}

function startedNotAfter(parent: ProcessEntry, child: ProcessEntry): boolean {
  return parent.start !== null && child.start !== null && parent.start <= child.start;
}

/** Whether the live parent chain of `entry` reaches `rootPid` (each parent started no later than its child). */
function liveChainReaches(
  entry: ProcessEntry,
  table: ReadonlyMap<number, ProcessEntry>,
  rootPid: number,
): { reached: boolean; last: ProcessEntry } {
  let child = entry;
  for (let hop = 0; hop < MAX_CHAIN_HOPS; hop += 1) {
    if (child.ppid === rootPid) {
      const root = table.get(rootPid);
      return { reached: root !== undefined && startedNotAfter(root, child), last: child };
    }
    const parent = table.get(child.ppid);
    if (!parent || parent.pid === child.pid || !startedNotAfter(parent, child))
      return { reached: false, last: child };
    child = parent;
  }
  return { reached: false, last: child };
}

/**
 * Windows only: `entry`'s parent PID belonged to a recorded worker of this run (whose own parent is `rootPid`) and
 * `entry` started inside the window in which that worker was alive. A PID is held by one live process at a time,
 * so within that window the worker was the only process the parent PID can denote.
 */
function viaWorkerLedger(
  entry: ProcessEntry,
  table: ReadonlyMap<number, ProcessEntry>,
  clock: StartClock,
  rootPid: number,
  workers: readonly WorkerRecord[],
): boolean {
  const start = entry.start;
  const root = table.get(rootPid);
  if (clock !== 'epoch-us' || start === null || !root || !startedNotAfter(root, entry))
    return false;
  return workers.some(
    (w) =>
      w.pid === entry.ppid &&
      w.ppid === rootPid &&
      w.endedAtMs !== null &&
      BigInt(w.startedAtMs) * 1000n <= start &&
      start <= BigInt(w.endedAtMs) * 1000n,
  );
}

/** How `candidate` is proven to belong to the run rooted at `rootPid`; null when it cannot be proven. */
export function attributeProcess(
  candidate: MarkedProcess,
  table: ReadonlyMap<number, ProcessEntry>,
  clock: StartClock,
  rootPid: number,
  workers: readonly WorkerRecord[],
): Attribution | null {
  const chain = liveChainReaches(candidate, table, rootPid);
  if (chain.reached) return 'chain';
  if (viaWorkerLedger(chain.last, table, clock, rootPid, workers)) return 'worker-ledger';
  if (candidate.runMarker === true) return 'run-marker';
  return null;
}

/** rootPid and its live ancestors (never candidates, never killed). */
export function lineageOf(table: ReadonlyMap<number, ProcessEntry>, rootPid: number): Set<number> {
  const lineage = new Set<number>([rootPid]);
  let current = table.get(rootPid);
  for (let hop = 0; current && hop < MAX_CHAIN_HOPS; hop += 1) {
    const parent = table.get(current.ppid);
    if (!parent || parent.pid === current.pid || !startedNotAfter(parent, current)) break;
    lineage.add(parent.pid);
    current = parent;
  }
  return lineage;
}

/** Vitest processes that are neither this run's root, its ancestors nor its descendants. */
export function foreignVitestPids(
  table: ReadonlyMap<number, ProcessEntry>,
  rootPid: number,
): number[] {
  const lineage = lineageOf(table, rootPid);
  const foreign: number[] = [];
  for (const entry of table.values()) {
    if (lineage.has(entry.pid) || entry.defunct || !VITEST_ENTRY.test(entry.commandLine)) continue;
    if (liveChainReaches(entry, table, rootPid).reached) continue;
    foreign.push(entry.pid);
  }
  return foreign.sort((a, b) => a - b);
}

function tableOf(processes: readonly ProcessEntry[]): Map<number, ProcessEntry> {
  return new Map(processes.map((p) => [p.pid, p]));
}

function identity(entry: ProcessEntry): string {
  return `${entry.pid}@${entry.start === null ? '?' : entry.start.toString()}`;
}

function note(entry: ProcessEntry): ProcessNote {
  return {
    pid: entry.pid,
    ppid: entry.ppid,
    start: entry.start === null ? null : entry.start.toString(),
    commandLine: entry.commandLine,
  };
}

async function markCandidates(ctx: LedgerContext, scan: ProcessScan): Promise<MarkedScan> {
  if (!scan.ok) return scan;
  const processes = await Promise.all(
    scan.processes.map(async (entry): Promise<MarkedProcess> => {
      const candidate = !entry.defunct && carriesPath(entry, ctx.fakeClaudePaths, ctx.platform);
      const runMarker = candidate
        ? await readEnvMarker(entry.pid, RUN_ID_ENV, ctx.runId, ctx.platform)
        : null;
      return { ...entry, runMarker };
    }),
  );
  return { ok: true, clock: scan.clock, processes };
}

// ---- snapshot and diff ------------------------------------------------------------------------------------------

export async function takeSnapshot(
  ctx: LedgerContext,
  options: { readonly db?: () => Promise<DbScan> } = {},
): Promise<LeakSnapshot> {
  const [dirs, scan] = await Promise.all([
    scanTempDirs(ctx.tmpRoot),
    scanProcessTable(ctx.platform),
  ]);
  const processes = await markCandidates(ctx, scan);
  const db = options.db ? await options.db() : null;
  return { takenAt: new Date().toISOString(), dirs, processes, db };
}

function dirKey(ctx: LedgerContext, dir: string): string {
  return ctx.platform === 'win32' ? dir.toLowerCase() : dir;
}

function diffDirs(
  ctx: LedgerContext,
  before: DirScan,
  after: DirScan,
  unavailable: string[],
): TempDirEntry[] {
  if (!before.ok) unavailable.push(`temp dirs (before): ${before.reason}`);
  if (!after.ok) unavailable.push(`temp dirs (after): ${after.reason}`);
  if (!before.ok || !after.ok) return [];
  const known = new Map(before.dirs.map((d) => [dirKey(ctx, d.path), d.ino]));
  return after.dirs.filter(
    (d) => known.get(dirKey(ctx, d.path)) !== d.ino && pinLeakDir(ctx.tmpRoot, d.name) === d.path,
  );
}

function diffDb(before: DbScan | null, after: DbScan | null, unavailable: string[]): DbDelta[] {
  if (before === null && after === null) return [];
  if (!before?.ok) unavailable.push(`database (before): ${before ? before.reason : 'not counted'}`);
  if (!after?.ok) unavailable.push(`database (after): ${after ? after.reason : 'not counted'}`);
  if (!before?.ok || !after?.ok) return [];
  const initial = new Map(before.counts.map((c) => [c.table, c.rows]));
  const deltas: DbDelta[] = [];
  for (const count of after.counts) {
    const was = initial.get(count.table) ?? 0;
    if (count.rows !== was) deltas.push({ table: count.table, before: was, after: count.rows });
  }
  return deltas;
}

/** Pure: what appeared between `before` and `after` and what of it is provably this run's. */
export function diffSnapshots(
  ctx: LedgerContext,
  before: LeakSnapshot,
  after: LeakSnapshot,
  workers: readonly WorkerRecord[],
): LeakDiff {
  const unavailable: string[] = [];
  const dirs = diffDirs(ctx, before.dirs, after.dirs, unavailable);
  const owned: ProcessLeak[] = [];
  const unattributed: ProcessNote[] = [];
  const concurrent = new Set<number>();
  if (!before.processes.ok) unavailable.push(`processes (before): ${before.processes.reason}`);
  if (!after.processes.ok) unavailable.push(`processes (after): ${after.processes.reason}`);
  if (before.processes.ok) {
    for (const pid of foreignVitestPids(tableOf(before.processes.processes), ctx.rootPid))
      concurrent.add(pid);
  }
  if (after.processes.ok) {
    const table = tableOf(after.processes.processes);
    for (const pid of foreignVitestPids(table, ctx.rootPid)) concurrent.add(pid);
    if (before.processes.ok) {
      const existed = new Set(before.processes.processes.map(identity));
      const lineage = lineageOf(table, ctx.rootPid);
      for (const entry of after.processes.processes) {
        if (entry.defunct || lineage.has(entry.pid) || existed.has(identity(entry))) continue;
        if (!carriesPath(entry, ctx.fakeClaudePaths, ctx.platform)) continue;
        const attribution = attributeProcess(
          entry,
          table,
          after.processes.clock,
          ctx.rootPid,
          workers,
        );
        if (attribution === null) unattributed.push(note(entry));
        else owned.push({ ...note(entry), attribution });
      }
    }
  }
  return {
    dirs,
    ownedProcesses: owned,
    unattributedProcesses: unattributed,
    db: diffDb(before.db, after.db, unavailable),
    concurrentRuns: [...concurrent].sort((a, b) => a - b),
    scanUnavailable: unavailable,
  };
}

// ---- tree inspection and git details ----------------------------------------------------------------------------

/** Target of a `.git` pointer file (`gitdir: <path>`), canonical when it exists; null when unreadable. */
async function readGitdirPointer(file: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  if (text.length > MAX_GITDIR_POINTER_BYTES) return null;
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  const raw = match?.[1];
  if (raw === undefined || raw === '') return null;
  const target = path.resolve(path.dirname(file), raw);
  try {
    return await realpath(target);
  } catch {
    return target;
  }
}

/** Walks `dir` without following links (bounded); links and foreign git pointers make a tree unremovable. */
export async function inspectTree(ctx: LedgerContext, dir: string): Promise<TreeInspection> {
  const links: string[] = [];
  const repos: string[] = [];
  const external: string[] = [];
  let entries = 0;
  let complete = true;
  const pending: Array<{ readonly dir: string; readonly depth: number }> = [{ dir, depth: 0 }];
  walk: for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    let children: Dirent[];
    try {
      children = await readdir(next.dir, { withFileTypes: true });
    } catch {
      complete = false;
      continue;
    }
    for (const child of children) {
      entries += 1;
      if (entries > MAX_TREE_ENTRIES) {
        complete = false;
        break walk;
      }
      const full = path.join(next.dir, child.name);
      if (child.isSymbolicLink()) {
        links.push(full);
      } else if (child.isDirectory()) {
        if (child.name === '.git' && repos.length < MAX_REPOS_PER_DIR) repos.push(next.dir);
        if (next.depth + 1 > MAX_TREE_DEPTH) complete = false;
        else pending.push({ dir: full, depth: next.depth + 1 });
      } else if (child.isFile()) {
        if (child.name === '.git') {
          const target = await readGitdirPointer(full);
          if (target === null || !isInsideRoot(ctx.tmpRoot, target)) external.push(target ?? full);
        }
      } else if (!child.isFIFO() && !child.isSocket()) {
        complete = false;
      }
    }
  }
  return { complete, entries, links, repos, externalGitdirs: external };
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP'] as const) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  };
}

/** Read-only git query inside a leaked temp repository (argv array, shell: false, isolated config). */
function runGit(
  cwd: string,
  args: readonly string[],
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', 'safe.directory=*', '-C', cwd, ...args], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: gitEnv(),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, stdout: Buffer.concat(out).toString('utf8') });
      else
        resolve({
          ok: false,
          error: `git ${args[0] ?? ''} exited with ${String(code)}: ${Buffer.concat(err).toString('utf8').trim()}`,
        });
    });
  });
}

export async function describeRepo(repo: string): Promise<GitDetails> {
  const [refs, worktrees] = await Promise.all([
    runGit(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads/orc/']),
    runGit(repo, ['worktree', 'list', '--porcelain']),
  ]);
  const errors = [refs, worktrees].flatMap((r) => (r.ok ? [] : [r.error]));
  const branches = refs.ok
    ? refs.stdout
        .split(/\r?\n/)
        .map((line) => /^refs\/heads\/(orc\/task-\S+)$/.exec(line.trim())?.[1])
        .filter((name): name is string => name !== undefined)
    : [];
  const listed = worktrees.ok
    ? worktrees.stdout
        .split(/\r?\n/)
        .map((line) => /^worktree (.+)$/.exec(line)?.[1])
        .filter((p): p is string => p !== undefined)
        .map((p) => path.resolve(p))
    : [];
  return {
    repo,
    branches,
    worktrees: listed.slice(1),
    error: errors.length > 0 ? errors.join('; ') : null,
  };
}

/** Tree inspection plus the orc/task-* branches and linked worktrees of every repository found in each dir. */
export async function describeDirLeaks(
  ctx: LedgerContext,
  dirs: readonly TempDirEntry[],
): Promise<DirLeakReport[]> {
  const reports: DirLeakReport[] = [];
  for (const dir of dirs) {
    const inspection = await inspectTree(ctx, dir.path);
    const git: GitDetails[] = [];
    for (const repo of inspection.repos) git.push(await describeRepo(repo));
    reports.push({ path: dir.path, inspection, git });
  }
  return reports;
}

// ---- reap (ORC_TEST_REAP=1 only) --------------------------------------------------------------------------------

/**
 * Removes the given leaked directories, each only if it is still the same real directory (same inode, not a link)
 * pinned below the temp root with an orc-test- name, and its full walk found no link and no git pointer leading
 * outside the temp root. The caller passes only entries of this run's diff.
 */
export async function reapDirs(
  ctx: LedgerContext,
  dirs: readonly TempDirEntry[],
): Promise<ReapOutcome> {
  const removed: string[] = [];
  const skipped: ReapSkip[] = [];
  for (const dir of dirs) {
    const pinned = pinLeakDir(ctx.tmpRoot, dir.name);
    if (pinned === null || pinned !== dir.path) {
      skipped.push({
        item: dir.path,
        reason: 'not a listed-prefix temp directory directly below the temp root',
      });
      continue;
    }
    const info = await lstatOrNull(pinned);
    if (!info) {
      skipped.push({ item: pinned, reason: 'already gone' });
      continue;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      skipped.push({ item: pinned, reason: 'not a real directory' });
      continue;
    }
    if (info.ino.toString() !== dir.ino) {
      skipped.push({ item: pinned, reason: 'replaced since it was detected' });
      continue;
    }
    const tree = await inspectTree(ctx, pinned);
    if (!tree.complete) {
      skipped.push({ item: pinned, reason: 'tree walk incomplete' });
      continue;
    }
    if (tree.links.length > 0) {
      skipped.push({ item: pinned, reason: `contains ${tree.links.length} link(s)` });
      continue;
    }
    if (tree.externalGitdirs.length > 0) {
      skipped.push({ item: pinned, reason: 'git pointer outside the temp root' });
      continue;
    }
    try {
      await rm(pinned, REMOVE_OPTIONS);
      removed.push(pinned);
    } catch (error) {
      skipped.push({ item: pinned, reason: `removal failed: ${errorText(error)}` });
    }
  }
  return { removedDirs: removed, killedPids: [], skipped };
}

function errnoCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

/** Skip reasons of {@link killVerifiedProcesses} that mean "the target process no longer exists". */
export const SKIP_EXITED = 'already exited';
export const SKIP_REPLACED = 'no longer the same fake-claude process';

/** Extra condition of {@link killVerifiedProcesses}, evaluated on the fresh process table. */
export type KillCondition = (
  entry: MarkedProcess,
  table: ReadonlyMap<number, ProcessEntry>,
  clock: StartClock,
) => boolean;

/**
 * Kills each target only if a FRESH process table still shows the same process: same PID and same start time,
 * running, carrying the fake-claude path, outside this run's lineage, and accepted by `condition`. Only that single
 * process is killed (never a tree: its other descendants do not carry the fake-claude path). A target that has
 * exited, or whose PID now belongs to another process, is skipped with SKIP_EXITED / SKIP_REPLACED.
 */
export async function killVerifiedProcesses(
  ctx: LedgerContext,
  targets: readonly ProcessNote[],
  condition: KillCondition = () => true,
): Promise<ReapOutcome> {
  if (targets.length === 0) return { removedDirs: [], killedPids: [], skipped: [] };
  const fresh = await markCandidates(ctx, await scanProcessTable(ctx.platform));
  if (!fresh.ok) {
    return {
      removedDirs: [],
      killedPids: [],
      skipped: targets.map((t) => ({
        item: `pid ${t.pid}`,
        reason: `re-verification scan unavailable: ${fresh.reason}`,
      })),
    };
  }
  const table = tableOf(fresh.processes);
  const lineage = lineageOf(table, ctx.rootPid);
  const killed: number[] = [];
  const skipped: ReapSkip[] = [];
  for (const target of targets) {
    const item = `pid ${target.pid}`;
    const now = fresh.processes.find((p) => p.pid === target.pid);
    if (!now || now.defunct) {
      skipped.push({ item, reason: SKIP_EXITED });
      continue;
    }
    const sameProcess = now.start !== null && now.start.toString() === target.start;
    if (
      !sameProcess ||
      lineage.has(now.pid) ||
      !carriesPath(now, ctx.fakeClaudePaths, ctx.platform)
    ) {
      skipped.push({ item, reason: SKIP_REPLACED });
      continue;
    }
    if (!condition(now, table, fresh.clock)) {
      skipped.push({ item, reason: 'no longer attributable to this run' });
      continue;
    }
    try {
      process.kill(now.pid, 'SIGKILL');
    } catch (error) {
      if (errnoCode(error) !== 'ESRCH') {
        skipped.push({ item, reason: `kill failed: ${errorText(error)}` });
        continue;
      }
    }
    try {
      await waitForProcessExit(now.pid, { timeoutMs: KILL_WAIT_MS });
      killed.push(now.pid);
    } catch {
      skipped.push({ item, reason: 'still alive after SIGKILL' });
    }
  }
  return { removedDirs: [], killedPids: killed, skipped };
}

/** The current identity (PID, start time, command line) of `pid` if it runs fake-claude; null otherwise. */
export async function describeFakeClaude(
  ctx: LedgerContext,
  pid: number,
): Promise<ProcessNote | null> {
  const scan = await scanProcessTable(ctx.platform);
  if (!scan.ok) return null;
  const entry = scan.processes.find((p) => p.pid === pid);
  if (!entry || entry.defunct || entry.start === null) return null;
  return carriesPath(entry, ctx.fakeClaudePaths, ctx.platform) ? note(entry) : null;
}

/** ORC_TEST_REAP=1: kills this run's attributed fake-claude processes, each re-verified and re-attributed. */
export async function reapProcesses(
  ctx: LedgerContext,
  leaks: readonly ProcessLeak[],
  workers: readonly WorkerRecord[],
): Promise<ReapOutcome> {
  return killVerifiedProcesses(
    ctx,
    leaks,
    (entry, table, clock) => attributeProcess(entry, table, clock, ctx.rootPid, workers) !== null,
  );
}
