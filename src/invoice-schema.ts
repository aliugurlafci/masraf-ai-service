import { z } from 'zod';

const text = z.string().trim().min(1).nullable();
const amount = z.number().finite().nullable();

export const InvoiceHeaderSchema = z
  .object({
    faturaNo: text,
    faturaTarihi: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD bekleniyor')
      .nullable(),
    saticiUnvan: text,
    saticiVergiNo: text,
    aliciUnvan: text,
    aliciVergiNo: text,
    paraBirimi: z
      .string()
      .regex(/^[A-Z]{3}$/, 'ISO 4217 kodu bekleniyor (TRY, USD, EUR)')
      .nullable(),
    araToplam: amount,
    kdvToplam: amount,
    genelToplam: amount,
  })
  .strict();

export const InvoiceLineSchema = z
  .object({
    aciklama: text,
    miktar: amount,
    birim: text,
    birimFiyat: amount,
    kdvOrani: amount,
    tutar: amount,
  })
  .strict();

export const InvoiceSchema = z
  .object({
    fatura: InvoiceHeaderSchema,
    kalemler: z.array(InvoiceLineSchema),
  })
  .strict();

export type Invoice = z.infer<typeof InvoiceSchema>;

/** JSON Schema handed to `claude --json-schema`; generated from the Zod schema so the two never drift. */
export function invoiceJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(InvoiceSchema) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
