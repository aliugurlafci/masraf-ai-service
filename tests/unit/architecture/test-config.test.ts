// Contract §18.1 / §18.5 ("real Claude only on explicit command"): the standard `test` script and
// the Vitest projects never include claude-live unless CLAUDE_LIVE=1, and `test:claude-live` is the
// only path that sets it; selecting claude-live without it throws (§18.1). §18.2: every infrastructure project
// registers tests/setup/global-infra.ts followed by the B-005 leak guard (tests/setup/global-teardown.ts) and the
// leak-worker setupFile, and runs its files serially. The leak guard's selection rules are checked here as pure
// functions on fabricated snapshots. Static checks plus re-evaluation of vitest.config.ts; nothing is spawned and no
// infrastructure is touched.
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STANDARD_PROJECTS, selectProjects } from '../../helpers/common/test-report';
import claudeLiveGuardSetup, {
  CLAUDE_LIVE_OPT_IN_MESSAGE,
  assertClaudeLiveOptIn,
  requestedProjectFilters,
  requestsClaudeLive,
} from '../../setup/claude-live-guard';
import { gateFails, readLeakFlags, statusOf } from '../../setup/global-teardown';
import { assertCountableDatabase } from '../../setup/leak-db';
import type { DbScan } from '../../setup/leak-db';
import {
  attributeProcess,
  carriesPath,
  diffSnapshots,
  foreignVitestPids,
  isInsideRoot,
  isLeakDirName,
  pinLeakDir,
} from '../../setup/leak-ledger';
import type {
  LeakSnapshot,
  LedgerContext,
  MarkedProcess,
  TempDirEntry,
} from '../../setup/leak-ledger';
import type { WorkerRecord } from '../../setup/leak-worker-record';
import {
  POWERSHELL_ARGS,
  WINDOWS_PROCESS_SCAN_SCRIPT,
  parseProcStat,
  parseWindowsProcessJson,
  windowsTicksToEpochUs,
} from '../../setup/process-table';
import type { StartClock } from '../../setup/process-table';
import { testEnvDefaults } from '../../setup/test-env';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLAUDE_LIVE_TEST = 'tests/claude-live/permission-boundary.test.ts';
const GLOBAL_INFRA = 'tests/setup/global-infra.ts';
const LEAK_GUARD = 'tests/setup/global-teardown.ts';
const LEAK_WORKER = 'tests/setup/leak-worker.ts';
const CLAUDE_LIVE_GUARD = 'tests/setup/claude-live-guard.ts';
/** Projects that need MSSQL/Redis test infrastructure (§18.1 "Infra" column) and run files serially. */
const INFRA_PROJECTS = ['integration', 'api', 'security', 'e2e'] as const;
/** Cold evaluation of vitest.config.ts (plugin-react, vite) can exceed the 5 s default on a busy host. */
const CONFIG_TIMEOUT_MS = 60_000;

interface InlineProject {
  name: string;
  include: string[];
  globalSetup: string[];
  setupFiles: string[];
  fileParallelism: boolean | undefined;
}

function readScripts(): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  return manifest.scripts;
}

function projectsOf(script: string): string[] {
  return [...script.matchAll(/--project[= ](\S+)/g)].map((m) => m[1] ?? '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toStringList(value: unknown): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

/** Imports vitest.config.ts afresh with the given CLAUDE_LIVE value (undefined = unset) and command line. */
async function importConfig(
  claudeLive: string | undefined,
  argv: readonly string[],
): Promise<unknown> {
  vi.stubEnv('CLAUDE_LIVE', claudeLive);
  vi.resetModules();
  const savedArgv = process.argv;
  process.argv = [savedArgv[0] ?? process.execPath, 'vitest', ...argv];
  try {
    return await import('../../../vitest.config');
  } finally {
    process.argv = savedArgv;
  }
}

/** Evaluates vitest.config.ts afresh with the given CLAUDE_LIVE value and project filters. */
async function loadProjects(
  claudeLive: string | undefined,
  argv: readonly string[] = ['run'],
): Promise<InlineProject[]> {
  const mod = await importConfig(claudeLive, argv);
  const config = isRecord(mod) && isRecord(mod.default) ? mod.default : undefined;
  const test = config && isRecord(config.test) ? config.test : undefined;
  const projects = test?.projects;
  if (!Array.isArray(projects)) throw new Error('vitest.config.ts: test.projects is not an array');
  return projects.map((project: unknown) => {
    const projectTest = isRecord(project) && isRecord(project.test) ? project.test : undefined;
    if (
      !projectTest ||
      typeof projectTest.name !== 'string' ||
      !Array.isArray(projectTest.include)
    ) {
      throw new Error(
        'vitest.config.ts: every project must be inline with test.name and test.include',
      );
    }
    return {
      name: projectTest.name,
      include: projectTest.include.map(String),
      globalSetup: toStringList(projectTest.globalSetup),
      setupFiles: toStringList(projectTest.setupFiles),
      fileParallelism:
        typeof projectTest.fileParallelism === 'boolean' ? projectTest.fileParallelism : undefined,
    };
  });
}

function matchingProjects(projects: InlineProject[], file: string): string[] {
  return projects
    .filter((p) => p.include.some((pattern) => posix.matchesGlob(file, pattern)))
    .map((p) => p.name);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('package.json test scripts', () => {
  it('`test` runs exactly the standard projects and never claude-live', () => {
    const scripts = readScripts();
    const test = scripts.test ?? '';
    expect(test).toMatch(/^vitest run /);
    expect(projectsOf(test)).toEqual([...STANDARD_PROJECTS]);
    expect(test).not.toContain('claude-live');
    expect(test).not.toContain('CLAUDE_LIVE');
  });

  it('only test:claude-live reaches claude-live; no other script sets CLAUDE_LIVE', () => {
    const scripts = readScripts();
    expect(scripts['test:claude-live']).toBe('node scripts/run-claude-live.mjs');
    for (const [name, command] of Object.entries(scripts)) {
      if (name === 'test:claude-live') continue;
      expect(command, name).not.toContain('claude-live');
      expect(command, name).not.toContain('CLAUDE_LIVE');
    }
    for (const project of STANDARD_PROJECTS) {
      expect(projectsOf(scripts[`test:${project}`] ?? '')).toEqual([project]);
    }
  });

  it('test:report runs standard projects only', () => {
    expect(STANDARD_PROJECTS).not.toContain('claude-live');
    expect(() => selectProjects(['claude-live'])).toThrow(/non-standard project "claude-live"/);
  });

  it('scripts/run-claude-live.mjs sets CLAUDE_LIVE=1 and selects only the claude-live project', () => {
    const source = readFileSync(join(ROOT, 'scripts/run-claude-live.mjs'), 'utf8');
    expect(source).toMatch(/CLAUDE_LIVE:\s*'1'/);
    expect(source).toMatch(/'run',\s*'--project',\s*'claude-live'/);
    expect(source).toContain('shell: false');
  });
});

describe('vitest.config.ts claude-live guard', { timeout: CONFIG_TIMEOUT_MS }, () => {
  it.each([undefined, '', '0', 'true', 'yes', ' 1'])(
    'excludes claude-live when CLAUDE_LIVE=%j',
    async (value) => {
      const projects = await loadProjects(value);
      expect(projects.map((p) => p.name)).toEqual([...STANDARD_PROJECTS]);
      expect(matchingProjects(projects, CLAUDE_LIVE_TEST)).toEqual([]);
    },
  );

  it('adds the serial claude-live project only when CLAUDE_LIVE=1', async () => {
    const projects = await loadProjects('1');
    expect(projects.map((p) => p.name)).toEqual([...STANDARD_PROJECTS, 'claude-live']);
    const live = projects.find((p) => p.name === 'claude-live');
    expect(live?.include).toEqual(['tests/claude-live/**/*.test.ts']);
    expect(live?.fileParallelism).toBe(false);
    expect(matchingProjects(projects, CLAUDE_LIVE_TEST)).toEqual(['claude-live']);
  });

  it('standard project globs never pick up claude-live tests', async () => {
    const projects = await loadProjects('1');
    const standard = projects.filter((p) => p.name !== 'claude-live');
    expect(matchingProjects(standard, CLAUDE_LIVE_TEST)).toEqual([]);
    expect(matchingProjects(standard, 'tests/unit/architecture/test-config.test.ts')).toEqual([
      'unit',
    ]);
  });

  it.each([
    ['run', '--project', 'claude-live'],
    ['run', '--project=claude-live'],
    ['run', '--project', 'unit', '--project', 'claude*'],
  ])(
    'throws a clear opt-in error when %j selects claude-live without CLAUDE_LIVE=1',
    async (...argv) => {
      for (const value of [undefined, '0', 'true']) {
        await expect(importConfig(value, argv)).rejects.toThrow(CLAUDE_LIVE_OPT_IN_MESSAGE);
      }
      const projects = await loadProjects('1', argv);
      expect(projects.map((p) => p.name)).toContain('claude-live');
    },
  );

  it('claude-live runs the opt-in guard before the infrastructure setup and the leak guard', async () => {
    const projects = await loadProjects('1');
    const live = projects.find((p) => p.name === 'claude-live');
    expect(live?.globalSetup).toEqual([CLAUDE_LIVE_GUARD, GLOBAL_INFRA, LEAK_GUARD]);
    expect(live?.setupFiles).toEqual([LEAK_WORKER]);
  });
});

describe('claude-live guard module', () => {
  it('parses --project filters in both CLI spellings', () => {
    expect(
      requestedProjectFilters(['run', '--project', 'unit', '--project=web', '--reporter=dot']),
    ).toEqual(['unit', 'web']);
    expect(requestedProjectFilters(['run', '--project'])).toEqual([]);
  });

  it('matches claude-live exactly or through wildcards, never through other names or negations', () => {
    for (const argv of [['--project', 'claude-live'], ['--project=*'], ['--project', 'claude-*']]) {
      expect(requestsClaudeLive(argv), argv.join(' ')).toBe(true);
    }
    for (const argv of [
      [],
      ['--project', 'unit'],
      ['--project', '!claude-live'],
      ['--project', 'claude'],
    ]) {
      expect(requestsClaudeLive(argv), argv.join(' ')).toBe(false);
    }
  });

  it('accepts only CLAUDE_LIVE=1', () => {
    const argv = ['run', '--project', 'claude-live'];
    expect(() => assertClaudeLiveOptIn(argv, { CLAUDE_LIVE: '1' })).not.toThrow();
    expect(() => assertClaudeLiveOptIn(argv, {})).toThrow(/npm run test:claude-live/);
    expect(() => assertClaudeLiveOptIn(['run', '--project', 'unit'], {})).not.toThrow();
  });

  it('the globalSetup entry throws unless CLAUDE_LIVE=1', () => {
    vi.stubEnv('CLAUDE_LIVE', '0');
    expect(() => claudeLiveGuardSetup()).toThrow(CLAUDE_LIVE_OPT_IN_MESSAGE);
    vi.stubEnv('CLAUDE_LIVE', '1');
    expect(() => claudeLiveGuardSetup()).not.toThrow();
  });
});

describe('vitest.config.ts infrastructure projects (§18.2)', { timeout: CONFIG_TIMEOUT_MS }, () => {
  it('integration, api, security and e2e register global-infra, then the leak guard, and run files serially', async () => {
    const projects = await loadProjects(undefined);
    for (const name of INFRA_PROJECTS) {
      const project = projects.find((p) => p.name === name);
      // Order matters: the guard's snapshot follows the database reset; its teardown precedes the lock release.
      expect(project?.globalSetup, name).toEqual([GLOBAL_INFRA, LEAK_GUARD]);
      expect(project?.setupFiles, name).toEqual([LEAK_WORKER]);
      expect(project?.fileParallelism, name).toBe(false);
    }
    const live = (await loadProjects('1')).find((p) => p.name === 'claude-live');
    expect(live?.globalSetup).toContain(GLOBAL_INFRA);
    expect(live?.globalSetup).toContain(LEAK_GUARD);
  });

  it('unit and web need no infrastructure, have no leak guard and keep file parallelism', async () => {
    const projects = await loadProjects(undefined);
    for (const name of ['unit', 'web']) {
      const project = projects.find((p) => p.name === name);
      expect(project?.globalSetup, name).toEqual([]);
      expect(project?.setupFiles, name).not.toContain(LEAK_WORKER);
      expect(project?.fileParallelism, name).toBeUndefined();
    }
  });
});

// ---- B-005 leak guard: selection rules as pure functions on fabricated snapshots ----------------------------------

const TMP_ROOT = path.resolve(tmpdir());
const WIN_FAKE = 'C:\\repo\\tests\\fixtures\\fake-claude\\fake-claude.mjs';
const POSIX_FAKE = '/work/tests/fixtures/fake-claude/fake-claude.mjs';
const ROOT_PID = 100;
const RUN_ID = '0b6f2c1e-5d0a-4c8e-9a51-3f3a2b1c0d9e';

function ledgerCtx(platform: NodeJS.Platform = 'win32'): LedgerContext {
  return {
    runId: RUN_ID,
    rootPid: ROOT_PID,
    tmpRoot: TMP_ROOT,
    platform,
    fakeClaudePaths: [WIN_FAKE, POSIX_FAKE],
  };
}

function proc(
  pid: number,
  ppid: number,
  start: bigint | null,
  commandLine = 'node other.js',
): MarkedProcess {
  return { pid, ppid, start, commandLine, argv: null, defunct: false, runMarker: null };
}

function fake(pid: number, ppid: number, start: bigint | null): MarkedProcess {
  return proc(pid, ppid, start, `"C:\\Program Files\\nodejs\\node.exe" ${WIN_FAKE} -p`);
}

/** init (1) -> npm (50) -> vitest main (ROOT_PID) -> worker (200); present in every snapshot. */
const BASE: readonly MarkedProcess[] = [
  proc(1, 0, 1n, 'init'),
  proc(50, 1, 10n, 'npm run test:api'),
  proc(ROOT_PID, 50, 20n, 'node node_modules/vitest/vitest.mjs run'),
  proc(200, ROOT_PID, 30n, 'node node_modules/vitest/dist/workers/forks.js'),
];

function snap(
  processes: readonly MarkedProcess[],
  dirs: readonly TempDirEntry[] = [],
  clock: StartClock = 'epoch-us',
  db: DbScan | null = null,
): LeakSnapshot {
  return { takenAt: '', dirs: { ok: true, dirs }, processes: { ok: true, clock, processes }, db };
}

function tempEntry(name: string, ino = '1'): TempDirEntry {
  return { name, path: path.join(TMP_ROOT, name), ino };
}

function tableOf(processes: readonly MarkedProcess[]): Map<number, MarkedProcess> {
  return new Map(processes.map((p) => [p.pid, p]));
}

const NO_FINDINGS = {
  leaks: { dirs: [], processes: [], db: [] },
  warnings: { uncertainDirs: [], unattributedProcesses: [], concurrentRuns: [] },
  scanUnavailable: [],
};

describe('leak guard: directory selection (B-005)', () => {
  it('accepts only single-segment orc-test-<x> names pinned directly below the temp root', () => {
    expect(isLeakDirName('orc-test-abc123')).toBe(true);
    const bad = [
      'orc-test-',
      'orc-test-abcde',
      'orc-test-abcdefg',
      'orc-test-abc-12',
      'orc-testabc',
      'xorc-test-a',
      'orc-test-a/b',
      'orc-test-a\\b',
      'orc-test-a:b',
      ' orc-test-a',
      '..',
    ];
    for (const name of bad) {
      expect(isLeakDirName(name), name).toBe(false);
      expect(pinLeakDir(TMP_ROOT, name), name).toBeNull();
    }
    expect(pinLeakDir(TMP_ROOT, 'orc-test-abc123')).toBe(path.join(TMP_ROOT, 'orc-test-abc123'));
  });

  it('checks containment with resolveWithin (no sibling-prefix or parent escapes, no relative targets)', () => {
    expect(isInsideRoot(TMP_ROOT, path.join(TMP_ROOT, 'orc-test-a', '.git'))).toBe(true);
    expect(isInsideRoot(TMP_ROOT, `${TMP_ROOT}-evil${path.sep}x`)).toBe(false);
    expect(isInsideRoot(TMP_ROOT, path.dirname(TMP_ROOT))).toBe(false);
    expect(isInsideRoot(TMP_ROOT, 'relative/path')).toBe(false);
  });

  it('lists only directories that are new in this run (absent before, or recreated with another inode)', () => {
    const before = snap(BASE, [
      tempEntry('orc-test-oldAAA', '7'),
      tempEntry('orc-test-recr01', '8'),
    ]);
    const after = snap(BASE, [
      tempEntry('orc-test-oldAAA', '7'),
      tempEntry('orc-test-recr01', '9'),
      tempEntry('orc-test-newBBB', '10'),
      tempEntry('orc-wk-Ab3dE9', '13'),
      // A scan never yields these; the diff re-pins every entry anyway.
      { name: 'orc-other', path: path.join(TMP_ROOT, 'orc-other'), ino: '11' },
      { name: 'orc-test-xyz123', path: path.join(TMP_ROOT, 'nested', 'orc-test-xyz123'), ino: '12' },
      tempEntry('orc-cbm-rt-100000', '14'),
      tempEntry('orc-test-home', '15'),
    ]);
    const diff = diffSnapshots(ledgerCtx(), before, after, []);
    expect(diff.dirs.map((d) => d.name).sort()).toEqual([
      'orc-test-newBBB',
      'orc-test-recr01',
      'orc-wk-Ab3dE9',
    ]);
  });
});

describe('leak guard: process selection (B-005)', () => {
  it('matches the fake-claude path as a whole argv element (Linux) or command-line token (Windows)', () => {
    const paths = [WIN_FAKE, POSIX_FAKE];
    const linux = (argv: string[]): boolean =>
      carriesPath({ argv, commandLine: '' }, paths, 'linux');
    const win = (commandLine: string): boolean =>
      carriesPath({ argv: null, commandLine }, paths, 'win32');
    expect(linux(['node', POSIX_FAKE, '-p'])).toBe(true);
    expect(linux(['node', `${POSIX_FAKE}.bak`])).toBe(false);
    expect(linux(['node', 'tests/fixtures/fake-claude/fake-claude.mjs'])).toBe(false);
    expect(win(`node "${WIN_FAKE.toUpperCase()}" -p`)).toBe(true);
    expect(win(`node ${WIN_FAKE.replaceAll('\\', '/')} -p`)).toBe(true);
    expect(win(`node ${WIN_FAKE}.bak -p`)).toBe(false);
    expect(win(`node D:\\x${WIN_FAKE.slice(2)}`)).toBe(false);
  });

  it('attributes a new fake-claude whose live parent chain reaches the root', () => {
    const after = [
      ...BASE,
      proc(300, 200, 40n, 'node runner.js'),
      fake(301, 300, 41n),
      fake(302, 200, 42n),
    ];
    const diff = diffSnapshots(ledgerCtx(), snap(BASE), snap(after), []);
    expect(diff.ownedProcesses.map((p) => [p.pid, p.attribution])).toEqual([
      [301, 'chain'],
      [302, 'chain'],
    ]);
    expect(diff.unattributedProcesses).toEqual([]);
  });

  it('never links through a reused PID (a parent that started after its child)', () => {
    // 400 exited; its PID now belongs to an unrelated process started later than the fake-claude.
    const after = [...BASE, fake(401, 400, 50n), proc(400, 200, 60n, 'node reused.js')];
    const diff = diffSnapshots(ledgerCtx(), snap(BASE), snap(after), []);
    expect(diff.ownedProcesses).toEqual([]);
    expect(diff.unattributedProcesses.map((p) => p.pid)).toEqual([401]);
  });

  it('never attributes processes of another Vitest run and reports that run as concurrent', () => {
    const otherRun = proc(900, 1, 15n, 'node C:\\other\\node_modules\\vitest\\vitest.mjs run');
    const before = snap([...BASE, otherRun]);
    const after = snap([...BASE, otherRun, fake(901, 900, 45n)]);
    const diff = diffSnapshots(ledgerCtx(), before, after, []);
    expect(diff.ownedProcesses).toEqual([]);
    expect(diff.unattributedProcesses.map((p) => p.pid)).toEqual([901]);
    expect(diff.concurrentRuns).toEqual([900]);
    expect(foreignVitestPids(tableOf(BASE), ROOT_PID)).toEqual([]);
  });

  it('attributes an orphan through a recorded worker only inside the window the worker held its PID', () => {
    const worker = (
      startedAtMs: number,
      endedAtMs: number | null,
      ppid = ROOT_PID,
    ): WorkerRecord => ({
      pid: 250,
      ppid,
      startedAtMs,
      endedAtMs,
    });
    const orphan = fake(501, 250, 5_000_000n); // started at t = 5000 ms (epoch-us clock)
    const table = tableOf([...BASE, orphan]);
    const attribute = (workers: WorkerRecord[], clock: StartClock = 'epoch-us'): string | null =>
      attributeProcess(orphan, table, clock, ROOT_PID, workers);
    expect(attribute([worker(4000, 6000)])).toBe('worker-ledger');
    expect(attribute([worker(5001, 6000)])).toBeNull();
    expect(attribute([worker(4000, 4999)])).toBeNull();
    expect(attribute([worker(4000, null)])).toBeNull();
    expect(attribute([worker(4000, 6000, 999)])).toBeNull();
    expect(attribute([worker(4000, 6000)], 'boot-ticks')).toBeNull();
  });

  it('accepts the run marker only when it was read from the environment (Linux)', () => {
    const argv = ['node', POSIX_FAKE, '-p'];
    const marked: MarkedProcess = { ...proc(601, 1, 70n, argv.join(' ')), argv, runMarker: true };
    const unmarked: MarkedProcess = { ...proc(602, 1, 71n, argv.join(' ')), argv };
    const before = snap(BASE, [], 'boot-ticks');
    const after = snap([...BASE, marked, unmarked], [], 'boot-ticks');
    const diff = diffSnapshots(ledgerCtx('linux'), before, after, []);
    expect(diff.ownedProcesses.map((p) => [p.pid, p.attribution])).toEqual([[601, 'run-marker']]);
    expect(diff.unattributedProcesses.map((p) => p.pid)).toEqual([602]);
  });

  it('ignores pre-existing, defunct and path-less processes and the run lineage itself', () => {
    const old = fake(700, 200, 25n);
    const npmWithPath = proc(50, 1, 10n, `npm ${WIN_FAKE}`);
    const after = [
      ...BASE.filter((p) => p.pid !== 50),
      npmWithPath,
      old,
      { ...fake(701, 200, 80n), defunct: true },
      proc(702, 200, 81n, 'node something-else.mjs'),
    ];
    const diff = diffSnapshots(ledgerCtx(), snap([...BASE, old]), snap(after), []);
    expect(diff.ownedProcesses).toEqual([]);
    expect(diff.unattributedProcesses).toEqual([]);
  });

  it('a failed scan is reported as unavailable and never as clean', () => {
    const failed: LeakSnapshot = {
      takenAt: '',
      dirs: { ok: false, reason: 'EACCES' },
      processes: { ok: false, reason: 'PowerShell exited with 3' },
      db: { ok: false, reason: 'login failed' },
    };
    const ok = snap([...BASE, fake(801, 200, 90n)], [tempEntry('orc-test-zzz001')], 'epoch-us', {
      ok: true,
      counts: [],
    });
    for (const [before, after] of [
      [failed, ok],
      [ok, failed],
    ] as const) {
      const diff = diffSnapshots(ledgerCtx(), before, after, []);
      expect(diff.scanUnavailable).toHaveLength(3);
      expect(diff.dirs).toEqual([]);
      expect(diff.ownedProcesses).toEqual([]);
      const findings = { ...NO_FINDINGS, scanUnavailable: diff.scanUnavailable };
      expect(statusOf(findings)).toBe('scan-unavailable');
      expect(gateFails(findings)).toBe(true);
    }
  });
});

describe('leak guard: database, flags and process scan (B-005)', () => {
  it('reports per-table row deltas', () => {
    const counts = (tasks: number): DbScan => ({
      ok: true,
      counts: [
        { table: 'Teams', rows: 11 },
        { table: 'Tasks', rows: tasks },
      ],
    });
    const diff = diffSnapshots(
      ledgerCtx(),
      snap(BASE, [], 'epoch-us', counts(0)),
      snap(BASE, [], 'epoch-us', counts(2)),
      [],
    );
    expect(diff.db).toEqual([{ table: 'Tasks', before: 0, after: 2 }]);
  });

  it('counts rows only in a loopback *_test database', () => {
    const env = testEnvDefaults({});
    expect(assertCountableDatabase(env)).toBe('orchestrator_test');
    expect(() => assertCountableDatabase({ ...env, DB_NAME: 'orchestrator' })).toThrow();
    expect(() => assertCountableDatabase({ ...env, DB_HOST: '10.0.0.5' })).toThrow();
  });

  it('is report-only by default; only the exact value "1" enables reaping or the strict gate', () => {
    expect(readLeakFlags({})).toEqual({ reap: false, strict: false });
    expect(readLeakFlags({ ORC_TEST_REAP: 'true', ORC_TEST_LEAK_STRICT: 'yes' })).toEqual({
      reap: false,
      strict: false,
    });
    expect(readLeakFlags({ ORC_TEST_REAP: '1' })).toEqual({ reap: true, strict: false });
    expect(readLeakFlags({ ORC_TEST_LEAK_STRICT: '1' })).toEqual({ reap: false, strict: true });
  });

  it('warnings alone do not fail the strict gate; any leak does', () => {
    const warn = {
      ...NO_FINDINGS,
      warnings: {
        uncertainDirs: [],
        unattributedProcesses: [{ pid: 1, ppid: 0, start: null, commandLine: '' }],
        concurrentRuns: [9],
      },
    };
    expect(statusOf(NO_FINDINGS)).toBe('clean');
    expect(statusOf(warn)).toBe('warnings');
    expect(gateFails(warn)).toBe(false);
    const leak = {
      ...warn,
      leaks: { dirs: [], processes: [], db: [{ table: 'Tasks', before: 0, after: 1 }] },
    };
    expect(statusOf(leak)).toBe('leaks');
    expect(gateFails(leak)).toBe(true);
  });

  it('runs PowerShell only with the fixed argument vector and constant, single-quoted script text', () => {
    expect(POWERSHELL_ARGS).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_PROCESS_SCAN_SCRIPT,
    ]);
    expect(WINDOWS_PROCESS_SCAN_SCRIPT).not.toContain('"');
    expect(WINDOWS_PROCESS_SCAN_SCRIPT).not.toContain('${');
    expect(WINDOWS_PROCESS_SCAN_SCRIPT).toContain('Get-CimInstance -ClassName Win32_Process');
    const source = readFileSync(join(ROOT, 'tests/setup/process-table.ts'), 'utf8');
    const calls = [...source.matchAll(/\bspawn\('([^']+)', ([^,]+), \{\s*shell: false,/g)].map(
      (m) => [m[1], m[2]],
    );
    expect(calls).toEqual([['powershell.exe', '[...POWERSHELL_ARGS]']]);
  });

  it('parses the CIM rows (UTC ticks -> epoch microseconds) and rejects malformed output', () => {
    expect(windowsTicksToEpochUs(621_355_968_000_000_000n)).toBe(0n);
    const [row] = parseWindowsProcessJson(
      '[{"pid":4,"ppid":0,"created":"621355968000010000","cmd":null}]',
    );
    expect(row).toEqual({
      pid: 4,
      ppid: 0,
      start: 1000n,
      commandLine: '',
      argv: null,
      defunct: false,
    });
    expect(() => parseWindowsProcessJson('{"pid":4}')).toThrow();
    expect(() =>
      parseWindowsProcessJson('[{"pid":-1,"ppid":0,"created":null,"cmd":""}]'),
    ).toThrow();
  });

  it('parses /proc/<pid>/stat with a command name containing ") "', () => {
    const fields = ['S', '42', ...Array.from({ length: 17 }, () => '0'), '123456', '0'];
    expect(parseProcStat(`77 (evil) name) ${fields.join(' ')}`)).toEqual({
      state: 'S',
      ppid: 42,
      startTicks: 123456n,
    });
    expect(parseProcStat('garbage')).toBeNull();
  });
});
