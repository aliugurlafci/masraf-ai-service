// Chunked, masked TaskLogs sink with Redis `log` publication (contract §7, §13.1, §17.2).
import { systemClock, toIso } from '@orc/shared';
import type { LogSource, LogStream, Uuid } from '@orc/shared';
import type { NewTaskLog } from '@orc/database';
import { createStreamMasker } from '@orc/security';
import type { StreamMasker } from '@orc/security';
import { serializeError } from '@orc/logger';
import type { AttemptLogSink, OrchestratorDeps } from './types.js';

/** Max UTF-16 units per TaskLogs row (§13.1). */
export const LOG_CHUNK_MAX_CHARS = 4000;
/** A partial line held longer than this is force-flushed (T-m12). */
export const PARTIAL_LINE_MAX_AGE_MS = 2000;
const CLOSE_ATTEMPTS = 3;
const CLOSE_RETRY_DELAY_MS = 200;

interface Row {
  seq: number;
  stream: LogStream;
  source: LogSource;
  content: string;
}

interface MaskerState {
  stream: LogStream;
  source: LogSource;
  masker: StreamMasker;
  heldSince: number | null;
}

/** Splits text into pieces of <= max UTF-16 units without separating a surrogate pair. */
export function splitChunks(text: string, max = LOG_CHUNK_MAX_CHARS): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    if (end < text.length) {
      const last = text.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'unique_violation'
  );
}

export function createAttemptLogSink(
  i: { taskId: Uuid; attemptId: Uuid; startSeq: number },
  deps: Pick<OrchestratorDeps, 'db' | 'publisher' | 'secrets' | 'logger' | 'config' | 'clock'>,
): AttemptLogSink {
  const clock = deps.clock ?? systemClock;
  const cfg = deps.config;
  const maskers = new Map<string, MaskerState>();
  let queue: Row[] = [];
  let queuedBytes = 0;
  let nextSeq = i.startSeq;
  let droppedBytes = 0;
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  let warned = false;

  const enqueueText = (stream: LogStream, source: LogSource, text: string): void => {
    if (text.length === 0) return;
    let rest = text;
    const tail = queue[queue.length - 1];
    if (tail && tail.stream === stream && tail.source === source && tail.content.length < LOG_CHUNK_MAX_CHARS) {
      let room = LOG_CHUNK_MAX_CHARS - tail.content.length;
      if (room < rest.length) {
        const code = rest.charCodeAt(room - 1);
        if (code >= 0xd800 && code <= 0xdbff) room -= 1;
      }
      const piece = rest.slice(0, Math.max(0, room));
      if (piece.length > 0) {
        tail.content += piece;
        queuedBytes += byteLength(piece);
        rest = rest.slice(piece.length);
      }
    }
    for (const chunk of splitChunks(rest)) {
      queue.push({ seq: nextSeq, stream, source, content: chunk });
      nextSeq += 1;
      queuedBytes += byteLength(chunk);
    }
    enforceBufferCap();
  };

  const enforceBufferCap = (): void => {
    if (queuedBytes <= cfg.logBufferMaxBytes) return;
    let dropped = 0;
    while (queuedBytes > cfg.logBufferMaxBytes && queue.length > 0) {
      const row = queue.shift() as Row;
      const b = byteLength(row.content);
      queuedBytes -= b;
      dropped += b;
    }
    droppedBytes += dropped;
    const marker = `[orc] ${dropped} bytes of output dropped\n`;
    queue.push({ seq: nextSeq, stream: 'system', source: 'orchestrator', content: marker });
    nextSeq += 1;
    queuedBytes += byteLength(marker);
  };

  const maskerFor = (stream: LogStream, source: LogSource): MaskerState => {
    const key = `${stream}/${source}`;
    let m = maskers.get(key);
    if (m === undefined) {
      m = { stream, source, masker: createStreamMasker(deps.secrets), heldSince: null };
      maskers.set(key, m);
    }
    return m;
  };

  const releaseHeld = (force: boolean): void => {
    const now = clock.nowMs();
    for (const m of maskers.values()) {
      if (m.masker.pendingChars === 0) {
        m.heldSince = null;
        continue;
      }
      if (force || (m.heldSince !== null && now - m.heldSince >= PARTIAL_LINE_MAX_AGE_MS)) {
        enqueueText(m.stream, m.source, m.masker.flush());
        m.heldSince = null;
      }
    }
  };

  const publishRows = async (rows: readonly Row[]): Promise<void> => {
    const at = toIso(clock.now());
    for (const row of rows) {
      if (row.stream === 'claude') continue;
      await deps.publisher.publish(i.taskId, {
        v: 1,
        type: 'log',
        taskId: i.taskId,
        attemptId: i.attemptId,
        seq: row.seq,
        stream: row.stream,
        source: row.source,
        content: row.content,
        at,
      });
    }
  };

  /** One DB write of everything queued; failures keep the rows (bounded by LOG_BUFFER_MAX_BYTES). */
  const writeOnce = async (): Promise<boolean> => {
    releaseHeld(false);
    if (queue.length === 0) return true;
    const batch = queue;
    const batchBytes = queuedBytes;
    queue = [];
    queuedBytes = 0;
    const rows: NewTaskLog[] = batch.map((r) => ({
      taskId: i.taskId,
      attemptId: i.attemptId,
      seq: r.seq,
      stream: r.stream,
      source: r.source,
      content: r.content,
      byteLength: byteLength(r.content),
    }));
    try {
      await deps.db.repos.taskLogs.appendBatch(rows);
      warned = false;
    } catch (err) {
      if (isUniqueViolation(err)) {
        deps.logger.error({ err: serializeError(err), attemptId: i.attemptId }, 'task log batch rejected (duplicate seq); dropped');
        return true;
      }
      queue = [...batch, ...queue];
      queuedBytes += batchBytes;
      enforceBufferCap();
      if (!warned) {
        warned = true;
        deps.logger.warn({ err: serializeError(err), attemptId: i.attemptId }, 'task log write failed; buffering');
      }
      return false;
    }
    try {
      await publishRows(batch);
    } catch (err) {
      deps.logger.warn({ err: serializeError(err) }, 'task log publication failed');
    }
    return true;
  };

  const flush = (): Promise<void> => {
    const next = chain.then(async () => {
      await writeOnce();
    });
    chain = next.catch(() => undefined);
    return chain;
  };

  const timer = setInterval(() => {
    void flush();
  }, cfg.logFlushIntervalMs);
  timer.unref?.();

  return {
    write(stream, source, text) {
      if (closed || text.length === 0) return;
      try {
        if (stream === 'claude') {
          // Claude stdout lines arrive complete and already masked by the runner (§10.5): no second pass.
          enqueueText(stream, source, text);
          if (queuedBytes >= cfg.logFlushBytes) void flush();
          return;
        }
        const m = maskerFor(stream, source);
        const out = m.masker.push(text);
        if (m.masker.pendingChars > 0) m.heldSince ??= clock.nowMs();
        else m.heldSince = null;
        enqueueText(stream, source, out);
        if (queuedBytes >= cfg.logFlushBytes) void flush();
      } catch (err) {
        deps.logger.warn({ err: serializeError(err) }, 'task log write rejected');
      }
    },
    flush,
    async close() {
      if (closed) {
        await chain;
        return;
      }
      closed = true;
      clearInterval(timer);
      releaseHeld(true);
      for (let n = 0; n < CLOSE_ATTEMPTS; n++) {
        let ok = false;
        const next = chain.then(async () => {
          ok = await writeOnce();
        });
        chain = next.catch(() => undefined);
        await chain;
        if (ok && queue.length === 0) return;
        await new Promise<void>((r) => setTimeout(r, CLOSE_RETRY_DELAY_MS));
      }
      if (queue.length > 0) {
        droppedBytes += queuedBytes;
        deps.logger.error(
          { attemptId: i.attemptId, droppedBytes: queuedBytes },
          'task log rows dropped at close (database unavailable)',
        );
        queue = [];
        queuedBytes = 0;
      }
    },
    discard() {
      closed = true;
      clearInterval(timer);
      droppedBytes += queuedBytes;
      queue = [];
      queuedBytes = 0;
      maskers.clear();
    },
    get nextSeq() {
      return nextSeq;
    },
    get droppedBytes() {
      return droppedBytes;
    },
  };
}
