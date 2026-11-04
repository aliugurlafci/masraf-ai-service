// Defensive decoding of codebase-memory-mcp tool results (contract §12.2).
import { z } from 'zod';
import { maskObject } from '@orc/security';
import {
  COUNT_SEARCH_MAX_DEPTH,
  EDGE_COUNT_KEYS,
  NODE_COUNT_KEYS,
  RESULT_PREVIEW_MAX_BYTES,
} from './constants';
import { McpError } from './errors';
import type { McpToolResult } from './types';

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Value of a successful result: `structuredContent` if it is an object, else the first text content
 * parsed as JSON, else `{text}`. A result with neither yields null.
 */
export function decodeValue(r: McpToolResult): unknown {
  if (isPlainObject(r.structured)) return r.structured;
  if (r.text === null) return null;
  const trimmed = r.text.trim();
  if (trimmed.length > 0) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      // not JSON: fall through to the text wrapper
    }
  }
  return { text: r.text };
}

/** `isError` => mcp_tool_error (message = first text, masked, <= 2000 chars). */
export function toolErrorFrom(tool: string, r: McpToolResult): McpError {
  const text = r.text ?? (isPlainObject(r.structured) ? JSON.stringify(r.structured) : null);
  const message = text !== null && text.trim().length > 0 ? text : `Tool ${tool} returned an error`;
  return new McpError('mcp_tool_error', message, { details: { tool } });
}

function asCount(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.min(Math.trunc(v), 2_147_483_647);
}

/** First numeric field (breadth-first, object depth <= 3) whose key is one of `keys`. */
export function findCount(value: unknown, keys: readonly string[]): number | null {
  let level: Record<string, unknown>[] = isPlainObject(value) ? [value] : [];
  for (let depth = 1; depth <= COUNT_SEARCH_MAX_DEPTH && level.length > 0; depth += 1) {
    const next: Record<string, unknown>[] = [];
    for (const obj of level) {
      for (const [key, v] of Object.entries(obj)) {
        if (keys.includes(key)) {
          const n = asCount(v);
          if (n !== null) return n;
        }
        if (isPlainObject(v)) next.push(v);
      }
    }
    level = next;
  }
  return null;
}

export function extractCounts(value: unknown): { nodeCount: number | null; edgeCount: number | null } {
  return { nodeCount: findCount(value, NODE_COUNT_KEYS), edgeCount: findCount(value, EDGE_COUNT_KEYS) };
}

/** UTF-8 safe prefix of at most `maxBytes` bytes. */
function utf8Prefix(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // step back to a UTF-8 lead byte so no code point is cut
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Masks secrets and caps the stored JSON at `maxBytes`; larger values become
 * `{truncated: true, preview: <first 64 KiB of the JSON text>}`.
 */
export function capResult(value: unknown, maxBytes: number): unknown {
  if (value === undefined || value === null) return null;
  const masked = maskObject(value);
  let json: string;
  try {
    json = JSON.stringify(masked) ?? 'null';
  } catch {
    return { truncated: true, preview: '' };
  }
  if (Buffer.byteLength(json, 'utf8') <= maxBytes) return masked;
  const previewBytes = Math.max(0, Math.min(RESULT_PREVIEW_MAX_BYTES, maxBytes - 64));
  // the preview is JSON-escaped inside the stored document, so shrink until the envelope fits
  let preview = utf8Prefix(json, previewBytes);
  while (preview.length > 0) {
    const envelope = JSON.stringify({ truncated: true, preview });
    if (Buffer.byteLength(envelope, 'utf8') <= maxBytes) break;
    preview = utf8Prefix(preview, Math.floor(Buffer.byteLength(preview, 'utf8') * 0.9));
  }
  return { truncated: true, preview };
}

const NotFoundShape = z
  .object({ status: z.string().optional(), error: z.string().optional() })
  .loose();

/** True when a delete_project error result means "nothing to delete" (v0.12.0 reports status not_found). */
export function isNotFoundResult(r: McpToolResult): boolean {
  const parsed = NotFoundShape.safeParse(decodeValue(r));
  if (!parsed.success) return false;
  return parsed.data.status === 'not_found' || /not found/i.test(parsed.data.error ?? '');
}
