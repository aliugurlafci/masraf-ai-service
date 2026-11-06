import { describe, expect, it } from 'vitest';
import { findProblems } from '../src/invoice-checks.ts';
import type { Invoice } from '../src/invoice-schema.ts';
import { sampleInvoice } from './helpers.ts';

/** A read whose numbers all add up: 2 × 500 = 1000, 1000 + 200 = 1200. */
const consistent = (): Invoice => sampleInvoice({ araToplam: 1000, kdvToplam: 200, genelToplam: 1200 });

const withLine = (patch: Partial<Invoice['kalemler'][number]>): Invoice => {
  const inv = consistent();
  return { ...inv, kalemler: inv.kalemler.map((l) => ({ ...l, ...patch })) };
};

describe('findProblems', () => {
  it('accepts a read whose numbers add up', () => {
    expect(findProblems(consistent())).toEqual([]);
  });

  it('accepts the Şenpiliç invoice as printed (3 decimals, rounded line amount)', () => {
    const inv: Invoice = {
      fatura: {
        faturaNo: 'SBD2026000001037',
        faturaTarihi: '2026-08-24',
        saticiUnvan: 'ŞENPİLİÇ GIDA SANAYİ A.Ş.',
        saticiVergiNo: '8030043327',
        aliciUnvan: 'MÜLKİYE TUNÇ',
        aliciVergiNo: '47026641718',
        paraBirimi: 'TRY',
        araToplam: 933.267,
        kdvToplam: 9.333,
        genelToplam: 942.599,
      },
      kalemler: [{ aciklama: 'TAB.PİLİÇ CİĞER', miktar: 16.259, birim: 'KG', birimFiyat: 57.4, kdvOrani: 1, tutar: 933.267 }],
    };
    expect(findProblems(inv)).toEqual([]);
    // The digit misread seen in the model comparison: 57,400 read as 57,409.
    expect(findProblems({ ...inv, kalemler: [{ ...inv.kalemler[0]!, birimFiyat: 57.409 }] })).toEqual([
      '1. kalemde miktar × birim fiyat tutarı vermiyor.',
    ]);
  });

  it('catches amounts read 1000 times too large (Turkish thousands separator)', () => {
    // 4.032,36 TL read as 4032360 everywhere: the totals agree with each other, the line does not.
    const inv = sampleInvoice({ araToplam: 4032360, kdvToplam: 40324, genelToplam: 4072684 });
    const misread: Invoice = {
      ...inv,
      kalemler: [{ aciklama: 'KOLİ İRİ BÜTÜN PİLİÇ', miktar: 50, birim: 'KG', birimFiyat: 80.6472, kdvOrani: 1, tutar: 4032360 }],
    };
    expect(findProblems(misread)).toEqual(['1. kalemde miktar × birim fiyat tutarı vermiyor.']);
  });

  it('accepts a line amount that includes VAT', () => {
    // 2 × 500 = 1000, with 20% VAT 1200; the lines then add up to the grand total.
    expect(findProblems(withLine({ tutar: 1200 }))).toEqual([]);
  });

  it('allows a unit price rounded to 2 decimals', () => {
    // 3 × 33,333… = 100,00 printed with a unit price of 33,33.
    const inv = withLine({ miktar: 3, birimFiyat: 33.33, tutar: 100 });
    expect(findProblems({ ...inv, fatura: { ...inv.fatura, araToplam: 100, kdvToplam: 20, genelToplam: 120 } })).toEqual([]);
  });

  it('skips the line check when quantity or unit price is missing', () => {
    expect(findProblems(withLine({ miktar: null, birimFiyat: null }))).toEqual([]);
  });

  it('reports missing key fields and lines (a blank read or a document that is not an invoice)', () => {
    const blank: Invoice = {
      fatura: {
        faturaNo: null,
        faturaTarihi: null,
        saticiUnvan: null,
        saticiVergiNo: null,
        aliciUnvan: null,
        aliciVergiNo: null,
        paraBirimi: null,
        araToplam: null,
        kdvToplam: null,
        genelToplam: null,
      },
      kalemler: [],
    };
    expect(findProblems(blank)).toEqual([
      'Okunamayan alan: fatura no, fatura tarihi, satıcı, genel toplam.',
      'Kalem okunamadı.',
    ]);
  });

  it('reports a line without an amount', () => {
    expect(findProblems(withLine({ tutar: null }))).toEqual(['1. kalemin tutarı okunamadı.']);
  });

  it('reports totals that do not add up', () => {
    expect(findProblems(sampleInvoice({ araToplam: 1500, kdvToplam: 300, genelToplam: 1800 }))).toEqual([
      'Kalemlerin toplamı ara toplamı tutmuyor.',
    ]);
    expect(findProblems(sampleInvoice({ araToplam: 1000, kdvToplam: 200, genelToplam: 1250 }))).toEqual([
      'Ara toplam ile KDV genel toplamı tutmuyor.',
    ]);
  });
});
