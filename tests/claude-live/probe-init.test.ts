// claude-live (opt-in, CLAUDE_LIVE=1): CLI probe and init validation against the INSTALLED Claude Code CLI
// (contract §10.2, §10.9, §10.3, §18.1). The init test plants decoys a real CLI would pick up if the isolation
// failed: a project `.mcp.json` with an extra server and a project `.claude/settings.json` whose SessionStart hook
// writes a marker file. The run must report exactly the allow-listed MCP server, emit no hook event, never execute
// the hook and pass `validateInit`. Without ANTHROPIC_API_KEY this is a non-bare dev-mode run in the isolated
// per-workspace config dir: it is not logged in, so it ends with a synthetic error result after init (no tokens).
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CBM_MCP_SERVER_NAME, CLAUDE_PERMISSION_MODE, requiredClaudeFlags } from '@orc/claude-runner';
import { SESSION_ID, recordingHandlers } from '../helpers/claude/fake-claude';
import { HAS_API_KEY, createLiveEnv } from './live-env';
import type { LiveEnv } from './live-env';

let env: LiveEnv | null = null;

afterEach(async () => {
  const current = env;
  env = null;
  if (current) expect((await current.close()).alive, 'claude processes alive after the test').toEqual([]);
});

describe('claude-live: probe', () => {
  it('the installed CLI supports every flag and permission mode the runner emits', async () => {
    env = await createLiveEnv();
    const probe = await env.runner.probe();
    expect(probe.missingFlags).toEqual([]);
    expect(probe.ok).toBe(true);
    expect(probe.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(probe.permissionModes).toContain(CLAUDE_PERMISSION_MODE);
    expect(requiredClaudeFlags(env.bare).length).toBeGreaterThan(0);
  });
});

describe('claude-live: init validation and isolation', () => {
  it('reports only the allow-listed MCP server, loads no project/user hooks and passes validateInit', async () => {
    env = await createLiveEnv();
    const { layout } = env;
    const marker = path.join(env.dir.path, 'hook-ran.marker');
    await env.writeMcpConfig();
    await writeFile(
      path.join(layout.worktree, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'decoy-mcp': { type: 'stdio', command: process.execPath, args: ['-e', 'setInterval(()=>{},1e6)'] } } }),
    );
    await mkdir(path.join(layout.worktree, '.claude'), { recursive: true });
    const hookCommand = `"${process.execPath}" -e "require('fs').writeFileSync(${JSON.stringify(marker.replaceAll('\\', '/'))},'x')"`;
    await writeFile(
      path.join(layout.worktree, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hookCommand }] }] },
        enableAllProjectMcpServers: true,
      }),
    );

    const { handlers, rec } = recordingHandlers();
    const result = await env.runner.run(
      env.request({ prompt: 'Reply with the single word OK and do nothing else.', mcp: true, maxBudgetUsd: 0.05 }),
      handlers,
    );

    expect(rec.inits).toHaveLength(1);
    const { init, validation } = rec.inits[0] ?? { init: null, validation: null };
    expect(validation?.violations).toEqual([]);
    expect(validation?.ok).toBe(true);
    expect(validation?.mcpConnected).toBe(true);
    expect(init?.mcp_servers.map((s) => s.name)).toEqual([CBM_MCP_SERVER_NAME]);
    expect(init?.mcp_servers[0]?.status).toBe('connected');
    expect(init?.permissionMode).toBe(CLAUDE_PERMISSION_MODE);
    expect(init?.session_id).toBe(SESSION_ID);
    expect(realpathSync(init?.cwd ?? '')).toBe(realpathSync(layout.worktree));
    expect(rec.lines.filter((l) => l.parsed.kind === 'hook')).toEqual([]);
    expect(existsSync(marker)).toBe(false);

    // the spawned environment is the isolated per-workspace one (§10.3)
    const spawned = env.launcher.launches[0]?.spec.env ?? {};
    expect(spawned['CLAUDE_CONFIG_DIR']).toBe(path.join(layout.claudeHomeRoot, 'w', '33333333-4444-4555-8666-777777777777', 'config'));
    expect(spawned['HOME']).toBe(path.join(layout.claudeHomeRoot, 'w', '33333333-4444-4555-8666-777777777777', 'home'));
    expect('ANTHROPIC_API_KEY' in spawned).toBe(HAS_API_KEY);

    expect(result.violation).toBeNull();
    // with a key the tiny run succeeds; without one the isolated dev-mode CLI is not logged in
    expect(result.outcome).toBe(HAS_API_KEY ? 'success' : 'result_error');
    expect(result.init?.session_id).toBe(SESSION_ID);
  });
});
