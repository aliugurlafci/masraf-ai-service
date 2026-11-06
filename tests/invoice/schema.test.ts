import { describe, expect, it } from 'vitest';
import { InvoiceSchema, invoiceJsonSchema } from '../../src/invoice/schema.ts';
import { sampleInvoice } from '../helpers.ts';

describe('InvoiceSchema', () => {
  it('accepts a complete invoice', () => {
    expect(InvoiceSchema.safeParse(sampleInvoice()).success).toBe(true);
  });

  it('accepts nulls for missing fields and an empty item list', () => {
    const empty = {
      fatura: Object.fromEntries(Object.keys(sampleInvoice().fatura).map((k) => [k, null])),
      kalemler: [],
    };
    expect(InvoiceSchema.safeParse(empty).success).toBe(true);
  });

  it.each([
    ['tarih biçimi', { faturaTarihi: '05.11.2026' }],
    ['para birimi', { paraBirimi: 'TL' }],
    ['metin tutar', { genelToplam: '1.800,00' as unknown as number }],
    ['boş metin', { faturaNo: '   ' }],
  ])('rejects bad %s', (_name, override) => {
    expect(InvoiceSchema.safeParse(sampleInvoice(override)).success).toBe(false);
  });

  it('rejects unknown fields so the output stays minimal', () => {
    const invoice = { ...sampleInvoice(), ekstra: 1 };
    expect(InvoiceSchema.safeParse(invoice).success).toBe(false);
  });

  it('produces a JSON schema that requires every field', () => {
    const schema = invoiceJsonSchema() as {
      $schema?: string;
      required: string[];
      properties: { fatura: { required: string[] }; kalemler: { items: { required: string[] } } };
    };
    expect(schema.$schema).toBeUndefined();
    expect(schema.required).toEqual(['fatura', 'kalemler']);
    expect(schema.properties.fatura.required).toHaveLength(10);
    expect(schema.properties.kalemler.items.required).toEqual([
      'aciklama',
      'miktar',
      'birim',
      'birimFiyat',
      'kdvOrani',
      'tutar',
    ]);
  });
});
