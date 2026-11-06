// Expense form rules from docs/onay-sistemi.md, section 3. Pure functions; no database.
import { MAX_AMOUNT, round2 } from '../approval/flow.ts';

export const ROLES = ['calisan', 'muhasebe', 'yonetici'] as const;
export type Rol = (typeof ROLES)[number];

export const FORM_STATES = ['taslak', 'onayda', 'onaylandi', 'reddedildi', 'iptal', 'odendi'] as const;
export type FormDurum = (typeof FORM_STATES)[number];

export type AdimDurum = 'sirada' | 'bekliyor' | 'onaylandi' | 'reddedildi' | 'atlandi' | 'iptal';

export interface Actor {
  readonly id: number;
  readonly rol: Rol;
}

/** Sees every form, invoice and reading, exports and marks forms paid. */
export const isPrivileged = (actor: Actor): boolean => actor.rol === 'muhasebe' || actor.rol === 'yonetici';

export interface Izinler {
  readonly duzenle: boolean;
  readonly gonder: boolean;
  readonly geriCek: boolean;
  readonly iptal: boolean;
  readonly onayla: boolean;
  readonly reddet: boolean;
  readonly odendi: boolean;
  readonly devret: boolean;
}

export interface FormFacts {
  readonly durum: FormDurum;
  readonly olusturanId: number;
  /** Approver of the step waiting for a decision; null when none waits. */
  readonly bekleyenOnayciId: number | null;
}

const EDITABLE: readonly FormDurum[] = ['taslak', 'reddedildi'];

/** What `actor` may do with the form right now. The API enforces the same rules. */
export function permissions(form: FormFacts, actor: Actor): Izinler {
  const owner = form.olusturanId === actor.id;
  const editable = owner && EDITABLE.includes(form.durum);
  const decides = form.durum === 'onayda' && form.bekleyenOnayciId === actor.id;
  return {
    duzenle: editable,
    gonder: editable,
    geriCek: owner && form.durum === 'onayda',
    iptal: editable,
    onayla: decides,
    reddet: decides,
    odendi: isPrivileged(actor) && form.durum === 'onaylandi',
    devret: actor.rol === 'yonetici' && form.durum === 'onayda',
  };
}

/** Amount in the base currency: tutar × kur, or tutar when the form is in the base currency. */
export function localAmount(tutar: number, kur: number | null): number {
  return round2(tutar * (kur ?? 1));
}

/** Most invoices one form may hold. */
export const MAX_INVOICES = 20;

export interface InvoiceTotal {
  readonly genelToplam: number | null;
  readonly paraBirimi: string | null;
  /** Base-currency equivalent the sender entered, for an invoice in a third currency. */
  readonly yerelKarsilik?: number | null | undefined;
}

export interface FormMoney {
  readonly tutar: number;
  readonly paraBirimi: string;
  readonly kur: number | null;
}

/**
 * Whether the sender must enter the invoice's value in the base currency: its currency was read and
 * is neither the form's (converted with the form rate) nor the base currency (counted as it is).
 */
export function needsEquivalent(formCurrency: string, base: string, invoice: Pick<InvoiceTotal, 'paraBirimi'>): boolean {
  return invoice.paraBirimi !== null && invoice.paraBirimi !== formCurrency && invoice.paraBirimi !== base;
}

const positive = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v) && v > 0;

/**
 * The invoices' total in cents, split by where it comes from: `form` in the form's currency (invoices in
 * that currency or whose currency was not read), `local` in the base currency (base-currency invoices
 * and entered equivalents). Null when no invoice can count.
 */
function invoiceCents(form: FormMoney, base: string, invoices: readonly InvoiceTotal[]): { form: number; local: number } | null {
  let formCents = 0;
  let localCents = 0;
  let counted = false;
  for (const invoice of invoices) {
    if (needsEquivalent(form.paraBirimi, base, invoice)) {
      if (!positive(invoice.yerelKarsilik)) continue;
      localCents += Math.round(invoice.yerelKarsilik * 100);
    } else {
      if (!positive(invoice.genelToplam)) continue;
      if (invoice.paraBirimi === null || invoice.paraBirimi === form.paraBirimi) formCents += Math.round(invoice.genelToplam * 100);
      else localCents += Math.round(invoice.genelToplam * 100);
    }
    counted = true;
  }
  return counted ? { form: formCents, local: localCents } : null;
}

/** The invoices' total in the base currency, or null when no invoice can count. */
export function invoicesLocalTotal(form: FormMoney, base: string, invoices: readonly InvoiceTotal[]): number | null {
  const cents = invoiceCents(form, base, invoices);
  return cents === null ? null : round2(localAmount(cents.form / 100, form.kur) + cents.local / 100);
}

/**
 * The amount approvers are picked by: the larger of the declared amount and the invoices' total, both
 * in the base currency, so a form cannot slip under a higher approval tier by declaring less than its
 * invoices say. Invoices in a third currency count with the equivalent the sender entered.
 */
export function approvalAmount(form: FormMoney, base: string, invoices: readonly InvoiceTotal[]): number {
  const declared = localAmount(form.tutar, form.kur);
  const total = invoicesLocalTotal(form, base, invoices);
  if (total === null) return declared;
  return Math.min(MAX_AMOUNT, Math.max(declared, total));
}

/**
 * Set when the declared amount differs from the invoices' total, so approvers see it. Both are in the
 * form's currency; base-currency amounts are converted back with the form rate.
 */
export function amountMismatch(
  form: FormMoney,
  base: string,
  invoices: readonly InvoiceTotal[],
): { readonly fatura: number; readonly beyan: number } | null {
  const cents = invoiceCents(form, base, invoices);
  if (cents === null) return null;
  const total = round2(cents.form / 100 + cents.local / 100 / (form.kur ?? 1));
  if (total === round2(form.tutar)) return null;
  return { fatura: total, beyan: round2(form.tutar) };
}
