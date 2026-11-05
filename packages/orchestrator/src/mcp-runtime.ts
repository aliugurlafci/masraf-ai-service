import type { FailureReason } from '@orc/shared';

/**
 * ADR-0037 item 4: what the pipeline does when `McpManager.ensureClaudeMcpRuntime` fails. Pure so it is testable
 * without a pipeline harness. `MCP_REQUIRED` and the project's `requireIndex` both fail the attempt closed
 * (K9 9.1); otherwise Claude starts without `--mcp-config` and the pipeline publishes a warning.
 */
export type McpRuntimeDecision =
  | { settle: readonly ['failed', Extract<FailureReason, 'security_violation' | 'workspace_error'>, string] }
  | { warn: { warning: 'mcp_runtime_rejected'; errorCode: string; message: string } };

function errorCodeOf(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return 'unknown';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function mcpRuntimeDecision(
  err: unknown,
  opts: { mcpRequired: boolean; requireIndex: boolean },
): McpRuntimeDecision {
  const errorCode = errorCodeOf(err);
  const message = messageOf(err);
  if (opts.mcpRequired || opts.requireIndex) {
    const reason = errorCode === 'path_escape' ? 'security_violation' : 'workspace_error';
    return { settle: ['failed', reason, message] as const };
  }
  return { warn: { warning: 'mcp_runtime_rejected', errorCode, message } };
}
