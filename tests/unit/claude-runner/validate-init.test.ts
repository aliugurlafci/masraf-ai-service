import { describe, expect, it } from 'vitest';
import {
  CLAUDE_INTERNAL_TOOL_NAMES,
  CLAUDE_REVIEWED_EXTENSIONS,
  claudeExtensionKey,
  validateInit,
  type ReviewedExtensionTable,
  type ValidateInitExpectations,
} from '@orc/claude-runner';
import type { ClaudeInitEvent } from '@orc/shared';

const CWD_POSIX = '/srv/workspaces/p/t/wt';
const SESSION = '3f1c2b6a-1d2e-4f5a-9b8c-7d6e5f4a3b2c';
const BUILTINS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];

// Init sets recorded from the real CLI offline (B-017 D2: fake credential, isolated HOME,
// CLAUDE_CONFIG_DIR and AppData, no network; Linux `orc-worker:smoke` 2.1.316 with oauth on fd 3 and
// api_key, win32 host 2.1.318 with both modes; the hardened §10.2 argv). Both versions report the same
// skills, slash commands and agents; plugins differ per platform. Plugin `path`/`source` omitted.
const RECORDED_SKILLS = [
  'deep-research',
  'dataviz',
  'update-config',
  'verify',
  'debug',
  'code-review',
  'simplify',
  'batch',
  'fewer-permission-prompts',
  'doctor',
  'loop',
  'claude-api',
  'workflow-authoring',
  'run',
  'run-skill-generator',
  'plugin-authoring',
];
const RECORDED_SLASH_COMMANDS = [
  ...RECORDED_SKILLS,
  'agents',
  'auto-mode-setup',
  'autocompact',
  'clear',
  'color',
  'compact',
  'config',
  'output-style',
  'context',
  'effort',
  'fast',
  'focus',
  'init',
  'mcp',
  'model',
  '__remote-workflow',
  'workflow-launch-exec',
  'reload-plugins',
  'reload-skills',
  'rename',
  'security-review',
  'usage',
  'insights',
  'recap',
  'goal',
  'list-agents',
  'team-onboarding',
];
const RECORDED_AGENTS = ['claude', 'Explore', 'general-purpose', 'Plan', 'statusline-setup'];
const PLUGINS_POSIX = ['cc-plugin-agents-md', 'cc-plugin-plugin-authoring'];
const PLUGINS_WIN32 = ['cc-plugin-agents-md', 'cc-plugin-privacy', 'cc-plugin-plugin-authoring'];
const CBM_TOOLS = [
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
];
/** MCP prompts of codebase-memory-mcp 0.12.0, listed by the CLI as slash commands. */
const CBM_PROMPTS = ['mcp__codebase-memory-mcp__explore_codebase', 'mcp__codebase-memory-mcp__review_change_impact'];

/** Linux 2.1.316, oauth (fd 3), no `--mcp-config`. cwd/session replaced by test values. */
const RECORDED_2_1_316_NO_MCP: ClaudeInitEvent = {
  type: 'system',
  subtype: 'init',
  cwd: CWD_POSIX,
  session_id: SESSION,
  tools: ['Edit', 'Glob', 'Grep', 'Read', 'Write'],
  mcp_servers: [],
  model: 'claude-sonnet-4-5',
  permissionMode: 'dontAsk',
  slash_commands: RECORDED_SLASH_COMMANDS,
  terminal_slash_commands: ['doctor', 'color', 'focus', 'reload-plugins'],
  apiKeySource: 'none',
  claude_code_version: '2.1.316',
  output_style: 'default',
  agents: RECORDED_AGENTS,
  skills: RECORDED_SKILLS,
  plugins: PLUGINS_POSIX.map((name) => ({ name })),
};

/** Same, with `--mcp-config` (codebase-memory-mcp connected). */
const RECORDED_2_1_316_MCP: ClaudeInitEvent = {
  ...RECORDED_2_1_316_NO_MCP,
  tools: [...RECORDED_2_1_316_NO_MCP.tools, ...CBM_TOOLS],
  mcp_servers: [{ name: 'codebase-memory-mcp', status: 'connected', source: 'dynamic' }],
  slash_commands: [...RECORDED_SLASH_COMMANDS, ...CBM_PROMPTS],
};

/** win32 2.1.318, oauth (env), no `--mcp-config`. */
const RECORDED_2_1_318_WIN32: ClaudeInitEvent = {
  ...RECORDED_2_1_316_NO_MCP,
  cwd: 'C:\\orc\\workspaces\\p\\t\\wt',
  claude_code_version: '2.1.318',
  plugins: PLUGINS_WIN32.map((name) => ({ name })),
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
    authMode: 'oauth',
    cliVersion: '2.1.316',
    ...over,
  };
}

const rules = (init: ClaudeInitEvent, e: ValidateInitExpectations): string[] =>
  validateInit(init, e).violations.map((v) => v.rule);

describe('CLAUDE_REVIEWED_EXTENSIONS (frozen, recorded names only)', () => {
  it('holds exactly the recorded entries', () => {
    const entry = (plugins: string[], oauth: boolean) => ({
      skills: [...RECORDED_SKILLS, ...(oauth ? ['schedule'] : [])],
      agents: RECORDED_AGENTS,
      slashCommands: [...RECORDED_SLASH_COMMANDS, ...(oauth ? ['schedule'] : [])],
      plugins,
    });
    expect(Object.keys(CLAUDE_REVIEWED_EXTENSIONS).sort()).toEqual([
      '2.1.316/posix/api_key',
      '2.1.316/posix/oauth',
      '2.1.318/win32/api_key',
      '2.1.318/win32/oauth',
    ]);
    expect(CLAUDE_REVIEWED_EXTENSIONS['2.1.316/posix/oauth']).toEqual(entry(PLUGINS_POSIX, true));
    expect(CLAUDE_REVIEWED_EXTENSIONS['2.1.316/posix/api_key']).toEqual(entry(PLUGINS_POSIX, false));
    expect(
      [...(CLAUDE_REVIEWED_EXTENSIONS['2.1.318/win32/oauth']?.plugins ?? [])].sort(),
    ).toEqual([...PLUGINS_WIN32].sort());
    const win32OAuth = entry([], true);
    expect({ ...CLAUDE_REVIEWED_EXTENSIONS['2.1.318/win32/oauth'], plugins: [] }).toEqual({
      ...win32OAuth,
      slashCommands: [...win32OAuth.slashCommands, 'heapdump'],
    });
    expect({ ...CLAUDE_REVIEWED_EXTENSIONS['2.1.318/win32/api_key'], plugins: [] }).toEqual({
      ...entry([], false),
    });
  });

  it('is frozen and keyed by <cliVersion>/<posix|win32>/<oauth|api_key>', () => {
    expect(Object.isFrozen(CLAUDE_REVIEWED_EXTENSIONS)).toBe(true);
    for (const entry of Object.values(CLAUDE_REVIEWED_EXTENSIONS)) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.skills)).toBe(true);
      expect(Object.isFrozen(entry.plugins)).toBe(true);
    }
    expect(claudeExtensionKey('2.1.316', 'posix', 'oauth')).toBe('2.1.316/posix/oauth');
    // No fake-claude guesses in the production table.
    const all = Object.values(CLAUDE_REVIEWED_EXTENSIONS).flatMap((e) => [...e.agents, ...e.slashCommands]);
    expect(all).not.toContain('claude-code-guide');
    expect(all).not.toContain('cost');
  });
});

describe('validateInit (§10.6)', () => {
  it('accepts every recorded init of the pinned CLIs with the production table', () => {
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
    const apiKey = { ...RECORDED_2_1_316_NO_MCP, apiKeySource: 'ANTHROPIC_API_KEY' };
    expect(validateInit(apiKey, expectations({ authMode: 'api_key' })).ok).toBe(true);
    const win = expectations({ platform: 'win32', cliVersion: '2.1.318', cwd: 'C:\\orc\\workspaces\\p\\t\\wt' });
    expect(validateInit(RECORDED_2_1_318_WIN32, win).ok).toBe(true);
    expect(
      validateInit({ ...RECORDED_2_1_318_WIN32, apiKeySource: 'ANTHROPIC_API_KEY' }, { ...win, authMode: 'api_key' }).ok,
    ).toBe(true);
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

  it('tool_missing: a requested builtin absent from the init (B-019: bare mode drops Glob, Grep, Write)', () => {
    const bareLike = { ...RECORDED_2_1_316_NO_MCP, tools: ['Edit', 'Read'] };
    const v = validateInit(bareLike, expectations());
    expect(v.violations).toEqual([
      { rule: 'tool_missing', detail: 'requested builtin tool(s) missing from init: "Write", "Glob", "Grep"' },
    ]);
    expect(rules({ ...RECORDED_2_1_316_NO_MCP, tools: BUILTINS }, expectations({ builtinTools: [...BUILTINS, 'Bash'] }))).toEqual([
      'tool_missing',
    ]);
  });

  it('admits CLAUDE_INIT_EXTRA_TOOLS and Bash only when they are expected', () => {
    const init = { ...RECORDED_2_1_316_NO_MCP, tools: [...BUILTINS, 'ToolSearch'] };
    expect(validateInit(init, expectations()).ok).toBe(false);
    expect(validateInit(init, expectations({ extraTools: ['ToolSearch'] })).ok).toBe(true);
    const bash = { ...RECORDED_2_1_316_NO_MCP, tools: [...BUILTINS, 'Bash'] };
    expect(validateInit(bash, expectations({ builtinTools: [...BUILTINS, 'Bash'] })).ok).toBe(true);
  });

  it('MCP tools and resource tools are allowed only when MCP is enabled', () => {
    const withResources = {
      ...RECORDED_2_1_316_MCP,
      tools: [...RECORDED_2_1_316_MCP.tools, 'ListMcpResourcesTool', 'ReadMcpResourceTool'],
    };
    expect(validateInit(withResources, expectations({ mcpEnabled: true })).ok).toBe(true);
    const v = validateInit(
      { ...withResources, mcp_servers: [], slash_commands: RECORDED_SLASH_COMMANDS },
      expectations({ mcpEnabled: false }),
    );
    expect(v.ok).toBe(false);
    expect(v.violations.map((x) => x.rule)).toEqual(['tool']);
  });

  it('extension: codebase-memory-mcp prompts as slash commands only when MCP is enabled', () => {
    const v = validateInit({ ...RECORDED_2_1_316_MCP, tools: RECORDED_2_1_316_NO_MCP.tools, mcp_servers: [] }, expectations());
    expect(v.violations).toEqual([
      {
        rule: 'extension',
        detail: `unexpected slash_commands: ${CBM_PROMPTS.map((p) => JSON.stringify(p)).join(', ')}`,
      },
    ]);
    const foreignPrompt = { ...RECORDED_2_1_316_MCP, slash_commands: [...RECORDED_SLASH_COMMANDS, 'mcp__evil__prompt'] };
    expect(rules(foreignPrompt, expectations({ mcpEnabled: true }))).toEqual(['extension']);
  });

  it.each([
    ['skills', 'evil-skill'],
    ['agents', 'evil-agent'],
    ['slash_commands', 'evil-command'],
  ] as const)('extension: an unexpected name in %s is a violation naming only that name', (field, name) => {
    const list = (RECORDED_2_1_316_NO_MCP as Record<string, unknown>)[field] as string[];
    const v = validateInit({ ...RECORDED_2_1_316_NO_MCP, [field]: [...list, name] }, expectations());
    expect(v.violations).toEqual([{ rule: 'extension', detail: `unexpected ${field}: "${name}"` }]);
  });

  it('extension: plugins are checked by name; win32-only plugin is foreign on posix', () => {
    const v = validateInit({ ...RECORDED_2_1_316_NO_MCP, plugins: PLUGINS_WIN32.map((name) => ({ name, path: '/p' })) }, expectations());
    expect(v.violations).toEqual([{ rule: 'extension', detail: 'unexpected plugins: "cc-plugin-privacy"' }]);
  });

  it('extension: oauth-only `schedule` is foreign in api_key mode', () => {
    const init = {
      ...RECORDED_2_1_316_NO_MCP,
      apiKeySource: 'ANTHROPIC_API_KEY',
      skills: [...RECORDED_SKILLS, 'schedule'],
    };
    expect(validateInit(init, expectations({ authMode: 'oauth', cliVersion: '2.1.316' })).violations.map((x) => x.rule)).toEqual([
      'auth_source',
    ]);
    expect(validateInit(init, expectations({ authMode: 'api_key' })).violations).toEqual([
      { rule: 'extension', detail: 'unexpected skills: "schedule"' },
    ]);
  });

  it('extension: real-token `heapdump` slash command is admitted only in the win32 oauth entry', () => {
    const slash = [...RECORDED_SLASH_COMMANDS, 'heapdump'];
    const foreign = [{ rule: 'extension', detail: 'unexpected slash_commands: "heapdump"' }];
    const win = expectations({ platform: 'win32', cliVersion: '2.1.318', cwd: 'C:\\orc\\workspaces\\p\\t\\wt' });
    expect(validateInit({ ...RECORDED_2_1_318_WIN32, slash_commands: slash }, win).ok).toBe(true);
    expect(
      validateInit(
        { ...RECORDED_2_1_318_WIN32, apiKeySource: 'ANTHROPIC_API_KEY', slash_commands: slash },
        { ...win, authMode: 'api_key' },
      ).violations,
    ).toEqual(foreign);
    expect(validateInit({ ...RECORDED_2_1_316_NO_MCP, slash_commands: slash }, expectations()).violations).toEqual(foreign);
  });

  it('extension: a missing table entry names the key; an injected table replaces the production one', () => {
    const v = validateInit({ ...RECORDED_2_1_316_NO_MCP, claude_code_version: '2.1.400' }, expectations({ cliVersion: '2.1.400' }));
    expect(v.violations).toEqual([
      { rule: 'extension', detail: 'no reviewed extension entry for "2.1.400/posix/oauth" (CLAUDE_REVIEWED_EXTENSIONS)' },
    ]);
    expect(rules(RECORDED_2_1_316_NO_MCP, expectations({ platform: 'win32', cwd: CWD_POSIX }))).toContain('extension');
    const injected: ReviewedExtensionTable = {
      '2.1.400/posix/oauth': { skills: ['x'], agents: [], slashCommands: [], plugins: [] },
    };
    const minimal = {
      ...RECORDED_2_1_316_NO_MCP,
      claude_code_version: '2.1.400',
      skills: ['x'],
      agents: undefined,
      slash_commands: undefined,
      plugins: undefined,
    };
    expect(validateInit(minimal, expectations({ cliVersion: '2.1.400', reviewedExtensions: injected })).ok).toBe(true);
    // The injected table replaces the production one entirely.
    expect(rules(RECORDED_2_1_316_NO_MCP, expectations({ reviewedExtensions: injected }))).toEqual(['extension']);
  });

  it('extension: init version differing from the probed version is a violation', () => {
    const v = validateInit(RECORDED_2_1_316_NO_MCP, expectations({ cliVersion: '2.1.318' }));
    expect(v.violations).toEqual([
      { rule: 'extension', detail: 'claude_code_version="2.1.316" differs from the probed CLI version "2.1.318"' },
    ]);
    const { claude_code_version: _v, ...noVersion } = RECORDED_2_1_316_NO_MCP;
    expect(validateInit(noVersion as ClaudeInitEvent, expectations()).violations).toEqual([
      { rule: 'extension', detail: 'claude_code_version=null differs from the probed CLI version "2.1.316"' },
    ]);
  });

  it.each([
    ['skills', 'verify'],
    ['agents', [1, 2]],
    ['plugins', [{ path: '/no/name' }]],
    ['slash_commands', null],
  ] as const)('extension: an unparsable %s field is a violation; an absent field counts as empty', (field, value) => {
    const v = validateInit({ ...RECORDED_2_1_316_NO_MCP, [field]: value }, expectations());
    expect(v.violations).toEqual([{ rule: 'extension', detail: `${field}: unparsable field` }]);
    expect(validateInit({ ...RECORDED_2_1_316_NO_MCP, [field]: undefined }, expectations()).ok).toBe(true);
  });

  it.each([[undefined], [null], [{}], [[]], [{ auto: null }], [{ auto: '' }]])('memory: %o is accepted', (value) => {
    expect(validateInit({ ...RECORDED_2_1_316_NO_MCP, memory_paths: value }, expectations()).ok).toBe(true);
  });

  it('memory: any memory path is a violation', () => {
    const v = validateInit({ ...RECORDED_2_1_316_NO_MCP, memory_paths: { auto: '/home/x/.claude/projects/p/memory' } }, expectations());
    expect(v.violations).toEqual([
      {
        rule: 'memory',
        detail: 'memory_paths must be absent, null or empty (got {"auto":"/home/x/.claude/projects/p/memory"})',
      },
    ]);
    expect(rules({ ...RECORDED_2_1_316_NO_MCP, memory_paths: ['/m'] }, expectations())).toEqual(['memory']);
  });

  it.each([
    ['oauth', 'ANTHROPIC_API_KEY', 'apiKeySource="ANTHROPIC_API_KEY" (expected "none" in oauth mode)'],
    ['oauth', 'apiKeyHelper', 'apiKeySource="apiKeyHelper" (expected "none" in oauth mode)'],
    ['oauth', undefined, 'apiKeySource=null (expected "none" in oauth mode)'],
    ['api_key', 'none', 'apiKeySource="none" (expected "ANTHROPIC_API_KEY" in api_key mode)'],
    ['api_key', 'apiKeyHelper', 'apiKeySource="apiKeyHelper" (expected "ANTHROPIC_API_KEY" in api_key mode)'],
  ] as const)('auth_source (%s mode, apiKeySource %s)', (authMode, apiKeySource, detail) => {
    const v = validateInit({ ...RECORDED_2_1_316_NO_MCP, apiKeySource }, expectations({ authMode }));
    expect(v.violations).toEqual([{ rule: 'auth_source', detail }]);
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

  it('reports every violated rule in contract order', () => {
    const v = validateInit(
      {
        ...RECORDED_2_1_316_NO_MCP,
        permissionMode: 'default',
        mcp_servers: [{ name: 'evil', status: 'connected' }],
        tools: ['Read', 'WebFetch'],
        skills: ['evil'],
        memory_paths: { auto: '/m' },
        apiKeySource: 'ANTHROPIC_API_KEY',
        cwd: '/elsewhere',
        session_id: 'other',
      },
      expectations(),
    );
    expect(v.violations.map((x) => x.rule)).toEqual([
      'permission_mode',
      'mcp_server',
      'tool',
      'tool_missing',
      'extension',
      'memory',
      'auth_source',
      'cwd',
      'session_id',
    ]);
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
    const winE = { cwd: win, platform: 'win32', cliVersion: '2.1.318' } as const;
    expect(validateInit({ ...RECORDED_2_1_318_WIN32, cwd: 'c:\\ORC\\workspaces\\p\\t\\wt' }, expectations(winE)).ok).toBe(true);
    expect(
      validateInit({ ...RECORDED_2_1_318_WIN32, cwd: 'C:\\orc\\workspaces\\p\\t2\\wt' }, expectations(winE)).violations.map(
        (x) => x.rule,
      ),
    ).toEqual(['cwd']);
  });

  it('masks secrets that appear in violation details', () => {
    const secretTool = 'sk-ant-api03-SECRETTOOLNAME0000000000000';
    const v = validateInit({ ...RECORDED_2_1_316_NO_MCP, tools: [...BUILTINS, secretTool] }, expectations());
    expect(v.violations[0]?.detail).not.toContain('SECRETTOOLNAME');
    const memory = validateInit(
      { ...RECORDED_2_1_316_NO_MCP, memory_paths: { auto: `/x/sk-ant-oat01-${'S'.repeat(40)}` } },
      expectations(),
    );
    expect(memory.violations[0]?.detail).not.toContain('S'.repeat(40));
  });
});
