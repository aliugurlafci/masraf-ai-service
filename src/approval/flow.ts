// The approval flow rules from docs/onay-sistemi.md, section 2. Pure functions; no database.
//
// A flow is an ordered list of approvers, each with an approval limit: the largest amount (base
// currency, inclusive) they may give the last approval for. Limits rise along the list and the last
// approver has none, so every amount has exactly one approver whose limit covers it: the "deciding"
// approver. The flow's strategy says who else sees the expense:
// - 'zincir' (chain): every approver from the first up to the deciding one, in order.
// - 'tek' (single): the deciding approver alone.

export type Strateji = 'zincir' | 'tek';
export const STRATEGIES: readonly Strateji[] = ['zincir', 'tek'];

/** One approver of the flow. `limit` null = no limit (the last approver only). */
export interface FlowStep {
  readonly onayciId: number;
  readonly limit: number | null;
}

/** A flow step with its position (1-based). */
export interface OrderedStep extends FlowStep {
  readonly sira: number;
}

/** The amounts (base currency, inclusive) that reach a step; null upper limit = no limit. */
export interface Band {
  readonly altLimit: number;
  readonly ustLimit: number | null;
}

export type PlannedState = 'bekliyor' | 'sirada' | 'atlandi';

/** One approval row of a form being sent, with the band of the flow step it came from. */
export interface PlannedStep extends Band {
  readonly sira: number;
  readonly onayciId: number;
  readonly durum: PlannedState;
  /** A fallback administrator: no approver above the sender was left in the flow. */
  readonly yedek: boolean;
}

/** Largest amount accepted: fits DECIMAL(18,2), and its cents stay a safe integer. */
export const MAX_AMOUNT = 90_000_000_000_000;

export const toCents = (amount: number): number => Math.round(amount * 100);
export const round2 = (amount: number): number => toCents(amount) / 100;

const moneyFormat = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatMoney(amount: number, currency: string): string {
  return `${moneyFormat.format(amount)} ${currency}`;
}

/** Problems that keep the flow from being saved, in Turkish; empty when the flow is valid. */
export function validateFlow(steps: readonly FlowStep[], currency: string): string[] {
  if (steps.length === 0) return ['Onay akışında en az bir onaycı olmalıdır.'];
  const problems: string[] = [];
  const seen = new Set<number>();
  let previous: { n: number; cents: number } | null = null;
  steps.forEach((s, i) => {
    const n = i + 1;
    const last = i === steps.length - 1;
    if (seen.has(s.onayciId)) problems.push(`${n}. onaycı: aynı kullanıcı akışta birden fazla kez yer alamaz.`);
    seen.add(s.onayciId);
    if (s.limit === null) {
      if (!last) problems.push(`${n}. onaycı: onay limiti girilmelidir. Yalnızca son onaycının limiti sınırsızdır.`);
      return;
    }
    if (last) problems.push(`Son onaycının limiti sınırsız olmalıdır; böylece her tutarı onaylayacak biri olur.`);
    if (!Number.isFinite(s.limit) || toCents(s.limit) <= 0 || s.limit > MAX_AMOUNT) {
      problems.push(`${n}. onaycı: onay limiti 0'dan büyük ve en fazla ${formatMoney(MAX_AMOUNT, currency)} olmalıdır.`);
      return;
    }
    const cents = toCents(s.limit);
    if (previous !== null && cents <= previous.cents) {
      problems.push(`${n}. onaycının limiti, ${previous.n}. onaycınınkinden (${formatMoney(previous.cents / 100, currency)}) büyük olmalıdır.`);
    }
    previous = { n, cents };
  });
  return problems;
}

/** Index of the deciding approver: the first whose limit covers the amount (the last one if none does). */
export function decidingIndex(steps: readonly FlowStep[], amount: number): number {
  const cents = toCents(amount);
  const i = steps.findIndex((s) => s.limit === null || cents <= toCents(s.limit));
  return i === -1 ? steps.length - 1 : i;
}

/**
 * The amounts that reach step `i` of an ordered flow: above the previous approver's limit, up to the
 * step's own limit for 'tek' and with no upper end for 'zincir' (larger amounts pass through it).
 */
export function stepBand(strateji: Strateji, steps: readonly FlowStep[], i: number): Band {
  const before = i > 0 ? (steps[i - 1]?.limit ?? null) : null;
  const altLimit = before === null ? 0 : (toCents(before) + 1) / 100;
  return { altLimit, ustLimit: strateji === 'tek' ? (steps[i]?.limit ?? null) : null };
}

/**
 * The approval rows for a form sent by `senderId` with `amount` to approve, renumbered 1..n:
 * the approvers the strategy picks, in flow order. The sender's own step is skipped. When the sender
 * is the deciding approver, the last approval goes one approver up the flow; above the top approver it
 * goes to the first of `fallbackAdminIds` (active administrators, in order) who is neither the sender
 * nor already approving this expense. Returns null when nobody can approve.
 */
export function planApprovals(
  strateji: Strateji,
  flow: readonly OrderedStep[],
  amount: number,
  senderId: number,
  fallbackAdminIds: readonly number[],
): PlannedStep[] | null {
  const steps = [...flow].sort((a, b) => a.sira - b.sira);
  const plan: PlannedStep[] = [];
  let waiting = false;
  const add = (onayciId: number, band: Band, yedek: boolean): void => {
    const durum: PlannedState = onayciId === senderId ? 'atlandi' : waiting ? 'sirada' : 'bekliyor';
    if (durum === 'bekliyor') waiting = true;
    plan.push({ sira: plan.length + 1, onayciId, altLimit: band.altLimit, ustLimit: band.ustLimit, durum, yedek });
  };
  const k = decidingIndex(steps, amount);
  const deciding = steps[k];
  if (deciding !== undefined) {
    for (let i = strateji === 'zincir' ? 0 : k; i <= k; i++) {
      const s = steps[i];
      if (s !== undefined) add(s.onayciId, stepBand(strateji, steps, i), false);
    }
    if (deciding.onayciId !== senderId) return plan;
    const up = steps[k + 1];
    if (up !== undefined) {
      add(up.onayciId, stepBand(strateji, steps, k + 1), false);
      return plan;
    }
  }
  // Someone already approving in this round would approve the same expense twice.
  const approving = new Set(plan.filter((s) => s.durum !== 'atlandi').map((s) => s.onayciId));
  const fallback = fallbackAdminIds.find((id) => id !== senderId && !approving.has(id));
  if (fallback !== undefined) {
    add(fallback, { altLimit: 0, ustLimit: null }, true);
    return plan;
  }
  return waiting ? plan : null;
}
