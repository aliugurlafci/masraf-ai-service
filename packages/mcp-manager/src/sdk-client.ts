// McpClientFactory over the official SDK Client and ProcessStdioTransport (contract §2.7, §12.1).
import { basename } from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CallToolResultSchema,
  ErrorCode as SdkErrorCode,
  McpError as SdkMcpError,
} from '@modelcontextprotocol/sdk/types.js';
import { OrcError, isOrcError } from '@orc/shared';
import type { LaunchLease, SupervisedProcess } from '@orc/shared/node';
import type { Logger } from '@orc/logger';
import { serializeError } from '@orc/logger';
import {
  DEFAULT_APP_VERSION,
  MAX_TOOL_LIST_PAGES,
  MCP_CLIENT_NAME,
} from './constants';
import { McpError, errorText, isMcpError } from './errors';
import { ProcessStdioTransport } from './transport';
import type {
  McpClientFactory,
  McpManagerConfig,
  McpSession,
  McpToolInfo,
  McpToolResult,
  SdkClientFactoryDeps,
} from './types';

const ToolInfoSchema = z
  .object({
    name: z.string().min(1),
    inputSchema: z
      .object({ properties: z.record(z.string(), z.unknown()).optional() })
      .loose(),
  })
  .loose();

const ToolResultShape = z
  .object({
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
    content: z
      .array(z.object({ type: z.string(), text: z.string().optional() }).loose())
      .optional(),
  })
  .loose();

type Phase = 'connect' | 'list' | 'call';

function abortedError(phase: Phase, tool: string | null, cause?: unknown): McpError {
  return new McpError('mcp_timeout', 'codebase-memory-mcp operation aborted', {
    cause,
    details: { phase, tool, aborted: true },
  });
}

/**
 * Maps any failure raised while talking to the server to a typed McpError (§12.4):
 * abort/RequestTimeout => mcp_timeout (connect: mcp_unavailable), undecodable output => mcp_protocol_error,
 * connection closed / process gone => mcp_unavailable, JSON-RPC error answer => mcp_tool_error,
 * anything else (schema violation of a result) => mcp_protocol_error.
 */
function mapSdkError(
  e: unknown,
  ctx: { phase: Phase; tool: string | null; timeoutMs: number; transport: ProcessStdioTransport; signal?: AbortSignal | undefined },
): McpError {
  if (isMcpError(e)) return e;
  const { phase, tool, timeoutMs, transport, signal } = ctx;
  const details: Record<string, unknown> = { phase, tool };
  const tail = transport.stderrTail();
  if (tail.length > 0) details['stderrTail'] = tail;
  const exit = transport.exit;
  if (exit !== null) details['exit'] = exit;
  const fatal = transport.serverFatalError;
  if (fatal !== null) details['serverError'] = fatal;
  if (signal?.aborted === true) return abortedError(phase, tool, e);
  if (transport.protocolError !== null) {
    const sample = transport.protocolErrorSample;
    if (sample !== null) details['sample'] = sample;
    return new McpError('mcp_protocol_error', `Undecodable response from codebase-memory-mcp: ${transport.protocolError}`, {
      cause: e,
      details,
    });
  }
  if (e instanceof SdkMcpError) {
    if (e.code === Number(SdkErrorCode.RequestTimeout)) {
      if (phase === 'connect') {
        return new McpError('mcp_unavailable', `codebase-memory-mcp did not answer initialize within ${timeoutMs} ms`, {
          cause: e,
          details,
        });
      }
      return new McpError('mcp_timeout', `codebase-memory-mcp ${tool ?? phase} exceeded ${timeoutMs} ms`, {
        cause: e,
        details: { ...details, timeoutMs },
      });
    }
    if (e.code === Number(SdkErrorCode.ConnectionClosed)) {
      const how = exit !== null ? ` (exit code ${String(exit.exitCode)}, signal ${String(exit.signal)})` : '';
      const why = fatal !== null ? `: ${fatal}` : '';
      return new McpError('mcp_unavailable', `codebase-memory-mcp connection closed${how}${why}`, { cause: e, details });
    }
    if (phase === 'connect') {
      return new McpError('mcp_unavailable', `codebase-memory-mcp initialize failed: ${e.message}`, { cause: e, details });
    }
    if (e.code === Number(SdkErrorCode.ParseError)) {
      return new McpError('mcp_protocol_error', e.message, { cause: e, details: { ...details, rpcCode: e.code } });
    }
    return new McpError('mcp_tool_error', e.message, { cause: e, details: { ...details, rpcCode: e.code } });
  }
  if (phase === 'connect') {
    return new McpError('mcp_unavailable', `codebase-memory-mcp connect failed: ${errorText(e)}`, { cause: e, details });
  }
  if (exit !== null) {
    return new McpError('mcp_unavailable', `codebase-memory-mcp exited: ${errorText(e)}`, { cause: e, details });
  }
  return new McpError('mcp_protocol_error', `Unexpected response from codebase-memory-mcp: ${errorText(e)}`, {
    cause: e,
    details,
  });
}

class SdkSession implements McpSession {
  readonly serverVersion: string | null;
  private readonly client: Client;
  private readonly transport: ProcessStdioTransport;
  private readonly listTimeoutMs: number;
  private closing: Promise<void> | null = null;

  constructor(client: Client, transport: ProcessStdioTransport, listTimeoutMs: number) {
    this.client = client;
    this.transport = transport;
    this.listTimeoutMs = listTimeoutMs;
    this.serverVersion = client.getServerVersion()?.version ?? null;
  }

  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    try {
      for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
        const res = await this.client.listTools(cursor === undefined ? undefined : { cursor }, {
          timeout: this.listTimeoutMs,
          maxTotalTimeout: this.listTimeoutMs,
        });
        for (const raw of res.tools) {
          const parsed = ToolInfoSchema.safeParse(raw);
          if (!parsed.success) {
            throw new McpError('mcp_protocol_error', 'tools/list returned a malformed tool entry');
          }
          const props = parsed.data.inputSchema.properties;
          tools.push({ name: parsed.data.name, inputSchema: props === undefined ? {} : { properties: props } });
        }
        cursor = res.nextCursor;
        if (cursor === undefined || cursor.length === 0) break;
      }
    } catch (e) {
      throw mapSdkError(e, { phase: 'list', tool: null, timeoutMs: this.listTimeoutMs, transport: this.transport });
    }
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    o: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<McpToolResult> {
    if (o.signal?.aborted === true) throw abortedError('call', name);
    let raw: unknown;
    try {
      // timeout = maxTotalTimeout; no resetTimeoutOnProgress and no onprogress (§12.2, T-m9)
      raw = await this.client.callTool({ name, arguments: args }, CallToolResultSchema, {
        timeout: o.timeoutMs,
        maxTotalTimeout: o.timeoutMs,
        ...(o.signal ? { signal: o.signal } : {}),
      });
    } catch (e) {
      throw mapSdkError(e, { phase: 'call', tool: name, timeoutMs: o.timeoutMs, transport: this.transport, signal: o.signal });
    }
    const parsed = ToolResultShape.safeParse(raw);
    if (!parsed.success) {
      throw new McpError('mcp_protocol_error', `Malformed tools/call result for ${name}`, { details: { tool: name } });
    }
    const firstText = parsed.data.content?.find((c) => c.type === 'text' && typeof c.text === 'string');
    const structured = parsed.data.structuredContent;
    return {
      isError: parsed.data.isError === true,
      structured: structured === undefined ? null : structured,
      text: firstText?.text ?? null,
    };
  }

  close(): Promise<void> {
    this.closing ??= this.client.close().then(
      () => this.transport.close(),
      () => this.transport.close(),
    );
    return this.closing;
  }
}

/**
 * Factory spawning one codebase-memory-mcp server per connection through `launcher.spawn(lease, {kind: 'mcp'})`
 * and speaking MCP over its stdio (ProcessStdioTransport; stderr piped and logged at debug, masked).
 */
export function createSdkClientFactory(cfg: McpManagerConfig, deps: SdkClientFactoryDeps): McpClientFactory {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cfg.bin)) {
    throw new OrcError(
      'config_invalid',
      'CODEBASE_MEMORY_MCP_BIN must be an .exe on win32 (or an interpreter with the script in CODEBASE_MEMORY_MCP_BIN_PREFIX_ARGS)',
    );
  }
  const logger: Logger = deps.logger;
  const command = basename(cfg.bin);
  const appVersion = cfg.appVersion ?? DEFAULT_APP_VERSION;

  return {
    async connect(o: {
      env: Record<string, string>;
      cwd: string;
      lease: LaunchLease;
      timeoutMs: number;
      signal?: AbortSignal;
    }): Promise<McpSession> {
      if (o.signal?.aborted === true) throw abortedError('connect', null);
      let proc: SupervisedProcess;
      try {
        proc = await deps.launcher.spawn(o.lease, {
          kind: 'mcp',
          cmd: cfg.bin,
          args: [...cfg.binPrefixArgs],
          cwd: o.cwd,
          env: o.env,
        });
      } catch (e) {
        const detail = isOrcError(e) ? { reason: e.code, ...(e.details ?? {}) } : { reason: errorText(e) };
        throw new McpError('mcp_unavailable', `Failed to start ${command}: ${errorText(e)}`, {
          cause: e,
          details: { command, ...detail },
        });
      }
      const transport = new ProcessStdioTransport(proc, { logger });
      const client = new Client({ name: MCP_CLIENT_NAME, version: appVersion }, { capabilities: {} });
      client.onerror = (err: Error) => {
        logger.debug({ source: 'mcp', pid: proc.pid, err: serializeError(err) }, 'codebase-memory-mcp transport error');
      };
      try {
        await client.connect(transport, {
          timeout: o.timeoutMs,
          maxTotalTimeout: o.timeoutMs,
          ...(o.signal ? { signal: o.signal } : {}),
        });
      } catch (e) {
        const mapped = mapSdkError(e, {
          phase: 'connect',
          tool: null,
          timeoutMs: o.timeoutMs,
          transport,
          signal: o.signal,
        });
        await client.close().catch(() => undefined);
        await transport.close();
        throw mapped;
      }
      logger.debug(
        { source: 'mcp', pid: proc.pid, serverVersion: client.getServerVersion()?.version ?? null },
        'codebase-memory-mcp connected',
      );
      return new SdkSession(client, transport, cfg.callTimeoutMs);
    },
  };
}
