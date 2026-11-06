import { describe, expect, it } from 'vitest';
import {
  decidingIndex,
  formatMoney,
  MAX_AMOUNT,
  planApprovals,
  stepBand,
  validateFlow,
  type FlowStep,
  type OrderedStep,
  type PlannedStep,
  type Strateji,
} from '../../src/approval/flow.ts';

const step = (onayciId: number, limit: number | null): FlowStep => ({ onayciId, limit });
const ordered = (...steps: Array<[number, number | null]>): OrderedStep[] => steps.map(([onayciId, limit], i) => ({ sira: i + 1, onayciId, limit }));

// The example of docs/onay-sistemi.md, section 2: Ayşe up to 5.000, Mehmet up to 50.000, Zeynep without a limit.
const AYSE = 10;
const MEHMET = 20;
const ZEYNEP = 30;
const ADMIN = 1;
const SENDER = 99;
const example = ordered([AYSE, 5000], [MEHMET, 50000], [ZEYNEP, null]);

/** [sira, approver, state] of each planned step; null when nobody can approve. */
const route = (plan: PlannedStep[] | null): Array<[number, number, string]> | null => plan?.map((s) => [s.sira, s.onayciId, s.durum]) ?? null;
const plan = (strateji: Strateji, amount: number, sender = SENDER, admin: number | null = ADMIN) => planApprovals(strateji, example, amount, sender, admin === null ? [] : [admin]);

describe('validateFlow', () => {
  it('requires at least one approver', () => {
    expect(validateFlow([], 'TRY')).toEqual(['Onay akışında en az bir onaycı olmalıdır.']);
  });

  it('accepts one approver without a limit', () => {
    expect(validateFlow([step(1, null)], 'TRY')).toEqual([]);
  });

  it('accepts rising limits that end without one, even a cent apart', () => {
    expect(validateFlow([step(1, 5000), step(2, 50000), step(3, null)], 'TRY')).toEqual([]);
    expect(validateFlow([step(1, 0.01), step(2, 1000), step(3, 1000.01), step(4, null)], 'TRY')).toEqual([]);
  });

  it('requires the last approver to have no limit', () => {
    expect(validateFlow([step(1, 1000)], 'TRY')).toEqual(['Son onaycının limiti sınırsız olmalıdır; böylece her tutarı onaylayacak biri olur.']);
    expect(validateFlow([step(1, 1000), step(2, 5000)], 'TRY')).toEqual(['Son onaycının limiti sınırsız olmalıdır; böylece her tutarı onaylayacak biri olur.']);
  });

  it('requires a limit on every approver but the last', () => {
    expect(validateFlow([step(1, 1000), step(2, null), step(3, null)], 'TRY')).toEqual([
      '2. onaycı: onay limiti girilmelidir. Yalnızca son onaycının limiti sınırsızdır.',
    ]);
    // Swapped: the unlimited approver first and a limited one last.
    expect(validateFlow([step(1, null), step(2, 5000)], 'TRY')).toEqual([
      '1. onaycı: onay limiti girilmelidir. Yalnızca son onaycının limiti sınırsızdır.',
      'Son onaycının limiti sınırsız olmalıdır; böylece her tutarı onaylayacak biri olur.',
    ]);
  });

  it('requires each limit to be larger than the one before, to the cent, in the flow currency', () => {
    expect(validateFlow([step(1, 5000), step(2, 5000), step(3, null)], 'TRY')).toEqual([
      '2. onaycının limiti, 1. onaycınınkinden (5.000,00 TRY) büyük olmalıdır.',
    ]);
    expect(validateFlow([step(1, 5000), step(2, 1000), step(3, null)], 'EUR')).toEqual([
      '2. onaycının limiti, 1. onaycınınkinden (5.000,00 EUR) büyük olmalıdır.',
    ]);
    // Compared with the last valid limit: the third approver is checked against the first.
    expect(validateFlow([step(1, 5000), step(2, 0), step(3, 4000), step(4, null)], 'TRY')).toEqual([
      `2. onaycı: onay limiti 0'dan büyük ve en fazla ${formatMoney(MAX_AMOUNT, 'TRY')} olmalıdır.`,
      '3. onaycının limiti, 1. onaycınınkinden (5.000,00 TRY) büyük olmalıdır.',
    ]);
  });

  it('refuses a limit of zero, below zero, under a cent or too large', () => {
    const message = `1. onaycı: onay limiti 0'dan büyük ve en fazla ${formatMoney(MAX_AMOUNT, 'TRY')} olmalıdır.`;
    expect(message).toBe("1. onaycı: onay limiti 0'dan büyük ve en fazla 90.000.000.000.000,00 TRY olmalıdır.");
    for (const limit of [0, -1, 0.004, MAX_AMOUNT + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateFlow([step(1, limit), step(2, null)], 'TRY'), String(limit)).toEqual([message]);
    }
  });

  it('rejects the same user twice', () => {
    expect(validateFlow([step(1, 1000), step(1, null)], 'TRY')).toEqual(['2. onaycı: aynı kullanıcı akışta birden fazla kez yer alamaz.']);
  });

  it('lists every problem at once', () => {
    expect(validateFlow([step(1, null), step(1, -5), step(2, 100)], 'TRY')).toEqual([
      '1. onaycı: onay limiti girilmelidir. Yalnızca son onaycının limiti sınırsızdır.',
      '2. onaycı: aynı kullanıcı akışta birden fazla kez yer alamaz.',
      `2. onaycı: onay limiti 0'dan büyük ve en fazla ${formatMoney(MAX_AMOUNT, 'TRY')} olmalıdır.`,
      'Son onaycının limiti sınırsız olmalıdır; böylece her tutarı onaylayacak biri olur.',
    ]);
  });
});

describe('decidingIndex', () => {
  it('picks the first approver whose limit covers the amount, the limit included, to the cent', () => {
    const cases: Array<[number, number]> = [
      [0.01, 0],
      [3000, 0],
      [5000, 0],
      [5000.01, 1],
      [20000, 1],
      [50000, 1],
      [50000.01, 2],
      [MAX_AMOUNT, 2],
    ];
    for (const [amount, index] of cases) expect(decidingIndex(example, amount), String(amount)).toBe(index);
  });

  it('falls back to the last approver when no limit covers the amount', () => {
    expect(decidingIndex([step(1, 100), step(2, 200)], 500)).toBe(1);
    expect(decidingIndex([step(1, null)], 1)).toBe(0);
  });
});

describe('stepBand', () => {
  it('gives each approver of a chain every amount above the previous limit', () => {
    expect([0, 1, 2].map((i) => stepBand('zincir', example, i))).toEqual([
      { altLimit: 0, ustLimit: null },
      { altLimit: 5000.01, ustLimit: null },
      { altLimit: 50000.01, ustLimit: null },
    ]);
  });

  it('gives each single approver the amounts from just above the previous limit up to their own', () => {
    expect([0, 1, 2].map((i) => stepBand('tek', example, i))).toEqual([
      { altLimit: 0, ustLimit: 5000 },
      { altLimit: 5000.01, ustLimit: 50000 },
      { altLimit: 50000.01, ustLimit: null },
    ]);
  });

  it('gives a lone approver every amount in both strategies', () => {
    const lone = [step(1, null)];
    expect(stepBand('zincir', lone, 0)).toEqual({ altLimit: 0, ustLimit: null });
    expect(stepBand('tek', lone, 0)).toEqual({ altLimit: 0, ustLimit: null });
  });
});

describe('planApprovals', () => {
  describe('the example of the contract', () => {
    it('chain: every approver up to the deciding one, in order', () => {
      expect(route(plan('zincir', 3000))).toEqual([[1, AYSE, 'bekliyor']]);
      expect(route(plan('zincir', 5000))).toEqual([[1, AYSE, 'bekliyor']]);
      expect(route(plan('zincir', 5000.01))).toEqual([
        [1, AYSE, 'bekliyor'],
        [2, MEHMET, 'sirada'],
      ]);
      expect(route(plan('zincir', 20000))).toEqual([
        [1, AYSE, 'bekliyor'],
        [2, MEHMET, 'sirada'],
      ]);
      expect(route(plan('zincir', 80000))).toEqual([
        [1, AYSE, 'bekliyor'],
        [2, MEHMET, 'sirada'],
        [3, ZEYNEP, 'sirada'],
      ]);
    });

    it('single: the deciding approver alone', () => {
      expect(route(plan('tek', 3000))).toEqual([[1, AYSE, 'bekliyor']]);
      expect(route(plan('tek', 5000))).toEqual([[1, AYSE, 'bekliyor']]);
      expect(route(plan('tek', 5000.01))).toEqual([[1, MEHMET, 'bekliyor']]);
      expect(route(plan('tek', 20000))).toEqual([[1, MEHMET, 'bekliyor']]);
      expect(route(plan('tek', 80000))).toEqual([[1, ZEYNEP, 'bekliyor']]);
    });

    it('copies the band of each step and never adds the fallback administrator while someone else decides', () => {
      expect(plan('zincir', 80000)).toEqual([
        { sira: 1, onayciId: AYSE, altLimit: 0, ustLimit: null, durum: 'bekliyor', yedek: false },
        { sira: 2, onayciId: MEHMET, altLimit: 5000.01, ustLimit: null, durum: 'sirada', yedek: false },
        { sira: 3, onayciId: ZEYNEP, altLimit: 50000.01, ustLimit: null, durum: 'sirada', yedek: false },
      ]);
      expect(plan('tek', 20000)).toEqual([{ sira: 1, onayciId: MEHMET, altLimit: 5000.01, ustLimit: 50000, durum: 'bekliyor', yedek: false }]);
    });
  });

  it('follows the flow order, not the order of the array', () => {
    const shuffled = [...example].reverse();
    expect(planApprovals('zincir', shuffled, 80000, SENDER, [ADMIN])?.map((s) => s.onayciId)).toEqual([AYSE, MEHMET, ZEYNEP]);
    expect(planApprovals('tek', shuffled, 3000, SENDER, [ADMIN])?.map((s) => s.onayciId)).toEqual([AYSE]);
  });

  describe("the sender's own expense", () => {
    it('skips the sender in the middle of a chain; someone above them still decides', () => {
      expect(route(plan('zincir', 80000, MEHMET))).toEqual([
        [1, AYSE, 'bekliyor'],
        [2, MEHMET, 'atlandi'],
        [3, ZEYNEP, 'sirada'],
      ]);
      // Ayşe passes her own step; Mehmet decides 20.000 as he would anyway.
      expect(route(plan('zincir', 20000, AYSE))).toEqual([
        [1, AYSE, 'atlandi'],
        [2, MEHMET, 'bekliyor'],
      ]);
    });

    it('sends the last approval one approver up when the sender is the deciding approver', () => {
      // The contract's example: Mehmet's 20.000 goes to Ayşe, then to Zeynep.
      expect(route(plan('zincir', 20000, MEHMET))).toEqual([
        [1, AYSE, 'bekliyor'],
        [2, MEHMET, 'atlandi'],
        [3, ZEYNEP, 'sirada'],
      ]);
      expect(route(plan('zincir', 5000, AYSE))).toEqual([
        [1, AYSE, 'atlandi'],
        [2, MEHMET, 'bekliyor'],
      ]);
      expect(plan('tek', 3000, AYSE)).toEqual([
        { sira: 1, onayciId: AYSE, altLimit: 0, ustLimit: 5000, durum: 'atlandi', yedek: false },
        { sira: 2, onayciId: MEHMET, altLimit: 5000.01, ustLimit: 50000, durum: 'bekliyor', yedek: false },
      ]);
      expect(route(plan('tek', 20000, MEHMET))).toEqual([
        [1, MEHMET, 'atlandi'],
        [2, ZEYNEP, 'bekliyor'],
      ]);
    });

    it('sends the last approval to the fallback administrator when the sender is at the top', () => {
      expect(plan('tek', 80000, ZEYNEP)).toEqual([
        { sira: 1, onayciId: ZEYNEP, altLimit: 50000.01, ustLimit: null, durum: 'atlandi', yedek: false },
        { sira: 2, onayciId: ADMIN, altLimit: 0, ustLimit: null, durum: 'bekliyor', yedek: true },
      ]);
      expect(plan('zincir', 80000, ZEYNEP)).toEqual([
        { sira: 1, onayciId: AYSE, altLimit: 0, ustLimit: null, durum: 'bekliyor', yedek: false },
        { sira: 2, onayciId: MEHMET, altLimit: 5000.01, ustLimit: null, durum: 'sirada', yedek: false },
        { sira: 3, onayciId: ZEYNEP, altLimit: 50000.01, ustLimit: null, durum: 'atlandi', yedek: false },
        { sira: 4, onayciId: ADMIN, altLimit: 0, ustLimit: null, durum: 'sirada', yedek: true },
      ]);
    });

    it('without a fallback administrator, keeps the approvers below the sender in a chain', () => {
      for (const admin of [null, ZEYNEP]) {
        expect(route(plan('zincir', 80000, ZEYNEP, admin)), String(admin)).toEqual([
          [1, AYSE, 'bekliyor'],
          [2, MEHMET, 'sirada'],
          [3, ZEYNEP, 'atlandi'],
        ]);
      }
    });

    it('returns null when nobody but the sender could approve', () => {
      expect(plan('tek', 80000, ZEYNEP, null)).toBeNull();
      expect(plan('tek', 80000, ZEYNEP, ZEYNEP)).toBeNull();
      const lone = ordered([SENDER, null]);
      for (const strateji of ['zincir', 'tek'] as const) {
        expect(planApprovals(strateji, lone, 100, SENDER, []), strateji).toBeNull();
        expect(planApprovals(strateji, lone, 100, SENDER, [SENDER]), strateji).toBeNull();
        expect(route(planApprovals(strateji, lone, 100, SENDER, [ADMIN])), strateji).toEqual([
          [1, SENDER, 'atlandi'],
          [2, ADMIN, 'bekliyor'],
        ]);
      }
    });

    it('does not take as fallback an administrator who already approves this expense', () => {
      // The administrator is the first, smallest step; the top approver sends their own expense.
      const flow = ordered([ADMIN, 1000], [MEHMET, 5000], [ZEYNEP, null]);
      const OTHER = 2;
      expect(route(planApprovals('zincir', flow, 10000, ZEYNEP, [ADMIN, OTHER]))).toEqual([
        [1, ADMIN, 'bekliyor'],
        [2, MEHMET, 'sirada'],
        [3, ZEYNEP, 'atlandi'],
        [4, OTHER, 'sirada'],
      ]);
      // No other administrator: the chain below the sender decides, nobody twice.
      expect(route(planApprovals('zincir', flow, 10000, ZEYNEP, [ADMIN]))).toEqual([
        [1, ADMIN, 'bekliyor'],
        [2, MEHMET, 'sirada'],
        [3, ZEYNEP, 'atlandi'],
      ]);
      // In a single-approver flow that administrator is not approving it yet, so they take it.
      expect(route(planApprovals('tek', flow, 10000, ZEYNEP, [ADMIN, OTHER]))).toEqual([
        [1, ZEYNEP, 'atlandi'],
        [2, ADMIN, 'bekliyor'],
      ]);
    });
  });

  it('gives a flow without approvers to the fallback administrator, or to nobody', () => {
    expect(planApprovals('zincir', [], 100, SENDER, [ADMIN])).toEqual([{ sira: 1, onayciId: ADMIN, altLimit: 0, ustLimit: null, durum: 'bekliyor', yedek: true }]);
    expect(planApprovals('tek', [], 100, SENDER, [])).toBeNull();
  });
});

describe('formatMoney', () => {
  it('writes amounts the Turkish way', () => {
    expect(formatMoney(1234567.5, 'TRY')).toBe('1.234.567,50 TRY');
  });
});
