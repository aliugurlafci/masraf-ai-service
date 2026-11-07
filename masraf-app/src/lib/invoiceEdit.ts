import type { FaturaBasligi, FaturaKalemi, MasrafFatura, OkunanFatura, ZorunluAlan } from '@/api/types';

import { attachmentId, type InvoiceAttachment } from '@/hooks/useInvoiceAttachments';

import { formatDate, formatMoney, formatNumber } from './format';

/** Contract: a correction line holds at most this many lines (docs/onay-sistemi.md, section 6). */
export const MAX_LINES = 200;
/** Text fields of a correction are at most this long. */
export const MAX_TEXT = 500;

export type HeaderKey = keyof FaturaBasligi;
export type LineKey = keyof FaturaKalemi;
export type FieldKind = 'text' | 'date' | 'currency' | 'amount';

export interface FieldSpec<K extends string> {
  readonly key: K;
  readonly label: string;
  readonly kind: FieldKind;
  readonly required?: boolean;
}

/** The invoice header, in the order it is shown (schema: src/invoice/schema.ts). */
export const HEADER_FIELDS: readonly FieldSpec<HeaderKey>[] = [
  { key: 'faturaNo', label: 'Fatura no', kind: 'text', required: true },
  { key: 'faturaTarihi', label: 'Fatura tarihi', kind: 'date', required: true },
  { key: 'saticiUnvan', label: 'Satıcı ünvanı', kind: 'text', required: true },
  { key: 'saticiVergiNo', label: 'Satıcı vergi no', kind: 'text' },
  { key: 'aliciUnvan', label: 'Alıcı ünvanı', kind: 'text' },
  { key: 'aliciVergiNo', label: 'Alıcı vergi no', kind: 'text' },
  { key: 'paraBirimi', label: 'Para birimi', kind: 'currency' },
  { key: 'araToplam', label: 'Ara toplam', kind: 'amount' },
  { key: 'kdvToplam', label: 'KDV toplamı', kind: 'amount' },
  { key: 'genelToplam', label: 'Genel toplam', kind: 'amount', required: true },
];

export const LINE_FIELDS: readonly FieldSpec<LineKey>[] = [
  { key: 'aciklama', label: 'Açıklama', kind: 'text' },
  { key: 'miktar', label: 'Miktar', kind: 'amount' },
  { key: 'birim', label: 'Birim', kind: 'text' },
  { key: 'birimFiyat', label: 'Birim fiyat', kind: 'amount' },
  { key: 'kdvOrani', label: 'KDV oranı (%)', kind: 'amount' },
  { key: 'tutar', label: 'Tutar', kind: 'amount' },
];

export const REQUIRED_FIELDS: readonly ZorunluAlan[] = ['faturaNo', 'faturaTarihi', 'saticiUnvan', 'genelToplam'];

export const fieldLabel = (key: string): string => HEADER_FIELDS.find((f) => f.key === key)?.label ?? key;

/** The effective information of an invoice already on a form, in the shape of the read result. */
export function toOkunan(f: MasrafFatura): OkunanFatura {
  return {
    fatura: {
      faturaNo: f.faturaNo,
      faturaTarihi: f.faturaTarihi,
      saticiUnvan: f.saticiUnvan,
      saticiVergiNo: f.saticiVergiNo,
      aliciUnvan: f.aliciUnvan,
      aliciVergiNo: f.aliciVergiNo,
      paraBirimi: f.paraBirimi,
      araToplam: f.araToplam,
      kdvToplam: f.kdvToplam,
      genelToplam: f.genelToplam,
    },
    kalemler: f.kalemler,
  };
}

const blank = (value: string | number | null | undefined): boolean => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

/** Required fields that are empty. A missing result (nothing read) leaves all of them empty. */
export function missingFields(value: OkunanFatura | null): ZorunluAlan[] {
  return REQUIRED_FIELDS.filter((key) => value === null || blank(value.fatura[key]));
}

const sameLine = (a: FaturaKalemi, b: FaturaKalemi): boolean => LINE_FIELDS.every((f) => a[f.key] === b[f.key]);

export function sameLines(a: readonly FaturaKalemi[], b: readonly FaturaKalemi[]): boolean {
  return a.length === b.length && a.every((line, i) => sameLine(line, b[i] as FaturaKalemi));
}

export function sameInvoice(a: OkunanFatura, b: OkunanFatura): boolean {
  return HEADER_FIELDS.every((f) => a.fatura[f.key] === b.fatura[f.key]) && sameLines(a.kalemler, b.kalemler);
}

/** Header fields whose values differ. */
export function changedHeaderKeys(read: OkunanFatura, current: OkunanFatura): HeaderKey[] {
  return HEADER_FIELDS.filter((f) => read.fatura[f.key] !== current.fatura[f.key]).map((f) => f.key);
}

/** A header value as text for display; empty values read "—". */
export function displayValue(spec: FieldSpec<string>, value: string | number | null, currency?: string | null): string {
  if (value === null || value === '') return '—';
  if (spec.kind === 'date' && typeof value === 'string') return formatDate(value);
  if (spec.kind === 'amount' && typeof value === 'number') return currency ? formatMoney(value, currency) : formatNumber(value);
  return String(value);
}

/** A number as editable text, keeping every digit (the Turkish decimal comma). */
export const numberToText = (value: number | null): string => (value === null ? '' : String(value).replace('.', ','));

/** Corrections made on the form screen, by invoice id: a whole invoice, or null = back to the read result. */
export type Edits = Readonly<Record<string, OkunanFatura | null>>;

/** What was read from the invoice (before any correction), or null when nothing is known. */
export function originalOf(item: InvoiceAttachment): OkunanFatura | null {
  if (item.kind === 'server') return item.fatura.okunan ?? toOkunan(item.fatura);
  return item.reading.phase === 'done' ? item.reading.sonuc : null;
}

/** The invoice's effective information: this screen's correction, else what the server holds, else what was read. */
export function effectiveOf(item: InvoiceAttachment, edits: Edits): OkunanFatura | null {
  const id = attachmentId(item);
  if (id !== null && id in edits) {
    const edit = edits[id];
    return edit === undefined || edit === null ? originalOf(item) : edit;
  }
  return item.kind === 'server' ? toOkunan(item.fatura) : originalOf(item);
}

/** Whether the invoice is shown corrected (its effective information differs from the read result). */
export function isCorrected(item: InvoiceAttachment, edits: Edits): boolean {
  const id = attachmentId(item);
  if (id !== null && id in edits) return edits[id] !== null && edits[id] !== undefined;
  return item.kind === 'server' && item.fatura.duzeltildi;
}

/** Required fields still empty. Without a change on this screen the server's own `eksikAlanlar` counts. */
export function missingOf(item: InvoiceAttachment, edits: Edits): ZorunluAlan[] {
  const id = attachmentId(item);
  if (item.kind === 'server' && (id === null || !(id in edits))) return [...item.fatura.eksikAlanlar];
  return missingFields(effectiveOf(item, edits));
}
