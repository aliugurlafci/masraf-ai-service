// The approval document renderer (docs/onay-sistemi.md, section 7). No database.
import { describe, expect, it } from 'vitest';
import { headerRows, receiptFieldRows, renderApprovalPdf, type PdfData } from '../../src/expenses/pdf.ts';

const data = (over: Partial<PdfData> = {}): PdfData => ({
  form: {
    id: 1001,
    baslik: 'Müşteri yemeği — İstanbul, Şişli, Çağlayan',
    sahip: 'Ayşe Kaya',
    departman: 'Satış',
    kategori: 'Yemek',
    masrafTarihi: '2026-11-05',
    tutar: 1800,
    paraBirimi: 'TRY',
    kur: null,
    onayTutari: 1800,
    durum: 'onaylandi',
  },
  base: 'TRY',
  faturalar: [
    { faturaNo: 'ABC-1', faturaTarihi: '2026-11-05', saticiUnvan: 'Örnek Lokanta Ğıda', saticiVergiNo: '1234567890', genelToplam: 1800, paraBirimi: 'TRY', duzeltildi: true },
    { faturaNo: null, faturaTarihi: null, saticiUnvan: null, saticiVergiNo: null, genelToplam: null, paraBirimi: null, duzeltildi: false },
  ],
  onaylar: [
    { sira: 1, onayci: 'Mehmet Demir', durum: 'onaylandi', kararTarihi: new Date('2026-11-06T09:00:00Z'), aciklama: 'Uygun', yedek: false },
    { sira: 2, onayci: 'Zeynep Ak', durum: 'onaylandi', kararTarihi: new Date('2026-11-06T10:00:00Z'), aciklama: null, yedek: true },
  ],
  olusturma: new Date('2026-11-07T08:00:00Z'),
  ...over,
});

describe('renderApprovalPdf', () => {
  it('renders a PDF with the embedded Noto Sans fonts for Turkish letters', async () => {
    const pdf = await renderApprovalPdf(data(), { compress: false });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = pdf.toString('latin1');
    expect(text).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSans-Regular/);
    expect(text).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSans-Bold/);
    expect(text).toContain('/FontFile2');
    expect(text).not.toMatch(/\/BaseFont \/Helvetica/);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('continues long invoice tables on further pages', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ...data().faturalar[0]!, faturaNo: `F-${i}` }));
    const pdf = await renderApprovalPdf(data({ faturalar: many }), { compress: false });
    const pages = (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages).toBeGreaterThan(1);
  });

  it('renders a form without invoices', async () => {
    const pdf = await renderApprovalPdf(data({ faturalar: [] }));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('prints the organisation and the cost centre only when the form carries them, with a dash for none', () => {
    const labels = (d: PdfData): string[] => headerRows(d).map(([label]) => label);
    expect(labels(data())).not.toContain('Organizasyon');
    expect(labels(data())).not.toContain('Masraf merkezi');
    const rows = headerRows(data({ form: { ...data().form, organizasyon: '1000 – Şenpiliç Gıda', masrafMerkezi: null } }));
    expect(rows.slice(2, 5)).toEqual([
      ['Organizasyon', '1000 – Şenpiliç Gıda'],
      ['Masraf merkezi', '-'],
      ['Kategori', 'Yemek'],
    ]);
  });

  it("lists each invoice's receipt fields under its number, and renders them", async () => {
    const [first, second] = data().faturalar;
    const faturalar = [
      { ...first!, alanlar: [{ ad: 'Etiket', gosterim: 'P34MHG325 – Bakım' }, { ad: 'Not', gosterim: 'Çağlayan şubesi' }] },
      { ...second!, alanlar: [{ ad: 'Ödeme Yöntemi', gosterim: 'Nakit' }] },
      { ...first!, faturaNo: 'ABC-3' },
    ];
    expect(receiptFieldRows({ faturalar })).toEqual([
      ['1. fatura · ABC-1', 'Etiket', 'P34MHG325 – Bakım'],
      ['1. fatura · ABC-1', 'Not', 'Çağlayan şubesi'],
      ['2. fatura', 'Ödeme Yöntemi', 'Nakit'],
    ]);
    const pdf = await renderApprovalPdf(data({ faturalar }));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
