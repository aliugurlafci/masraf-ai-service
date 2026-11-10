import { useRef, useState } from 'react';

import type { AlanDegerleri, AlanTanimi, FisDegeri, MasrafDetay, MasrafFatura } from '@/api/types';
import { attachmentId, fileHash, pendingHash, type InvoiceAttachment } from '@/hooks/useInvoiceAttachments';
import { blankValue, type ReceiptValueMap } from '@/lib/fields';
import { numberToText } from '@/lib/invoiceEdit';

/**
 * A receipt field's value while it is edited: the option id and its label for a liste field, otherwise
 * the text as typed (a number too, so "12," can be typed) with the same text as label.
 */
export interface DraftValue {
  readonly deger: number | string;
  readonly gosterim: string;
}

export type ReceiptDraft = Readonly<Record<string, DraftValue>>;

const NO_VALUES: ReceiptDraft = {};

/**
 * Who a receipt is across its states. A file picked here keeps its list key from upload to read invoice.
 * A file of the saved form keeps its SHA-256 when the server reads it into an invoice (the pending row
 * goes, an invoice with the same `dosyaOzeti` comes), so the values follow it; an old invoice without a
 * file hash goes by its id.
 */
export function receiptKey(item: InvoiceAttachment): string {
  if (item.kind === 'local') return item.key;
  const hash = fileHash(item);
  if (hash !== null) return `h:${hash}`;
  return item.kind === 'server' ? `s:${item.fatura.id}` : item.key;
}

const savedInvoiceKey = (f: MasrafFatura): string => (f.dosyaOzeti !== null ? `h:${f.dosyaOzeti}` : `s:${f.id}`);

/**
 * The receipt's key in `fisAlanlari`: the invoice id once read, the file's SHA-256 while it is read (it
 * also finds the invoice the file became meanwhile). Null while the file is not on the server yet or
 * could not be read on this device.
 */
export function requestKey(item: InvoiceAttachment): string | null {
  return attachmentId(item) ?? pendingHash(item);
}

/** Whether a server path's receipt key (`fisAlanlari.<key>`) names this receipt. */
export const isReceipt = (item: InvoiceAttachment, key: string): boolean =>
  attachmentId(item) === key || pendingHash(item) === key || fileHash(item) === key;

/** The server's values as drafts: they keep the server's form until the user types over them. */
const draftOf = (alanlar: AlanDegerleri): ReceiptDraft => ({ ...alanlar });

/** The text an input shows for a value: a stored number with the decimal comma, typed text as it is. */
export const inputText = (value: DraftValue | undefined): string =>
  value === undefined ? '' : typeof value.deger === 'number' ? numberToText(value.deger) : value.deger;

/** What the rules look at: option ids for liste fields, the values otherwise. */
export const conditionValues = (draft: ReceiptDraft): ReceiptValueMap =>
  Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, value.deger]));

const SAYI = /^-?\d+([.,]\d+)?$/;

/** A draft value as the request carries it, or why it cannot go. */
export function requestValue(field: AlanTanimi, value: DraftValue): { readonly value: FisDegeri } | { readonly error: string } {
  if (field.tur === 'liste') return typeof value.deger === 'number' ? { value: value.deger } : { error: 'Listeden bir seçenek seçin.' };
  if (field.tur === 'sayi' && typeof value.deger === 'number') return { value: value.deger };
  const text = String(value.deger).trim();
  if (field.tur === 'sayi') {
    const plain = text.replace(/\s/g, '');
    if (!SAYI.test(plain)) return { error: 'Geçerli bir sayı girin.' };
    const n = Number(plain.replace(',', '.'));
    return Number.isFinite(n) ? { value: n } : { error: 'Geçerli bir sayı girin.' };
  }
  return { value: text };
}

/** The receipt's values for `fisAlanlari` (only the given fields, empty ones left out = deleted), or the fields' errors. */
export function requestValues(
  fields: readonly AlanTanimi[],
  draft: ReceiptDraft,
): { readonly values: Record<string, FisDegeri> } | { readonly errors: Record<string, string> } {
  const values: Record<string, FisDegeri> = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = draft[field.anahtar];
    if (value === undefined || blankValue(value.deger)) continue;
    const result = requestValue(field, value);
    if ('error' in result) errors[field.anahtar] = result.error;
    else values[field.anahtar] = result.value;
  }
  return Object.keys(errors).length > 0 ? { errors } : { values };
}

/** Same values, ignoring empty ones and the way they are shown. */
export function sameDraft(a: ReceiptDraft, b: ReceiptDraft): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const x = a[key];
    const y = b[key];
    const xBlank = x === undefined || blankValue(x.deger);
    const yBlank = y === undefined || blankValue(y.deger);
    if (xBlank && yBlank) continue;
    if (xBlank !== yBlank) return false;
    if (typeof x?.deger === 'string' && typeof y?.deger === 'string') {
      if (x.deger.trim() !== y.deger.trim()) return false;
    } else if (x?.deger !== y?.deger) {
      return false;
    }
  }
  return true;
}

function serverValues(detail: MasrafDetay): Record<string, ReceiptDraft> {
  const out: Record<string, ReceiptDraft> = {};
  for (const f of detail.faturalar) out[savedInvoiceKey(f)] = draftOf(f.alanlar);
  for (const b of detail.bekleyenFaturalar) out[`h:${b.dosyaOzeti}`] = draftOf(b.alanlar);
  return out;
}

/**
 * Receipt field values of the form's receipts, by receiptKey, with what the server holds (`base`) and
 * which receipts the user changed here. A newer copy of the saved form brings the server's values for
 * receipts the user has not touched; what the user entered is never overwritten.
 */
export function useReceiptValues(initial: MasrafDetay | undefined) {
  const [values, setValues] = useState<Readonly<Record<string, ReceiptDraft>>>(() => (initial === undefined ? {} : serverValues(initial)));
  const valuesRef = useRef(values);
  const base = useRef<Record<string, ReceiptDraft>>(initial === undefined ? {} : serverValues(initial));
  const dirty = useRef(new Set<string>());
  // Server or local errors by receipt, then by field key.
  const [errors, setErrorsState] = useState<Readonly<Record<string, Readonly<Record<string, string>>>>>({});

  const update = (change: (current: Readonly<Record<string, ReceiptDraft>>) => Readonly<Record<string, ReceiptDraft>>): void => {
    const next = change(valuesRef.current);
    valuesRef.current = next;
    setValues(next);
  };

  /** Sets (or with null clears) one field of one receipt. */
  const set = (receipt: string, anahtar: string, value: DraftValue | null): void => {
    dirty.current.add(receipt);
    update((current) => {
      const draft = { ...(current[receipt] ?? NO_VALUES) };
      if (value === null) delete draft[anahtar];
      else draft[anahtar] = value;
      return { ...current, [receipt]: draft };
    });
    setErrorsState((e) => {
      const own = e[receipt];
      if (own === undefined || !(anahtar in own)) return e;
      const rest = { ...own };
      delete rest[anahtar];
      return { ...e, [receipt]: rest };
    });
  };

  /** Takes in a newer copy of the saved form. */
  const adopt = (detail: MasrafDetay): void => {
    const server = serverValues(detail);
    Object.assign(base.current, server);
    const untouched = Object.entries(server).filter(([key]) => !dirty.current.has(key));
    if (untouched.length > 0) update((current) => ({ ...current, ...Object.fromEntries(untouched) }));
  };

  /** The server now holds these receipts' values as they are on screen. */
  const markSaved = (receipts: readonly string[]): void => {
    for (const key of receipts) {
      base.current[key] = valuesRef.current[key] ?? NO_VALUES;
      dirty.current.delete(key);
    }
  };

  return {
    values,
    of: (receipt: string): ReceiptDraft => values[receipt] ?? NO_VALUES,
    /** The user changed the receipt's values here and they differ from what the server holds. */
    changed: (receipt: string): boolean => dirty.current.has(receipt) && !sameDraft(valuesRef.current[receipt] ?? NO_VALUES, base.current[receipt] ?? NO_VALUES),
    set,
    adopt,
    markSaved,
    errors,
    setErrors: (next: Readonly<Record<string, Readonly<Record<string, string>>>>): void => setErrorsState(next),
  };
}
