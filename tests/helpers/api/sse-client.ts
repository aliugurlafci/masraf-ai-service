// Minimal incremental text/event-stream client for SSE tests (contract §8.2 wire format).
export interface SseEvent {
  id: string | null;
  event: string;
  data: unknown;
}

export class SseClient {
  readonly status: number;
  readonly headers: Headers;
  readonly events: SseEvent[] = [];
  retry: number | null = null;
  ended = false;
  private buffer = '';
  private readonly reader: ReadableStreamDefaultReader<Uint8Array> | null;
  private readonly decoder = new TextDecoder();
  private readonly controller: AbortController;
  private pending: Promise<void> | null = null;

  private constructor(res: Response, controller: AbortController) {
    this.status = res.status;
    this.headers = res.headers;
    this.controller = controller;
    this.reader = res.body ? res.body.getReader() : null;
  }

  static async open(url: string, headers: Record<string, string> = {}): Promise<SseClient> {
    const controller = new AbortController();
    const res = await fetch(url, { headers: { Accept: 'text/event-stream', ...headers }, signal: controller.signal });
    return new SseClient(res, controller);
  }

  /** Body of a non-SSE answer (Problem Details). */
  async json(): Promise<unknown> {
    const text = await this.readAll();
    return text === '' ? null : (JSON.parse(text) as unknown);
  }

  private async readAll(): Promise<string> {
    if (!this.reader) return '';
    let text = '';
    for (;;) {
      const { done, value } = await this.reader.read();
      if (done) break;
      text += this.decoder.decode(value, { stream: true });
    }
    this.ended = true;
    return text;
  }

  private parse(): void {
    let idx = this.buffer.indexOf('\n\n');
    while (idx >= 0) {
      const frame = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      idx = this.buffer.indexOf('\n\n');
      let id: string | null = null;
      let event = 'message';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('id: ')) id = line.slice(4);
        else if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data.push(line.slice(6));
        else if (line.startsWith('retry: ')) this.retry = Number(line.slice(7));
      }
      if (data.length > 0) this.events.push({ id, event, data: JSON.parse(data.join('\n')) as unknown });
    }
  }

  private readMore(): Promise<void> {
    this.pending ??= (async () => {
      if (!this.reader || this.ended) return;
      try {
        const { done, value } = await this.reader.read();
        if (done) {
          this.ended = true;
          return;
        }
        this.buffer += this.decoder.decode(value, { stream: true });
        this.parse();
      } catch {
        this.ended = true;
      }
    })().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** Reads until `predicate(events)` holds or the stream ends; throws after `timeoutMs`. */
  async until(predicate: (events: readonly SseEvent[]) => boolean, timeoutMs = 15_000): Promise<SseEvent[]> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.events)) {
      if (this.ended) return this.events;
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(`SSE timeout; events so far: ${JSON.stringify(this.events.map((e) => [e.id, e.event]))}`);
      }
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.readMore(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, left);
        }),
      ]);
      clearTimeout(timer);
    }
    return this.events;
  }

  /** Waits for the server to end the stream. */
  async waitEnd(timeoutMs = 15_000): Promise<SseEvent[]> {
    return this.until(() => false, timeoutMs).then((ev) => {
      if (!this.ended) throw new Error('stream did not end');
      return ev;
    });
  }

  close(): void {
    this.controller.abort();
    this.ended = true;
  }
}
