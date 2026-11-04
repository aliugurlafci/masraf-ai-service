import { maskObject, maskText } from '@orc/security';
import type { SecretRegistry } from '@orc/security';

export interface SerializedError {
  type: string;
  message: string;
  code?: string;
  stack?: string;
}

const MAX_MESSAGE_CHARS = 16 * 1024;
const MAX_STACK_CHARS = 32 * 1024;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text;
}

function describe(value: unknown, registry: SecretRegistry | undefined): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value);
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
  try {
    return JSON.stringify(maskObject(value, registry)) ?? Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function isSerializedError(value: unknown): value is SerializedError {
  if (value === null || typeof value !== 'object' || value instanceof Error) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.type === 'string' &&
    typeof v.message === 'string' &&
    Object.keys(v).every((k) => ['type', 'message', 'code', 'stack'].includes(k))
  );
}

/** Error-like -> `{type, message, code?, stack?}` with message and stack masked. Never throws. */
export function serializeErrorWith(err: unknown, registry?: SecretRegistry): SerializedError {
  if (isSerializedError(err)) {
    const out: SerializedError = { type: err.type, message: maskText(err.message, registry) };
    if (err.code !== undefined) out.code = err.code;
    if (err.stack !== undefined) out.stack = maskText(err.stack, registry);
    return out;
  }
  if (err instanceof Error) {
    const out: SerializedError = {
      type: err.name || err.constructor.name || 'Error',
      message: clip(maskText(err.message, registry), MAX_MESSAGE_CHARS),
    };
    const code: unknown = (err as { code?: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number') out.code = String(code);
    if (typeof err.stack === 'string')
      out.stack = clip(maskText(err.stack, registry), MAX_STACK_CHARS);
    return out;
  }
  const type =
    err === null
      ? 'null'
      : typeof err === 'object'
        ? (err.constructor?.name ?? 'Object')
        : typeof err;
  return { type, message: clip(maskText(describe(err, registry), registry), MAX_MESSAGE_CHARS) };
}

/** Contract §2.4: `{type, message, code?, stack?}`; masks message (and stack) with the §17.2 patterns. */
export function serializeError(err: unknown): SerializedError {
  return serializeErrorWith(err);
}
