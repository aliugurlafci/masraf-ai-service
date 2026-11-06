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
}

/**
 * The sum of the invoice grand totals that can be compared with the form: invoices in the form's
 * currency (or whose currency was not read) with a positive total. Null when no invoice qualifies.
 */
export function comparableInvoiceTotal(paraBirimi: string, invoices: readonly InvoiceTotal[]): number | null {
  let cents = 0;
  let counted = false;
  for (const invoice of invoices) {
    const total = invoice.genelToplam;
    if (total === null || !Number.isFinite(total) || total <= 0) continue;
    if (invoice.paraBirimi !== null && invoice.paraBirimi !== paraBirimi) continue;
    cents += Math.round(total * 100);
    counted = true;
  }
  return counted ? cents / 100 : null;
}

/**
 * The amount approvers are picked by: the larger of the declared amount and the invoices' total,
 * so a form cannot slip under a higher approval tier by declaring less than its invoices say.
 */
export function approvalAmount(
  form: { readonly tutar: number; readonly paraBirimi: string; readonly kur: number | null },
  invoices: readonly InvoiceTotal[],
): number {
  const declared = localAmount(form.tutar, form.kur);
  const total = comparableInvoiceTotal(form.paraBirimi, invoices);
  if (total === null) return declared;
  return Math.min(MAX_AMOUNT, Math.max(declared, localAmount(total, form.kur)));
}

/** Set when the declared amount differs from the invoices' total, so approvers see it. */
export function amountMismatch(
  form: { readonly tutar: number; readonly paraBirimi: string },
  invoices: readonly InvoiceTotal[],
): { readonly fatura: number; readonly beyan: number } | null {
  const total = comparableInvoiceTotal(form.paraBirimi, invoices);
  if (total === null || round2(total) === round2(form.tutar)) return null;
  return { fatura: round2(total), beyan: round2(form.tutar) };
}
