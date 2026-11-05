// Constants of the Claude runner (contract §10.2, §10.6, §10.9).
import type { ReviewedExtensions } from './types';

/**
 * Flags the pinned CLI must document in `--help` (§10.9, ADR-0036 Decision 6). Each entry may also be
 * satisfied by its alias in {@link CLAUDE_FLAG_ALIASES}.
 */
export const CLAUDE_REQUIRED_FLAGS: readonly string[] = Object.freeze([
  '-p',
  '--output-format',
  '--verbose',
  '--setting-sources',
  '--settings',
  '--include-hook-events',
  '--restricted',
  '--model',
  '--effort',
  '--permission-mode',
  '--tools',
  '--allowed-tools',
  '--disallowed-tools',
  '--mcp-config',
  '--strict-mcp-config',
  '--append-system-prompt',
  '--session-id',
  '--resume',
  '--fork-session',
  '--max-budget-usd',
]);

/** Accepted alternative spellings of required flags (§10.9). */
export const CLAUDE_FLAG_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '-p': Object.freeze(['--print']),
  '--allowed-tools': Object.freeze(['--allowedTools']),
  '--disallowed-tools': Object.freeze(['--disallowedTools']),
});

/**
 * Frozen inline `--settings` value (§10.2 row 7, ADR-0036 Decision 3). Passed inline, never as a file:
 * a file in `.meta` would be writable by the lease uid.
 */
export const CLAUDE_HARDENED_SETTINGS =
  '{"disableAllHooks":true,"autoMemoryEnabled":false,"attribution":{"commit":"","pr":""},"includeGitInstructions":false}';

/** The only permission mode the platform runs Claude with (§10.2 row 10). */
export const CLAUDE_PERMISSION_MODE = 'dontAsk';

/**
 * Reviewed tool names the pinned CLI adds to `init.tools` on its own (§10.6, T-M9).
 * CLI 2.1.316 (Linux) and 2.1.318 (win32) were recorded offline (fake credential, no network) with
 * the exact §10.2 argv, with and without `--mcp-config` (codebase-memory-mcp connected): `init.tools`
 * held exactly the `--tools` builtins plus `mcp__codebase-memory-mcp__*`, so no internal names are
 * admitted. Re-check on every CLI version bump; operators can add names via CLAUDE_INIT_EXTRA_TOOLS.
 */
export const CLAUDE_INTERNAL_TOOL_NAMES: readonly string[] = Object.freeze([]);

/** The only MCP server an attempt may run (§10.6 mcp_server rule). */
export const CBM_MCP_SERVER_NAME = 'codebase-memory-mcp';

/** MCP resource tools the CLI adds when an MCP server is configured (§10.6 tool rule). */
export const MCP_RESOURCE_TOOL_NAMES: readonly string[] = Object.freeze([
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
]);

/**
 * Prefix of tool names exposed by the codebase-memory-mcp server. The CLI also lists the server's
 * prompts under this prefix in `init.slash_commands` (recorded: `explore_codebase`,
 * `review_change_impact`), which the extension rule admits only when MCP is enabled.
 */
export const CBM_MCP_TOOL_PREFIX = `mcp__${CBM_MCP_SERVER_NAME}__`;

// Init extension sets recorded offline from the real CLI (B-017 D2 recording: fake credential, isolated
// HOME/CLAUDE_CONFIG_DIR/AppData, no network; Linux `orc-worker:smoke` 2.1.316 and win32 host 2.1.318,
// both auth modes, oauth on Linux through fd 3; repeated runs identical). Both versions report the
// same skills, slash commands and agents; only the plugin set differs per platform (also ADR-0036 D-6).
const RECORDED_SKILLS: readonly string[] = [
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

const RECORDED_SLASH_COMMANDS: readonly string[] = [
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

const RECORDED_AGENTS: readonly string[] = ['claude', 'Explore', 'general-purpose', 'Plan', 'statusline-setup'];

const RECORDED_PLUGINS_POSIX: readonly string[] = ['cc-plugin-agents-md', 'cc-plugin-plugin-authoring'];
const RECORDED_PLUGINS_WIN32: readonly string[] = [...RECORDED_PLUGINS_POSIX, 'cc-plugin-privacy'];

/** Bundled extras of the oauth mode, recorded in ADR-0036 D-6 (skill and slash command `schedule`). */
const RECORDED_OAUTH_EXTRAS: readonly string[] = ['schedule'];

/**
 * Slash command win32 2.1.318 lists only with a real subscription token (recorded 2026-11-05 with the
 * exact §10.2 argv and a live oauth token; the fake-token recording does not show it). It adds no
 * capability: the model has no Skill/SlashCommand tool and the task prompt never starts with `/`.
 * Not recorded on posix yet: re-check with `test:claude-live` (probe-init) and a real token.
 */
const RECORDED_WIN32_OAUTH_SLASH_EXTRAS: readonly string[] = ['heapdump'];

function reviewedEntry(
  plugins: readonly string[],
  oauth: boolean,
  slashExtras: readonly string[] = [],
): ReviewedExtensions {
  const extra = oauth ? RECORDED_OAUTH_EXTRAS : [];
  return Object.freeze({
    skills: Object.freeze([...RECORDED_SKILLS, ...extra]),
    agents: Object.freeze([...RECORDED_AGENTS]),
    slashCommands: Object.freeze([...RECORDED_SLASH_COMMANDS, ...extra, ...slashExtras]),
    plugins: Object.freeze([...plugins]),
  });
}

/**
 * Reviewed init extensions per `<cliVersion>/<posix|win32>/<oauth|api_key>` (§10.6 extension rule,
 * ADR-0036 Decision 5; Security review; no operator knob). Only names recorded from the real CLI
 * enter this table; a CLI version without an entry fails every run closed.
 */
export const CLAUDE_REVIEWED_EXTENSIONS: Readonly<Record<string, ReviewedExtensions>> = Object.freeze({
  '2.1.316/posix/oauth': reviewedEntry(RECORDED_PLUGINS_POSIX, true),
  '2.1.316/posix/api_key': reviewedEntry(RECORDED_PLUGINS_POSIX, false),
  '2.1.318/win32/oauth': reviewedEntry(RECORDED_PLUGINS_WIN32, true, RECORDED_WIN32_OAUTH_SLASH_EXTRAS),
  '2.1.318/win32/api_key': reviewedEntry(RECORDED_PLUGINS_WIN32, false),
});

/** `--version` / `--help` probe timeout (§10.9). */
export const CLAUDE_PROBE_TIMEOUT_MS = 15_000;

/** Upper bound of probe output kept in memory. */
export const CLAUDE_PROBE_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Marker variable carried by every Claude process (orphan detection, §10.3/§10.8). */
export const CLAUDE_MARKER_ENV = 'ORC_ATTEMPT_ID';

/** ProcessRegistry kind and key prefix of Claude processes (§10.8). */
export const CLAUDE_PROCESS_KIND = 'claude';
