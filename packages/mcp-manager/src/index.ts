// @orc/mcp-manager — codebase-memory-mcp client (contract §2.7, §12).
export {
  REQUIRED_MCP_TOOLS,
  REQUIRED_TOOL_PARAMS,
  IMPACT_MCP_TOOLS,
  IMPACT_TOOL_PARAMS,
} from './constants';
export { changedLines, isSafeRepoPath, selectSeeds } from './impact';
export type { Declaration } from './impact';
export type { McpErrorCode } from './errors';
export { McpError } from './errors';
export type {
  McpManagerConfig,
  McpToolInfo,
  McpToolResult,
  McpSession,
  McpClientFactory,
  McpOperationRecorder,
  OperationOutcome,
  McpProbeResult,
  IndexScope,
  ImpactChangeSet,
  ImpactFileChange,
  McpManager,
  ClaudeMcpConfigFile,
} from './types';
export { createSdkClientFactory } from './sdk-client';
export { createMcpManager } from './manager';
