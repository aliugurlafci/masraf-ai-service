import { z } from 'zod';
import { MAX_AMOUNT } from '../approval/flow.ts';
import { HttpError } from '../errors.ts';

// Fallback messages in Turkish; the schemas below set friendlier ones for the fields users type.
z.config(z.locales.tr());

/** Parses a body or query with `schema`; a failure becomes 400 with a message per field. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const alanlar: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join('.') : '_';
    alanlar[key] ??= issue.message;
  }
  const first = result.error.issues[0]?.message ?? 'İstek geçersiz.';
  throw new HttpError(400, 'gecersiz_istek', first, { alanlar });
}

export const text = (label: string, max: number) =>
  z
    .string({ error: `${label} girilmelidir.` })
    .trim()
    .min(1, `${label} boş olamaz.`)
    .max(max, `${label} en fazla ${max} karakter olabilir.`);

/** Optional free text: empty becomes null. */
export const optionalText = (label: string, max: number) =>
  z
    .string({ error: `${label} metin olmalıdır.` })
    .trim()
    .max(max, `${label} en fazla ${max} karakter olabilir.`)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : v));

const hasCents = (n: number): boolean => Math.abs(Math.round(n * 100) - n * 100) < 1e-6;

export const amount = (label: string) =>
  z
    .number({ error: `${label} sayı olmalıdır.` })
    .finite(`${label} geçerli bir sayı olmalıdır.`)
    .positive(`${label} sıfırdan büyük olmalıdır.`)
    .max(MAX_AMOUNT, `${label} çok büyük.`)
    .refine(hasCents, `${label} en fazla iki ondalık basamak içerebilir.`);

export const limit = (label: string) =>
  z
    .number({ error: `${label} sayı olmalıdır.` })
    .finite(`${label} geçerli bir sayı olmalıdır.`)
    .min(0, `${label} sıfırdan küçük olamaz.`)
    .max(MAX_AMOUNT, `${label} çok büyük.`)
    .refine(hasCents, `${label} en fazla iki ondalık basamak içerebilir.`);

export const rate = z
  .number({ error: 'Kur sayı olmalıdır.' })
  .finite('Kur geçerli bir sayı olmalıdır.')
  .positive('Kur sıfırdan büyük olmalıdır.')
  .max(1_000_000, 'Kur çok büyük.');

export const isoDate = (label: string) =>
  z
    .string({ error: `${label} girilmelidir.` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${label} YYYY-AA-GG biçiminde olmalıdır.`)
    .refine((s) => {
      const d = new Date(`${s}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && d.getUTCFullYear() >= 2000;
    }, `${label} geçerli bir tarih olmalıdır.`);

export const currency = z
  .string({ error: 'Para birimi girilmelidir.' })
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Para birimi üç harfli ISO kodu olmalıdır (TRY, USD, EUR).');

export const email = z
  .string({ error: 'E-posta girilmelidir.' })
  .trim()
  .toLowerCase()
  .max(254, 'E-posta çok uzun.')
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Geçerli bir e-posta adresi girin.');

export const password = z.string({ error: 'Şifre girilmelidir.' }).min(1, 'Şifre girilmelidir.').max(128, 'Şifre en fazla 128 karakter olabilir.');

export const id = (label = 'Kimlik') => z.coerce.number({ error: `${label} geçersiz.` }).int(`${label} geçersiz.`).positive(`${label} geçersiz.`).max(2_147_483_647, `${label} geçersiz.`);

export const recordId = z.string().regex(/^\d{8}-\d{6}-[a-f0-9]{8}$/, 'Fatura kimliği geçersiz.');

/** A route parameter that must be a positive integer; anything else is 404. */
export function routeId(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{1,9}$/.test(value)) throw new HttpError(404, 'bulunamadi', 'Kayıt bulunamadı.');
  return Number(value);
}

/** "a,b,c" query values. */
export const csvList = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? [] : v.split(',').map((s) => s.trim()).filter((s) => s !== '')));

export const bool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1'));
