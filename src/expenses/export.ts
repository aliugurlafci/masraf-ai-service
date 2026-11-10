import { display } from '../definitions/display.ts';
import type { ExportRow } from './forms.ts';
import type { FormDurum } from './rules.ts';

const STATE_LABELS: Record<FormDurum, string> = {
  taslak: 'Taslak',
  onayda: 'Onayda',
  onaylandi: 'Onaylandı',
  reddedildi: 'Reddedildi',
  iptal: 'İptal',
  odendi: 'Ödendi',
};

const decimal = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 6, useGrouping: false });

/** Turkish date and time in Istanbul time, as Excel shows it. */
const dateTime = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'short', timeStyle: 'short' });

function cell(value: string | number | null): string {
  if (value === null) return '';
  let text = typeof value === 'number' ? decimal.format(value) : value;
  // A cell starting with = + - @ would run as a formula in Excel (CSV injection).
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const when = (iso: string | null): string | null => (iso === null ? null : dateTime.format(new Date(iso)));

/** Semicolon-separated with a BOM, so Excel opens it in Turkish settings with the right characters. */
export function toCsv(rows: readonly ExportRow[]): string {
  const header = [
    'No',
    'Başlık',
    'Kategori',
    'Masraf tarihi',
    'Satıcı',
    'Fatura no',
    'Tutar',
    'Para birimi',
    'Kur',
    'Yerel tutar',
    'Durum',
    'Oluşturan',
    'Departman',
    'Gönderim',
    'Sonuçlanma',
    'Ödeme',
    'Organizasyon',
    'Masraf Merkezi',
  ];
  const lines = rows.map((r) =>
    [
      String(r.id),
      r.baslik,
      r.kategori.ad,
      r.masrafTarihi,
      r.satici,
      r.faturaNo,
      r.tutar,
      r.paraBirimi,
      r.kur,
      r.yerelTutar,
      STATE_LABELS[r.durum],
      r.olusturan.adSoyad,
      r.departman,
      when(r.gonderim),
      when(r.sonuclanma),
      when(r.odeme),
      r.organizasyon === null ? null : display(r.organizasyon.kod, r.organizasyon.ad),
      r.masrafMerkezi?.gosterim ?? null,
    ]
      .map(cell)
      .join(';'),
  );
  return `\uFEFF${[header.join(';'), ...lines].join('\r\n')}\r\n`;
}
