import { OrcError, isOrcError } from '@orc/shared';
import { maskText } from '@orc/security';
import { ERROR_MESSAGE_MAX_CHARS } from './constants';

export type McpErrorCode =
  | 'mcp_unavailable'
  | 'mcp_tool_missing'
  | 'mcp_tool_schema_mismatch'
  | 'mcp_tool_error'
  | 'mcp_timeout'
  | 'mcp_protocol_error';

const MCP_ERROR_CODES: ReadonlySet<string> = new Set<McpErrorCode>([
  'mcp_unavailable',
  'mcp_tool_missing',
  'mcp_tool_schema_mismatch',
  'mcp_tool_error',
  'mcp_timeout',
  'mcp_protocol_error',
]);

export interface McpErrorOptions {
  details?: Record<string, unknown>;
  cause?: unknown;
}

/** Typed codebase-memory-mcp failure (contract §2.7, §12.4). */
export class McpError extends OrcError {
  declare readonly code: McpErrorCode;

  constructor(code: McpErrorCode, message?: string, options?: McpErrorOptions) {
    super(code, message === undefined ? undefined : clipMessage(message), options);
    this.name = 'McpError';
  }
}

export function isMcpErrorCode(code: string): code is McpErrorCode {
  return MCP_ERROR_CODES.has(code);
}

export function isMcpError(e: unknown): e is McpError {
  return isOrcError(e) && isMcpErrorCode(e.code);
}

/** Masks secrets and caps a message at ERROR_MESSAGE_MAX_CHARS. */
export function clipMessage(text: string): string {
  const masked = maskText(text);
  return masked.length > ERROR_MESSAGE_MAX_CHARS
    ? masked.slice(0, ERROR_MESSAGE_MAX_CHARS)
    : masked;
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'unknown error';
}
