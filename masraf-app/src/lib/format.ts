/** Turkish number, money and date formatting. */

const MONTHS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'] as const;
const MONTHS_LONG = [
  'Ocak',
  'Şubat',
  'Mart',
  'Nisan',
  'Mayıs',
  'Haziran',
  'Temmuz',
  'Ağustos',
  'Eylül',
  'Ekim',
  'Kasım',
  'Aralık',
] as const;
export const WEEKDAYS_SHORT = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'] as const;

const moneyFormats = new Map<string, Intl.NumberFormat>();

function moneyFormat(currency: string): Intl.NumberFormat | null {
  const code = currency.toUpperCase();
  const cached = moneyFormats.get(code);
  if (cached !== undefined) return cached;
  try {
    const format = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 });
    moneyFormats.set(code, format);
    return format;
  } catch {
    return null;
  }
}

/** Groups with "." and uses "," for decimals, without relying on Intl. */
export function formatNumber(value: number, fractionDigits = 2): string {
  const fixed = Math.abs(value).toFixed(fractionDigits);
  const [whole = '0', fraction] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${value < 0 ? '-' : ''}${grouped}${fraction !== undefined ? `,${fraction}` : ''}`;
}

/** "₺1.800,00" — Intl with tr-TR; falls back to "1.800,00 XYZ" for an unknown currency code. */
export function formatMoney(value: number, currency: string): string {
  const format = moneyFormat(currency);
  if (format !== null) {
    try {
      return format.format(value);
    } catch {
      // fall through
    }
  }
  return `${formatNumber(value)} ${currency.toUpperCase()}`;
}

/** Prefix and suffix around the number for a currency, so a worklet can format animated values. */
export function moneyAffixes(currency: string): { prefix: string; suffix: string } {
  const sample = formatMoney(1, currency);
  const index = sample.indexOf('1,00');
  if (index < 0) return { prefix: '', suffix: ` ${currency.toUpperCase()}` };
  return { prefix: sample.slice(0, index), suffix: sample.slice(index + 4) };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local calendar date as YYYY-MM-DD. */
export function toIsoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const todayIso = (): string => toIsoDate(new Date());

/** Parses YYYY-MM-DD as a local calendar date (no time zone shift). */
export function parseIsoDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "5 Kas 2026" for a YYYY-MM-DD date. */
export function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const date = parseIsoDate(value);
  if (date === null) return value;
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

const WEEKDAYS = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];

/** "Salı" for an ISO date; empty when it cannot be read. */
export function formatWeekday(value: string): string {
  const date = parseIsoDate(value);
  return date === null ? '' : (WEEKDAYS[date.getDay()] ?? '');
}

/** "5 Kas 2026 14:32" for an ISO timestamp, in the device's time zone. */
export function formatDateTime(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export const monthTitle = (year: number, month: number): string => `${MONTHS_LONG[month]} ${year}`;

/** "Bugün", "Dün" or "5 Kas 2026" for a YYYY-MM-DD date. */
export function formatDateFriendly(value: string): string {
  const today = new Date();
  if (value === toIsoDate(today)) return 'Bugün';
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (value === toIsoDate(yesterday)) return 'Dün';
  return formatDate(value);
}

/**
 * Reads an amount typed the Turkish way ("1.234,56") or with a decimal point ("1234.56").
 * Returns null when the text is not a number.
 */
export function parseAmount(text: string): number | null {
  let value = text.replace(/[\s₺]/g, '');
  if (value === '') return null;
  if (value.includes(',')) {
    value = value.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(value)) {
    // "1.234" or "1.234.567": dots are thousands separators.
    value = value.replace(/\./g, '');
  }
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Amount for an input field: "1800,5" → "1800,50"; whole numbers stay whole. */
export function amountToInput(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace('.', ',');
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toLocaleUpperCase('tr-TR');
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/**
 * The amounts that reach an approver, both ends inclusive: "Tüm tutarlar", "₺5.000,00 ve altı",
 * "₺5.000,01 ve üzeri" or "₺5.000,01 – ₺50.000,00". Worded without suffixes, which would need
 * Turkish vowel harmony on a formatted number.
 */
export function formatBand(alt: number, ust: number | null, currency: string): string {
  if (ust === null) return alt <= 0 ? 'Tüm tutarlar' : `${formatMoney(alt, currency)} ve üzeri`;
  if (alt <= 0) return `${formatMoney(ust, currency)} ve altı`;
  return `${formatMoney(alt, currency)} – ${formatMoney(ust, currency)}`;
}
