/** Contract limit (docs/onay-sistemi.md, section 3): a form holds at most this many invoices. The server enforces it. */
export const MAX_INVOICES = 20;

/** The invoice fields the form fills itself from; both MasrafFatura and a freshly read FaturaBasligi have them. */
export interface InvoiceSummary {
  readonly genelToplam: number | null;
  readonly paraBirimi: string | null;
  readonly faturaTarihi: string | null;
  readonly saticiUnvan: string | null;
}

/** What an invoice adds to the total: its grand total, currency and, in a third currency, the entered equivalent. */
export interface InvoiceMoney {
  readonly genelToplam: number | null;
  readonly paraBirimi: string | null;
  /** Base-currency equivalent the sender entered, for an invoice in a third currency. */
  readonly yerelKarsilik?: number | null;
}

/*
 * The rules below mirror src/expenses/rules.ts (contract rule 6) so the form can fill its amount and ask
 * for equivalents as the user types. The server applies the same rules and its answer is what counts.
 */

/**
 * Whether the sender must enter the invoice's value in the base currency: its currency was read and is
 * neither the form's (converted with the form rate) nor the base currency (counted as it is).
 */
export function needsEquivalent(formCurrency: string, base: string, invoice: Pick<InvoiceMoney, 'paraBirimi'>): boolean {
  return invoice.paraBirimi !== null && invoice.paraBirimi !== formCurrency && invoice.paraBirimi !== base;
}

const positive = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v) && v > 0;

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * The invoices' total split by where it comes from: `form` in the form's currency (invoices in that
 * currency or whose currency was not read), `local` in the base currency (base-currency invoices and
 * entered equivalents). Null when no invoice can count; an invoice without its equivalent does not.
 */
function invoiceParts(
  formCurrency: string,
  base: string,
  invoices: readonly InvoiceMoney[],
): { readonly formCents: number; readonly localCents: number; readonly formCount: number; readonly localCount: number } | null {
  let formCents = 0;
  let localCents = 0;
  let formCount = 0;
  let localCount = 0;
  for (const invoice of invoices) {
    if (needsEquivalent(formCurrency, base, invoice)) {
      if (!positive(invoice.yerelKarsilik)) continue;
      localCents += Math.round(invoice.yerelKarsilik * 100);
      localCount += 1;
    } else {
      if (!positive(invoice.genelToplam)) continue;
      if (invoice.paraBirimi === null || invoice.paraBirimi === formCurrency) {
        formCents += Math.round(invoice.genelToplam * 100);
        formCount += 1;
      } else {
        localCents += Math.round(invoice.genelToplam * 100);
        localCount += 1;
      }
    }
  }
  return formCount + localCount === 0 ? null : { formCents, localCents, formCount, localCount };
}

/**
 * The invoices' total in the form's currency: invoices in that currency plus the base-currency amounts
 * (base-currency invoices and entered equivalents) divided by the form rate. Without a usable rate on a
 * foreign-currency form the base-currency amounts cannot be converted and only the form-currency invoices
 * count. Null when nothing counts. `count` is how many invoices went into the total.
 */
export function invoiceTotalInForm(
  formCurrency: string,
  base: string,
  kur: number | null,
  invoices: readonly InvoiceMoney[],
): { readonly total: number; readonly count: number } | null {
  const parts = invoiceParts(formCurrency, base, invoices);
  if (parts === null) return null;
  if (formCurrency === base) return { total: round2((parts.formCents + parts.localCents) / 100), count: parts.formCount + parts.localCount };
  if (positive(kur)) return { total: round2(parts.formCents / 100 + parts.localCents / 100 / kur), count: parts.formCount + parts.localCount };
  return parts.formCount === 0 ? null : { total: parts.formCents / 100, count: parts.formCount };
}

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Same invoice ids with the same amounts to the cent. */
export function sameAmounts(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean {
  const entries = Object.entries(a);
  if (entries.length !== Object.keys(b).length) return false;
  return entries.every(([id, value]) => {
    const other = b[id];
    return other !== undefined && Math.round(value * 100) === Math.round(other * 100);
  });
}
