// The approval document of a form (docs/onay-sistemi.md, section 7). Rendered from the data given, with
// the embedded Noto Sans fonts so Turkish letters print; nothing here touches the database.
import { resolve } from 'node:path';
import PDFDocument from 'pdfkit';
import { formatMoney } from '../approval/flow.ts';
import { ROOT_DIR } from '../config.ts';
import type { AdimDurum, FormDurum } from './rules.ts';

const FONT_DIR = resolve(ROOT_DIR, 'assets', 'fonts');
const REGULAR = resolve(FONT_DIR, 'NotoSans-Regular.ttf');
const BOLD = resolve(FONT_DIR, 'NotoSans-Bold.ttf');

export interface PdfData {
  readonly form: {
    readonly id: number;
    readonly baslik: string;
    readonly sahip: string;
    readonly departman: string | null;
    readonly kategori: string;
    readonly masrafTarihi: string;
    readonly tutar: number;
    readonly paraBirimi: string;
    readonly kur: number | null;
    readonly onayTutari: number | null;
    readonly durum: FormDurum;
  };
  /** The base currency (PARA_BIRIMI), the currency of the approval amount. */
  readonly base: string;
  readonly faturalar: ReadonlyArray<{
    readonly faturaNo: string | null;
    readonly faturaTarihi: string | null;
    readonly saticiUnvan: string | null;
    readonly saticiVergiNo: string | null;
    readonly genelToplam: number | null;
    readonly paraBirimi: string | null;
    readonly duzeltildi: boolean;
  }>;
  /** The steps of the last round, in order. */
  readonly onaylar: ReadonlyArray<{
    readonly sira: number;
    readonly onayci: string;
    readonly durum: AdimDurum;
    readonly kararTarihi: Date | null;
    readonly aciklama: string | null;
    readonly yedek: boolean;
  }>;
  readonly olusturma: Date;
}

const STEP_TEXT: Record<AdimDurum, string> = {
  sirada: 'Sırada',
  bekliyor: 'Bekliyor',
  onaylandi: 'Onaylandı',
  reddedildi: 'Reddedildi',
  atlandi: 'Atlandı',
  iptal: 'İptal',
};

const FORM_TEXT: Record<FormDurum, string> = {
  taslak: 'Taslak',
  onayda: 'Onayda',
  onaylandi: 'Onaylandı',
  reddedildi: 'Reddedildi',
  iptal: 'İptal edildi',
  odendi: 'Ödendi',
};

/** Local time of the server, as the rest of the service shows it. */
const timeText = (d: Date): string => new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }).format(d);
const dateText = (s: string | null): string => (s === null ? '-' : `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}`);
const dash = (s: string | null | undefined): string => (s === null || s === undefined || s.trim() === '' ? '-' : s);

interface Column {
  readonly title: string;
  readonly width: number;
  readonly align?: 'left' | 'right';
}

/** Renders the approval document. `compress: false` keeps the text readable in the file (tests). */
export function renderApprovalPdf(data: PdfData, opts: { readonly compress?: boolean } = {}): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 48,
    compress: opts.compress ?? true,
    info: { Title: `Masraf #${data.form.id} onay belgesi`, Author: 'Masraf servisi' },
  });
  doc.registerFont('regular', REGULAR);
  doc.registerFont('bold', BOLD);
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((ok, fail) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => ok(Buffer.concat(chunks)));
    doc.on('error', fail);
  });

  const left = doc.page.margins.left;
  const usable = doc.page.width - left - doc.page.margins.right;
  const bottom = (): number => doc.page.height - doc.page.margins.bottom;

  const heading = (text: string): void => {
    doc.moveDown(0.8).font('bold').fontSize(12).fillColor('#111').text(text, left, doc.y, { width: usable });
    doc.moveDown(0.3);
  };

  /** A table that continues on the next page with its header repeated. */
  const table = (columns: readonly Column[], rows: ReadonlyArray<readonly string[]>): void => {
    const pad = 4;
    const drawRow = (cells: readonly string[], bold: boolean): void => {
      doc.font(bold ? 'bold' : 'regular').fontSize(8.5);
      const height = Math.max(...cells.map((c, i) => doc.heightOfString(c, { width: (columns[i] as Column).width - pad * 2 }))) + pad * 2;
      if (doc.y + height > bottom()) {
        doc.addPage();
        if (!bold) drawRow(columns.map((c) => c.title), true);
      }
      const y = doc.y;
      if (bold) doc.rect(left, y, usable, height).fill('#eef2f6');
      doc.fillColor('#111');
      let x = left;
      cells.forEach((cell, i) => {
        const col = columns[i] as Column;
        doc.font(bold ? 'bold' : 'regular').fontSize(8.5).text(cell, x + pad, y + pad, { width: col.width - pad * 2, align: col.align ?? 'left' });
        x += col.width;
      });
      doc.moveTo(left, y + height).lineTo(left + usable, y + height).lineWidth(0.5).strokeColor('#cbd2d9').stroke();
      doc.x = left;
      doc.y = y + height;
    };
    drawRow(columns.map((c) => c.title), true);
    for (const r of rows) drawRow(r, false);
  };

  const f = data.form;
  doc.font('bold').fontSize(16).fillColor('#111').text('Masraf onay belgesi', left, doc.y);
  doc.font('regular').fontSize(10).fillColor('#52606d').text(`Form #${f.id} · ${FORM_TEXT[f.durum]}`);
  doc.moveDown(0.6);

  const fields: Array<[string, string]> = [
    ['Başlık', f.baslik],
    ['Sahibi', f.departman === null ? f.sahip : `${f.sahip} (${f.departman})`],
    ['Kategori', f.kategori],
    ['Masraf tarihi', dateText(f.masrafTarihi)],
    ['Tutar', formatMoney(f.tutar, f.paraBirimi)],
    ['Para birimi', f.paraBirimi],
    ['Kur', f.kur === null ? '-' : String(f.kur).replace('.', ',')],
    ['Onay tutarı', f.onayTutari === null ? '-' : formatMoney(f.onayTutari, data.base)],
  ];
  for (const [k, v] of fields) {
    const y = doc.y;
    doc.font('bold').fontSize(10).fillColor('#111').text(k, left, y, { width: 110 });
    doc.font('regular').text(v, left + 115, y, { width: usable - 115 });
    doc.x = left;
  }

  heading('Faturalar');
  if (data.faturalar.length === 0) {
    doc.font('regular').fontSize(10).text('Bu forma fatura eklenmemiş.', left, doc.y);
  } else {
    table(
      [
        { title: 'Fatura no', width: 95 },
        { title: 'Tarih', width: 62 },
        { title: 'Satıcı', width: 165 },
        { title: 'Vergi no', width: 85 },
        { title: 'Genel toplam', width: usable - 407, align: 'right' },
      ],
      data.faturalar.map((x) => [
        `${dash(x.faturaNo)}${x.duzeltildi ? ' *' : ''}`,
        dateText(x.faturaTarihi),
        dash(x.saticiUnvan),
        dash(x.saticiVergiNo),
        x.genelToplam === null ? '-' : formatMoney(x.genelToplam, x.paraBirimi ?? ''),
      ]),
    );
    if (data.faturalar.some((x) => x.duzeltildi)) {
      doc.moveDown(0.3).font('regular').fontSize(8).fillColor('#52606d').text('* Bilgileri form sahibi tarafından düzeltilen fatura.', left, doc.y);
    }
  }

  heading('Onay adımları');
  table(
    [
      { title: 'Sıra', width: 32 },
      { title: 'Onaycı', width: 130 },
      { title: 'Karar', width: 70 },
      { title: 'Karar zamanı', width: 95 },
      { title: 'Açıklama', width: usable - 327 },
    ],
    data.onaylar.map((s) => [
      String(s.sira),
      `${s.onayci}${s.yedek ? ' (yedek)' : ''}`,
      STEP_TEXT[s.durum],
      s.kararTarihi === null ? '-' : timeText(s.kararTarihi),
      dash(s.aciklama),
    ]),
  );

  doc.moveDown(1).font('regular').fontSize(8).fillColor('#52606d').text(`Belgenin oluşturulma zamanı: ${timeText(data.olusturma)}`, left, doc.y);
  doc.end();
  return done;
}
