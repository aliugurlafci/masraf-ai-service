import { describe, expect, it } from 'vitest';
import { coverageGaps, formatMoney, inRange, planApprovals, validateFlow, type OrderedStep } from '../../src/approval/flow.ts';

const step = (onayciId: number, altLimit: number, ustLimit: number | null) => ({ onayciId, altLimit, ustLimit });
const ordered = (...steps: Array<[number, number, number | null]>): OrderedStep[] =>
  steps.map(([onayciId, altLimit, ustLimit], i) => ({ sira: i + 1, onayciId, altLimit, ustLimit }));

describe('validateFlow', () => {
  it('requires at least one approver', () => {
    expect(validateFlow([], 'TRY')).toEqual(['Onay akışında en az bir onaycı olmalıdır.']);
  });

  it('accepts one approver for every amount', () => {
    expect(validateFlow([step(1, 0, null)], 'TRY')).toEqual([]);
  });

  it('accepts tiers that touch at the cent and overlapping escalation ranges', () => {
    expect(validateFlow([step(1, 0, 1000), step(2, 1000.01, 5000), step(3, 5000.01, null)], 'TRY')).toEqual([]);
    expect(validateFlow([step(1, 0, null), step(2, 5000.01, null), step(3, 50000.01, null)], 'TRY')).toEqual([]);
  });

  it('names the amounts nobody approves', () => {
    expect(validateFlow([step(1, 0, 1000), step(2, 5000, null)], 'TRY')).toEqual(['1.000,01 TRY – 4.999,99 TRY arası tutarlar için onaycı yok.']);
  });

  it('requires the ranges to start at zero', () => {
    expect(validateFlow([step(1, 100, null)], 'TRY')).toEqual(['0,00 TRY – 99,99 TRY arası tutarlar için onaycı yok.']);
  });

  it('requires an approver without an upper limit', () => {
    expect(validateFlow([step(1, 0, 1000), step(2, 500, 20000)], 'EUR')).toEqual([
      '20.000,01 EUR ve üzeri tutarlar için onaycı yok. En az bir onaycının üst limiti sınırsız olmalıdır.',
    ]);
  });

  it('rejects the same user twice', () => {
    expect(validateFlow([step(1, 0, null), step(1, 100, null)], 'TRY')).toEqual(['2. onaycı: aynı kullanıcı akışta birden fazla kez yer alamaz.']);
  });

  it('rejects an upper limit below the lower one, and negative limits', () => {
    expect(validateFlow([step(1, 0, null), step(2, 500, 100)], 'TRY')).toEqual(['2. onaycı: üst limit alt limitten küçük olamaz.']);
    expect(validateFlow([step(1, -1, null)], 'TRY')[0]).toMatch(/^1\. onaycı: alt limit 0 ile/);
  });

  it('allows a range of a single amount', () => {
    expect(validateFlow([step(1, 0, 0), step(2, 0.01, null)], 'TRY')).toEqual([]);
  });
});

describe('coverageGaps', () => {
  it('ignores the order of the steps', () => {
    expect(coverageGaps([step(2, 1000.01, null), step(1, 0, 1000)], 'TRY')).toEqual([]);
  });

  it('lists every gap', () => {
    expect(coverageGaps([step(1, 10, 20), step(2, 30, 40)], 'TRY')).toHaveLength(3);
  });
});

describe('inRange', () => {
  it('includes both limits, to the cent', () => {
    const s = step(1, 1000.01, 5000);
    expect([1000, 1000.01, 3000, 5000, 5000.01].map((a) => inRange(s, a))).toEqual([false, true, true, true, false]);
    expect(inRange(step(1, 0, null), 9e13)).toBe(true);
  });
});

describe('planApprovals', () => {
  // Ayşe 0–∞, Mehmet 5.000,01–∞, Zeynep 50.000,01–∞ (escalation)
  const flow = ordered([10, 0, null], [20, 5000.01, null], [30, 50000.01, null]);

  it('sends a form to every approver whose range holds the amount, in order', () => {
    expect(planApprovals(flow, 3000, 99, 1)?.map((s) => [s.sira, s.onayciId, s.durum])).toEqual([[1, 10, 'bekliyor']]);
    expect(planApprovals(flow, 20000, 99, 1)?.map((s) => [s.sira, s.onayciId, s.durum])).toEqual([
      [1, 10, 'bekliyor'],
      [2, 20, 'sirada'],
    ]);
    expect(planApprovals(flow, 80000, 99, 1)?.map((s) => s.onayciId)).toEqual([10, 20, 30]);
  });

  it('follows the flow order, not the order of the array', () => {
    const shuffled = [...flow].reverse();
    expect(planApprovals(shuffled, 80000, 99, 1)?.map((s) => s.onayciId)).toEqual([10, 20, 30]);
  });

  it('picks exactly one approver with non-overlapping tiers', () => {
    const tiers = ordered([10, 0, 5000], [20, 5000.01, 50000], [30, 50000.01, null]);
    expect(planApprovals(tiers, 5000, 99, 1)?.map((s) => s.onayciId)).toEqual([10]);
    expect(planApprovals(tiers, 5000.01, 99, 1)?.map((s) => s.onayciId)).toEqual([20]);
  });

  it("skips the sender's own step; the next approver decides", () => {
    const plan = planApprovals(flow, 20000, 10, 1);
    expect(plan?.map((s) => [s.onayciId, s.durum])).toEqual([
      [10, 'atlandi'],
      [20, 'bekliyor'],
    ]);
  });

  it('falls back to an administrator when every matching approver is the sender', () => {
    const plan = planApprovals(flow, 3000, 10, 1);
    expect(plan).toEqual([
      { sira: 1, onayciId: 10, altLimit: 0, ustLimit: null, durum: 'atlandi', yedek: false },
      { sira: 2, onayciId: 1, altLimit: 0, ustLimit: null, durum: 'bekliyor', yedek: true },
    ]);
  });

  it('returns null when nobody but the sender could approve', () => {
    expect(planApprovals(flow, 3000, 10, null)).toBeNull();
    expect(planApprovals(flow, 3000, 10, 10)).toBeNull();
  });

  it('keeps the copied limits on each step', () => {
    expect(planApprovals(flow, 60000, 99, 1)?.[2]).toMatchObject({ altLimit: 50000.01, ustLimit: null });
  });
});

describe('formatMoney', () => {
  it('writes amounts the Turkish way', () => {
    expect(formatMoney(1234567.5, 'TRY')).toBe('1.234.567,50 TRY');
  });
});
