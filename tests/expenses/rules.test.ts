import { describe, expect, it } from 'vitest';
import { amountMismatch, approvalAmount, comparableInvoiceTotal, localAmount, permissions, type Actor, type FormDurum } from '../../src/expenses/rules.ts';

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
    expect(approvalAmount(base, [])).toBe(1500);
    expect(approvalAmount(base, [{ genelToplam: 1800, paraBirimi: 'TRY' }])).toBe(1800);
    expect(approvalAmount({ ...base, tutar: 2000 }, [{ genelToplam: 1800, paraBirimi: 'TRY' }])).toBe(2000);
  });

  it('converts the invoice total with the form rate', () => {
    expect(approvalAmount({ tutar: 90, paraBirimi: 'EUR', kur: 40 }, [{ genelToplam: 100, paraBirimi: 'EUR' }])).toBe(4000);
  });

  it('ignores an invoice total in another currency or without a usable amount', () => {
    const base = { tutar: 1500, paraBirimi: 'TRY', kur: null };
    expect(approvalAmount(base, [{ genelToplam: 99999, paraBirimi: 'USD' }])).toBe(1500);
    expect(approvalAmount(base, [{ genelToplam: null, paraBirimi: 'TRY' }])).toBe(1500);
    expect(approvalAmount(base, [{ genelToplam: -5, paraBirimi: 'TRY' }])).toBe(1500);
    // An unread currency is taken as the form's.
    expect(approvalAmount(base, [{ genelToplam: 2000, paraBirimi: null }])).toBe(2000);
  });

  it('caps a misread, absurd invoice total', () => {
    expect(approvalAmount({ tutar: 10, paraBirimi: 'TRY', kur: null }, [{ genelToplam: 4e30, paraBirimi: 'TRY' }])).toBe(90_000_000_000_000);
  });

  it('reports a declared amount that differs from the invoice', () => {
    expect(amountMismatch({ tutar: 1500, paraBirimi: 'TRY' }, [{ genelToplam: 1800, paraBirimi: 'TRY' }])).toEqual({ fatura: 1800, beyan: 1500 });
    expect(amountMismatch({ tutar: 1800, paraBirimi: 'TRY' }, [{ genelToplam: 1800.001, paraBirimi: 'TRY' }])).toBeNull();
    expect(amountMismatch({ tutar: 1500, paraBirimi: 'TRY' }, [])).toBeNull();
  });

  it('adds up several invoices in the form currency', () => {
    const base = { tutar: 1000, paraBirimi: 'TRY', kur: null };
    const hotel = { genelToplam: 1200.1, paraBirimi: 'TRY' };
    const taxi = { genelToplam: 350.2, paraBirimi: 'TRY' };
    expect(comparableInvoiceTotal('TRY', [hotel, taxi])).toBe(1550.3);
    expect(approvalAmount(base, [hotel, taxi])).toBe(1550.3);
    // Declared above the invoices: the declared amount decides.
    expect(approvalAmount({ ...base, tutar: 2000 }, [hotel, taxi])).toBe(2000);
    expect(amountMismatch(base, [hotel, taxi])).toEqual({ fatura: 1550.3, beyan: 1000 });
    expect(amountMismatch({ ...base, tutar: 1550.3 }, [hotel, taxi])).toBeNull();
  });

  it('leaves invoices in another currency or without a usable total out of the sum', () => {
    const base = { tutar: 100, paraBirimi: 'TRY', kur: null };
    const counted = { genelToplam: 300, paraBirimi: 'TRY' };
    const unread = { genelToplam: 50, paraBirimi: null };
    const usd = { genelToplam: 99999, paraBirimi: 'USD' };
    const noTotal = { genelToplam: null, paraBirimi: 'TRY' };
    expect(approvalAmount(base, [counted, usd, noTotal, unread])).toBe(350);
    expect(amountMismatch(base, [counted, usd, noTotal, unread])).toEqual({ fatura: 350, beyan: 100 });
    // No invoice qualifies: as if the form had none.
    expect(comparableInvoiceTotal('TRY', [usd, noTotal])).toBeNull();
    expect(approvalAmount(base, [usd, noTotal])).toBe(100);
    expect(amountMismatch(base, [usd, noTotal])).toBeNull();
  });

  it('converts the sum of foreign-currency invoices with the form rate', () => {
    const invoices = [
      { genelToplam: 60, paraBirimi: 'EUR' },
      { genelToplam: 40, paraBirimi: 'EUR' },
    ];
    expect(approvalAmount({ tutar: 90, paraBirimi: 'EUR', kur: 40 }, invoices)).toBe(4000);
  });
});
