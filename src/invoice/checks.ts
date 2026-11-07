import type { Invoice } from './schema.ts';

/** Header fields every invoice must have, with their Turkish labels. Also the fields a form cannot be sent without. */
export const REQUIRED = [
  ['faturaNo', 'fatura no'],
  ['faturaTarihi', 'fatura tarihi'],
  ['saticiUnvan', 'satıcı'],
  ['genelToplam', 'genel toplam'],
] as const;

/**
 * A unit price printed with 2 decimals can hide up to half a kuruş per unit, and the line amount is
 * rounded too. A percentage tolerance would be too loose: 57,400 misread as 57,409 on 16,259 kg is
 * only 0.016% off.
 */
const lineClose = (expected: number, tutar: number, miktar: number): boolean =>
  Math.abs(expected - tutar) <= Math.abs(miktar) * 0.005 + 0.02;

/**
 * Token-free checks on a read invoice. A cheaper model's read is kept only when this finds nothing;
 * otherwise the cascade reads the file again with the next model. Messages are shown to the user.
 *
 * They catch misread amounts (a digit or the Turkish thousands separator read wrong) and blank reads,
 * not misread text such as a name or an invoice number.
 */
export function findProblems(inv: Invoice): string[] {
  const f = inv.fatura;
  const lines = inv.kalemler;
  const problems: string[] = [];

  const missing = REQUIRED.filter(([key]) => f[key] === null || f[key] === '').map(([, label]) => label);
  if (missing.length > 0) problems.push(`Okunamayan alan: ${missing.join(', ')}.`);
  if (lines.length === 0) problems.push('Kalem okunamadı.');

  lines.forEach((line, i) => {
    if (line.tutar === null) {
      problems.push(`${i + 1}. kalemin tutarı okunamadı.`);
      return;
    }
    if (line.miktar === null || line.birimFiyat === null) return;
    const net = line.miktar * line.birimFiyat;
    // Some invoices print the line amount with VAT included.
    const gross = line.kdvOrani === null ? null : net * (1 + line.kdvOrani / 100);
    if (!lineClose(net, line.tutar, line.miktar) && !(gross !== null && lineClose(gross, line.tutar, line.miktar))) {
      problems.push(`${i + 1}. kalemde miktar × birim fiyat tutarı vermiyor.`);
    }
  });

  // Same tolerance as the panel's checks.
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(0.05, lines.length * 0.01);
  if (f.araToplam !== null && lines.length > 0 && lines.every((l) => l.tutar !== null)) {
    const sum = lines.reduce((acc, l) => acc + (l.tutar ?? 0), 0);
    if (!near(sum, f.araToplam) && !(f.genelToplam !== null && near(sum, f.genelToplam))) {
      problems.push('Kalemlerin toplamı ara toplamı tutmuyor.');
    }
  }
  if (f.araToplam !== null && f.kdvToplam !== null && f.genelToplam !== null && !near(f.araToplam + f.kdvToplam, f.genelToplam)) {
    problems.push('Ara toplam ile KDV genel toplamı tutmuyor.');
  }
  return problems;
}
