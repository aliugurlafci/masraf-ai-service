// Constants of the Claude runner (contract §10.2, §10.6, §10.9).

/**
 * Flags the pinned CLI must document in `--help` (§10.9). Each entry may also be satisfied by its
 * alias in {@link CLAUDE_FLAG_ALIASES}; `--bare` ({@link CLAUDE_BARE_FLAG}) is required only when
 * CLAUDE_BARE=true.
 */
export const CLAUDE_REQUIRED_FLAGS: readonly string[] = Object.freeze([
  '-p',
  '--output-format',
  '--verbose',
  '--setting-sources',
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

export const CLAUDE_BARE_FLAG = '--bare';

/** The only permission mode the platform runs Claude with (§10.2 #8). */
export const CLAUDE_PERMISSION_MODE = 'dontAsk';

/**
 * Reviewed tool names the pinned CLI adds to `init.tools` on its own (§10.6, T-M9).
 * CLI 2.1.316 was recorded offline (no API key, network blocked) with the exact §10.2 argv, with
 * and without `--mcp-config` (codebase-memory-mcp connected): `init.tools` contained only a subset
 * of the `--tools` builtins plus `mcp__codebase-memory-mcp__*`, so no internal names are admitted.
 * Re-check on every CLI version bump; operators can add names via CLAUDE_INIT_EXTRA_TOOLS.
 */
export const CLAUDE_INTERNAL_TOOL_NAMES: readonly string[] = Object.freeze([]);

/** The only MCP server an attempt may run (§10.6 mcp_server rule). */
export const CBM_MCP_SERVER_NAME = 'codebase-memory-mcp';

/** MCP resource tools the CLI adds when an MCP server is configured (§10.6 tool rule). */
export const MCP_RESOURCE_TOOL_NAMES: readonly string[] = Object.freeze([
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
]);

/** Prefix of tool names exposed by the codebase-memory-mcp server. */
export const CBM_MCP_TOOL_PREFIX = `mcp__${CBM_MCP_SERVER_NAME}__`;

/** `--version` / `--help` probe timeout (§10.9). */
export const CLAUDE_PROBE_TIMEOUT_MS = 15_000;

/** Upper bound of probe output kept in memory. */
export const CLAUDE_PROBE_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Marker variable carried by every Claude process (orphan detection, §10.3/§10.8). */
export const CLAUDE_MARKER_ENV = 'ORC_ATTEMPT_ID';

/** ProcessRegistry kind and key prefix of Claude processes (§10.8). */
export const CLAUDE_PROCESS_KIND = 'claude';
