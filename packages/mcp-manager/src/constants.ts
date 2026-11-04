// Real codebase-memory-mcp tool names and the parameters each must advertise (contract §2.7, §12.1).
// Names are verified with tools/list on every connection; they are never guessed.

export const REQUIRED_MCP_TOOLS = [
  'index_repository',
  'index_status',
  'list_projects',
  'delete_project',
  'detect_changes',
] as const;

export type RequiredMcpTool = (typeof REQUIRED_MCP_TOOLS)[number];

export const REQUIRED_TOOL_PARAMS: Readonly<Record<RequiredMcpTool, readonly string[]>> =
  Object.freeze({
    index_repository: Object.freeze(['repo_path', 'mode', 'name']),
    index_status: Object.freeze(['project']),
    list_projects: Object.freeze([]),
    delete_project: Object.freeze(['project']),
    detect_changes: Object.freeze(['project', 'base_branch', 'scope']),
  });

/**
 * Graph tools of the diff-seeded impact analysis (ADR-0035). Checked only by that operation, so a server
 * without them still indexes; the impact operation then fails with mcp_tool_missing / _schema_mismatch.
 */
export const IMPACT_MCP_TOOLS = ['get_file_outline', 'trace_path'] as const;

export const IMPACT_TOOL_PARAMS: Readonly<Record<(typeof IMPACT_MCP_TOOLS)[number], readonly string[]>> =
  Object.freeze({
    get_file_outline: Object.freeze(['project', 'file_path']),
    trace_path: Object.freeze(['project', 'function_name', 'direction', 'depth']),
  });

/** Inbound CALLS hops walked from each seed (detect_changes default). */
export const IMPACT_DEPTH = 2;
/** Changed files whose declarations are looked up (one get_file_outline call each, plus pages). */
export const IMPACT_MAX_FILES = 200;
/** Seeds traced (one trace_path call each); further seeds are counted but not traced. */
export const IMPACT_MAX_SEEDS = 100;
/** Entries kept in `changed_files`, `seeds` and `impacted` of the stored result. */
export const IMPACT_MAX_LISTED = 500;
export const IMPACT_MAX_IMPACTED = 200;
/** `skipped_files` entries kept (the count is always exact). */
export const IMPACT_MAX_SKIPPED_LISTED = 50;
/** get_file_outline page size (v0.12.0 maximum) and pages read per file. */
export const OUTLINE_PAGE_LIMIT = 200;
export const OUTLINE_MAX_PAGES = 10;
/** trace_path rows requested per seed. */
export const TRACE_LIMIT = 200;

/** MCP client identity sent in `initialize` (§12.1). */
export const MCP_CLIENT_NAME = 'orc-mcp-manager';
export const DEFAULT_APP_VERSION = '0.0.0-dev';

/** Error messages taken from tool output are masked and capped (§12.2). */
export const ERROR_MESSAGE_MAX_CHARS = 2000;
/** Preview kept when a result exceeds MCP_RESULT_MAX_BYTES (§12.2). */
export const RESULT_PREVIEW_MAX_BYTES = 64 * 1024;
/** Counts are searched up to this object depth (§12.2). */
export const COUNT_SEARCH_MAX_DEPTH = 3;
export const NODE_COUNT_KEYS: readonly string[] = ['nodes', 'node_count', 'total_nodes', 'nodeCount'];
export const EDGE_COUNT_KEYS: readonly string[] = ['edges', 'edge_count', 'total_edges', 'edgeCount'];

/** Largest single JSON-RPC line accepted from the server. */
export const MAX_MESSAGE_LINE_BYTES = 16 * 1024 * 1024;
/** After stdin EOF the server gets this long to exit before the tree is stopped. */
export const CLOSE_EOF_GRACE_MS = 2000;
/** Grace between graceful and forced stop of the server process tree. */
export const STOP_GRACE_MS = 2000;
/** Stderr: lines kept for error details, max chars per kept/logged line. */
export const STDERR_TAIL_LINES = 20;
export const STDERR_LINE_MAX_CHARS = 1000;
/** Upper bound on tools/list pages followed through `nextCursor`. */
export const MAX_TOOL_LIST_PAGES = 20;

/** Child environment keys inherited from the worker in addition to the CBM_* overrides. */
export const MCP_INHERITED_ENV: readonly string[] = ['PATH'];
