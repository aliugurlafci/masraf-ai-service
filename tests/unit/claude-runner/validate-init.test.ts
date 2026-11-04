import { describe, expect, it } from 'vitest';
import {
  CLAUDE_INTERNAL_TOOL_NAMES,
  validateInit,
  type ValidateInitExpectations,
} from '@orc/claude-runner';
import type { ClaudeInitEvent } from '@orc/shared';

const CWD_POSIX = '/srv/workspaces/p/t/wt';
const SESSION = '3f1c2b6a-1d2e-4f5a-9b8c-7d6e5f4a3b2c';
const BUILTINS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];

/**
 * `init.tools` / `init.mcp_servers` recorded from the real CLI 2.1.316 (offline: no API key,
 * network blocked) with the §10.2 argv, `--tools Read,Edit,Write,Glob,Grep`, without and with
 * `--mcp-config` (codebase-memory-mcp connected). cwd/session replaced by test values.
 */
const RECORDED_2_1_316_NO_MCP: ClaudeInitEvent = {
  type: 'system',
  subtype: 'init',
  cwd: CWD_POSIX,
  session_id: SESSION,
  tools: ['Edit', 'Read'],
  mcp_servers: [],
  model: 'claude-sonnet-4-5',
  permissionMode: 'dontAsk',
  apiKeySource: 'none',
  claude_code_version: '2.1.316',
  output_style: 'default',
};

const RECORDED_2_1_316_MCP: ClaudeInitEvent = {
  ...RECORDED_2_1_316_NO_MCP,
  tools: [
    'Edit',
    'Read',
    'mcp__codebase-memory-mcp__check_index_coverage',
    'mcp__codebase-memory-mcp__compare_graphs',
    'mcp__codebase-memory-mcp__delete_project',
    'mcp__codebase-memory-mcp__detect_changes',
    'mcp__codebase-memory-mcp__get_architecture',
    'mcp__codebase-memory-mcp__get_code_snippet',
    'mcp__codebase-memory-mcp__get_file_outline',
    'mcp__codebase-memory-mcp__get_graph_schema',
    'mcp__codebase-memory-mcp__index_repository',
    'mcp__codebase-memory-mcp__index_status',
    'mcp__codebase-memory-mcp__ingest_traces',
    'mcp__codebase-memory-mcp__list_projects',
    'mcp__codebase-memory-mcp__manage_adr',
    'mcp__codebase-memory-mcp__query_graph',
    'mcp__codebase-memory-mcp__search_code',
    'mcp__codebase-memory-mcp__search_graph',
    'mcp__codebase-memory-mcp__trace_path',
  ],
  mcp_servers: [{ name: 'codebase-memory-mcp', status: 'connected', source: 'dynamic' }],
};

function expectations(over: Partial<ValidateInitExpectations> = {}): ValidateInitExpectations {
  return {
    permissionMode: 'dontAsk',
    cwd: CWD_POSIX,
    sessionId: SESSION,
    builtinTools: BUILTINS,
    extraTools: [...CLAUDE_INTERNAL_TOOL_NAMES],
    mcpEnabled: false,
    platform: 'posix',
    ...over,
  };
}

describe('validateInit (§10.6)', () => {
  it('accepts both recorded inits of the pinned CLI', () => {
    expect(validateInit(RECORDED_2_1_316_NO_MCP, expectations())).toEqual({
      ok: true,
      violations: [],
      mcpConnected: false,
    });
    expect(validateInit(RECORDED_2_1_316_MCP, expectations({ mcpEnabled: true }))).toEqual({
      ok: true,
      violations: [],
      mcpConnected: true,
    });
  });

  it.each([
    ['WebFetch'],
    ['Task'],
    ['Agent'],
    ['NotebookEdit'],
    ['Bash'],
    ['mcp__other-server__tool'],
    ['ToolSearch'],
  ])('rejects each recorded init with one added foreign tool %s', (tool) => {
    for (const [init, mcpEnabled] of [
      [RECORDED_2_1_316_NO_MCP, false],
      [RECORDED_2_1_316_MCP, true],
    ] as const) {
      const v = validateInit({ ...init, tools: [...init.tools, tool] }, expectations({ mcpEnabled }));
      expect(v.ok).toBe(false);
      expect(v.violations.map((x) => x.rule)).toEqual(['tool']);
      expect(v.violations[0]?.detail).toContain(tool);
    }
  });

  it('admits CLAUDE_INIT_EXTRA_TOOLS and Bash only when they are expected', () => {
    const init = { ...RECORDED_2_1_316_NO_MCP, tools: ['Read', 'ToolSearch'] };
    expect(validateInit(init, expectations()).ok).toBe(false);
    expect(validateInit(init, expectations({ extraTools: ['ToolSearch'] })).ok).toBe(true);
    const bash = { ...RECORDED_2_1_316_NO_MCP, tools: ['Read', 'Bash'] };
    expect(validateInit(bash, expectations({ builtinTools: [...BUILTINS, 'Bash'] })).ok).toBe(true);
  });

  it('MCP tools and resource tools are allowed only when MCP is enabled', () => {
    const withResources = {
      ...RECORDED_2_1_316_MCP,
      tools: [...RECORDED_2_1_316_MCP.tools, 'ListMcpResourcesTool', 'ReadMcpResourceTool'],
    };
    expect(validateInit(withResources, expectations({ mcpEnabled: true })).ok).toBe(true);
    const v = validateInit({ ...withResources, mcp_servers: [] }, expectations({ mcpEnabled: false }));
    expect(v.ok).toBe(false);
    expect(v.violations.map((x) => x.rule)).toEqual(['tool']);
  });

  it('an extra MCP server is a security violation (mcp_server)', () => {
    const init = {
      ...RECORDED_2_1_316_MCP,
      mcp_servers: [...RECORDED_2_1_316_MCP.mcp_servers, { name: 'evil-server', status: 'connected' }],
    };
    const v = validateInit(init, expectations({ mcpEnabled: true }));
    expect(v.ok).toBe(false);
    expect(v.violations).toHaveLength(1);
    expect(v.violations[0]?.rule).toBe('mcp_server');
    expect(v.violations[0]?.detail).toContain('evil-server');
  });

  it('any MCP server is a violation when MCP is disabled', () => {
    const v = validateInit(
      { ...RECORDED_2_1_316_NO_MCP, mcp_servers: [{ name: 'codebase-memory-mcp', status: 'connected' }] },
      expectations({ mcpEnabled: false }),
    );
    expect(v.violations.map((x) => x.rule)).toEqual(['mcp_server']);
  });

  it('a non-connected codebase-memory-mcp is only a warning', () => {
    const v = validateInit(
      { ...RECORDED_2_1_316_NO_MCP, mcp_servers: [{ name: 'codebase-memory-mcp', status: 'failed' }] },
      expectations({ mcpEnabled: true }),
    );
    expect(v).toEqual({ ok: true, violations: [], mcpConnected: false });
  });

  it('checks permission mode, cwd and session id', () => {
    const v = validateInit(
      {
        ...RECORDED_2_1_316_NO_MCP,
        permissionMode: 'bypassPermissions',
        cwd: '/srv/workspaces/p/other/wt',
        session_id: '00000000-0000-4000-8000-000000000000',
      },
      expectations(),
    );
    expect(v.violations.map((x) => x.rule)).toEqual(['permission_mode', 'cwd', 'session_id']);
    expect(v.violations[0]?.detail).toContain('bypassPermissions');
  });

  it('skips the session check for resumed (forked) sessions', () => {
    const init = { ...RECORDED_2_1_316_NO_MCP, session_id: 'new-fork-id' };
    expect(validateInit(init, expectations({ sessionId: null })).ok).toBe(true);
  });

  it('compares cwd after resolution; case-insensitive on win32 only', () => {
    expect(validateInit({ ...RECORDED_2_1_316_NO_MCP, cwd: `${CWD_POSIX}/` }, expectations()).ok).toBe(true);
    expect(validateInit({ ...RECORDED_2_1_316_NO_MCP, cwd: `${CWD_POSIX}/../wt` }, expectations()).ok).toBe(true);
    expect(validateInit({ ...RECORDED_2_1_316_NO_MCP, cwd: CWD_POSIX.toUpperCase() }, expectations()).ok).toBe(false);
    const win = 'C:\\orc\\workspaces\\p\\t\\wt';
    expect(
      validateInit(
        { ...RECORDED_2_1_316_NO_MCP, cwd: 'c:\\ORC\\workspaces\\p\\t\\wt' },
        expectations({ cwd: win, platform: 'win32' }),
      ).ok,
    ).toBe(true);
    expect(
      validateInit(
        { ...RECORDED_2_1_316_NO_MCP, cwd: 'C:\\orc\\workspaces\\p\\t2\\wt' },
        expectations({ cwd: win, platform: 'win32' }),
      ).violations.map((x) => x.rule),
    ).toEqual(['cwd']);
  });

  it('masks secrets that appear in violation details', () => {
    const v = validateInit(
      { ...RECORDED_2_1_316_NO_MCP, tools: ['Read', 'sk-ant-api03-SECRETTOOLNAME0000000000000'] },
      expectations(),
    );
    expect(v.violations[0]?.detail).not.toContain('SECRETTOOLNAME');
  });
});
