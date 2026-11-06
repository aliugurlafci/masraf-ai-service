/**
 * App settings. Every value comes from masraf-app/.env (EXPO_PUBLIC_*), see env.example.
 * Expo inlines `process.env.EXPO_PUBLIC_*` at build time, so each variable must be read with a static
 * property access; dynamic lookups (process.env[name]) are not replaced and would always be undefined.
 */

export interface AppConfig {
  /** Server base URL without a trailing slash, or null when EXPO_PUBLIC_API_URL is missing or invalid. */
  readonly apiUrl: string | null;
  /** Why apiUrl is null, shown on the settings warning screen. */
  readonly apiUrlProblem: string | null;
  /** How often the invoice reading status is polled. */
  readonly pollIntervalMs: number;
  /** Longest wait for a reading before the user is told to fill the form by hand. */
  readonly readingMaxMs: number;
  /** Timeout of an ordinary API request. */
  readonly requestTimeoutMs: number;
  /** Timeout of an invoice upload request. */
  readonly uploadTimeoutMs: number;
}

function intSetting(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function parseApiUrl(raw: string | undefined): { url: string | null; problem: string | null } {
  const value = raw?.trim() ?? '';
  if (value === '') {
    return { url: null, problem: 'EXPO_PUBLIC_API_URL tanımlı değil.' };
  }
  if (!/^https?:\/\/[^\s/]+(:\d+)?(\/.*)?$/i.test(value)) {
    return { url: null, problem: `EXPO_PUBLIC_API_URL geçerli bir adres değil: "${value}". Örnek: http://127.0.0.1:4000` };
  }
  return { url: value.replace(/\/+$/, ''), problem: null };
}

const api = parseApiUrl(process.env.EXPO_PUBLIC_API_URL);

export const config: AppConfig = {
  apiUrl: api.url,
  apiUrlProblem: api.problem,
  pollIntervalMs: intSetting(process.env.EXPO_PUBLIC_OKUMA_SORGU_ARALIGI_MS, 2500, 1000, 30_000),
  readingMaxMs: intSetting(process.env.EXPO_PUBLIC_OKUMA_UST_SURE_MS, 300_000, 30_000, 1_800_000),
  requestTimeoutMs: intSetting(process.env.EXPO_PUBLIC_ISTEK_ZAMAN_ASIMI_MS, 20_000, 3000, 120_000),
  uploadTimeoutMs: intSetting(process.env.EXPO_PUBLIC_YUKLEME_ZAMAN_ASIMI_MS, 60_000, 10_000, 300_000),
};
