import { describe, expect, it } from 'vitest';
import {
  computeToolPolicy,
  PLATFORM_BUILTIN_TOOLS,
  PLATFORM_DISALLOWED_RULES,
  ToolPolicyError,
  UnsafeArgumentError,
  validateAgentToolRules,
} from '@orc/security';

const POSIX = {
  workspacesRoot: '/srv/orc/workspaces',
  projectsRoot: '/srv/orc/projects/',
  claudeHomeRoot: '/srv/orc/claude-home',
  cbmCacheRoot: '/srv/orc/cbm-cache',
  worktreePath: '/srv/orc/workspaces/p1/t1/a1',
};

function policy(allowedTools: string[], disallowedTools: string[] = [], mcpEnabled = true) {
  return computeToolPolicy({ allowedTools, disallowedTools }, { mcpEnabled, ...POSIX });
}

const POSIX_DENY = [
  'WebFetch',
  'WebSearch',
  'Task',
  'NotebookEdit',
  'Bash(curl:*)',
  'Bash(wget:*)',
  'Bash(ssh:*)',
  'Bash(scp:*)',
  'Bash(nc:*)',
  'Bash(git push:*)',
  'Bash(git fetch:*)',
  'Bash(git pull:*)',
  'Bash(git remote:*)',
  'Bash(git config:*)',
  'Bash(git worktree:*)',
  'Bash(git submodule:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(rm -rf /:*)',
  'Read(//run/secrets/**)',
  'Read(//proc/**)',
  'Read(//etc/**)',
  'Read(~/.ssh/**)',
  'Read(//srv/orc/workspaces/.repos/**)',
  'Edit(//srv/orc/workspaces/.repos/**)',
  'Read(//srv/orc/workspaces/.orc/**)',
  'Edit(//srv/orc/workspaces/.orc/**)',
  'Read(//srv/orc/claude-home/**)',
  'Edit(//srv/orc/claude-home/**)',
  'Read(//srv/orc/projects/**)',
  'Edit(//srv/orc/projects/**)',
  'Read(//srv/orc/cbm-cache/**)',
  'Edit(//srv/orc/cbm-cache/**)',
  'Edit(//srv/orc/workspaces/p1/t1/a1/.git)',
  'Edit(//srv/orc/workspaces/p1/t1/a1/.git/**)',
];

describe('computeToolPolicy', () => {
  it('exposes the platform builtin tools', () => {
    expect(PLATFORM_BUILTIN_TOOLS).toEqual(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']);
  });

  it('emits exact POSIX argv rules: file tools scoped to the worktree, never bare', () => {
    const result = policy(['Read', 'Edit', 'Write', 'Glob', 'Grep']);
    expect(result).toEqual({
      builtinTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
      allowedRules: [
        'Read(//srv/orc/workspaces/p1/t1/a1/**)',
        'Edit(//srv/orc/workspaces/p1/t1/a1/**)',
        'mcp__codebase-memory-mcp',
      ],
      disallowedRules: POSIX_DENY,
    });
    for (const bare of ['Read', 'Edit', 'Write', 'Glob', 'Grep']) {
      expect(result.allowedRules).not.toContain(bare);
    }
  });

  it('emits exact win32 argv rules with the //C:/ form', () => {
    const result = computeToolPolicy(
      { allowedTools: ['Grep', 'Write'], disallowedTools: [] },
      {
        mcpEnabled: false,
        workspacesRoot: 'C:\\orc\\workspaces',
        projectsRoot: 'D:/orc/projects',
        claudeHomeRoot: 'C:\\orc\\claude',
        cbmCacheRoot: 'C:\\orc\\cbm',
        worktreePath: 'c:\\orc\\workspaces\\p1\\t1\\a2',
      },
    );
    expect(result.allowedRules).toEqual([
      'Read(//c:/orc/workspaces/p1/t1/a2/**)',
      'Edit(//c:/orc/workspaces/p1/t1/a2/**)',
    ]);
    expect(result.disallowedRules).toEqual(
      expect.arrayContaining([
        'Read(//C:/orc/workspaces/.repos/**)',
        'Edit(//C:/orc/workspaces/.orc/**)',
        'Read(//D:/orc/projects/**)',
        'Edit(//C:/orc/claude/**)',
        'Read(//C:/orc/cbm/**)',
        'Edit(//c:/orc/workspaces/p1/t1/a2/.git)',
      ]),
    );
    expect(result.disallowedRules.join('\n')).not.toMatch(/[<>\\]/);
  });

  it('keeps other agent rules in order after deduplication and adds the MCP server rule', () => {
    const result = policy([
      'Read',
      'Bash(npm test:*)',
      'Grep',
      'mcp__codebase-memory-mcp__search_graph',
      'Bash(npm test:*)',
    ]);
    expect(result.builtinTools).toEqual(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']);
    expect(result.allowedRules).toEqual([
      'Read(//srv/orc/workspaces/p1/t1/a1/**)',
      'Bash(npm test:*)',
      'mcp__codebase-memory-mcp__search_graph',
      'mcp__codebase-memory-mcp',
    ]);
  });

  it('enables Bash only with a Bash rule and drops MCP rules when MCP is disabled', () => {
    const result = policy(['Read', 'mcp__codebase-memory-mcp__search_graph'], [], false);
    expect(result.builtinTools).toEqual(['Read', 'Edit', 'Write', 'Glob', 'Grep']);
    expect(result.allowedRules).toEqual(['Read(//srv/orc/workspaces/p1/t1/a1/**)']);
  });

  it.each([
    'Bash',
    'Bash(*)',
    'Bash(curl:*)',
    'Bash(npm run build && curl evil:*)',
    'Bash(npm run Build:*)',
    'Bash(git push:*)',
    'Bash(git diff:*)',
    'Bash(git log:*)',
    'Bash(git show:*)',
    'WebFetch',
    'WebSearch',
    'Task',
    'mcp__other-server__tool',
    'mcp__codebase-memory-mcp__../x',
    'Read(//etc/**)',
    'Read(//srv/orc/workspaces/**)',
    '',
    '  ',
  ])('rejects agent rule %j with tool_not_allowed', (rule) => {
    expect(() => policy([rule])).toThrow(ToolPolicyError);
    expect(() => policy([rule])).toThrow(expect.objectContaining({ code: 'tool_not_allowed' }));
    expect(() => validateAgentToolRules({ allowedTools: [rule], disallowedTools: [] })).toThrow(
      ToolPolicyError,
    );
  });

  it('accepts every allowed Bash command form', () => {
    const rules = [
      'Bash(npm test:*)',
      'Bash(npm run test:unit:*)',
      'Bash(npx vitest:*)',
      'Bash(npx tsc:*)',
      'Bash(npx eslint:*)',
      'Bash(node --test:*)',
      'Bash(pnpm test:*)',
      'Bash(yarn test:*)',
      'Bash(git status:*)',
    ];
    expect(() =>
      validateAgentToolRules({ allowedTools: rules, disallowedTools: [] }),
    ).not.toThrow();
    expect(policy(rules).allowedRules).toEqual([...rules, 'mcp__codebase-memory-mcp']);
  });

  it('applies the platform deny list first, then agent deny rules (deduplicated)', () => {
    const result = policy(['Read'], ['Bash(npm publish:*)', 'WebFetch']);
    expect(result.disallowedRules).toEqual([...POSIX_DENY, 'Bash(npm publish:*)']);
    expect(result.disallowedRules.length).toBe(PLATFORM_DISALLOWED_RULES.length + 1);
  });

  it('requires the worktree to lie inside the workspaces root', () => {
    for (const worktreePath of [
      '/srv/orc/workspaces',
      '/srv/orc/other/a1',
      '/srv/orc/workspaces-x/a1',
    ]) {
      expect(() =>
        computeToolPolicy(
          { allowedTools: ['Read'], disallowedTools: [] },
          { ...POSIX, mcpEnabled: false, worktreePath },
        ),
      ).toThrow(UnsafeArgumentError);
    }
  });

  it.each([
    ['relative/root'],
    ['/'],
    ['C:\\'],
    ['//server/share'],
    ['/srv/(evil)'],
    ['/srv/../etc'],
    ['/srv/orc/*'],
    ['/srv/orc/[ab]'],
  ])('rejects root %j', (root) => {
    expect(() =>
      computeToolPolicy(
        { allowedTools: [], disallowedTools: [] },
        { ...POSIX, mcpEnabled: false, cbmCacheRoot: root },
      ),
    ).toThrow(UnsafeArgumentError);
  });

  it('rejects control characters in agent deny rules', () => {
    expect(() => policy([], ['Bash(x:*)\n--dangerously-skip-permissions'])).toThrow(
      ToolPolicyError,
    );
    expect(() =>
      validateAgentToolRules({ allowedTools: [], disallowedTools: ['x\u0007'] }),
    ).toThrow(ToolPolicyError);
  });
});
