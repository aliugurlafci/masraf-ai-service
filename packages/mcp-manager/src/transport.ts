// ProcessStdioTransport: an MCP SDK Transport over a launcher-spawned SupervisedProcess (contract §12.1).
// Newline-delimited JSON-RPC on stdin/stdout; stderr lines are logged at debug (masked) and the last
// lines are kept for error details. An undecodable stdout line is a protocol error: the transport
// records it and closes, so pending requests fail and are mapped to `mcp_protocol_error`.
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { deserializeMessage, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { SupervisedProcess } from '@orc/shared/node';
import type { Logger } from '@orc/logger';
import { maskText } from '@orc/security';
import {
  CLOSE_EOF_GRACE_MS,
  MAX_MESSAGE_LINE_BYTES,
  STDERR_LINE_MAX_CHARS,
  STDERR_TAIL_LINES,
  STOP_GRACE_MS,
} from './constants';

export interface ProcessStdioTransportOptions {
  logger: Logger;
  maxLineBytes?: number;
  closeGraceMs?: number;
  stopGraceMs?: number;
}

/** How long to wait for buffered stdout after the process exited before reporting the close. */
const STDOUT_DRAIN_AFTER_EXIT_MS = 250;

const FatalErrorLine = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.null(),
  error: z.object({ code: z.number(), message: z.string() }).loose(),
});

function parseFatalError(line: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = FatalErrorLine.safeParse(raw);
  return parsed.success ? parsed.data.error.message : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

export class ProcessStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  private readonly proc: SupervisedProcess;
  private readonly logger: Logger;
  private readonly maxLineBytes: number;
  private readonly closeGraceMs: number;
  private readonly stopGraceMs: number;
  private stdoutChunks: Buffer[] = [];
  private stdoutBytes = 0;
  private stderrPartial = '';
  /** Keeps multi-byte UTF-8 sequences split across stderr chunks intact. */
  private readonly stderrDecoder = new StringDecoder('utf8');
  private readonly stderrLines: string[] = [];
  private started = false;
  private closing: Promise<void> | null = null;
  private closedNotified = false;
  private exitInfo: { exitCode: number | null; signal: string | null } | null = null;
  private protocolFault: string | null = null;
  private protocolSample: string | null = null;
  private fatalMessage: string | null = null;

  constructor(proc: SupervisedProcess, opts: ProcessStdioTransportOptions) {
    this.proc = proc;
    this.logger = opts.logger;
    this.maxLineBytes = opts.maxLineBytes ?? MAX_MESSAGE_LINE_BYTES;
    this.closeGraceMs = opts.closeGraceMs ?? CLOSE_EOF_GRACE_MS;
    this.stopGraceMs = opts.stopGraceMs ?? STOP_GRACE_MS;
  }

  get pid(): number {
    return this.proc.pid;
  }

  /** Set when the server wrote something that is not a JSON-RPC message. */
  get protocolError(): string | null {
    return this.protocolFault;
  }

  /** Masked prefix of the undecodable line. */
  get protocolErrorSample(): string | null {
    return this.protocolSample;
  }

  /** Message of a session-level JSON-RPC error (id null) sent by the server before it gave up. */
  get serverFatalError(): string | null {
    return this.fatalMessage;
  }

  get exit(): { exitCode: number | null; signal: string | null } | null {
    return this.exitInfo;
  }

  /** Last stderr lines (masked, capped). */
  stderrTail(): string[] {
    const partial = this.stderrPartial.trim();
    return partial.length > 0
      ? [...this.stderrLines, this.clipLine(partial)].slice(-STDERR_TAIL_LINES)
      : [...this.stderrLines];
  }

  start(): Promise<void> {
    if (this.started) {
      return Promise.reject(new Error('ProcessStdioTransport already started'));
    }
    this.started = true;
    let stdoutEnded = false;
    let resolveStdoutEnd: () => void = () => undefined;
    const stdoutEnd = new Promise<void>((resolve) => {
      resolveStdoutEnd = resolve;
    });
    this.proc.stdout.on('data', (chunk: Buffer | string) => this.onStdout(chunk));
    this.proc.stdout.on('end', () => {
      stdoutEnded = true;
      resolveStdoutEnd();
    });
    this.proc.stdout.on('error', (err: Error) => this.onerror?.(err));
    this.proc.stderr.on('data', (chunk: Buffer | string) => this.onStderr(chunk));
    this.proc.stderr.on('error', () => undefined);
    // EPIPE after the server died must not become an unhandled 'error' event; send() rejects instead.
    this.proc.stdin.on('error', (err: Error) => this.onerror?.(err));
    void this.proc.exited.then(async (info) => {
      this.exitInfo = info;
      if (!stdoutEnded) await Promise.race([stdoutEnd, delay(STDOUT_DRAIN_AFTER_EXIT_MS)]);
      this.flushStderr();
      this.notifyClosed();
    });
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (this.closing !== null || this.closedNotified || this.exitInfo !== null) {
      return Promise.reject(new Error('Not connected'));
    }
    const line = serializeMessage(message);
    return new Promise<void>((resolve, reject) => {
      this.proc.stdin.write(line, (err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  close(): Promise<void> {
    this.closing ??= this.doClose();
    return this.closing;
  }

  private async doClose(): Promise<void> {
    try {
      this.proc.stdin.end();
    } catch {
      // stdin already closed
    }
    if (this.exitInfo === null) {
      await Promise.race([this.proc.exited, delay(this.closeGraceMs)]);
    }
    if (this.exitInfo === null) {
      try {
        await this.proc.stop({ graceMs: this.stopGraceMs });
      } catch (e) {
        this.logger.warn(
          { source: 'mcp', pid: this.proc.pid, err: e instanceof Error ? e.message : String(e) },
          'codebase-memory-mcp process stop failed',
        );
      }
    }
    this.stdoutChunks = [];
    this.stdoutBytes = 0;
    this.flushStderr();
    this.notifyClosed();
  }

  private notifyClosed(): void {
    if (this.closedNotified) return;
    this.closedNotified = true;
    this.onclose?.();
  }

  private onStdout(chunk: Buffer | string): void {
    if (this.protocolFault !== null) return;
    let buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    for (;;) {
      const nl = buf.indexOf(0x0a);
      if (nl === -1) break;
      const head = buf.subarray(0, nl);
      buf = buf.subarray(nl + 1);
      const lineBuf = this.stdoutChunks.length > 0 ? Buffer.concat([...this.stdoutChunks, head]) : head;
      this.stdoutChunks = [];
      this.stdoutBytes = 0;
      if (!this.handleLine(lineBuf.toString('utf8'))) return;
    }
    if (buf.length > 0) {
      this.stdoutBytes += buf.length;
      if (this.stdoutBytes > this.maxLineBytes) {
        this.fault(`server message exceeds ${this.maxLineBytes} bytes`);
        return;
      }
      this.stdoutChunks.push(Buffer.from(buf));
    }
  }

  /** Returns false when the stream must stop being processed. */
  private handleLine(raw: string): boolean {
    const line = raw.replace(/\r$/, '');
    if (line.trim().length === 0) return true;
    let message: JSONRPCMessage;
    try {
      message = deserializeMessage(line);
    } catch {
      const fatal = parseFatalError(line);
      if (fatal !== null) {
        // JSON-RPC error with id null: the server refuses the session (e.g. its daemon cannot start);
        // it exits next, so the close maps to mcp_unavailable carrying this message.
        this.fatalMessage = this.clipLine(fatal);
        return true;
      }
      this.protocolSample = this.clipLine(line.slice(0, 200));
      this.fault('server wrote a line that is not a JSON-RPC message');
      return false;
    }
    try {
      this.onmessage?.(message);
    } catch (e) {
      this.onerror?.(e instanceof Error ? e : new Error(String(e)));
    }
    return true;
  }

  private fault(reason: string): void {
    this.protocolFault = reason;
    this.stdoutChunks = [];
    this.stdoutBytes = 0;
    this.onerror?.(new Error(reason));
    void this.close();
  }

  private onStderr(chunk: Buffer | string): void {
    this.stderrPartial += typeof chunk === 'string' ? chunk : this.stderrDecoder.write(chunk);
    const parts = this.stderrPartial.split(/\r?\n/);
    this.stderrPartial = parts.pop() ?? '';
    if (this.stderrPartial.length > STDERR_LINE_MAX_CHARS * 4) {
      parts.push(this.stderrPartial);
      this.stderrPartial = '';
    }
    for (const part of parts) this.recordStderr(part);
  }

  private flushStderr(): void {
    this.stderrPartial += this.stderrDecoder.end();
    if (this.stderrPartial.length > 0) {
      this.recordStderr(this.stderrPartial);
      this.stderrPartial = '';
    }
  }

  private clipLine(line: string): string {
    const masked = maskText(line);
    return masked.length > STDERR_LINE_MAX_CHARS ? masked.slice(0, STDERR_LINE_MAX_CHARS) : masked;
  }

  private recordStderr(raw: string): void {
    if (raw.trim().length === 0) return;
    const line = this.clipLine(raw);
    this.stderrLines.push(line);
    if (this.stderrLines.length > STDERR_TAIL_LINES) this.stderrLines.shift();
    this.logger.debug({ source: 'mcp', pid: this.proc.pid, stderr: line }, 'codebase-memory-mcp stderr');
  }
}
