// NDJSON framing with a hard per-frame size limit (contract §10.11 item 5).
import type { z } from 'zod';
import { protocolError } from './errors';
import { MAX_FRAME_BYTES } from './protocol';

const NEWLINE = 0x0a;

/**
 * Splits a byte stream into lines. A line longer than `maxBytes` (newline excluded) raises a
 * protocol error as soon as it is detected, without buffering the remainder.
 */
export class FrameDecoder {
  private readonly maxBytes: number;
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  constructor(maxBytes: number = MAX_FRAME_BYTES) {
    this.maxBytes = maxBytes;
  }

  /** Returns the complete lines contained in `chunk` (plus buffered bytes). */
  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(NEWLINE, start);
      if (nl === -1) break;
      const part = chunk.subarray(start, nl);
      const total = this.pendingBytes + part.length;
      if (total > this.maxBytes) throw protocolError('Frame exceeds the size limit');
      const line = this.pending.length === 0 ? part : Buffer.concat([...this.pending, part], total);
      this.pending = [];
      this.pendingBytes = 0;
      lines.push(line.toString('utf8'));
      start = nl + 1;
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      this.pendingBytes += rest.length;
      if (this.pendingBytes > this.maxBytes) throw protocolError('Frame exceeds the size limit');
      this.pending.push(Buffer.from(rest));
    }
    return lines;
  }

  /** Bytes of an unterminated trailing line. */
  get buffered(): number {
    return this.pendingBytes;
  }
}

/** Serializes one frame as a JSON line; throws when it would exceed {@link MAX_FRAME_BYTES}. */
export function encodeFrame(frame: object): Buffer {
  const json = Buffer.from(JSON.stringify(frame), 'utf8');
  if (json.length > MAX_FRAME_BYTES) throw protocolError('Frame exceeds the size limit');
  return Buffer.concat([json, Buffer.from('\n')]);
}

/** JSON.parse + strict schema validation; any failure is a protocol error. */
export function parseFrame<S extends z.ZodType>(schema: S, line: string): z.output<S> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    // The SyntaxError quotes part of the input; a spawn frame carries env values (API key, proxy
    // credentials), so the cause is never attached and cannot reach a log line.
    throw protocolError('Frame is not valid JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw protocolError('Frame failed schema validation');
  return parsed.data;
}
