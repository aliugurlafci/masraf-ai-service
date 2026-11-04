import { ToolPolicyError, UnsafeArgumentError } from './errors.js';

export const PLATFORM_BUILTIN_TOOLS = Object.freeze([
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash',
] as const);

const MCP_SERVER_RULE = 'mcp__codebase-memory-mcp';
const MCP_RULE_PREFIX = 'mcp__';

/**
 * Agent profile vocabulary (§10.4). File-tool names are capabilities that {@link computeToolPolicy}
 * rewrites into worktree-scoped rules; they are never emitted bare. `Bash(...)` rules grant code
 * execution (repository scripts) and are an admin opt-in per agent. Anything else raises
 * {@link ToolPolicyError}.
 */
export const PLATFORM_ALLOWED_RULE_PATTERNS: readonly RegExp[] = Object.freeze([
  /^(?:Read|Edit|Write|Glob|Grep)$/,
  /^mcp__codebase-memory-mcp$/,
  /^mcp__codebase-memory-mcp__[A-Za-z0-9_]+$/,
  /^Bash\((?:npm (?:test|run [a-z0-9:_-]+)|npx (?:vitest|tsc|eslint)|node --test|pnpm test|yarn test|git status):\*\)$/,
]);

/**
 * Always-denied rules (§10.4). `<WORKSPACES_ROOT>`, `<PROJECTS_ROOT>`, `<CLAUDE_HOME_ROOT>`,
 * `<CBM_CACHE_DIR>` and `<WORKTREE>` are substituted by {@link computeToolPolicy}
 * (POSIX `//srv/x`, win32 `//C:/x`).
 */
export const PLATFORM_DISALLOWED_RULES: readonly string[] = Object.freeze([
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
  'Read(//<WORKSPACES_ROOT>/.repos/**)',
  'Edit(//<WORKSPACES_ROOT>/.repos/**)',
  'Read(//<WORKSPACES_ROOT>/.orc/**)',
  'Edit(//<WORKSPACES_ROOT>/.orc/**)',
  'Read(//<CLAUDE_HOME_ROOT>/**)',
  'Edit(//<CLAUDE_HOME_ROOT>/**)',
  'Read(//<PROJECTS_ROOT>/**)',
  'Edit(//<PROJECTS_ROOT>/**)',
  'Read(//<CBM_CACHE_DIR>/**)',
  'Edit(//<CBM_CACHE_DIR>/**)',
  'Edit(//<WORKTREE>/.git)',
  'Edit(//<WORKTREE>/.git/**)',
]);

export interface EffectiveToolPolicy {
  builtinTools: string[];
  allowedRules: string[];
  disallowedRules: string[];
}

export interface ToolPolicyOptions {
  mcpEnabled: boolean;
  /** Absolute realpath of the attempt worktree (must lie inside `workspacesRoot`). */
  worktreePath: string;
  workspacesRoot: string;
  projectsRoot: string;
  claudeHomeRoot: string;
  cbmCacheRoot: string;
}

const RULE_MAX_LENGTH = 512;
/** File-tool capability -> scoped rule family (Read rules also cover Glob/Grep, Edit rules cover Write). */
const FILE_TOOL_SCOPE: Readonly<Record<string, 'Read' | 'Edit'>> = Object.freeze({
  Read: 'Read',
  Glob: 'Read',
  Grep: 'Read',
  Edit: 'Edit',
  Write: 'Edit',
});

/** Absolute root -> path after the `//` rule prefix: `/srv/ws` -> `srv/ws`, `C:\ws` -> `C:/ws`. */
function rulePath(root: string, name: string): string {
  // Glob metacharacters and rule delimiters would change the rule's meaning.
  if (typeof root !== 'string' || root.includes('\0') || /[()*?[\]{}!\r\n]/.test(root)) {
    throw new UnsafeArgumentError(`${name} contains characters not allowed in a tool rule`, {
      details: { reason: 'invalid_root', root: name },
    });
  }
  const drive = /^([A-Za-z]:)[\\/]/.exec(root);
  let rel: string;
  if (drive) {
    rel = root.replace(/\\/g, '/');
  } else if (root.startsWith('/') && !root.startsWith('//')) {
    rel = root.replace(/^\/+/, '');
  } else {
    throw new UnsafeArgumentError(`${name} must be an absolute POSIX or drive path`, {
      details: { reason: 'invalid_root', root: name },
    });
  }
  rel = rel.replace(/\/+/g, '/').replace(/\/+$/, '');
  if (
    rel.length === 0 ||
    /^[A-Za-z]:$/.test(rel) ||
    rel.split('/').some((s) => s === '..' || s === '.')
  ) {
    throw new UnsafeArgumentError(`${name} must not be a filesystem root or contain '.'/'..'`, {
      details: { reason: 'invalid_root', root: name },
    });
  }
  return rel;
}

function isWithin(child: string, parent: string): boolean {
  const drive = /^[A-Za-z]:/.test(parent);
  const c = drive ? child.toLowerCase() : child;
  const p = drive ? parent.toLowerCase() : parent;
  return c.startsWith(`${p}/`);
}

// eslint-disable-next-line no-control-regex -- control characters are exactly what is rejected
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function assertRuleText(rule: unknown, kind: 'allowed' | 'disallowed'): string {
  if (
    typeof rule !== 'string' ||
    rule.trim().length === 0 ||
    rule.length > RULE_MAX_LENGTH ||
    CONTROL_CHARS.test(rule)
  ) {
    throw new ToolPolicyError(`Invalid ${kind} tool rule`, { details: { kind } });
  }
  return rule;
}

function assertAllowedRule(raw: unknown): string {
  const rule = assertRuleText(raw, 'allowed');
  if (!PLATFORM_ALLOWED_RULE_PATTERNS.some((pattern) => pattern.test(rule))) {
    throw new ToolPolicyError(`Tool rule not allowed: ${rule.slice(0, 120)}`, {
      details: { rule: rule.slice(0, 200) },
    });
  }
  return rule;
}

/**
 * Validates an agent profile's rules without a worktree (agent create/update, §2.10).
 * Throws {@link ToolPolicyError} (`tool_not_allowed`) for any allow rule outside
 * {@link PLATFORM_ALLOWED_RULE_PATTERNS} or any malformed rule.
 */
export function validateAgentToolRules(agent: {
  allowedTools: readonly string[];
  disallowedTools: readonly string[];
}): void {
  for (const raw of agent.allowedTools) assertAllowedRule(raw);
  for (const raw of agent.disallowedTools) assertRuleText(raw, 'disallowed');
}

/**
 * Effective Claude tool policy = agent rules ∩ platform allowlist (§10.4).
 * - builtins: Read, Edit, Write, Glob, Grep always; Bash only with at least one allowed `Bash(...)` rule.
 * - allowedRules: file-tool capabilities rewritten to `Read(//<worktree>/**)` / `Edit(//<worktree>/**)`
 *   (a bare tool name is never emitted: it would allow that tool on every path), then the other agent
 *   rules (deduplicated, order kept) and the server-wide MCP rule when MCP is enabled; MCP rules are
 *   dropped when MCP is disabled. Any non-matching agent rule throws ToolPolicyError.
 * - disallowedRules: platform deny list with roots substituted, then agent disallowed rules.
 */
export function computeToolPolicy(
  agent: { allowedTools: readonly string[]; disallowedTools: readonly string[] },
  opts: ToolPolicyOptions,
): EffectiveToolPolicy {
  const roots: Record<string, string> = {
    '<WORKSPACES_ROOT>': rulePath(opts.workspacesRoot, 'workspacesRoot'),
    '<PROJECTS_ROOT>': rulePath(opts.projectsRoot, 'projectsRoot'),
    '<CLAUDE_HOME_ROOT>': rulePath(opts.claudeHomeRoot, 'claudeHomeRoot'),
    '<CBM_CACHE_DIR>': rulePath(opts.cbmCacheRoot, 'cbmCacheRoot'),
    '<WORKTREE>': rulePath(opts.worktreePath, 'worktreePath'),
  };
  const worktree = roots['<WORKTREE>'] ?? '';
  if (!isWithin(worktree, roots['<WORKSPACES_ROOT>'] ?? '')) {
    throw new UnsafeArgumentError('worktreePath must lie inside workspacesRoot', {
      details: { reason: 'worktree_outside_root' },
    });
  }

  const allowed: string[] = [];
  const push = (rule: string): void => {
    if (!allowed.includes(rule)) allowed.push(rule);
  };
  for (const raw of agent.allowedTools) {
    const rule = assertAllowedRule(raw);
    const scope = FILE_TOOL_SCOPE[rule];
    if (scope !== undefined) {
      push(`${scope}(//${worktree}/**)`);
      continue;
    }
    if (rule.startsWith(MCP_RULE_PREFIX) && !opts.mcpEnabled) continue;
    push(rule);
  }
  if (opts.mcpEnabled) push(MCP_SERVER_RULE);

  const builtinTools: string[] = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
  if (allowed.some((rule) => rule.startsWith('Bash('))) builtinTools.push('Bash');

  const disallowed: string[] = [];
  for (const template of PLATFORM_DISALLOWED_RULES) {
    const rule = template.replace(
      /<(?:WORKSPACES_ROOT|PROJECTS_ROOT|CLAUDE_HOME_ROOT|CBM_CACHE_DIR|WORKTREE)>/g,
      (token) => roots[token] ?? token,
    );
    if (!disallowed.includes(rule)) disallowed.push(rule);
  }
  for (const raw of agent.disallowedTools) {
    const rule = assertRuleText(raw, 'disallowed');
    if (!disallowed.includes(rule)) disallowed.push(rule);
  }
  return { builtinTools, allowedRules: allowed, disallowedRules: disallowed };
}
