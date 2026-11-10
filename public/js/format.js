// Turkish number, money, date and duration formatting.

// Show amounts with the precision the invoice printed (some print 3 decimals, e.g. 942,599); never round them away.
const money2 = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const plain = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 4 });
const dayFmt = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' });
const countFmt = new Intl.NumberFormat('tr-TR');
const usdFmt = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });
const usdShort = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

const missing = (v) => v === null || v === undefined;

export const fmtAmount = (v) => (missing(v) ? null : money2.format(v));
export const fmtMoney = (v, cur) => (missing(v) ? null : `${money2.format(v)} ${cur ?? ''}`.trim());
export const fmtQty = (v) => (missing(v) ? null : plain.format(v));
export const fmtRate = (v) => (missing(v) ? null : `%${plain.format(v)}`);
export const fmtDate = (iso) => (iso ? iso.split('-').reverse().join('.') : null);
export const fmtCount = (v) => countFmt.format(v);
export const fmtUsd = (v) => usdFmt.format(v);
export const fmtUsdShort = (v) => (v > 0 && v < 0.01 ? usdFmt.format(v) : usdShort.format(v));
export const fmtTime = (iso) => timeFmt.format(new Date(iso));
export const fmtDay = (date) => dayFmt.format(date);

export const fmtSeconds = (ms) => `${(ms / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} sn`;
export const fmtRequest = (ms) => (ms < 1000 ? `${ms} ms` : fmtSeconds(ms));

/** Running time on a lane: 0:07, 1:42, 12:05. */
export function fmtClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Running time in a sentence: 7 sn, 1 dk 42 sn. */
export function fmtElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} sn`;
  return `${Math.floor(total / 60)} dk ${String(total % 60).padStart(2, '0')} sn`;
}

/**
 * A file's place in the shared reading line (docs/onay-sistemi.md, "Okuma sırası"):
 * 3, 4 → "Sırada 3. · önünde 4 fatura var"; without a known place just "Sırada".
 */
export function queueText(kuyrukSirasi, onundeki) {
  if (!Number.isInteger(kuyrukSirasi) || kuyrukSirasi < 1) return 'Sırada';
  const ahead = Number.isInteger(onundeki) && onundeki > 0 ? `önünde ${countFmt.format(onundeki)} fatura var` : 'birazdan okunacak';
  return `Sırada ${countFmt.format(kuyrukSirasi)}. · ${ahead}`;
}

export function dayLabel(date) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Bugün';
  if (date.toDateString() === yesterday.toDateString()) return 'Dün';
  return dayFmt.format(date);
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** claude-haiku-5-5 becomes Haiku 5.5, the alias opus becomes Opus; anything else is shown as is. */
export function modelName(model) {
  if (!model) return null;
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model);
  if (m) return `${cap(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
  if (/^[a-z]+$/.test(model)) return cap(model);
  return model;
}

// ---------- Expense panel: currency, dates and amount input ----------

const currencyFmts = new Map();

/** 1800, 'TRY' → ₺1.800,00. Unknown codes fall back to "1.800,00 XYZ". */
export function fmtCurrency(v, cur) {
  if (missing(v)) return null;
  const code = typeof cur === 'string' && /^[A-Z]{3}$/.test(cur) ? cur : null;
  if (!code) return money2.format(v);
  if (!currencyFmts.has(code)) {
    let f = null;
    try {
      f = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } catch {
      f = null;
    }
    currencyFmts.set(code, f);
  }
  const f = currencyFmts.get(code);
  return f ? f.format(v) : `${money2.format(v)} ${code}`;
}

const compactFmt = new Intl.NumberFormat('tr-TR', { notation: 'compact', maximumFractionDigits: 1 });
export const fmtCompact = (v) => compactFmt.format(v);

const input2 = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const input6 = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 6 });

/** A number as it is typed back into an amount box: 1800.5 → 1.800,50. */
export const fmtAmountInput = (v) => (missing(v) ? '' : input2.format(v));
/** An exchange rate: up to 6 decimals, no trailing zeros. */
export const fmtRateInput = (v) => (missing(v) ? '' : input6.format(v));

/**
 * Reads an amount typed the Turkish way (1.800,50) or the plain way (1800.50).
 * Returns { value } or { error } with a Turkish message; an empty box gives { value: null }.
 */
export function parseAmount(text, { decimals = 2, dotThousands = true } = {}) {
  const raw = String(text ?? '').replace(/[\s ₺$€£]/g, '');
  if (raw === '') return { value: null };
  let normalized;
  if (raw.includes(',')) {
    // Comma is the decimal mark; dots are thousands separators.
    if (raw.indexOf(',') !== raw.lastIndexOf(',')) return { error: 'Geçerli bir sayı girin.' };
    normalized = raw.replace(/\./g, '').replace(',', '.');
  } else if (dotThousands && /^\d{1,3}(\.\d{3})+$/.test(raw)) {
    normalized = raw.replace(/\./g, ''); // 1.800 or 1.250.000: thousands
  } else {
    normalized = raw;
  }
  if (!/^\d+(\.\d+)?$/.test(normalized)) return { error: 'Geçerli bir sayı girin.' };
  const fraction = normalized.split('.')[1] ?? '';
  if (fraction.length > decimals) return { error: `En çok ${decimals} ondalık basamak girilebilir.` };
  return { value: Number(normalized) };
}

/** Whole cents, so limits compare exactly (5.000,00 and 5.000,01). */
export const toCents = (v) => Math.round(v * 100);

/** Today in the browser's time zone as YYYY-MM-DD. */
export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function localDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

const shortDayFmt = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });
const weekdayFmt = new Intl.DateTimeFormat('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** YYYY-MM-DD → 5 Kasım 2026. */
export const fmtDateLong = (iso) => {
  const d = localDate(iso);
  return d ? dayFmt.format(d) : null;
};
/** YYYY-MM-DD → 5 Kas 2026. */
export const fmtDateShort = (iso) => {
  const d = localDate(iso);
  return d ? shortDayFmt.format(d) : null;
};
/** ISO time → 5 Kas 2026 14:32. */
export const fmtDateTime = (iso) => (iso ? dateTimeFmt.format(new Date(iso)) : null);
export const fmtToday = () => weekdayFmt.format(new Date());

const relFmt = new Intl.RelativeTimeFormat('tr', { numeric: 'auto' });

/** ISO time → az önce, 5 dakika önce, dün, 3 gün önce; older ones as a date. */
export function fmtRelative(iso) {
  if (!iso) return null;
  const then = new Date(iso);
  const diff = (then.getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'az önce';
  if (abs < 3600) return relFmt.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return relFmt.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 7) return relFmt.format(Math.round(diff / 86400), 'day');
  return shortDayFmt.format(then);
}

/** Initials for an avatar: Ayşe Kaya → AK. */
export function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '';
  return `${first}${last}`.toLocaleUpperCase('tr-TR');
}
