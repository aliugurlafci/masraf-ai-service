// EventSource test double (readyState semantics of the WHATWG spec; events dispatched synchronously).
import { vi } from 'vitest';

export class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: MockEventSource[] = [];

  readonly url: string;
  readyState = MockEventSource.CONNECTING;
  #lastEventId = '';
  readonly #listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  static latest(): MockEventSource {
    const last = MockEventSource.instances[MockEventSource.instances.length - 1];
    if (!last) {
      throw new Error('No EventSource was created');
    }
    return last;
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.readyState = MockEventSource.CLOSED;
  }

  get closed(): boolean {
    return this.readyState === MockEventSource.CLOSED;
  }

  #dispatch(event: Event): void {
    for (const listener of this.#listeners.get(event.type) ?? []) {
      listener(event);
    }
  }

  open(): void {
    this.readyState = MockEventSource.OPEN;
    this.#dispatch(new Event('open'));
  }

  /** Server-sent event; `id` updates the last-event-id buffer like a browser does. */
  emit(type: string, data: unknown, id?: string): void {
    if (this.readyState === MockEventSource.CLOSED) {
      return;
    }
    if (id !== undefined) {
      this.#lastEventId = id;
    }
    this.readyState = MockEventSource.OPEN;
    this.#dispatch(new MessageEvent(type, { data: JSON.stringify(data), lastEventId: this.#lastEventId }));
  }

  /** Connection error: plain Event without data. `closed` => the browser gave up (non-200 / 204). */
  fail(closed: boolean): void {
    this.readyState = closed ? MockEventSource.CLOSED : MockEventSource.CONNECTING;
    this.#dispatch(new Event('error'));
  }
}

export function installEventSource(): typeof MockEventSource {
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
  return MockEventSource;
}
