// In-memory McpClientFactory for manager unit tests (no process): scripted tools/list and tool handlers.
import { IMPACT_MCP_TOOLS, IMPACT_TOOL_PARAMS, REQUIRED_MCP_TOOLS, REQUIRED_TOOL_PARAMS } from '@orc/mcp-manager';
import type {
  McpClientFactory,
  McpSession,
  McpToolInfo,
  McpToolResult,
} from '@orc/mcp-manager';

export type ToolHandler = (
  args: Record<string, unknown>,
  o: { timeoutMs: number; signal?: AbortSignal },
) => Promise<McpToolResult> | McpToolResult;

export interface ConnectRecord {
  env: Record<string, string>;
  cwd: string;
  leaseKey: string;
  timeoutMs: number;
}

export interface CallRecord {
  tool: string;
  args: Record<string, unknown>;
  timeoutMs: number;
}

export interface ScriptedFactory extends McpClientFactory {
  readonly connects: ConnectRecord[];
  readonly calls: CallRecord[];
  closed: number;
  tools: McpToolInfo[];
  handlers: Record<string, ToolHandler>;
  connectError: Error | null;
}

/** Tools advertising REQUIRED_TOOL_PARAMS plus the given optional params. */
export function standardTools(optional: Partial<Record<string, string[]>> = {}): McpToolInfo[] {
  return REQUIRED_MCP_TOOLS.map((name) => {
    const props: Record<string, unknown> = {};
    for (const p of [...REQUIRED_TOOL_PARAMS[name], ...(optional[name] ?? [])]) props[p] = { type: 'string' };
    return { name, inputSchema: { properties: props } };
  });
}

/** The diff-seeded impact tools (get_file_outline, trace_path) with their required plus the given optional params. */
export function impactTools(optional: Partial<Record<string, string[]>> = {}): McpToolInfo[] {
  return IMPACT_MCP_TOOLS.map((name) => {
    const props: Record<string, unknown> = {};
    for (const p of [...IMPACT_TOOL_PARAMS[name], ...(optional[name] ?? [])]) props[p] = { type: 'string' };
    return { name, inputSchema: { properties: props } };
  });
}

/** A v0.12.0 get_file_outline page (`lines` = "start-end"). */
export function outlineResult(rows: [name: string, label: string, lines: string, qn: string][], hasMore = false): McpToolResult {
  return textResult({ file_path: 'x', cols: ['name', 'label', 'lines', 'qn'], rows, has_more: hasMore });
}

/** A v0.12.0 trace_path result grouped by qn_prefix. */
export function traceResult(callers: [qn: string, hop: number][], total = callers.length): McpToolResult {
  const groups = new Map<string, [string, number][]>();
  for (const [qn, hop] of callers) {
    const i = qn.lastIndexOf('.');
    const prefix = i === -1 ? '' : qn.slice(0, i);
    const rows = groups.get(prefix) ?? [];
    rows.push([i === -1 ? qn : qn.slice(i + 1), hop]);
    groups.set(prefix, rows);
  }
  return textResult({
    callers_total: total,
    callers: { cols: ['name', 'hop'], groups: [...groups].map(([qn_prefix, rows]) => ({ qn_prefix, rows })) },
  });
}

export function textResult(value: unknown, isError = false): McpToolResult {
  return { isError, structured: null, text: typeof value === 'string' ? value : JSON.stringify(value) };
}

export function structuredResult(value: unknown, text: string | null = null): McpToolResult {
  return { isError: false, structured: value, text };
}

export function createScriptedFactory(): ScriptedFactory {
  const factory: ScriptedFactory = {
    connects: [],
    calls: [],
    closed: 0,
    tools: [
      ...standardTools({ index_repository: ['doc_candidates', 'async'], index_status: ['format'], detect_changes: ['format'] }),
      ...impactTools({ get_file_outline: ['format', 'limit', 'offset'], trace_path: ['format', 'limit'] }),
    ],
    handlers: {
      index_repository: (args) => textResult({ project: args['name'], nodes: 12, edges: 7, status: 'indexed' }),
      index_status: (args) => textResult({ project: args['project'], nodes: 20, edges: 9, status: 'ready' }),
      list_projects: () => textResult({ projects: [] }),
      delete_project: (args) => textResult({ project: args['project'], status: 'deleted' }),
      detect_changes: () => textResult({ changed_files: ['src/a.ts'], impacted_symbols: [] }),
      get_file_outline: () => outlineResult([]),
      trace_path: () => traceResult([]),
    },
    connectError: null,
    connect(o) {
      factory.connects.push({ env: o.env, cwd: o.cwd, leaseKey: o.lease.key, timeoutMs: o.timeoutMs });
      if (factory.connectError) return Promise.reject(factory.connectError);
      let closed = false;
      const session: McpSession = {
        serverVersion: '0.12.0-scripted',
        listTools: () => Promise.resolve(factory.tools.map((t) => ({ ...t }))),
        async callTool(name, args, co) {
          if (closed) throw new Error('session closed');
          factory.calls.push({ tool: name, args, timeoutMs: co.timeoutMs });
          const h = factory.handlers[name];
          if (!h) return textResult({ error: `no handler for ${name}` }, true);
          return h(args, co);
        },
        close() {
          if (!closed) {
            closed = true;
            factory.closed += 1;
          }
          return Promise.resolve();
        },
      };
      return Promise.resolve(session);
    },
  };
  return factory;
}
