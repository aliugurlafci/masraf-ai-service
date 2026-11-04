// Claude stream-json schemas (contract §3.4). Loose objects: unknown fields are preserved.
import { z } from 'zod';
import { CLAUDE_EVENT_KINDS, CLAUDE_EVENT_TEXT_MAX_CHARS } from '../constants';
import { IdSchema, IsoDateTimeSchema, jsonRecord } from './common';

export const ClaudeStreamLineSchema = z.looseObject({ type: z.string() });

export const ClaudeInitEventSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: z.string(),
  cwd: z.string(),
  tools: z.array(z.string()),
  mcp_servers: z.array(
    z.looseObject({ name: z.string(), status: z.string(), source: z.string().optional() }),
  ),
  model: z.string(),
  permissionMode: z.string(),
  claude_code_version: z.string().optional(),
  apiKeySource: z.string().optional(),
});
export type ClaudeInitEvent = z.infer<typeof ClaudeInitEventSchema>;

export const ClaudeAssistantEventSchema = z.looseObject({
  type: z.literal('assistant'),
  message: z.looseObject({ content: z.array(z.unknown()), usage: z.unknown().optional() }),
});
export type ClaudeAssistantEvent = z.infer<typeof ClaudeAssistantEventSchema>;

export const ClaudeUserEventSchema = z.looseObject({
  type: z.literal('user'),
  message: z.looseObject({ content: z.array(z.unknown()) }),
});
export type ClaudeUserEvent = z.infer<typeof ClaudeUserEventSchema>;

export const ClaudeResultEventSchema = z.looseObject({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  num_turns: z.number().optional(),
  result: z.string().optional(),
  total_cost_usd: z.number().optional(),
  usage: z
    .looseObject({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
    })
    .optional(),
  duration_ms: z.number().optional(),
  duration_api_ms: z.number().optional(),
  permission_denials: z.array(z.unknown()).optional(),
  session_id: z.string().optional(),
  stop_reason: z.string().nullable().optional(),
  terminal_reason: z.string().nullable().optional(),
});
export type ClaudeResultEvent = z.infer<typeof ClaudeResultEventSchema>;

export type ParsedClaudeLine =
  | { kind: 'init'; event: ClaudeInitEvent }
  | { kind: 'hook'; subtype: string; event: Record<string, unknown> }
  | { kind: 'system'; subtype: string | null; event: Record<string, unknown> }
  | { kind: 'assistant'; event: ClaudeAssistantEvent }
  | { kind: 'user'; event: ClaudeUserEvent }
  | { kind: 'result'; event: ClaudeResultEvent }
  | { kind: 'rate_limit'; event: Record<string, unknown> }
  | { kind: 'unknown'; event: Record<string, unknown> }
  | { kind: 'invalid'; raw: string; error: string };

/** SSE `claude` event data and Redis stream `claude` entry. */
export const ClaudeEventPayloadSchema = z.object({
  v: z.literal(1),
  type: z.literal('claude'),
  taskId: IdSchema,
  attemptId: IdSchema,
  line: z.int().min(0),
  block: z.int().min(0),
  kind: z.enum(CLAUDE_EVENT_KINDS),
  text: z.string().max(CLAUDE_EVENT_TEXT_MAX_CHARS).nullable(),
  toolName: z.string().nullable(),
  toolUseId: z.string().nullable(),
  isError: z.boolean().nullable(),
  data: jsonRecord.nullable(),
  at: IsoDateTimeSchema,
});
export type ClaudeEventPayload = z.infer<typeof ClaudeEventPayloadSchema>;
