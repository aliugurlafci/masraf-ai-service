import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ClaudeEffort } from './claude/extractor.ts';

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_TOKEN_FILE = resolve(ROOT_DIR, 'secrets', 'claude_oauth_token.txt');
export const OAUTH_TOKEN_REGEX = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,500}$/;
export const MODEL_NAME_REGEX = /^[A-Za-z0-9._[\]-]+$/;

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  CLAUDE_BIN: z.string().min(1).default('claude'),
  // A cascade, cheapest first: the next model reads only when the checks find a problem. On the user's
  // scanned invoices haiku misread amounts and opus misread the fewest digits (npm run karsilastir, 2026-11-06).
  CLAUDE_MODEL: z
    .string()
    .default('haiku,opus')
    .transform((s) => s.split(',').map((m) => m.trim()))
    .pipe(z.array(z.string().regex(MODEL_NAME_REGEX)).min(1).max(4)),
  // Reading an invoice needs little reasoning; "default" leaves the CLI's own setting.
  CLAUDE_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'default']).default('low'),
  CLAUDE_TIMEOUT_SEC: z.coerce.number().int().min(10).max(900).default(180),
  // Files read at once. Above 4 the subscription's usage limit fills fast and reads start failing with 429.
  CLAUDE_MAX_CONCURRENT: z.coerce.number().int().min(1).max(4).default(2),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
  CLAUDE_OAUTH_TOKEN_FILE: z.string().min(1).optional(),
  MAX_FILE_MB: z.coerce.number().int().min(1).max(32).default(20),
  // "yerel" opens the service to the local network (phones on the same Wi-Fi). Off by default.
  AG_ERISIMI: z.enum(['kapali', 'yerel'], { error: 'kapali ya da yerel olmalı' }).default('kapali'),
  // Extra host names the service answers to on the local network, e.g. "masraf-pc.local".
  IZINLI_HOSTLAR: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h !== ''),
    )
    .pipe(z.array(z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/, 'ana makine adı ya da IPv4 adresi olmalı')).max(10)),
});

const flag = z
  .enum(['true', 'false', '1', '0', 'evet', 'hayir'])
  .transform((v) => v === 'true' || v === '1' || v === 'evet');

const DbEnvSchema = z.object({
  MSSQL_HOST: z.string().min(1).default('127.0.0.1'),
  MSSQL_PORT: z.coerce.number().int().min(1).max(65535).default(1433),
  // Becomes part of CREATE DATABASE, so only plain identifiers.
  MSSQL_DATABASE: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/, 'harf, rakam ve alt çizgi olmalı')
    .default('masraf'),
  MSSQL_USER: z.string().min(1).default('sa'),
  MSSQL_PASSWORD: z.string({ error: 'tanımlı değil' }).min(1, 'boş olamaz'),
  MSSQL_ENCRYPT: flag.default(true),
  MSSQL_TRUST_SERVER_CERTIFICATE: flag.default(true),
  MSSQL_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  MSSQL_CONNECT_WAIT_SEC: z.coerce.number().int().min(0).max(600).default(60),
});

const optionalText = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const ServiceEnvSchema = z.object({
  OTURUM_SURESI_SAAT: z.coerce.number().int().min(1).max(8760).default(168),
  GIRIS_DENEME_SINIRI: z.coerce.number().int().min(3).max(100).default(10),
  GIRIS_KILIT_DAKIKA: z.coerce.number().int().min(1).max(1440).default(15),
  SIFRE_MIN_UZUNLUK: z.coerce.number().int().min(8).max(128).default(8),
  PARA_BIRIMI: z
    .string()
    .regex(/^[A-Z]{3}$/, 'ISO 4217 kodu bekleniyor (TRY, USD, EUR)')
    .default('TRY'),
  ILK_YONETICI_EPOSTA: optionalText,
  ILK_YONETICI_SIFRE: z.string().optional(),
  ILK_YONETICI_AD: optionalText,
  // Notification mail. "kapali" writes mails as skipped; nothing leaves the machine unless "smtp".
  MAIL_GONDERIM: z.enum(['kapali', 'smtp'], { error: 'kapali ya da smtp olmalı' }).default('kapali'),
  SMTP_HOST: optionalText.pipe(z.string().regex(/^[A-Za-z0-9.-]+$/, 'ana makine adı ya da IP adresi olmalı').optional()),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_GUVENLIK: z.enum(['starttls', 'tls', 'yok'], { error: 'starttls, tls ya da yok olmalı' }).default('starttls'),
  SMTP_KULLANICI: optionalText,
  SMTP_SIFRE: z.string().optional(),
  MAIL_GONDEREN: optionalText.pipe(z.string().max(200).regex(/^[^\r\n]*@[^\r\n]*$/, 'e-posta adresi içermeli').optional()),
  MAIL_DENEME_SAYISI: z.coerce.number().int().min(1).max(20).default(5),
  UYGULAMA_ADRESI: optionalText.pipe(
    z
      .string()
      .regex(/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/, 'http:// ya da https:// ile başlayan bir adres olmalı')
      .transform((u) => u.replace(/\/+$/, ''))
      .optional(),
  ),
  // Reminders: 0 hours turns them off.
  HATIRLATMA_BEKLEME_SAAT: z.coerce.number().int().min(0).max(720).default(24),
  HATIRLATMA_SAATI: z
    .string()
    .trim()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'SS:DD biçiminde olmalı (ör. 09:00)')
    .default('09:00'),
  // Integrations (docs/onay-sistemi.md, section 9): the key that seals the stored Basic passwords, and
  // how many times a failed send is tried.
  ENTEGRASYON_ANAHTARI: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()))
    .pipe(z.string().min(32, 'en az 32 karakter olmalı').max(500, 'en fazla 500 karakter olmalı').optional()),
  ENTEGRASYON_DENEME_SAYISI: z.coerce.number().int().min(1).max(20).default(5),
});

export interface AppConfig {
  readonly port: number;
  readonly claudeBin: string;
  /** Models in cascade order; usually one or two. */
  readonly claudeModels: readonly string[];
  readonly claudeEffort: ClaudeEffort | undefined;
  readonly timeoutMs: number;
  readonly maxConcurrent: number;
  readonly oauthToken: string;
  readonly maxFileBytes: number;
  /** Listen on the local network too (AG_ERISIMI=yerel); otherwise on 127.0.0.1 only. */
  readonly lanAccess: boolean;
  /** Extra host names accepted when lanAccess is on. */
  readonly extraHosts: readonly string[];
}

export interface DbConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly encrypt: boolean;
  readonly trustServerCertificate: boolean;
  readonly poolMax: number;
  /** How long start-up keeps retrying while SQL Server is still starting. */
  readonly connectWaitMs: number;
}

export interface AuthSettings {
  readonly sessionTtlMs: number;
  /** Failed logins in a row before the e-mail address is locked for `loginLockMs`. */
  readonly loginMaxAttempts: number;
  readonly loginLockMs: number;
  readonly passwordMinLength: number;
}

export interface FirstAdmin {
  readonly eposta: string;
  readonly sifre: string;
  readonly adSoyad: string;
}

export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  /** tls: TLS from the start (465); starttls: upgrade required (587); yok: plain (trusted networks only). */
  readonly guvenlik: 'starttls' | 'tls' | 'yok';
  readonly kullanici: string | null;
  /** Never logged or written to the database. */
  readonly sifre: string | null;
}

export interface MailSettings {
  /** MAIL_GONDERIM=smtp; when false mails are written as skipped (atlandi) and never sent. */
  readonly enabled: boolean;
  /** Set when enabled. */
  readonly smtp: SmtpSettings | null;
  /** From address; set when enabled. */
  readonly gonderen: string | null;
  readonly maxAttempts: number;
  /** Panel address for links in mails, without a trailing slash; null = no links. */
  readonly appUrl: string | null;
}

export interface ReminderSettings {
  /** Steps waiting longer than this many hours are reminded; 0 = off. */
  readonly waitHours: number;
  /** Local time of day after which the daily reminder run starts. */
  readonly hour: number;
  readonly minute: number;
}

export interface IntegrationSettings {
  /** ENTEGRASYON_ANAHTARI; null = no password can be stored. Never logged. */
  readonly key: string | null;
  readonly maxAttempts: number;
}

export interface ServiceConfig {
  readonly auth: AuthSettings;
  /** Currency of the approval ranges and of the reports. */
  readonly baseCurrency: string;
  /** Created on the first start, when the database has no users yet. */
  readonly firstAdmin: FirstAdmin | null;
  readonly mail: MailSettings;
  readonly reminder: ReminderSettings;
  readonly integration: IntegrationSettings;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

function parseEnv<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Geçersiz yapılandırma: ${detail}`);
  }
  return parsed.data;
}

function readTokenFile(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ConfigError(
        `Claude token dosyası bulunamadı: ${path}. Komut satırında "claude setup-token" çalıştırıp çıkan token'ı bu dosyaya tek satır olarak kaydedin.`,
      );
    }
    throw new ConfigError(`Claude token dosyası okunamadı: ${path} (${code ?? 'bilinmeyen hata'})`);
  }
}

/** Reads the environment. Error messages name variables, never their values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const e = parseEnv(EnvSchema, env);
  const inline = e.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  const token = inline !== undefined && inline !== '' ? inline : readTokenFile(e.CLAUDE_OAUTH_TOKEN_FILE ?? DEFAULT_TOKEN_FILE);
  if (!OAUTH_TOKEN_REGEX.test(token)) {
    throw new ConfigError(
      'Claude token biçimi geçersiz (sk-ant-oat ile başlamalı). "claude setup-token" ile yeni token alıp dosyaya kaydedin.',
    );
  }
  return {
    port: e.PORT,
    claudeBin: e.CLAUDE_BIN,
    claudeModels: e.CLAUDE_MODEL,
    claudeEffort: e.CLAUDE_EFFORT === 'default' ? undefined : e.CLAUDE_EFFORT,
    timeoutMs: e.CLAUDE_TIMEOUT_SEC * 1000,
    maxConcurrent: e.CLAUDE_MAX_CONCURRENT,
    oauthToken: token,
    maxFileBytes: e.MAX_FILE_MB * 1024 * 1024,
    lanAccess: e.AG_ERISIMI === 'yerel',
    extraHosts: e.IZINLI_HOSTLAR,
  };
}

/** SQL Server connection (MSSQL_*). The password is never echoed. */
export function loadDbConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  let e;
  try {
    e = parseEnv(DbEnvSchema, env);
  } catch (err) {
    if (err instanceof ConfigError && /MSSQL_PASSWORD/.test(err.message)) {
      throw new ConfigError(
        `${err.message}. env.example dosyasını .env adıyla kopyalayıp MSSQL_PASSWORD değerini doldurun, sonra "npm run db:up" ile veritabanını başlatın.`,
      );
    }
    throw err;
  }
  return {
    host: e.MSSQL_HOST,
    port: e.MSSQL_PORT,
    database: e.MSSQL_DATABASE,
    user: e.MSSQL_USER,
    password: e.MSSQL_PASSWORD,
    encrypt: e.MSSQL_ENCRYPT,
    trustServerCertificate: e.MSSQL_TRUST_SERVER_CERTIFICATE,
    poolMax: e.MSSQL_POOL_MAX,
    connectWaitMs: e.MSSQL_CONNECT_WAIT_SEC * 1000,
  };
}

/** Accounts, sessions and expense settings. */
export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const e = parseEnv(ServiceEnvSchema, env);
  const auth: AuthSettings = {
    sessionTtlMs: e.OTURUM_SURESI_SAAT * 3_600_000,
    loginMaxAttempts: e.GIRIS_DENEME_SINIRI,
    loginLockMs: e.GIRIS_KILIT_DAKIKA * 60_000,
    passwordMinLength: e.SIFRE_MIN_UZUNLUK,
  };
  let firstAdmin: FirstAdmin | null = null;
  const adminPassword = e.ILK_YONETICI_SIFRE ?? '';
  if (e.ILK_YONETICI_EPOSTA !== undefined || adminPassword !== '') {
    if (e.ILK_YONETICI_EPOSTA === undefined || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.ILK_YONETICI_EPOSTA)) {
      throw new ConfigError('Geçersiz yapılandırma: ILK_YONETICI_EPOSTA geçerli bir e-posta adresi olmalı.');
    }
    if (adminPassword.length < auth.passwordMinLength) {
      throw new ConfigError(`Geçersiz yapılandırma: ILK_YONETICI_SIFRE en az ${auth.passwordMinLength} karakter olmalı.`);
    }
    firstAdmin = { eposta: e.ILK_YONETICI_EPOSTA.toLowerCase(), sifre: adminPassword, adSoyad: e.ILK_YONETICI_AD ?? 'Sistem Yöneticisi' };
  }
  const enabled = e.MAIL_GONDERIM === 'smtp';
  if (enabled && e.SMTP_HOST === undefined) throw new ConfigError('Geçersiz yapılandırma: MAIL_GONDERIM=smtp iken SMTP_HOST doldurulmalı.');
  if (enabled && e.MAIL_GONDEREN === undefined) throw new ConfigError('Geçersiz yapılandırma: MAIL_GONDERIM=smtp iken MAIL_GONDEREN doldurulmalı.');
  const sifre = e.SMTP_SIFRE ?? '';
  const mail: MailSettings = {
    enabled,
    smtp:
      enabled && e.SMTP_HOST !== undefined
        ? { host: e.SMTP_HOST, port: e.SMTP_PORT, guvenlik: e.SMTP_GUVENLIK, kullanici: e.SMTP_KULLANICI ?? null, sifre: sifre === '' ? null : sifre }
        : null,
    gonderen: enabled ? (e.MAIL_GONDEREN ?? null) : null,
    maxAttempts: e.MAIL_DENEME_SAYISI,
    appUrl: e.UYGULAMA_ADRESI ?? null,
  };
  const [hour, minute] = e.HATIRLATMA_SAATI.split(':').map(Number) as [number, number];
  const reminder: ReminderSettings = { waitHours: e.HATIRLATMA_BEKLEME_SAAT, hour, minute };
  const integration: IntegrationSettings = { key: e.ENTEGRASYON_ANAHTARI ?? null, maxAttempts: e.ENTEGRASYON_DENEME_SAYISI };
  return { auth, baseCurrency: e.PARA_BIRIMI, firstAdmin, mail, reminder, integration };
}
