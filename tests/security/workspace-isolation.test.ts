// Requirements §15 "workspace isolation" (contract §10.4, §11, §18.5): two tasks of one project run
// through the real worker pipeline (fake-claude, local launcher). Each Claude process runs in its own
// worktree, gets allow rules scoped to that worktree only, the platform deny rules, a per-attempt MCP
// config/cache and allowed root, never references the other task's worktree, and the source
// repository is never modified. The OS-level part (per-lease uid, 0700 dirs) is proven by
// sandbox-escape (static) and `npm run test:compose` (dynamic); the real-CLI permission boundary by
// the release gate `npm run test:claude-live -- permission-boundary`.
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLATFORM_DISALLOWED_RULES, computeToolPolicy, UnsafeArgumentError } from '@orc/security';
import type { AttemptRecord, TaskRecord } from '@orc/database';
import { resetDb } from '../helpers/database/db';
import { hashTree } from '../helpers/git/fixtures';
import { createWorkerWorld, writeDirective } from '../helpers/worker/world';
import type { WorkerWorld } from '../helpers/worker/world';

interface RunView {
  task: TaskRecord;
  attempt: AttemptRecord;
  worktree: string;
  argv: string[];
  envNames: string[];
  hasApiKey: boolean;
  initCwd: string;
}

const norm = (p: string): string => {
  const s = p.replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};

function valuesOf(argv: readonly string[], flag: string): string[] {
  const i = argv.indexOf(flag);
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < argv.length && !(argv[j] ?? '').startsWith('--'); j += 1) out.push(argv[j] ?? '');
  return out;
}

let world: WorkerWorld;
let repoDir: string;
let sourceBefore: Map<string, string>;
const runs: RunView[] = [];

async function inspect(taskId: string, attemptId: string): Promise<RunView> {
  const task = await world.db.repos.tasks.findById(taskId);
  const attempt = await world.db.repos.attempts.findById(attemptId);
  if (task === null || attempt === null || attempt.workspaceId === null) throw new Error('missing rows');
  const ws = await world.db.repos.workspaces.findById(attempt.workspaceId);
  if (ws === null) throw new Error('missing workspace');
  const logs = await world.db.repos.taskLogs.listByAttempt({ attemptId, stream: 'claude', limit: 1000 });
  let argv: string[] = [];
  let envNames: string[] = [];
  let hasApiKey = false;
  let initCwd = '';
  for (const line of logs.map((l) => l.content).join('').split('\n')) {
    if (!line.startsWith('{')) continue;
    const ev = JSON.parse(line) as { type?: string; subtype?: string; argv?: string[]; names?: string[]; hasApiKey?: boolean; cwd?: string };
    if (ev.subtype === 'fake_argv') argv = ev.argv ?? [];
    if (ev.subtype === 'fake_env') {
      envNames = ev.names ?? [];
      hasApiKey = ev.hasApiKey === true;
    }
    if (ev.type === 'system' && ev.subtype === 'init') initCwd = ev.cwd ?? '';
  }
  return { task, attempt, worktree: path.join(world.workspacesRoot, ...ws.path.split('/')), argv, envNames, hasApiKey, initCwd };
}

beforeAll(async () => {
  world = await createWorkerWorld();
  await world.startWorker({ workerId: 'sec-isolation-1' });
  const repo = world.repo();
  repoDir = repo.dir;
  sourceBefore = hashTree(repo.dir);
  const project = await world.project(repo);
  const created = [];
  for (const tag of ['one', 'two']) {
    created.push(
      await world.createTask(project, {
        directives: [
          '@@fake echo-argv',
          '@@fake echo-env',
          writeDirective(`src/${tag}.js`, `export const ${tag} = 1;\n`),
          `@@fake text wrote ${tag}`,
        ],
      }),
    );
  }
  for (const c of created) {
    const settled = await world.waitSettled(c.task.id, 120_000);
    expect(settled.status).toBe('completed');
    runs.push(await inspect(c.task.id, c.attempt.id));
  }
}, 240_000);

afterAll(async () => {
  await world?.dispose();
  await resetDb();
});

describe('workspace isolation through the worker pipeline', () => {
  it('gives each attempt its own worktree under WORKSPACES_ROOT/<project>/<task>/a<n>', () => {
    const [a, b] = runs as [RunView, RunView];
    for (const r of runs) {
      expect(norm(r.worktree).startsWith(`${norm(world.workspacesRoot)}/${r.task.projectId}/${r.task.id}/a`)).toBe(true);
      expect(r.attempt.branchName).toMatch(/^orc\/task-[0-9a-f]+-a1$/);
    }
    expect(norm(a.worktree)).not.toBe(norm(b.worktree));
    expect(a.attempt.branchName).not.toBe(b.attempt.branchName);
  });

  it('starts Claude with cwd = its worktree', () => {
    for (const r of runs) {
      expect(r.initCwd).not.toBe('');
      expect(norm(realpathSync.native(r.initCwd))).toBe(norm(realpathSync.native(r.worktree)));
    }
  });

  it('scopes file-tool allow rules to the own worktree and never names another task', () => {
    const [a, b] = runs as [RunView, RunView];
    for (const [self, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const allowed = valuesOf(self.argv, '--allowed-tools');
      expect(allowed.length).toBeGreaterThan(0);
      for (const rule of allowed) {
        if (rule.startsWith('mcp__')) continue;
        expect(rule).toMatch(/^(Read|Edit)\(\/\/.+\/\*\*\)$/);
        expect(rule).toContain(`${self.task.id}/a1/**`);
      }
      // Bare file-tool names would allow the tool on every path.
      for (const bare of ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']) expect(allowed).not.toContain(bare);
      expect(self.argv.join('\n')).not.toContain(other.task.id);
    }
  });

  it('passes the platform deny rules and denies the shared roots', () => {
    for (const r of runs) {
      const denied = valuesOf(r.argv, '--disallowed-tools');
      // Rules with <ROOT> placeholders are emitted with the absolute roots substituted (checked below).
      for (const rule of PLATFORM_DISALLOWED_RULES.filter((x) => !x.includes('<'))) expect(denied).toContain(rule);
      expect(denied.length).toBeGreaterThanOrEqual(PLATFORM_DISALLOWED_RULES.length);
      expect(denied.join('\n')).not.toContain('<');
      const joined = denied.join('\n');
      for (const needle of ['.repos/**', '.orc/**', 'Edit(//']) expect(joined).toContain(needle);
      for (const root of [world.projectsRoot, world.claudeHomeRoot, world.cbmCacheDir]) {
        const tail = norm(root).split('/').slice(-2).join('/');
        expect(norm(joined)).toContain(tail);
      }
      expect(valuesOf(r.argv, '--permission-mode')).toEqual(['dontAsk']);
    }
  });

  it('uses a per-attempt MCP config outside the worktree', () => {
    for (const r of runs) {
      const [mcpConfig] = valuesOf(r.argv, '--mcp-config');
      expect(mcpConfig).toBeDefined();
      expect(norm(mcpConfig ?? '')).toContain(`/${r.task.id}/a1.meta/`);
      expect(norm(mcpConfig ?? '').startsWith(`${norm(r.worktree)}/`)).toBe(false);
    }
  });

  it('gives Claude only allowlisted environment variable names (no DB/Redis/session secrets)', () => {
    for (const r of runs) {
      expect(r.envNames.length).toBeGreaterThan(0);
      for (const name of r.envNames) {
        expect(name).not.toMatch(/^(DB_|REDIS_|MSSQL_|SESSION_|npm_|NODE_OPTIONS$)|_FILE$|PASSWORD|EGRESS_PROXY_TOKEN/i);
      }
      expect(r.envNames).toEqual(expect.arrayContaining(['HOME', 'CLAUDE_CONFIG_DIR', 'CBM_ALLOWED_ROOT', 'ORC_ATTEMPT_ID']));
      expect(r.hasApiKey).toBe(true);
    }
  });

  it('keeps each task\'s changes in its own worktree and leaves the source repository untouched', () => {
    const [a, b] = runs as [RunView, RunView];
    expect(existsSync(path.join(a.worktree, 'src', 'one.js')) || a.attempt.filesChanged === 1).toBe(true);
    expect(existsSync(path.join(a.worktree, 'src', 'two.js'))).toBe(false);
    expect(existsSync(path.join(b.worktree, 'src', 'one.js'))).toBe(false);
    expect(hashTree(repoDir)).toEqual(sourceBefore);
  });
});

describe('tool policy confinement (computeToolPolicy)', () => {
  const opts = {
    mcpEnabled: true,
    workspacesRoot: '/srv/orc/workspaces',
    projectsRoot: '/srv/orc/projects',
    claudeHomeRoot: '/srv/orc/claude-home',
    cbmCacheRoot: '/srv/orc/cbm-cache',
    worktreePath: '/srv/orc/workspaces/p1/t1/a1',
  };

  it('refuses a worktree outside WORKSPACES_ROOT and roots with glob characters or dot segments', () => {
    const agent = { allowedTools: ['Read', 'Edit'], disallowedTools: [] };
    for (const worktreePath of ['/srv/orc/projects/acme/app', '/srv/orc/workspaces/../projects/x', '/etc']) {
      expect(() => computeToolPolicy(agent, { ...opts, worktreePath }), worktreePath).toThrow(UnsafeArgumentError);
    }
    for (const workspacesRoot of ['/srv/orc/work*', '/srv/orc/{a,b}', '/srv/orc/./ws']) {
      expect(() =>
        computeToolPolicy(agent, { ...opts, workspacesRoot, worktreePath: `${workspacesRoot}/p1/t1/a1` }),
      ).toThrow(UnsafeArgumentError);
    }
  });

  it('emits worktree-scoped allow rules only', () => {
    const p = computeToolPolicy({ allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'], disallowedTools: [] }, opts);
    expect(p.allowedRules).toEqual([
      'Read(//srv/orc/workspaces/p1/t1/a1/**)',
      'Edit(//srv/orc/workspaces/p1/t1/a1/**)',
      'mcp__codebase-memory-mcp',
    ]);
    expect(p.builtinTools).not.toContain('Bash');
    for (const rule of [
      'Read(//srv/orc/workspaces/.repos/**)',
      'Edit(//srv/orc/workspaces/.orc/**)',
      'Read(//srv/orc/projects/**)',
      'Read(//srv/orc/claude-home/**)',
      'Read(//srv/orc/cbm-cache/**)',
      'Edit(//srv/orc/workspaces/p1/t1/a1/.git/**)',
    ]) {
      expect(p.disallowedRules).toContain(rule);
    }
  });
});
