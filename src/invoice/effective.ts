// An invoice's effective data on a form, the fields a form cannot be sent without and the duplicate
// key (docs/onay-sistemi.md, section 3, "Fatura bilgileri, düzeltme ve gönderim kontrolleri").
// Pure functions; no database.
import { REQUIRED } from './checks.ts';
import { InvoiceHeaderSchema, InvoiceLineSchema, type Invoice } from './schema.ts';

type Header = Invoice['fatura'];
type Line = Invoice['kalemler'][number];

/** A header field that must be filled before a form is sent. */
export type RequiredField = (typeof REQUIRED)[number][0];

const HEADER_KEYS = Object.keys(InvoiceHeaderSchema.shape) as Array<keyof Header>;
const LINE_KEYS = Object.keys(InvoiceLineSchema.shape) as Array<keyof Line>;

/** Turkish names of the invoice fields, for the history ("2. fatura düzeltildi: fatura no."). */
export const FIELD_LABELS: Readonly<Record<keyof Header | 'kalemler', string>> = {
  faturaNo: 'fatura no',
  faturaTarihi: 'fatura tarihi',
  saticiUnvan: 'satıcı',
  saticiVergiNo: 'satıcı vergi no',
  aliciUnvan: 'alıcı',
  aliciVergiNo: 'alıcı vergi no',
  paraBirimi: 'para birimi',
  araToplam: 'ara toplam',
  kdvToplam: 'KDV toplamı',
  genelToplam: 'genel toplam',
  kalemler: 'kalemler',
};

/** The data every form calculation uses: the user's correction when there is one, else the read result. */
export function effectiveInvoice(read: Invoice, correction: Invoice | null | undefined): Invoice {
  return correction ?? read;
}

const blank = (v: string | number | null): boolean => v === null || (typeof v === 'string' && v.trim() === '');

/** Required header fields that are empty, in the order of REQUIRED. */
export function missingFields(invoice: Invoice): RequiredField[] {
  return REQUIRED.filter(([key]) => blank(invoice.fatura[key])).map(([key]) => key);
}

/** Spaces, '-', '/' and '.' removed; a–z upper-cased by ASCII rules (Turkish letters stay as they are). */
export function normalizeIdentifier(value: string | null): string {
  if (value === null) return '';
  return value.replace(/[\s\-/.]/g, '').replace(/[a-z]/g, (c) => c.toUpperCase());
}

/** Room for the key in form_faturalari.mukerrer_anahtari. */
export const MAX_KEY_LENGTH = 450;

/**
 * The key two declarations of the same invoice share: `V|<seller tax no>|<invoice no>` when the seller's
 * tax number is known, else `T|<invoice no>|<date>|<total, 2 decimals>`. Null without an invoice number.
 * The tax and invoice numbers are normalised; the date and the total are already in a fixed format.
 */
export function duplicateKey(invoice: Invoice): string | null {
  const f = invoice.fatura;
  const no = normalizeIdentifier(f.faturaNo);
  if (no === '') return null;
  const vergiNo = normalizeIdentifier(f.saticiVergiNo);
  const total = f.genelToplam === null ? '' : (Math.round(f.genelToplam * 100) / 100).toFixed(2);
  const key = vergiNo !== '' ? `V|${vergiNo}|${no}` : `T|${no}|${f.faturaTarihi ?? ''}|${total}`;
  // Only absurdly long read values reach the limit; the prefix still tells real invoices apart.
  return key.slice(0, MAX_KEY_LENGTH);
}

const canonical = (invoice: Invoice): string =>
  JSON.stringify([HEADER_KEYS.map((k) => invoice.fatura[k]), invoice.kalemler.map((line) => LINE_KEYS.map((k) => line[k]))]);

/** Whether two invoices carry the same data, field by field. A correction equal to the read result is not kept. */
export function sameInvoice(a: Invoice, b: Invoice): boolean {
  return canonical(a) === canonical(b);
}

/** Turkish names of the fields that differ, header fields in schema order, then "kalemler". */
export function changedFields(before: Invoice, after: Invoice): string[] {
  const changed: string[] = HEADER_KEYS.filter((k) => before.fatura[k] !== after.fatura[k]).map((k) => FIELD_LABELS[k]);
  const lines = (inv: Invoice): string => JSON.stringify(inv.kalemler.map((line) => LINE_KEYS.map((k) => line[k])));
  if (lines(before) !== lines(after)) changed.push(FIELD_LABELS.kalemler);
  return changed;
}

/**
 * Applies the corrections of one request to a form's invoices.
 *
 * `ids` is the form's invoice list after the request, `reads` the read result of each, `stored` the
 * corrections the form has. In `given`, a value replaces the correction, null removes it, and invoices
 * left out keep theirs; corrections of invoices no longer on the form are dropped. A correction equal to
 * the read result is not kept. Every id in `given` must be in `ids` (the caller checks).
 *
 * Returns the corrections to store and the history notes, in invoice order: "2. fatura düzeltildi:
 * fatura no, genel toplam." or "2. faturanın düzeltmesi geri alındı."
 */
export function mergeCorrections(
  ids: readonly string[],
  reads: ReadonlyMap<string, Invoice>,
  stored: ReadonlyMap<string, Invoice>,
  given: Readonly<Record<string, Invoice | null>> | undefined,
): { corrections: Map<string, Invoice>; notes: string[] } {
  const corrections = new Map<string, Invoice>();
  for (const id of ids) {
    const kept = stored.get(id);
    if (kept !== undefined) corrections.set(id, kept);
  }
  const notes: string[] = [];
  ids.forEach((id, i) => {
    if (given === undefined || !Object.hasOwn(given, id)) return;
    const read = reads.get(id);
    if (read === undefined) return;
    const value = given[id] ?? null;
    const before = corrections.get(id) ?? null;
    if (value === null || sameInvoice(value, read)) corrections.delete(id);
    else corrections.set(id, value);
    const after = corrections.get(id) ?? null;
    if (before !== null && after === null) {
      notes.push(`${i + 1}. faturanın düzeltmesi geri alındı.`);
    } else if (after !== null) {
      const changed = changedFields(before ?? read, after);
      if (changed.length > 0) notes.push(`${i + 1}. fatura düzeltildi: ${changed.join(', ')}.`);
    }
  });
  return { corrections, notes };
}
