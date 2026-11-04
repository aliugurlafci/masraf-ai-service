// tools/list checks (contract §12.1): names are verified on every connection and never guessed; optional
// parameters are sent only when the tool advertises them (§12.2).
import { REQUIRED_MCP_TOOLS, REQUIRED_TOOL_PARAMS } from './constants';
import { McpError } from './errors';
import type { McpToolInfo } from './types';

export type ToolMap = ReadonlyMap<string, McpToolInfo>;

/** Every name of `names` must exist with `params[name]` in its inputSchema.properties. */
export function checkTools(
  tools: ToolMap,
  names: readonly string[] = REQUIRED_MCP_TOOLS,
  params: Readonly<Record<string, readonly string[]>> = REQUIRED_TOOL_PARAMS,
): { missingTools: string[]; schemaMismatches: string[] } {
  const missingTools: string[] = [];
  const schemaMismatches: string[] = [];
  for (const name of names) {
    const tool = tools.get(name);
    if (tool === undefined) {
      missingTools.push(name);
      continue;
    }
    const props = tool.inputSchema.properties ?? {};
    for (const param of params[name] ?? []) {
      if (!Object.hasOwn(props, param)) schemaMismatches.push(`${name}.${param}`);
    }
  }
  return { missingTools, schemaMismatches };
}

/** Throws mcp_tool_missing / mcp_tool_schema_mismatch (§12.4). */
export function verifyTools(
  tools: ToolMap,
  names?: readonly string[],
  params?: Readonly<Record<string, readonly string[]>>,
): void {
  const { missingTools, schemaMismatches } = checkTools(tools, names, params);
  if (missingTools.length > 0) {
    throw new McpError('mcp_tool_missing', `codebase-memory-mcp lacks required tools: ${missingTools.join(', ')}`, {
      details: { missingTools },
    });
  }
  if (schemaMismatches.length > 0) {
    throw new McpError(
      'mcp_tool_schema_mismatch',
      `codebase-memory-mcp tool parameters missing: ${schemaMismatches.join(', ')}`,
      { details: { schemaMismatches } },
    );
  }
}

/** Optional parameters are sent only when the tool advertises them (§12.2). */
export function supports(tools: ToolMap, tool: string, param: string): boolean {
  const props = tools.get(tool)?.inputSchema.properties;
  return props !== undefined && Object.hasOwn(props, param);
}
