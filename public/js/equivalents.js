// What the invoices add to an expense, mirroring src/expenses/rules.ts (needsEquivalent,
// invoicesLocalTotal, amountMismatch) and docs/onay-sistemi.md, section 2, rule 6. Display only: the
// server works out the approval amount itself.
//
// An invoice in the form's currency (or whose currency was not read) counts with its grand total in
// that currency. One in the base currency (PARA_BIRIMI) counts as it is, in the base currency. One in
// any third currency counts only with the base-currency equivalent the sender entered.

const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** True when the sender must enter the invoice's value in the base currency. */
export function needsEquivalent(formCurrency, base, invoice) {
  const c = invoice?.paraBirimi ?? null;
  return c !== null && c !== formCurrency && c !== base;
}

/**
 * How one invoice adds to the total: { where: 'form', cents } in the form's currency,
 * { where: 'local', cents } in the base currency, or null when it does not count (no grand total
 * read, or a third-currency invoice without an equivalent).
 */
export function invoiceShare(invoice, formCurrency, base, equivalent) {
  if (needsEquivalent(formCurrency, base, invoice)) return positive(equivalent) ? { where: 'local', cents: Math.round(equivalent * 100) } : null;
  if (!positive(invoice?.genelToplam)) return null;
  const c = invoice.paraBirimi ?? null;
  return { where: c === null || c === formCurrency ? 'form' : 'local', cents: Math.round(invoice.genelToplam * 100) };
}

/**
 * The invoices' total in the form's currency. items: [{ fatura, equivalent }]. Base-currency amounts
 * are converted with the form's rate (none needed when the form is in the base currency); without a
 * rate they cannot be converted yet and are counted in `unconverted` instead.
 * Returns { value, count, unconverted }; value is null when no invoice counts.
 */
export function invoicesTotal(items, formCurrency, base, rate) {
  const k = formCurrency === base ? 1 : positive(rate) ? rate : null;
  let form = 0;
  let local = 0;
  let count = 0;
  let unconverted = 0;
  for (const { fatura, equivalent } of items) {
    const share = invoiceShare(fatura, formCurrency, base, equivalent);
    if (!share) continue;
    if (share.where === 'form') {
      form += share.cents;
      count++;
    } else if (k !== null) {
      local += share.cents;
      count++;
    } else {
      unconverted++;
    }
  }
  const value = count > 0 ? Math.round((form / 100 + (local > 0 ? local / 100 / k : 0)) * 100) / 100 : null;
  return { value, count, unconverted };
}
