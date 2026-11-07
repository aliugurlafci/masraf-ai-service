// Effective invoice data, required fields, the duplicate key and corrections (docs/onay-sistemi.md,
// section 3, "Fatura bilgileri, düzeltme ve gönderim kontrolleri"). No database.
import { describe, expect, it } from 'vitest';
import {
  changedFields,
  duplicateKey,
  effectiveInvoice,
  MAX_KEY_LENGTH,
  mergeCorrections,
  missingFields,
  normalizeIdentifier,
  sameInvoice,
} from '../../src/invoice/effective.ts';
import type { Invoice } from '../../src/invoice/schema.ts';
import { sampleInvoice } from '../helpers.ts';

const withLines = (inv: Invoice, kalemler: Invoice['kalemler']): Invoice => ({ ...inv, kalemler });

describe('effectiveInvoice', () => {
  it('is the correction when there is one, else the read result', () => {
    const read = sampleInvoice();
    const fixed = sampleInvoice({ faturaNo: 'X-1' });
    expect(effectiveInvoice(read, fixed)).toBe(fixed);
    expect(effectiveInvoice(read, null)).toBe(read);
    expect(effectiveInvoice(read, undefined)).toBe(read);
  });
});

describe('missingFields', () => {
  it('lists the empty required fields in contract order', () => {
    expect(missingFields(sampleInvoice())).toEqual([]);
    expect(missingFields(sampleInvoice({ genelToplam: null, faturaNo: null }))).toEqual(['faturaNo', 'genelToplam']);
    expect(missingFields(sampleInvoice({ faturaTarihi: null, saticiUnvan: '  ' }))).toEqual(['faturaTarihi', 'saticiUnvan']);
  });

  it('does not require the other fields, and takes a zero total as filled', () => {
    const inv = sampleInvoice({ saticiVergiNo: null, aliciUnvan: null, aliciVergiNo: null, paraBirimi: null, araToplam: null, kdvToplam: null, genelToplam: 0 });
    expect(missingFields(withLines(inv, []))).toEqual([]);
  });
});

describe('normalizeIdentifier', () => {
  it("removes spaces, '-', '/' and '.', and upper-cases a–z by ASCII rules only", () => {
    expect(normalizeIdentifier(' abc-2026/000.12 ')).toBe('ABC202600012');
    expect(normalizeIdentifier('a\tb\nc')).toBe('ABC');
    // Turkish letters are left alone: i → I (not İ), ı and ş stay.
    expect(normalizeIdentifier('gıb-i.ş')).toBe('GıBIş');
    expect(normalizeIdentifier(null)).toBe('');
    expect(normalizeIdentifier(' -/. ')).toBe('');
  });
});

describe('duplicateKey', () => {
  it('uses the seller tax number and the invoice number when the tax number is known', () => {
    expect(duplicateKey(sampleInvoice({ saticiVergiNo: '123 456-7890', faturaNo: 'abc/2026.1' }))).toBe('V|1234567890|ABC20261');
  });

  it('gives the same key to differently written numbers of the same invoice', () => {
    const a = sampleInvoice({ saticiVergiNo: '1234567890', faturaNo: 'ABC-2026-1', genelToplam: 1800 });
    const b = sampleInvoice({ saticiVergiNo: '1234 567 890', faturaNo: 'abc 2026 1', genelToplam: 999, faturaTarihi: '2026-01-01' });
    expect(duplicateKey(a)).toBe(duplicateKey(b));
  });

  it('uses the invoice number, date and total with two decimals without a tax number', () => {
    expect(duplicateKey(sampleInvoice({ saticiVergiNo: null, faturaNo: 'f-1', faturaTarihi: '2026-11-05', genelToplam: 1800 }))).toBe('T|F1|2026-11-05|1800.00');
    expect(duplicateKey(sampleInvoice({ saticiVergiNo: ' - ', faturaNo: 'F1', faturaTarihi: '2026-11-05', genelToplam: 1799.999 }))).toBe('T|F1|2026-11-05|1800.00');
    expect(duplicateKey(sampleInvoice({ saticiVergiNo: null, faturaNo: 'F1', faturaTarihi: '2026-11-05', genelToplam: 10.5 }))).toBe('T|F1|2026-11-05|10.50');
    expect(duplicateKey(sampleInvoice({ saticiVergiNo: null, faturaNo: 'F1', faturaTarihi: null, genelToplam: null }))).toBe('T|F1||');
  });

  it('has no key without an invoice number', () => {
    expect(duplicateKey(sampleInvoice({ faturaNo: null }))).toBeNull();
    expect(duplicateKey(sampleInvoice({ faturaNo: ' ./- ' }))).toBeNull();
  });

  it('fits the database column', () => {
    const key = duplicateKey(sampleInvoice({ faturaNo: 'X'.repeat(600) }));
    expect(key?.length).toBe(MAX_KEY_LENGTH);
  });
});

describe('sameInvoice and changedFields', () => {
  it('compares every field and line, whatever the key order', () => {
    const a = sampleInvoice();
    // Same values, keys written in another order (as JSON from a client may have them).
    const reordered = JSON.parse('{"kalemler":[{"tutar":1000,"kdvOrani":20,"birimFiyat":500,"birim":"saat","miktar":2,"aciklama":"Danışmanlık"}],"fatura":{}}') as Invoice;
    reordered.fatura = Object.fromEntries(Object.entries(a.fatura).reverse()) as Invoice['fatura'];
    expect(sameInvoice(a, reordered)).toBe(true);
    expect(sameInvoice(a, sampleInvoice({ aliciVergiNo: null }))).toBe(false);
    expect(sameInvoice(a, withLines(a, [...a.kalemler, ...a.kalemler]))).toBe(false);
  });

  it('names the changed fields in Turkish, in schema order, lines last', () => {
    const read = sampleInvoice();
    expect(changedFields(read, read)).toEqual([]);
    expect(changedFields(read, sampleInvoice({ genelToplam: 2000, faturaNo: 'Y' }))).toEqual(['fatura no', 'genel toplam']);
    const all = withLines(
      sampleInvoice({
        faturaNo: 'Y',
        faturaTarihi: '2026-01-01',
        saticiUnvan: 'S',
        saticiVergiNo: '1',
        aliciUnvan: 'A',
        aliciVergiNo: '2',
        paraBirimi: 'USD',
        araToplam: 1,
        kdvToplam: 2,
        genelToplam: 3,
      }),
      [],
    );
    expect(changedFields(read, all)).toEqual([
      'fatura no',
      'fatura tarihi',
      'satıcı',
      'satıcı vergi no',
      'alıcı',
      'alıcı vergi no',
      'para birimi',
      'ara toplam',
      'KDV toplamı',
      'genel toplam',
      'kalemler',
    ]);
  });
});

describe('mergeCorrections', () => {
  const reads = new Map([
    ['a', sampleInvoice({ faturaNo: 'A' })],
    ['b', sampleInvoice({ faturaNo: 'B' })],
    ['c', sampleInvoice({ faturaNo: 'C' })],
  ]);
  const fixedB = sampleInvoice({ faturaNo: 'B2', genelToplam: 2000 });

  it('stores a new correction and notes the changed fields with the invoice position', () => {
    const { corrections, notes } = mergeCorrections(['a', 'b'], reads, new Map(), { b: fixedB });
    expect([...corrections]).toEqual([['b', fixedB]]);
    expect(notes).toEqual(['2. fatura düzeltildi: fatura no, genel toplam.']);
  });

  it('keeps the corrections left out, and notes only what changed against the previous correction', () => {
    const stored = new Map([['b', fixedB]]);
    const again = sampleInvoice({ faturaNo: 'B2', genelToplam: 2000, kdvToplam: 1 });
    const { corrections, notes } = mergeCorrections(['a', 'b'], reads, stored, { b: again });
    expect(corrections.get('b')).toBe(again);
    expect(notes).toEqual(['2. fatura düzeltildi: KDV toplamı.']);
    expect(mergeCorrections(['a', 'b'], reads, stored, undefined)).toEqual({ corrections: stored, notes: [] });
    expect(mergeCorrections(['a', 'b'], reads, stored, { b: fixedB }).notes).toEqual([]);
  });

  it('removes a correction with null or with a value equal to the read result, noting the undo once', () => {
    const stored = new Map([['b', fixedB]]);
    expect(mergeCorrections(['a', 'b'], reads, stored, { b: null })).toEqual({ corrections: new Map(), notes: ['2. faturanın düzeltmesi geri alındı.'] });
    expect(mergeCorrections(['a', 'b'], reads, stored, { b: sampleInvoice({ faturaNo: 'B' }) })).toEqual({
      corrections: new Map(),
      notes: ['2. faturanın düzeltmesi geri alındı.'],
    });
    // Nothing to undo, nothing stored, nothing noted.
    expect(mergeCorrections(['a', 'b'], reads, new Map(), { a: null, b: sampleInvoice({ faturaNo: 'B' }) })).toEqual({ corrections: new Map(), notes: [] });
  });

  it('drops the corrections of invoices no longer on the form', () => {
    const stored = new Map([['b', fixedB]]);
    expect(mergeCorrections(['a', 'c'], reads, stored, undefined).corrections.size).toBe(0);
  });

  it('notes several invoices in form order', () => {
    const { notes } = mergeCorrections(['c', 'a'], reads, new Map(), { a: sampleInvoice({ faturaNo: 'A2' }), c: sampleInvoice({ faturaNo: 'C2' }) });
    expect(notes).toEqual(['1. fatura düzeltildi: fatura no.', '2. fatura düzeltildi: fatura no.']);
  });
});
