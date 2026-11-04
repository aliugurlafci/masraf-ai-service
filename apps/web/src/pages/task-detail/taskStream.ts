// Live task output over SSE (contract §8.4).
// - one EventSource per task page (`GET /api/v1/tasks/<id>/stream`, same-origin cookie)
// - every SSE_EVENT_TYPES type is listened to and validated with the @orc/shared schemas
// - the named `error` event (MessageEvent with data) is distinguished from connection errors (plain Event)
// - browsers never reconnect after a non-200 answer or a 204: when readyState is CLOSED without an
//   `end`, the task is re-checked (401 => login, 404 => not found, settled => stop) and otherwise a new
//   EventSource is opened with `?lastEventId=<last id>` after exponential backoff (1, 2, 4 ... 30 s)
// - duplicates are dropped by key: log (attemptId, seq); claude (attemptId, line, block);
//   test (testRunId, status); diff (attemptId); end (attemptId); status is never deduplicated
import {
  ErrorEventPayloadSchema,
  HeartbeatEventPayloadSchema,
  SSE_EVENT_TYPES,
  TaskStreamEventSchema,
} from '@orc/shared';
import type {
  ClaudeEventPayload,
  DiffEventPayload,
  EndEventPayload,
  ErrorEventPayload,
  LogEventPayload,
  SseEventType,
  StatusEventPayload,
  TaskStreamEvent,
  TestEventPayload,
} from '@orc/shared';

export const MAX_RENDERED_ITEMS = 5000;
export const BACKOFF_MAX_MS = 30_000;
const READY_STATE_CLOSED = 2;

export type StreamItem =
  | { key: string; type: 'status'; event: StatusEventPayload }
  | { key: string; type: 'log'; event: LogEventPayload }
  | { key: string; type: 'claude'; event: ClaudeEventPayload }
  | { key: string; type: 'test'; event: TestEventPayload }
  | { key: string; type: 'diff'; event: DiffEventPayload }
  | { key: string; type: 'end'; event: EndEventPayload };

export type StreamConnection =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'ended'
  | 'stopped'
  | 'not_found'
  | 'unauthenticated';

export interface StreamState {
  items: readonly StreamItem[];
  /** Items dropped from the front because of MAX_RENDERED_ITEMS. */
  trimmed: number;
  connection: StreamConnection;
  lastEventId: string | null;
  lastHeartbeatAt: string | null;
  /** Last named `error` event sent by the server. */
  serverError: ErrorEventPayload | null;
  /** Transport errors seen since the last successful open. */
  connectionErrors: number;
  /** Number of the scheduled reconnect (0 = none). */
  reconnectAttempt: number;
  /** Delay of the scheduled reconnect in ms (null when none is scheduled). */
  reconnectDelayMs: number | null;
  latestStatus: StatusEventPayload | null;
  ended: EndEventPayload | null;
  /** Payloads that failed schema validation (ignored). */
  invalidEvents: number;
}

export type TaskCheckOutcome = 'active' | 'settled' | 'unauthenticated' | 'not_found' | 'error';

/** The subset of EventSource used here (the real class and the test double both satisfy it). */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}

export interface TaskStreamOptions {
  taskId: string;
  createSource: (url: string) => EventSourceLike;
  checkTask: () => Promise<TaskCheckOutcome>;
  onStatus?: (event: StatusEventPayload) => void;
  onEnd?: (event: EndEventPayload | null) => void;
  onUnauthenticated?: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * The synthetic `end` after a DB replay (§8.2). Resuming after it always answers 204 (§8.3), so once
 * the task became active again (retry => new attempt) the stream is reopened from the start and the
 * replayed events are dropped by the §8.4 dedupe keys.
 */
export const DB_END_EVENT_ID = 'd-end';

export function resumeEventId(lastEventId: string | null): string | null {
  return lastEventId === DB_END_EVENT_ID ? null : lastEventId;
}

export function streamUrl(taskId: string, lastEventId: string | null): string {
  const base = `/api/v1/tasks/${encodeURIComponent(taskId)}/stream`;
  return lastEventId ? `${base}?lastEventId=${encodeURIComponent(lastEventId)}` : base;
}

export function backoffDelayMs(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, 1000 * 2 ** Math.max(0, attempt - 1));
}

/** Dedupe key per §8.4; `null` for events that are never deduplicated (status). */
export function dedupeKey(event: TaskStreamEvent): string | null {
  switch (event.type) {
    case 'log':
      return `log:${event.attemptId}:${event.seq}`;
    case 'claude':
      return `claude:${event.attemptId}:${event.line}:${event.block}`;
    case 'test':
      return `test:${event.testRunId}:${event.status}`;
    case 'diff':
      return `diff:${event.attemptId}`;
    case 'end':
      return `end:${event.attemptId ?? 'none'}`;
    case 'status':
      return null;
  }
}

function initialState(): StreamState {
  return {
    items: [],
    trimmed: 0,
    connection: 'idle',
    lastEventId: null,
    lastHeartbeatAt: null,
    serverError: null,
    connectionErrors: 0,
    reconnectAttempt: 0,
    reconnectDelayMs: null,
    latestStatus: null,
    ended: null,
    invalidEvents: 0,
  };
}

function hasMessageData(event: Event): event is MessageEvent<string> {
  return 'data' in event && typeof (event as MessageEvent).data === 'string';
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export class TaskStreamController {
  readonly #options: TaskStreamOptions;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  readonly #listeners = new Set<() => void>();
  readonly #seen = new Set<string>();
  #state: StreamState = initialState();
  #source: EventSourceLike | null = null;
  #timer: unknown = null;
  #running = false;
  #generation = 0;
  #statusSeq = 0;

  constructor(options: TaskStreamOptions) {
    this.#options = options;
    this.#setTimer = options.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.#clearTimer =
      options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): StreamState => this.#state;

  /** Opens the stream (resuming after the last received id when there is one). */
  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#open();
  }

  /** Closes the source and cancels any scheduled reconnect (page unmount). */
  stop(): void {
    this.#running = false;
    this.#generation += 1;
    this.#cancelTimer();
    this.#closeSource();
  }

  /** Opens a new EventSource after the stream ended (used after a retry created a new attempt). */
  reopen(): void {
    this.stop();
    this.#update({ ended: null, serverError: null, reconnectAttempt: 0, reconnectDelayMs: null });
    this.start();
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }

  #update(patch: Partial<StreamState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#emit();
  }

  #cancelTimer(): void {
    if (this.#timer !== null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
  }

  #closeSource(): void {
    if (this.#source !== null) {
      this.#source.close();
      this.#source = null;
    }
  }

  #open(): void {
    this.#cancelTimer();
    this.#closeSource();
    const generation = ++this.#generation;
    const source = this.#options.createSource(
      streamUrl(this.#options.taskId, resumeEventId(this.#state.lastEventId)),
    );
    this.#source = source;
    this.#update({ connection: this.#state.reconnectAttempt > 0 ? 'reconnecting' : 'connecting', reconnectDelayMs: null });

    source.addEventListener('open', () => {
      if (generation !== this.#generation) return;
      this.#update({ connection: 'live', connectionErrors: 0, reconnectAttempt: 0 });
    });
    for (const type of SSE_EVENT_TYPES) {
      source.addEventListener(type, (event) => {
        if (generation !== this.#generation) return;
        if (type === 'error' && !hasMessageData(event)) {
          this.#onConnectionError(source);
          return;
        }
        if (hasMessageData(event)) {
          this.#onMessage(type, event);
        }
      });
    }
  }

  #onMessage(type: SseEventType, event: MessageEvent<string>): void {
    const lastEventId = event.lastEventId ? event.lastEventId : this.#state.lastEventId;
    const data = parseJson(event.data);

    if (type === 'heartbeat') {
      const hb = HeartbeatEventPayloadSchema.safeParse(data);
      if (!hb.success) {
        this.#update({ invalidEvents: this.#state.invalidEvents + 1 });
        return;
      }
      this.#update({ connection: 'live', lastHeartbeatAt: hb.data.at, lastEventId, reconnectAttempt: 0 });
      return;
    }
    if (type === 'error') {
      const err = ErrorEventPayloadSchema.safeParse(data);
      if (!err.success) {
        this.#update({ invalidEvents: this.#state.invalidEvents + 1 });
        return;
      }
      this.#update({ serverError: err.data, lastEventId });
      return;
    }

    const parsed = TaskStreamEventSchema.safeParse(data);
    if (!parsed.success || parsed.data.type !== type) {
      this.#update({ invalidEvents: this.#state.invalidEvents + 1, lastEventId });
      return;
    }
    const payload = parsed.data;
    const key = dedupeKey(payload);
    if (key !== null) {
      if (this.#seen.has(key)) {
        this.#update({ lastEventId, connection: 'live', reconnectAttempt: 0 });
        return;
      }
      this.#seen.add(key);
    }
    const item = this.#toItem(payload, key);
    let items = [...this.#state.items, item];
    let trimmed = this.#state.trimmed;
    if (items.length > MAX_RENDERED_ITEMS) {
      const overflow = items.length - MAX_RENDERED_ITEMS;
      items = items.slice(overflow);
      trimmed += overflow;
    }
    const patch: Partial<StreamState> = {
      items,
      trimmed,
      lastEventId,
      connection: 'live',
      reconnectAttempt: 0,
    };
    if (payload.type === 'status') {
      patch.latestStatus = payload;
    }
    if (payload.type === 'end') {
      patch.ended = payload;
      patch.connection = 'ended';
    }
    this.#update(patch);

    if (payload.type === 'status') {
      this.#options.onStatus?.(payload);
    } else if (payload.type === 'end') {
      this.#running = false;
      this.#generation += 1;
      this.#closeSource();
      this.#options.onEnd?.(payload);
    }
  }

  #toItem(payload: TaskStreamEvent, key: string | null): StreamItem {
    switch (payload.type) {
      case 'status':
        this.#statusSeq += 1;
        return { key: `status:${this.#statusSeq}`, type: 'status', event: payload };
      case 'log':
        return { key: key ?? '', type: 'log', event: payload };
      case 'claude':
        return { key: key ?? '', type: 'claude', event: payload };
      case 'test':
        return { key: key ?? '', type: 'test', event: payload };
      case 'diff':
        return { key: key ?? '', type: 'diff', event: payload };
      case 'end':
        return { key: key ?? '', type: 'end', event: payload };
    }
  }

  #onConnectionError(source: EventSourceLike): void {
    const connectionErrors = this.#state.connectionErrors + 1;
    if (source.readyState !== READY_STATE_CLOSED) {
      // The browser reconnects by itself (Last-Event-ID header).
      this.#update({ connection: 'reconnecting', connectionErrors });
      return;
    }
    this.#closeSource();
    const generation = ++this.#generation;
    this.#update({ connection: 'reconnecting', connectionErrors });
    void this.#recheck(generation);
  }

  async #recheck(generation: number): Promise<void> {
    let outcome: TaskCheckOutcome;
    try {
      outcome = await this.#options.checkTask();
    } catch {
      outcome = 'error';
    }
    if (generation !== this.#generation || !this.#running) {
      return;
    }
    switch (outcome) {
      case 'settled':
        this.#running = false;
        this.#update({ connection: 'stopped', reconnectDelayMs: null });
        this.#options.onEnd?.(null);
        return;
      case 'unauthenticated':
        this.#running = false;
        this.#update({ connection: 'unauthenticated', reconnectDelayMs: null });
        this.#options.onUnauthenticated?.();
        return;
      case 'not_found':
        this.#running = false;
        this.#update({ connection: 'not_found', reconnectDelayMs: null });
        return;
      case 'active':
      case 'error': {
        const attempt = this.#state.reconnectAttempt + 1;
        const delay = backoffDelayMs(attempt);
        this.#update({ reconnectAttempt: attempt, reconnectDelayMs: delay });
        this.#timer = this.#setTimer(() => {
          this.#timer = null;
          if (generation === this.#generation && this.#running) {
            this.#open();
          }
        }, delay);
      }
    }
  }
}
