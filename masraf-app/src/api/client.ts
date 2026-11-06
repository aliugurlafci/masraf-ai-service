import { config } from '@/config';

import type { HataGovdesi } from './types';

/**
 * One error type for every failed request. Server errors carry the contract's `{kod, mesaj, alanlar}`;
 * failures that never reached the server use status 0 and a client-side code.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly kod: string;
  /** Field-level messages from a `400 gecersiz_istek`, keyed by request field name. */
  readonly alanlar: Readonly<Record<string, string>>;
  readonly sorunlar: readonly string[];

  constructor(
    status: number,
    kod: string,
    mesaj: string,
    alanlar: Readonly<Record<string, string>> = {},
    sorunlar: readonly string[] = [],
  ) {
    super(mesaj);
    this.name = 'ApiError';
    this.status = status;
    this.kod = kod;
    this.alanlar = alanlar;
    this.sorunlar = sorunlar;
  }
}

export const isApiError = (err: unknown): err is ApiError => err instanceof ApiError;

/** Turkish message for any error, safe to show to the user. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin.';
}

type Session = {
  token: string | null;
  onUnauthorized: (() => void) | null;
};

// Set by the auth provider. The token lives in expo-secure-store; this is only its in-memory copy.
const session: Session = { token: null, onUnauthorized: null };

export function setSessionToken(token: string | null): void {
  session.token = token;
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  session.onUnauthorized = handler;
}

/** Headers for requests made outside this module (e.g. expo-image loading the invoice file). */
export function authHeaders(): Record<string, string> {
  return session.token === null ? {} : { Authorization: `Bearer ${session.token}` };
}

export function apiUrl(path: string): string {
  if (config.apiUrl === null) {
    throw new ApiError(0, 'ayar_eksik', 'Sunucu adresi ayarlanmamış (EXPO_PUBLIC_API_URL).');
  }
  return `${config.apiUrl}${path}`;
}

type QueryValue = string | number | boolean | null | undefined | readonly string[];

function queryString(query: Readonly<Record<string, QueryValue>> | undefined): string {
  if (query === undefined) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    const text = Array.isArray(value) ? value.join(',') : String(value);
    if (text === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(text)}`);
  }
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly query?: Readonly<Record<string, QueryValue>>;
  /** JSON body. */
  readonly body?: unknown;
  /** Multipart body; sent as is so fetch sets the boundary. */
  readonly form?: FormData;
  readonly timeoutMs?: number;
  /** Cancellation from the caller (e.g. React Query). */
  readonly signal?: AbortSignal;
}

function parseErrorBody(status: number, text: string): ApiError {
  try {
    const body = JSON.parse(text) as Partial<HataGovdesi>;
    const hata = body.hata;
    if (hata !== undefined && typeof hata.kod === 'string' && typeof hata.mesaj === 'string') {
      return new ApiError(status, hata.kod, hata.mesaj, hata.alanlar ?? {}, hata.sorunlar ?? []);
    }
  } catch {
    // Not JSON; fall through to a generic message.
  }
  if (status === 401) return new ApiError(401, 'oturum_gerekli', 'Oturumunuz sona erdi. Lütfen yeniden giriş yapın.');
  if (status === 403) return new ApiError(403, 'yetki_yok', 'Bu işlem için yetkiniz yok.');
  if (status === 404) return new ApiError(404, 'bulunamadi', 'Kayıt bulunamadı.');
  if (status === 413) return new ApiError(413, 'dosya_cok_buyuk', 'Dosya çok büyük.');
  if (status >= 500) return new ApiError(status, 'sunucu_hatasi', 'Sunucuda bir hata oluştu. Lütfen biraz sonra tekrar deneyin.');
  return new ApiError(status, 'beklenmeyen_yanit', `Sunucu beklenmeyen bir yanıt verdi (${status}).`);
}

/**
 * Sends a request to the server. Adds the bearer token, applies a timeout, turns every failure into an
 * ApiError and signs the user out when the server answers 401 to an authenticated request.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = apiUrl(path) + queryString(options.query);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? config.requestTimeoutMs);
  const outer = options.signal;
  const forwardAbort = (): void => controller.abort();
  if (outer !== undefined) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', forwardAbort);
  }

  const token = session.token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  let body: string | FormData | undefined;
  if (options.form !== undefined) {
    body = options.form;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(url, { method: options.method ?? 'GET', headers, body, signal: controller.signal });
  } catch (err) {
    if (timedOut) {
      throw new ApiError(0, 'zaman_asimi', 'Sunucu zamanında yanıt vermedi. Bağlantınızı kontrol edip tekrar deneyin.');
    }
    if (outer?.aborted === true) throw err;
    throw new ApiError(0, 'ag_hatasi', 'Sunucuya ulaşılamadı. Bağlantınızı ve sunucu adresini kontrol edin.');
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', forwardAbort);
  }

  const text = await response.text().catch(() => '');
  if (!response.ok) {
    const error = parseErrorBody(response.status, text);
    // A 401 to a request that carried the token means the session is gone (expired or closed elsewhere).
    if (response.status === 401 && token !== null && token === session.token) session.onUnauthorized?.();
    throw error;
  }
  if (response.status === 204 || text === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(response.status, 'gecersiz_yanit', 'Sunucudan okunamayan bir yanıt geldi.');
  }
}
