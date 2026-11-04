// Typed fetch wrapper for /api/v1 (contract §9.2, §9.6, §20.1).
// - same-origin cookies, JSON bodies, response validation with the @orc/shared schemas
// - X-CSRF-Token on unsafe methods; on 403 csrf_failed: refetch /auth/me once and repeat once
// - If-Match / Idempotency-Key when requested; ETag, Location and Retry-After surfaced to callers
import { MeResponseSchema } from '@orc/shared';
import type { MeResponse } from '@orc/shared';
import { ApiError, invalidResponseError, networkError, problemFromResponse } from './errors';
import type { Schema } from './schema';

export const API_BASE = '/api/v1';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export type QueryValue = string | number | boolean | null | undefined | readonly string[];
export type QueryParams = Readonly<Record<string, QueryValue>>;

export interface RequestOptions {
  method?: HttpMethod;
  /** Path below /api/v1, e.g. `/tasks/<id>`. */
  path: string;
  query?: QueryParams;
  body?: unknown;
  ifMatch?: string | null;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface ApiResponse<T> {
  data: T;
  status: number;
  etag: string | null;
  location: string | null;
  headers: Headers;
}

const UNSAFE_METHODS: ReadonlySet<HttpMethod> = new Set(['POST', 'PATCH', 'DELETE']);
/** Routes whose 401 is part of their own flow (never broadcast as "session lost"). */
const AUTH_FLOW_PATHS: ReadonlySet<string> = new Set(['/auth/login', '/auth/me']);

export function buildApiUrl(path: string, query?: QueryParams): string {
  const params = new URLSearchParams();
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      if (Array.isArray(value)) {
        const list = value as readonly string[];
        if (list.length > 0) {
          params.set(key, list.join(','));
        }
        continue;
      }
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return `${API_BASE}${path}${qs.length > 0 ? `?${qs}` : ''}`;
}

function isJsonContentType(contentType: string | null): boolean {
  if (contentType === null) {
    return false;
  }
  const lower = contentType.toLowerCase();
  return lower.includes('application/json') || lower.includes('+json');
}

/** A cancelled request (react-query aborts queries that are no longer observed); never an API error. */
function isAbortError(cause: unknown): boolean {
  return (cause instanceof DOMException || cause instanceof Error) && cause.name === 'AbortError';
}

/** Releases an unread body without waiting (a cancel can stay pending on tee'd streams). */
function discardBody(res: Response): void {
  res.body?.cancel().catch(() => undefined);
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) {
    return null;
  }
  return JSON.parse(text) as unknown;
}

export class ApiClient {
  #csrfToken: string | null = null;
  readonly #meListeners = new Set<(me: MeResponse) => void>();
  readonly #unauthenticatedListeners = new Set<(error: ApiError) => void>();

  get csrfToken(): string | null {
    return this.#csrfToken;
  }

  setCsrfToken(token: string | null): void {
    this.#csrfToken = token;
  }

  /** Called whenever the client itself refreshed `/auth/me` (CSRF recovery). */
  onMe(listener: (me: MeResponse) => void): () => void {
    this.#meListeners.add(listener);
    return () => {
      this.#meListeners.delete(listener);
    };
  }

  /** Called on 401 from any route except the login/me flow (session expired mid-use). */
  onUnauthenticated(listener: (error: ApiError) => void): () => void {
    this.#unauthenticatedListeners.add(listener);
    return () => {
      this.#unauthenticatedListeners.delete(listener);
    };
  }

  /** `GET /auth/me`; remembers the CSRF token (null for PAT auth). */
  async fetchMe(signal?: AbortSignal): Promise<MeResponse> {
    const res = await this.json({ path: '/auth/me', signal }, MeResponseSchema);
    this.#csrfToken = res.data.csrfToken;
    return res.data;
  }

  /** Request whose 2xx response carries a JSON body validated by `schema`. */
  async json<T>(options: RequestOptions, schema: Schema<T>): Promise<ApiResponse<T>> {
    const res = await this.#requestWithCsrfRecovery(options);
    let body: unknown;
    try {
      body = await readJson(res);
      return {
        data: schema.parse(body),
        status: res.status,
        etag: res.headers.get('ETag'),
        location: res.headers.get('Location'),
        headers: res.headers,
      };
    } catch (cause) {
      if (isAbortError(cause)) {
        throw cause;
      }
      throw invalidResponseError(res.status, res.headers, cause);
    }
  }

  /** Request whose success response has no body (204) or whose body is ignored. */
  async empty(options: RequestOptions): Promise<ApiResponse<null>> {
    const res = await this.#requestWithCsrfRecovery(options);
    discardBody(res);
    return {
      data: null,
      status: res.status,
      etag: res.headers.get('ETag'),
      location: res.headers.get('Location'),
      headers: res.headers,
    };
  }

  async #requestWithCsrfRecovery(options: RequestOptions): Promise<Response> {
    const method = options.method ?? 'GET';
    try {
      return await this.#send(options);
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === 'csrf_failed' &&
        UNSAFE_METHODS.has(method) &&
        options.path !== '/auth/login'
      ) {
        const me = await this.fetchMe(options.signal);
        for (const listener of this.#meListeners) {
          listener(me);
        }
        return this.#send(options);
      }
      throw error;
    }
  }

  async #send(options: RequestOptions): Promise<Response> {
    const method = options.method ?? 'GET';
    const headers = new Headers({ Accept: 'application/json' });
    let body: string | undefined;
    if (options.body !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(options.body);
    }
    if (UNSAFE_METHODS.has(method) && this.#csrfToken !== null && options.path !== '/auth/login') {
      headers.set('X-CSRF-Token', this.#csrfToken);
    }
    if (options.ifMatch) {
      headers.set('If-Match', options.ifMatch);
    }
    if (options.idempotencyKey !== undefined) {
      headers.set('Idempotency-Key', options.idempotencyKey);
    }

    let res: Response;
    try {
      res = await globalThis.fetch(buildApiUrl(options.path, options.query), {
        method,
        headers,
        body,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: options.signal,
      });
    } catch (cause) {
      if (isAbortError(cause)) {
        throw cause;
      }
      throw networkError(cause);
    }

    if (res.ok) {
      return res;
    }

    let errorBody: unknown = null;
    if (isJsonContentType(res.headers.get('Content-Type'))) {
      try {
        errorBody = await readJson(res);
      } catch {
        errorBody = null;
      }
    } else {
      discardBody(res);
    }
    const error = problemFromResponse(res.status, res.headers, errorBody);
    if (res.status === 401 && !AUTH_FLOW_PATHS.has(options.path)) {
      for (const listener of this.#unauthenticatedListeners) {
        listener(error);
      }
    }
    throw error;
  }
}
