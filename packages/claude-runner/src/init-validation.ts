// Fail-closed validation of the `system/init` event (contract §10.6, ADR-0036 Decision 5).
import { posix, win32 } from 'node:path';
import { z } from 'zod';
import type { ClaudeAuthMode, ClaudeInitEvent } from '@orc/shared';
import type { HostPlatform } from '@orc/shared/node';
import { maskText } from '@orc/security';
import {
  CBM_MCP_SERVER_NAME,
  CBM_MCP_TOOL_PREFIX,
  CLAUDE_REVIEWED_EXTENSIONS,
  MCP_RESOURCE_TOOL_NAMES,
} from './constants';
import type {
  InitValidation,
  InitViolation,
  ReviewedExtensions,
  ValidateInitExpectations,
} from './types';

const DETAIL_MAX_CHARS = 1000;
const LIST_MAX_ITEMS = 20;

/** `apiKeySource` the CLI must report per auth mode (D-6). */
const EXPECTED_API_KEY_SOURCE: Readonly<Record<ClaudeAuthMode, string>> = Object.freeze({
  oauth: 'none',
  api_key: 'ANTHROPIC_API_KEY',
});

/** Init extension field -> table field (§10.6 extension rule). */
const EXTENSION_FIELDS = [
  ['skills', 'skills'],
  ['agents', 'agents'],
  ['slash_commands', 'slashCommands'],
  ['plugins', 'plugins'],
] as const satisfies readonly (readonly [string, keyof ReviewedExtensions])[];

/** Entries are names, or objects carrying a `name` (plugins: `{name, path, source}`). */
const ExtensionListSchema = z.array(
  z.union([z.string(), z.looseObject({ name: z.string() }).transform((o) => o.name)]),
);

/** `<cliVersion>/<posix|win32>/<oauth|api_key>`: the key of {@link CLAUDE_REVIEWED_EXTENSIONS}. */
export function claudeExtensionKey(
  cliVersion: string,
  platform: HostPlatform,
  authMode: ClaudeAuthMode,
): string {
  return `${cliVersion}/${platform}/${authMode}`;
}

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

function isEmptyMemoryValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.length === 0;
  if (Array.isArray(value)) return value.every(isEmptyMemoryValue);
  if (typeof value === 'object') return Object.values(value).every(isEmptyMemoryValue);
  return false;
}

/** The `extension` rule; returns the violation detail or null. */
function extensionProblem(init: ClaudeInitEvent, e: ValidateInitExpectations): string | null {
  const table = e.reviewedExtensions ?? CLAUDE_REVIEWED_EXTENSIONS;
  if (init.claude_code_version !== e.cliVersion) {
    return `claude_code_version=${JSON.stringify(init.claude_code_version ?? null)} differs from the probed CLI version ${JSON.stringify(e.cliVersion)}`;
  }
  const key = claudeExtensionKey(e.cliVersion, e.platform, e.authMode);
  const entry = Object.hasOwn(table, key) ? table[key] : undefined;
  if (entry === undefined) {
    return `no reviewed extension entry for ${JSON.stringify(key)} (CLAUDE_REVIEWED_EXTENSIONS)`;
  }
  const record = init as Record<string, unknown>;
  const problems: string[] = [];
  for (const [field, tableField] of EXTENSION_FIELDS) {
    const raw = record[field];
    if (raw === undefined) continue;
    const parsed = ExtensionListSchema.safeParse(raw);
    if (!parsed.success) {
      problems.push(`${field}: unparsable field`);
      continue;
    }
    const allowed = new Set(entry[tableField]);
    const unexpected = parsed.data.filter(
      (name) =>
        !allowed.has(name) &&
        // The CLI lists the MCP server's prompts as slash commands (recorded with codebase-memory-mcp).
        !(
          field === 'slash_commands' &&
          e.mcpEnabled &&
          name.startsWith(CBM_MCP_TOOL_PREFIX) &&
          name.length > CBM_MCP_TOOL_PREFIX.length
        ),
    );
    if (unexpected.length > 0) problems.push(`unexpected ${field}: ${describe(unexpected)}`);
  }
  return problems.length > 0 ? problems.join('; ') : null;
}

/**
 * Checks permission mode, MCP servers, tools (allowed and present), extensions, memory, auth source,
 * cwd and session id of an init event. A non-connected codebase-memory-mcp server is only a warning
 * (`mcpConnected: false`). The `hook_event` rule is enforced by the runner on every `system/hook_*`
 * line (it cannot be judged from the init alone).
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

  const present = new Set(tools);
  const missingTools = e.builtinTools.filter((t) => !present.has(t));
  if (missingTools.length > 0) {
    violations.push({
      rule: 'tool_missing',
      detail: detail(`requested builtin tool(s) missing from init: ${describe(missingTools)}`),
    });
  }

  const extension = extensionProblem(init, e);
  if (extension !== null) violations.push({ rule: 'extension', detail: detail(extension) });

  const memoryPaths = (init as Record<string, unknown>).memory_paths;
  if (!isEmptyMemoryValue(memoryPaths)) {
    violations.push({
      rule: 'memory',
      detail: detail(`memory_paths must be absent, null or empty (got ${JSON.stringify(memoryPaths)})`),
    });
  }

  const expectedSource = EXPECTED_API_KEY_SOURCE[e.authMode];
  if (init.apiKeySource !== expectedSource) {
    violations.push({
      rule: 'auth_source',
      detail: detail(
        `apiKeySource=${JSON.stringify(init.apiKeySource ?? null)} (expected ${JSON.stringify(expectedSource)} in ${e.authMode} mode)`,
      ),
    });
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
