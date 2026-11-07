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
  /** JSON body. Files go through upload(). */
  readonly body?: unknown;
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
  let body: string | undefined;
  if (options.body !== undefined) {
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
    // The device's own reason (e.g. "Network request failed") shows in the Metro console while developing.
    if (__DEV__) console.warn(`[api] ${options.method ?? 'GET'} ${path} ağ hatası:`, err);
    throw new ApiError(0, 'ag_hatasi', 'Sunucuya ulaşılamadı. Bağlantınızı ve sunucu adresini kontrol edin.');
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', forwardAbort);
  }

  const text = await response.text().catch(() => '');
  return readResponse<T>(response.status, text, token);
}

/** Turns a server answer into the parsed body or an ApiError; `token` is the one the request carried. */
function readResponse<T>(status: number, text: string, token: string | null): T {
  if (status < 200 || status > 299) {
    const error = parseErrorBody(status, text);
    // A 401 to a request that carried the token means the session is gone (expired or closed elsewhere).
    if (status === 401 && token !== null && token === session.token) session.onUnauthorized?.();
    throw error;
  }
  if (status === 204 || text === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(status, 'gecersiz_yanit', 'Sunucudan okunamayan bir yanıt geldi.');
  }
}

/**
 * Sends a multipart form with local files (`{uri, name, type}` parts) as a POST. Goes through React
 * Native's XMLHttpRequest, not fetch: since SDK 58 Expo replaces the global fetch with expo/fetch, which
 * rejects such parts ("Unsupported FormDataPart implementation"). The XHR streams the file from disk.
 * Same token, timeout and error handling as request().
 */
export function upload<T>(path: string, form: FormData, timeoutMs: number): Promise<T> {
  const url = apiUrl(path);
  const token = session.token;
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Accept', 'application/json');
    if (token !== null) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.timeout = timeoutMs;
    xhr.onload = () => {
      try {
        resolve(readResponse<T>(xhr.status, typeof xhr.responseText === 'string' ? xhr.responseText : '', token));
      } catch (err) {
        reject(err);
      }
    };
    xhr.onerror = () => {
      if (__DEV__) console.warn(`[api] POST ${path} ağ hatası (yükleme)`);
      reject(new ApiError(0, 'ag_hatasi', 'Sunucuya ulaşılamadı. Bağlantınızı ve sunucu adresini kontrol edin.'));
    };
    xhr.ontimeout = () => {
      reject(new ApiError(0, 'zaman_asimi', 'Sunucu zamanında yanıt vermedi. Bağlantınızı kontrol edip tekrar deneyin.'));
    };
    // No Content-Type header: the XHR sets multipart/form-data with its boundary.
    xhr.send(form);
  });
}
