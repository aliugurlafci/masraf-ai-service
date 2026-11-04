// stdout line splitting for stream-json (contract §10.5): split on \n, strip a trailing \r,
// cut lines longer than CLAUDE_MAX_LINE_BYTES (the rest of such a line is discarded).
import { StringDecoder } from 'node:string_decoder';

export interface SplitLine {
  text: string;
  /** The line exceeded the byte limit and was cut (rest discarded). */
  truncated: boolean;
}

const NEWLINE = 0x0a;

export class LineSplitter {
  private parts: Buffer[] = [];
  private size = 0;
  private discarding = false;
  private readonly maxLineBytes: number;

  constructor(maxLineBytes: number) {
    this.maxLineBytes = Math.max(1, Math.floor(maxLineBytes));
  }

  /** Bytes of the current unterminated line. */
  get pendingBytes(): number {
    return this.size;
  }

  push(chunk: Buffer): SplitLine[] {
    const out: SplitLine[] = [];
    let start = 0;
    while (start < chunk.length) {
      const nl = chunk.indexOf(NEWLINE, start);
      const end = nl === -1 ? chunk.length : nl;
      if (!this.discarding && end > start) {
        const piece = chunk.subarray(start, end);
        const room = this.maxLineBytes - this.size;
        if (piece.length > room) {
          if (room > 0) {
            this.parts.push(piece.subarray(0, room));
            this.size += room;
          }
          out.push(this.take(true));
          this.discarding = true;
        } else {
          this.parts.push(piece);
          this.size += piece.length;
        }
      }
      if (nl === -1) break;
      if (this.discarding) this.discarding = false;
      else out.push(this.take(false));
      start = nl + 1;
    }
    return out;
  }

  /** Emits an unterminated last line (end of stream). */
  flush(): SplitLine[] {
    if (this.discarding) {
      this.discarding = false;
      this.reset();
      return [];
    }
    return this.size > 0 ? [this.take(false)] : [];
  }

  private reset(): void {
    this.parts = [];
    this.size = 0;
  }

  private take(truncated: boolean): SplitLine {
    const buf = Buffer.concat(this.parts, this.size);
    this.reset();
    // StringDecoder.write holds back an incomplete trailing UTF-8 sequence (possible after a cut).
    let text = new StringDecoder('utf8').write(buf);
    if (!truncated && text.endsWith('\r')) text = text.slice(0, -1);
    return { text, truncated };
  }
}
