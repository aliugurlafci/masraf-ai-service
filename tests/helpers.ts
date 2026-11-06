import { fileURLToPath } from 'node:url';
import type { Extraction } from '../src/claude-extractor.ts';
import type { Invoice } from '../src/invoice-schema.ts';
import type { ClaudeOlcum } from '../src/olcum.ts';

export const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
export const FAKE_TOKEN = `sk-ant-oat01-${'a'.repeat(40)}`;

export const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

export function sampleInvoice(overrides: Partial<Invoice['fatura']> = {}): Invoice {
  return {
    fatura: {
      faturaNo: 'ABC2026000000123',
      faturaTarihi: '2026-11-05',
      saticiUnvan: 'Örnek Yazılım A.Ş.',
      saticiVergiNo: '1234567890',
      aliciUnvan: 'Deneme Ltd. Şti.',
      aliciVergiNo: '9876543210',
      paraBirimi: 'TRY',
      araToplam: 1500,
      kdvToplam: 300,
      genelToplam: 1800,
      ...overrides,
    },
    kalemler: [{ aciklama: 'Danışmanlık', miktar: 2, birim: 'saat', birimFiyat: 500, kdvOrani: 20, tutar: 1000 }],
  };
}

export function sampleOlcum(overrides: Partial<ClaudeOlcum> = {}): ClaudeOlcum {
  return {
    sureMs: 14200,
    apiSureMs: 12800,
    tur: 2,
    girdiToken: 12,
    onbellektenToken: 15800,
    onbellegeToken: 0,
    ciktiToken: 420,
    apiEsdegeriUsd: 0.0312,
    model: 'claude-sonnet-5-5',
    effort: 'low',
    ...overrides,
  };
}

export function sampleExtraction(): Extraction {
  return { sonuc: sampleInvoice(), olcum: sampleOlcum() };
}
