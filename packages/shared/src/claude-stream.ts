// Pure stream-json parsing and summarization (contract §3.4, §10.5).
// Shared by the runner (live), the API (DB replay) and the web UI. Input lines are already masked.
import type { z } from 'zod';
import { CLAUDE_EVENT_TEXT_MAX_CHARS, type ClaudeEventKind } from './constants';
import { truncateText, utf8Length, type IsoDateTime, type Uuid } from './primitives';
import {
  ClaudeAssistantEventSchema,
  ClaudeInitEventSchema,
  ClaudeResultEventSchema,
  ClaudeStreamLineSchema,
  ClaudeUserEventSchema,
  type ClaudeEventPayload,
  type ParsedClaudeLine,
} from './schemas/claude';

const TEXT_MAX = CLAUDE_EVENT_TEXT_MAX_CHARS;
const SNIPPET_MAX = 2000;
const RATE_LIMIT_DATA_MAX_BYTES = 2048;
const ERROR_MAX = 500;

function describeIssues(error: z.ZodError): string {
  const text = error.issues
    .map(
      (i) =>
        `${i.path.length > 0 ? i.path.map((p) => String(p)).join('.') : '(root)'}: ${i.message}`,
    )
    .join('; ');
  return truncateText(text, ERROR_MAX);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parses one stdout line of `claude -p --output-format stream-json`. Never throws. */
export function parseClaudeLine(raw: string): ParsedClaudeLine {
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (line.trim().length === 0) return { kind: 'invalid', raw, error: 'empty line' };
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch (e) {
    return {
      kind: 'invalid',
      raw,
      error: `invalid JSON: ${e instanceof Error ? e.message : 'parse error'}`,
    };
  }
  if (!isRecord(json)) return { kind: 'invalid', raw, error: 'not a JSON object' };
  const base = ClaudeStreamLineSchema.safeParse(json);
  if (!base.success) return { kind: 'invalid', raw, error: describeIssues(base.error) };
  const event = base.data;

  switch (event.type) {
    case 'system': {
      const subtype = typeof event.subtype === 'string' ? event.subtype : null;
      if (subtype === 'init') {
        const init = ClaudeInitEventSchema.safeParse(event);
        return init.success
          ? { kind: 'init', event: init.data }
          : { kind: 'invalid', raw, error: `system/init: ${describeIssues(init.error)}` };
      }
      if (subtype !== null && subtype.startsWith('hook_')) return { kind: 'hook', subtype, event };
      return { kind: 'system', subtype, event };
    }
    case 'assistant': {
      const r = ClaudeAssistantEventSchema.safeParse(event);
      return r.success
        ? { kind: 'assistant', event: r.data }
        : { kind: 'invalid', raw, error: `assistant: ${describeIssues(r.error)}` };
    }
    case 'user': {
      const r = ClaudeUserEventSchema.safeParse(event);
      return r.success
        ? { kind: 'user', event: r.data }
        : { kind: 'invalid', raw, error: `user: ${describeIssues(r.error)}` };
    }
    case 'result': {
      const r = ClaudeResultEventSchema.safeParse(event);
      return r.success
        ? { kind: 'result', event: r.data }
        : { kind: 'invalid', raw, error: `result: ${describeIssues(r.error)}` };
    }
    case 'rate_limit_event':
      return { kind: 'rate_limit', event };
    default:
      return { kind: 'unknown', event };
  }
}

export interface SummarizeContext {
  taskId: Uuid;
  attemptId: Uuid;
  line: number;
  at: IsoDateTime;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '[unserializable]';
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function toolResultText(content: unknown): string | null {
  if (content === undefined || content === null) return null;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content.map((c) =>
      isRecord(c) && c.type === 'text' && typeof c.text === 'string' ? c.text : safeJson(c),
    );
    return parts.join('\n');
  }
  return safeJson(content);
}

/** Maps a parsed line to SSE/Redis `claude` payloads (one per content block; one for other kinds). */
export function summarizeClaudeLine(
  p: ParsedClaudeLine,
  ctx: SummarizeContext,
): ClaudeEventPayload[] {
  const make = (
    block: number,
    kind: ClaudeEventKind,
    fields: Partial<
      Pick<ClaudeEventPayload, 'text' | 'toolName' | 'toolUseId' | 'isError' | 'data'>
    > = {},
  ): ClaudeEventPayload => ({
    v: 1,
    type: 'claude',
    taskId: ctx.taskId,
    attemptId: ctx.attemptId,
    line: ctx.line,
    block,
    kind,
    text:
      fields.text === undefined || fields.text === null
        ? null
        : truncateText(fields.text, TEXT_MAX),
    toolName: fields.toolName ?? null,
    toolUseId: fields.toolUseId ?? null,
    isError: fields.isError ?? null,
    data: fields.data ?? null,
    at: ctx.at,
  });

  switch (p.kind) {
    case 'assistant':
      return p.event.message.content.map((block, i) => {
        if (!isRecord(block)) return make(i, 'unknown', { text: typeof block });
        switch (block.type) {
          case 'text':
            return make(i, 'assistant_text', { text: str(block.text) ?? '' });
          case 'thinking':
            return make(i, 'thinking', { text: str(block.thinking) });
          case 'tool_use':
            return make(i, 'tool_use', {
              toolName: str(block.name),
              toolUseId: str(block.id),
              text: truncateText(safeJson(block.input ?? null), SNIPPET_MAX),
            });
          default:
            return make(i, 'unknown', { text: str(block.type) ?? 'assistant' });
        }
      });
    case 'user':
      return p.event.message.content.map((block, i) => {
        if (isRecord(block) && block.type === 'tool_result') {
          const text = toolResultText(block.content);
          return make(i, 'tool_result', {
            toolUseId: str(block.tool_use_id),
            isError: typeof block.is_error === 'boolean' ? block.is_error : null,
            text: text === null ? null : truncateText(text, SNIPPET_MAX),
          });
        }
        return make(i, 'unknown', {
          text: isRecord(block) ? (str(block.type) ?? 'user') : typeof block,
        });
      });
    case 'result':
      return [
        make(0, 'result', {
          text: p.event.result ?? null,
          isError: p.event.is_error,
          data: {
            subtype: p.event.subtype,
            isError: p.event.is_error,
            numTurns: num(p.event.num_turns),
            totalCostUsd: num(p.event.total_cost_usd),
            durationMs: num(p.event.duration_ms),
          },
        }),
      ];
    case 'init':
      return [
        make(0, 'init', {
          data: {
            model: p.event.model,
            sessionId: p.event.session_id,
            tools: p.event.tools.length,
            mcpServers: p.event.mcp_servers.map((s) => ({ name: s.name, status: s.status })),
          },
        }),
      ];
    case 'hook':
    case 'system':
      return [make(0, 'system', { text: p.subtype ?? 'system', data: { subtype: p.subtype } })];
    case 'rate_limit': {
      const json = safeJson(p.event);
      const data: Record<string, unknown> =
        utf8Length(json) <= RATE_LIMIT_DATA_MAX_BYTES
          ? p.event
          : { truncated: true, preview: truncateText(json, RATE_LIMIT_DATA_MAX_BYTES / 4) };
      return [make(0, 'rate_limit', { data })];
    }
    case 'unknown':
      return [make(0, 'unknown', { text: str(p.event.type) ?? 'unknown' })];
    case 'invalid':
      return [
        make(0, 'invalid', { text: truncateText(p.raw, SNIPPET_MAX), data: { error: p.error } }),
      ];
  }
}
