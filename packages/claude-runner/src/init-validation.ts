// Fail-closed validation of the `system/init` event (contract §10.6).
import { posix, win32 } from 'node:path';
import type { ClaudeInitEvent } from '@orc/shared';
import { maskText } from '@orc/security';
import { CBM_MCP_SERVER_NAME, CBM_MCP_TOOL_PREFIX, MCP_RESOURCE_TOOL_NAMES } from './constants';
import type { InitValidation, InitViolation, ValidateInitExpectations } from './types';

const DETAIL_MAX_CHARS = 1000;
const LIST_MAX_ITEMS = 20;

function describe(values: readonly string[]): string {
  const shown = values.slice(0, LIST_MAX_ITEMS).map((v) => JSON.stringify(v));
  const more = values.length > LIST_MAX_ITEMS ? `, ... (+${values.length - LIST_MAX_ITEMS})` : '';
  return shown.join(', ') + more;
}

function detail(text: string): string {
  const masked = maskText(text);
  return masked.length > DETAIL_MAX_CHARS ? `${masked.slice(0, DETAIL_MAX_CHARS)}...` : masked;
}

function sameCwd(actual: string, expected: string, platform: 'posix' | 'win32'): boolean {
  if (typeof actual !== 'string' || actual.length === 0) return false;
  if (platform === 'win32') {
    return win32.resolve(actual).toLowerCase() === win32.resolve(expected).toLowerCase();
  }
  return posix.resolve(actual) === posix.resolve(expected);
}

/**
 * Checks permission mode, MCP servers, tools, cwd and session id of an init event. A non-connected
 * codebase-memory-mcp server is only a warning (`mcpConnected: false`). The `hook_event` rule is
 * enforced by the runner on every `system/hook_*` line (it cannot be judged from the init alone).
 */
export function validateInit(init: ClaudeInitEvent, e: ValidateInitExpectations): InitValidation {
  const violations: InitViolation[] = [];

  if (init.permissionMode !== e.permissionMode) {
    violations.push({
      rule: 'permission_mode',
      detail: detail(`permissionMode=${JSON.stringify(init.permissionMode)} (expected "${e.permissionMode}")`),
    });
  }

  const servers = Array.isArray(init.mcp_servers) ? init.mcp_servers : [];
  const foreignServers = servers
    .map((s) => s.name)
    .filter((name) => !e.mcpEnabled || name !== CBM_MCP_SERVER_NAME);
  if (foreignServers.length > 0) {
    violations.push({
      rule: 'mcp_server',
      detail: detail(
        `unexpected MCP server(s): ${describe(foreignServers)}${e.mcpEnabled ? '' : ' (MCP disabled)'}`,
      ),
    });
  }
  const mcpConnected =
    e.mcpEnabled &&
    servers.some((s) => s.name === CBM_MCP_SERVER_NAME && s.status === 'connected');

  const allowed = new Set<string>([...e.builtinTools, ...e.extraTools]);
  if (e.mcpEnabled) for (const t of MCP_RESOURCE_TOOL_NAMES) allowed.add(t);
  const tools = Array.isArray(init.tools) ? init.tools : [];
  const foreignTools = tools.filter(
    (t) => !(allowed.has(t) || (e.mcpEnabled && t.startsWith(CBM_MCP_TOOL_PREFIX) && t.length > CBM_MCP_TOOL_PREFIX.length)),
  );
  if (foreignTools.length > 0) {
    violations.push({ rule: 'tool', detail: detail(`unexpected tool(s): ${describe(foreignTools)}`) });
  }

  if (!sameCwd(init.cwd, e.cwd, e.platform)) {
    violations.push({
      rule: 'cwd',
      detail: detail(`cwd=${JSON.stringify(init.cwd)} (expected ${JSON.stringify(e.cwd)})`),
    });
  }

  if (e.sessionId !== null && init.session_id !== e.sessionId) {
    violations.push({
      rule: 'session_id',
      detail: detail(`session_id=${JSON.stringify(init.session_id)} (expected ${JSON.stringify(e.sessionId)})`),
    });
  }

  return { ok: violations.length === 0, violations, mcpConnected };
}
