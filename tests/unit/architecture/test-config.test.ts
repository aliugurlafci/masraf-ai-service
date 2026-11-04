// Contract §18.1 / §18.5 ("real Claude only on explicit command"): the standard `test` script and
// the Vitest projects never include claude-live unless CLAUDE_LIVE=1, and `test:claude-live` is the
// only path that sets it; selecting claude-live without it throws (§18.1). §18.2: every infrastructure project
// registers tests/setup/global-infra.ts and runs its files serially. Static checks plus re-evaluation of
// vitest.config.ts; nothing is spawned and no infrastructure is touched.
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STANDARD_PROJECTS, selectProjects } from '../../helpers/common/test-report';
import claudeLiveGuardSetup, {
  CLAUDE_LIVE_OPT_IN_MESSAGE,
  assertClaudeLiveOptIn,
  requestedProjectFilters,
  requestsClaudeLive,
} from '../../setup/claude-live-guard';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLAUDE_LIVE_TEST = 'tests/claude-live/permission-boundary.test.ts';
const GLOBAL_INFRA = 'tests/setup/global-infra.ts';
const CLAUDE_LIVE_GUARD = 'tests/setup/claude-live-guard.ts';
/** Projects that need MSSQL/Redis test infrastructure (§18.1 "Infra" column) and run files serially. */
const INFRA_PROJECTS = ['integration', 'api', 'security', 'e2e'] as const;
/** Cold evaluation of vitest.config.ts (plugin-react, vite) can exceed the 5 s default on a busy host. */
const CONFIG_TIMEOUT_MS = 60_000;

interface InlineProject {
  name: string;
  include: string[];
  globalSetup: string[];
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
async function importConfig(claudeLive: string | undefined, argv: readonly string[]): Promise<unknown> {
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
    if (!projectTest || typeof projectTest.name !== 'string' || !Array.isArray(projectTest.include)) {
      throw new Error('vitest.config.ts: every project must be inline with test.name and test.include');
    }
    return {
      name: projectTest.name,
      include: projectTest.include.map(String),
      globalSetup: toStringList(projectTest.globalSetup),
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
  ])('throws a clear opt-in error when %j selects claude-live without CLAUDE_LIVE=1', async (...argv) => {
    for (const value of [undefined, '0', 'true']) {
      await expect(importConfig(value, argv)).rejects.toThrow(CLAUDE_LIVE_OPT_IN_MESSAGE);
    }
    const projects = await loadProjects('1', argv);
    expect(projects.map((p) => p.name)).toContain('claude-live');
  });

  it('claude-live runs the opt-in guard before the infrastructure setup', async () => {
    const projects = await loadProjects('1');
    expect(projects.find((p) => p.name === 'claude-live')?.globalSetup).toEqual([
      CLAUDE_LIVE_GUARD,
      GLOBAL_INFRA,
    ]);
  });
});

describe('claude-live guard module', () => {
  it('parses --project filters in both CLI spellings', () => {
    expect(requestedProjectFilters(['run', '--project', 'unit', '--project=web', '--reporter=dot'])).toEqual([
      'unit',
      'web',
    ]);
    expect(requestedProjectFilters(['run', '--project'])).toEqual([]);
  });

  it('matches claude-live exactly or through wildcards, never through other names or negations', () => {
    for (const argv of [['--project', 'claude-live'], ['--project=*'], ['--project', 'claude-*']]) {
      expect(requestsClaudeLive(argv), argv.join(' ')).toBe(true);
    }
    for (const argv of [[], ['--project', 'unit'], ['--project', '!claude-live'], ['--project', 'claude']]) {
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
  it('integration, api, security and e2e register global-infra and run files serially', async () => {
    const projects = await loadProjects(undefined);
    for (const name of INFRA_PROJECTS) {
      const project = projects.find((p) => p.name === name);
      expect(project?.globalSetup, name).toEqual([GLOBAL_INFRA]);
      expect(project?.fileParallelism, name).toBe(false);
    }
    const live = (await loadProjects('1')).find((p) => p.name === 'claude-live');
    expect(live?.globalSetup).toContain(GLOBAL_INFRA);
  });

  it('unit and web need no infrastructure and keep file parallelism', async () => {
    const projects = await loadProjects(undefined);
    for (const name of ['unit', 'web']) {
      const project = projects.find((p) => p.name === name);
      expect(project?.globalSetup, name).toEqual([]);
      expect(project?.fileParallelism, name).toBeUndefined();
    }
  });
});
