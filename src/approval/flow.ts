// The approval flow rules from docs/onay-sistemi.md, section 2. Pure functions; no database.

/** One approver of the flow. Limits are inclusive and in the base currency; null upper limit = no limit. */
export interface FlowStep {
  readonly onayciId: number;
  readonly altLimit: number;
  readonly ustLimit: number | null;
}

/** A flow step with its position (1-based). */
export interface OrderedStep extends FlowStep {
  readonly sira: number;
}

export type PlannedState = 'bekliyor' | 'sirada' | 'atlandi';

/** One approval row of a form being sent. */
export interface PlannedStep extends OrderedStep {
  readonly durum: PlannedState;
  /** A fallback administrator: every matching approver was the sender. */
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
  let rangesOk = true;
  steps.forEach((s, i) => {
    const label = `${i + 1}. onaycı`;
    if (seen.has(s.onayciId)) problems.push(`${label}: aynı kullanıcı akışta birden fazla kez yer alamaz.`);
    seen.add(s.onayciId);
    if (!Number.isFinite(s.altLimit) || s.altLimit < 0 || s.altLimit > MAX_AMOUNT) {
      problems.push(`${label}: alt limit 0 ile ${formatMoney(MAX_AMOUNT, currency)} arasında olmalıdır.`);
      rangesOk = false;
    } else if (s.ustLimit !== null && (!Number.isFinite(s.ustLimit) || s.ustLimit > MAX_AMOUNT)) {
      problems.push(`${label}: üst limit en fazla ${formatMoney(MAX_AMOUNT, currency)} olabilir.`);
      rangesOk = false;
    } else if (s.ustLimit !== null && toCents(s.ustLimit) < toCents(s.altLimit)) {
      problems.push(`${label}: üst limit alt limitten küçük olamaz.`);
      rangesOk = false;
    }
  });
  if (rangesOk) problems.push(...coverageGaps(steps, currency));
  return problems;
}

/** Amounts no approver covers, as messages. Works in cents so 1.000,00 and 1.000,01 touch. */
export function coverageGaps(steps: readonly FlowStep[], currency: string): string[] {
  const ranges = steps
    .map((s) => ({ from: toCents(s.altLimit), to: s.ustLimit === null ? Infinity : toCents(s.ustLimit) }))
    .sort((a, b) => a.from - b.from);
  const gaps: string[] = [];
  let covered = -1; // highest cent covered so far
  for (const r of ranges) {
    if (r.from > covered + 1) {
      gaps.push(
        `${formatMoney((covered + 1) / 100, currency)} – ${formatMoney((r.from - 1) / 100, currency)} arası tutarlar için onaycı yok.`,
      );
    }
    covered = Math.max(covered, r.to);
    if (covered === Infinity) break;
  }
  if (covered !== Infinity) {
    gaps.push(
      `${formatMoney((covered + 1) / 100, currency)} ve üzeri tutarlar için onaycı yok. En az bir onaycının üst limiti sınırsız olmalıdır.`,
    );
  }
  return gaps;
}

export function inRange(step: FlowStep, amount: number): boolean {
  const cents = toCents(amount);
  return toCents(step.altLimit) <= cents && (step.ustLimit === null || cents <= toCents(step.ustLimit));
}

/**
 * The approval rows for a form sent by `senderId` with `amount` to approve:
 * every approver whose range holds the amount, in flow order and renumbered 1..n.
 * The sender's own step is skipped. When no step is left, `fallbackAdminId` (an active administrator
 * other than the sender) decides. Returns null when nobody can approve.
 */
export function planApprovals(
  flow: readonly OrderedStep[],
  amount: number,
  senderId: number,
  fallbackAdminId: number | null,
): PlannedStep[] | null {
  const matching = [...flow].sort((a, b) => a.sira - b.sira).filter((s) => inRange(s, amount));
  const plan: PlannedStep[] = [];
  let waiting = false;
  for (const s of matching) {
    const own = s.onayciId === senderId;
    const durum: PlannedState = own ? 'atlandi' : waiting ? 'sirada' : 'bekliyor';
    if (durum === 'bekliyor') waiting = true;
    plan.push({ sira: plan.length + 1, onayciId: s.onayciId, altLimit: s.altLimit, ustLimit: s.ustLimit, durum, yedek: false });
  }
  if (waiting) return plan;
  if (fallbackAdminId === null || fallbackAdminId === senderId) return null;
  plan.push({ sira: plan.length + 1, onayciId: fallbackAdminId, altLimit: 0, ustLimit: null, durum: 'bekliyor', yedek: true });
  return plan;
}
