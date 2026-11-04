// Init event fail-closed validation against fake-claude (contract §10.6, §18.3, §18.5 "init fail-closed").
import { describe, expect, it } from 'vitest';
import type { InitRule } from '@orc/claude-runner';
import { isProcessAlive } from '../../helpers/common';
import { makeRunRequest, recordingHandlers } from '../../helpers/claude/fake-claude';
import { useRunnerEnv } from '../../helpers/claude/integration';

const env = useRunnerEnv();

describe('claude-runner init validation with fake-claude (integration)', () => {
  it.each<[string, string, InitRule, string]>([
    ['unexpected MCP server', '@@fake init-mcp-extra evil-server', 'mcp_server', 'evil-server'],
    ['unexpected tool', '@@fake init-tool-extra WebFetch', 'tool', 'WebFetch'],
    ['wrong permission mode', '@@fake init-permission-mode bypassPermissions', 'permission_mode', 'bypassPermissions'],
    ['foreign cwd', '@@fake init-cwd /somewhere/else', 'cwd', '/somewhere/else'],
  ])('%s => security_violation, immediate forced kill, nothing after init is processed', async (_n, directive, rule, needle) => {
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
    expect(res.violation?.detail).toContain(needle);
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
});
