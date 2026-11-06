/** Contract limit (docs/onay-sistemi.md, section 3): a form holds at most this many invoices. The server enforces it. */
export const MAX_INVOICES = 20;

/** The invoice fields the form fills itself from; both MasrafFatura and a freshly read FaturaBasligi have them. */
export interface InvoiceSummary {
  readonly genelToplam: number | null;
  readonly paraBirimi: string | null;
  readonly faturaTarihi: string | null;
  readonly saticiUnvan: string | null;
}

/** True when the invoice is in another currency than the form, so its total stays out of the sum. */
export const isOtherCurrency = (invoice: Pick<InvoiceSummary, 'paraBirimi'>, currency: string): boolean =>
  invoice.paraBirimi !== null && invoice.paraBirimi !== currency;

/**
 * Sum of the invoice grand totals in the form's currency (or whose currency was not read), with a positive
 * total; null when none qualifies. Mirrors the contract's rule 6 so the form can fill the amount and the
 * detail screen can word its notice; the approval amount itself always comes from the server.
 */
export function invoiceTotal(
  invoices: readonly Pick<InvoiceSummary, 'genelToplam' | 'paraBirimi'>[],
  currency: string,
): { readonly total: number; readonly count: number } | null {
  let cents = 0;
  let count = 0;
  for (const invoice of invoices) {
    const total = invoice.genelToplam;
    if (total === null || !Number.isFinite(total) || total <= 0 || isOtherCurrency(invoice, currency)) continue;
    cents += Math.round(total * 100);
    count += 1;
  }
  return count === 0 ? null : { total: cents / 100, count };
}

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
