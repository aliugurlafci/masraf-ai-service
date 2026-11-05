// Init event fail-closed validation against fake-claude (contract §10.6, §18.3, §18.5 "init fail-closed").
import { describe, expect, it } from 'vitest';
import type { InitRule } from '@orc/claude-runner';
import { isProcessAlive } from '../../helpers/common';
import { FAKE_CLI_VERSION, fakeAuth, hostPlatform, makeRunRequest, recordingHandlers } from '../../helpers/claude/fake-claude';
import { useRunnerEnv } from '../../helpers/claude/integration';

const env = useRunnerEnv();

describe('claude-runner init validation with fake-claude (integration)', () => {
  it.each<[string, string, InitRule, string[]]>([
    ['unexpected MCP server', '@@fake init-mcp-extra evil-server', 'mcp_server', ['evil-server']],
    ['unexpected tool', '@@fake init-tool-extra WebFetch', 'tool', ['WebFetch']],
    ['wrong permission mode', '@@fake init-permission-mode bypassPermissions', 'permission_mode', ['bypassPermissions']],
    ['foreign cwd', '@@fake init-cwd /somewhere/else', 'cwd', ['/somewhere/else']],
    // ADR-0036 Decision 5 rules. Details name only the offending value, never a credential.
    ['a requested builtin missing from the init', '@@fake init-tool-missing Read', 'tool_missing', ['requested builtin tool(s) missing from init', 'Read']],
    ['an unexpected plugin', '@@fake init-extension plugin evil-plugin', 'extension', ['unexpected plugins:', 'evil-plugin']],
    ['an unexpected skill', '@@fake init-extension skill evil-skill', 'extension', ['unexpected skills:', 'evil-skill']],
    ['an unexpected agent', '@@fake init-extension agent evil-agent', 'extension', ['unexpected agents:', 'evil-agent']],
    ['an unexpected slash command', '@@fake init-extension slash evil-command', 'extension', ['unexpected slash_commands:', 'evil-command']],
    ['a memory path in the init', '@@fake init-memory-path /somewhere/memory', 'memory', ['memory_paths must be absent, null or empty (got ', '/somewhere/memory']],
    ['an API key source in oauth mode', '@@fake init-api-key-source ANTHROPIC_API_KEY', 'auth_source', ['apiKeySource="ANTHROPIC_API_KEY" (expected "none" in oauth mode)']],
  ])('%s => security_violation, immediate forced kill, nothing after init is processed', async (_n, directive, rule, needles) => {
    const e = env();
    const { handlers, rec } = recordingHandlers();
    const res = await e.runner().run(
      makeRunRequest(e.layout, {
        lease: e.lease,
        directives: [directive, '@@fake delay-ms 300', '@@fake spawn-grandchild', '@@fake text after-init', '@@fake hang'],
      }),
      handlers,
    );
    e.trackPids(rec.spawn?.pid, ...rec.fakePids);
    expect(res.outcome).toBe('security_violation');
    expect(res.violation?.rule).toBe(rule);
    for (const needle of needles) expect(res.violation?.detail).toContain(needle);
    expect(rec.inits).toHaveLength(1);
    expect(rec.inits[0]?.validation.ok).toBe(false);
    expect(res.kill).toMatchObject({ forced: true, survivors: [] });
    expect(rec.lines.some((l) => l.parsed.kind === 'assistant')).toBe(false);
    expect(res.result).toBeNull();
    expect(isProcessAlive(rec.spawn?.pid ?? 0)).toBe(false);
  });

  it('missing init within the init timeout => init_timeout and the process is killed', async () => {
    const e = env();
    const { handlers, rec } = recordingHandlers();
    const res = await e
      .runner({ initTimeoutMs: 1_500 })
      .run(makeRunRequest(e.layout, { lease: e.lease, directives: ['@@fake no-init', '@@fake hang'] }), handlers);
    e.trackPids(rec.spawn?.pid);
    expect(res.outcome).toBe('init_timeout');
    expect(rec.inits).toHaveLength(0);
    expect(res.kill?.survivors).toEqual([]);
    expect(isProcessAlive(rec.spawn?.pid ?? 0)).toBe(false);
  });

  it('api_key mode: an apiKeySource of none => auth_source violation', async () => {
    const e = env();
    const { handlers, rec } = recordingHandlers();
    const res = await e
      .runner({ auth: fakeAuth('api_key') })
      .run(
        makeRunRequest(e.layout, {
          lease: e.lease,
          directives: ['@@fake init-api-key-source none', '@@fake delay-ms 300', '@@fake text after-init', '@@fake hang'],
        }),
        handlers,
      );
    e.trackPids(rec.spawn?.pid);
    expect(res.outcome).toBe('security_violation');
    expect(res.violation?.rule).toBe('auth_source');
    expect(res.violation?.detail).toContain('apiKeySource="none" (expected "ANTHROPIC_API_KEY" in api_key mode)');
    expect(res.kill).toMatchObject({ forced: true, survivors: [] });
    expect(rec.lines.some((l) => l.parsed.kind === 'assistant')).toBe(false);
  });

  it('a hook lifecycle event after init => hook_event violation and forced kill', async () => {
    const e = env();
    const { handlers, rec } = recordingHandlers();
    const res = await e.runner().run(
      makeRunRequest(e.layout, {
        lease: e.lease,
        directives: ['@@fake hook-event', '@@fake delay-ms 300', '@@fake spawn-grandchild', '@@fake text after-hook', '@@fake hang'],
      }),
      handlers,
    );
    e.trackPids(rec.spawn?.pid, ...rec.fakePids);
    expect(res.outcome).toBe('security_violation');
    expect(res.violation?.rule).toBe('hook_event');
    expect(res.violation?.detail).toContain('hook event "hook_started" (hooks are disabled)');
    expect(rec.inits[0]?.validation.ok).toBe(true);
    expect(res.kill).toMatchObject({ forced: true, survivors: [] });
    expect(rec.lines.some((l) => l.parsed.kind === 'assistant')).toBe(false);
    expect(res.result).toBeNull();
  });

  it('a CLI version without a reviewed extension entry => extension violation naming the key', async () => {
    const e = env();
    const { handlers, rec } = recordingHandlers();
    const res = await e
      .runner({ reviewedExtensions: {} })
      .run(makeRunRequest(e.layout, { lease: e.lease, directives: ['@@fake delay-ms 300', '@@fake text after-init', '@@fake hang'] }), handlers);
    e.trackPids(rec.spawn?.pid);
    expect(res.outcome).toBe('security_violation');
    expect(res.violation?.rule).toBe('extension');
    expect(res.violation?.detail).toContain(`no reviewed extension entry for "${FAKE_CLI_VERSION}/${hostPlatform}/oauth" (CLAUDE_REVIEWED_EXTENSIONS)`);
    expect(rec.lines.some((l) => l.parsed.kind === 'assistant')).toBe(false);
  });
});
