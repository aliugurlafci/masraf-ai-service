import { describe, expect, it } from 'vitest';
import { amountMismatch, approvalAmount, invoicesLocalTotal, localAmount, needsEquivalent, permissions, type Actor, type FormDurum } from '../../src/expenses/rules.ts';

const owner: Actor = { id: 1, rol: 'calisan' };
const approver: Actor = { id: 2, rol: 'calisan' };
const accountant: Actor = { id: 3, rol: 'muhasebe' };
const admin: Actor = { id: 4, rol: 'yonetici' };

const form = (durum: FormDurum, bekleyenOnayciId: number | null = null) => ({ durum, olusturanId: owner.id, bekleyenOnayciId });
const allowed = (durum: FormDurum, actor: Actor, bekleyen: number | null = null): string[] =>
  Object.entries(permissions(form(durum, bekleyen), actor))
    .filter(([, v]) => v)
    .map(([k]) => k);

describe('permissions', () => {
  it('lets the owner edit, send and cancel a draft or a rejected form', () => {
    expect(allowed('taslak', owner)).toEqual(['duzenle', 'gonder', 'iptal']);
    expect(allowed('reddedildi', owner)).toEqual(['duzenle', 'gonder', 'iptal']);
  });

  it('lets the owner only withdraw while it waits for approval', () => {
    expect(allowed('onayda', owner, approver.id)).toEqual(['geriCek']);
  });

  it('lets only the waiting approver decide', () => {
    expect(allowed('onayda', approver, approver.id)).toEqual(['onayla', 'reddet']);
    expect(allowed('onayda', approver, 99)).toEqual([]);
    expect(allowed('onaylandi', approver, approver.id)).toEqual([]);
  });

  it('lets accounting and administrators mark an approved form paid', () => {
    expect(allowed('onaylandi', accountant)).toEqual(['odendi']);
    expect(allowed('onaylandi', admin)).toEqual(['odendi']);
    expect(allowed('onaylandi', owner)).toEqual([]);
  });

  it('lets only administrators reassign a waiting form', () => {
    expect(allowed('onayda', admin, approver.id)).toEqual(['devret']);
    expect(allowed('onayda', accountant, approver.id)).toEqual([]);
  });

  it('allows nothing on finished forms', () => {
    for (const durum of ['iptal', 'odendi'] as const) {
      for (const actor of [owner, approver, accountant, admin]) expect(allowed(durum, actor)).toEqual([]);
    }
  });

  it('does not let another employee touch a draft', () => {
    expect(allowed('taslak', approver)).toEqual([]);
  });
});

describe('amounts', () => {
  it('converts to the base currency and rounds to the cent', () => {
    expect(localAmount(100, null)).toBe(100);
    expect(localAmount(100, 35.123456)).toBe(3512.35);
  });

  it('routes by the larger of the declared amount and the invoice total', () => {
    const base = { tutar: 1500, paraBirimi: 'TRY', kur: null };
    expect(approvalAmount(base, 'TRY', [])).toBe(1500);
    expect(approvalAmount(base, 'TRY', [{ genelToplam: 1800, paraBirimi: 'TRY' }])).toBe(1800);
    expect(approvalAmount({ ...base, tutar: 2000 }, 'TRY', [{ genelToplam: 1800, paraBirimi: 'TRY' }])).toBe(2000);
  });

  it('converts the invoice total with the form rate', () => {
    expect(approvalAmount({ tutar: 90, paraBirimi: 'EUR', kur: 40 }, 'TRY', [{ genelToplam: 100, paraBirimi: 'EUR' }])).toBe(4000);
  });

  it('ignores an invoice in a third currency without an equivalent, or without a usable amount', () => {
    const base = { tutar: 1500, paraBirimi: 'TRY', kur: null };
    expect(approvalAmount(base, 'TRY', [{ genelToplam: 99999, paraBirimi: 'USD' }])).toBe(1500);
    expect(approvalAmount(base, 'TRY', [{ genelToplam: null, paraBirimi: 'TRY' }])).toBe(1500);
    expect(approvalAmount(base, 'TRY', [{ genelToplam: -5, paraBirimi: 'TRY' }])).toBe(1500);
    // An unread currency is taken as the form's.
    expect(approvalAmount(base, 'TRY', [{ genelToplam: 2000, paraBirimi: null }])).toBe(2000);
  });

  it('caps a misread, absurd invoice total', () => {
    expect(approvalAmount({ tutar: 10, paraBirimi: 'TRY', kur: null }, 'TRY', [{ genelToplam: 4e30, paraBirimi: 'TRY' }])).toBe(90_000_000_000_000);
  });

  it('reports a declared amount that differs from the invoice', () => {
    const form = { tutar: 1500, paraBirimi: 'TRY', kur: null };
    expect(amountMismatch(form, 'TRY', [{ genelToplam: 1800, paraBirimi: 'TRY' }])).toEqual({ fatura: 1800, beyan: 1500 });
    expect(amountMismatch({ ...form, tutar: 1800 }, 'TRY', [{ genelToplam: 1800.001, paraBirimi: 'TRY' }])).toBeNull();
    expect(amountMismatch(form, 'TRY', [])).toBeNull();
  });

  it('adds up several invoices in the form currency', () => {
    const base = { tutar: 1000, paraBirimi: 'TRY', kur: null };
    const hotel = { genelToplam: 1200.1, paraBirimi: 'TRY' };
    const taxi = { genelToplam: 350.2, paraBirimi: 'TRY' };
    expect(invoicesLocalTotal(base, 'TRY', [hotel, taxi])).toBe(1550.3);
    expect(approvalAmount(base, 'TRY', [hotel, taxi])).toBe(1550.3);
    // Declared above the invoices: the declared amount decides.
    expect(approvalAmount({ ...base, tutar: 2000 }, 'TRY', [hotel, taxi])).toBe(2000);
    expect(amountMismatch(base, 'TRY', [hotel, taxi])).toEqual({ fatura: 1550.3, beyan: 1000 });
    expect(amountMismatch({ ...base, tutar: 1550.3 }, 'TRY', [hotel, taxi])).toBeNull();
  });

  it('leaves invoices without a usable total or equivalent out of the sum', () => {
    const base = { tutar: 100, paraBirimi: 'TRY', kur: null };
    const counted = { genelToplam: 300, paraBirimi: 'TRY' };
    const unread = { genelToplam: 50, paraBirimi: null };
    const usd = { genelToplam: 99999, paraBirimi: 'USD' };
    const noTotal = { genelToplam: null, paraBirimi: 'TRY' };
    expect(approvalAmount(base, 'TRY', [counted, usd, noTotal, unread])).toBe(350);
    expect(amountMismatch(base, 'TRY', [counted, usd, noTotal, unread])).toEqual({ fatura: 350, beyan: 100 });
    // No invoice qualifies: as if the form had none.
    expect(invoicesLocalTotal(base, 'TRY', [usd, noTotal])).toBeNull();
    expect(approvalAmount(base, 'TRY', [usd, noTotal])).toBe(100);
    expect(amountMismatch(base, 'TRY', [usd, noTotal])).toBeNull();
  });

  it('converts the sum of foreign-currency invoices with the form rate', () => {
    const invoices = [
      { genelToplam: 60, paraBirimi: 'EUR' },
      { genelToplam: 40, paraBirimi: 'EUR' },
    ];
    expect(approvalAmount({ tutar: 90, paraBirimi: 'EUR', kur: 40 }, 'TRY', invoices)).toBe(4000);
  });

  it('asks for an equivalent only for an invoice in a third currency', () => {
    expect(needsEquivalent('TRY', 'TRY', { paraBirimi: 'USD' })).toBe(true);
    expect(needsEquivalent('TRY', 'TRY', { paraBirimi: 'TRY' })).toBe(false);
    expect(needsEquivalent('TRY', 'TRY', { paraBirimi: null })).toBe(false);
    // On a USD form: USD goes with the form rate, TRY is the base currency, EUR needs an equivalent.
    expect(needsEquivalent('USD', 'TRY', { paraBirimi: 'USD' })).toBe(false);
    expect(needsEquivalent('USD', 'TRY', { paraBirimi: 'TRY' })).toBe(false);
    expect(needsEquivalent('USD', 'TRY', { paraBirimi: 'EUR' })).toBe(true);
  });

  it('counts a third-currency invoice with the equivalent the sender entered, so it cannot dodge a tier', () => {
    const form = { tutar: 100, paraBirimi: 'TRY', kur: null };
    const usd = { genelToplam: 50000, paraBirimi: 'USD', yerelKarsilik: 1_625_000 };
    expect(approvalAmount(form, 'TRY', [usd])).toBe(1_625_000);
    expect(amountMismatch(form, 'TRY', [usd])).toEqual({ fatura: 1_625_000, beyan: 100 });
    expect(approvalAmount(form, 'TRY', [usd, { genelToplam: 400, paraBirimi: 'TRY' }])).toBe(1_625_400);
    // An equivalent on an invoice that does not need one is not used: its own total counts.
    expect(approvalAmount(form, 'TRY', [{ genelToplam: 400, paraBirimi: 'TRY', yerelKarsilik: 9_999_999 }])).toBe(400);
    // A missing or unusable equivalent leaves the invoice out (the service refuses to send such a form).
    expect(approvalAmount(form, 'TRY', [{ ...usd, yerelKarsilik: null }])).toBe(100);
    expect(approvalAmount(form, 'TRY', [{ ...usd, yerelKarsilik: 0 }])).toBe(100);
  });

  it('counts base-currency invoices on a foreign-currency form as they are, and reports the difference in the form currency', () => {
    const form = { tutar: 100, paraBirimi: 'USD', kur: 32.5 };
    const usd = { genelToplam: 80, paraBirimi: 'USD' };
    const lira = { genelToplam: 1300, paraBirimi: 'TRY' };
    const eur = { genelToplam: 20, paraBirimi: 'EUR', yerelKarsilik: 750 };
    // 80 × 32.5 + 1300 + 750 = 4650 TRY; declared 100 × 32.5 = 3250 TRY.
    expect(invoicesLocalTotal(form, 'TRY', [usd, lira, eur])).toBe(4650);
    expect(approvalAmount(form, 'TRY', [usd, lira, eur])).toBe(4650);
    // In USD: 80 + (1300 + 750) / 32.5 = 80 + 63.08 = 143.08.
    expect(amountMismatch(form, 'TRY', [usd, lira, eur])).toEqual({ fatura: 143.08, beyan: 100 });
    expect(amountMismatch({ ...form, tutar: 80 }, 'TRY', [usd])).toBeNull();
  });
});
