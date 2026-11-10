// Mail texts: plain text and HTML (docs/onay-sistemi.md, section 7). Pure; no database.
// Every value is escaped in the HTML; the subject never carries a line break (header injection).
import type { FormDurum } from '../expenses/rules.ts';
import { formatMoney } from '../approval/flow.ts';
import type { FormRef } from './events.ts';

export interface RenderedMail {
  readonly konu: string;
  readonly metin: string;
  readonly html: string;
}

const STATE_TEXT: Record<FormDurum, string> = {
  taslak: 'Taslak',
  onayda: 'Onayda',
  onaylandi: 'Onaylandı',
  reddedildi: 'Reddedildi',
  iptal: 'İptal edildi',
  odendi: 'Ödendi',
};

/** The longest subject stored (eposta_kutusu.konu). */
export const MAX_SUBJECT = 200;

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** One line: control characters and line breaks become spaces, at most MAX_SUBJECT characters. */
export function subjectLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SUBJECT);
}

/** The panel page of the form, or null when UYGULAMA_ADRESI is empty. */
export const formLink = (appUrl: string | null, formId: number): string | null => (appUrl === null ? null : `${appUrl}/#/masraflar/${formId}`);

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
  `<body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2933;line-height:1.5">${body}` +
  `<p style="color:#7b8794;font-size:12px">Bu mail Masraf servisi tarafından gönderildi. Bildirim maillerini profilinizden kapatabilirsiniz.</p></body></html>`;

/** A notification about a form, addressed to `alici`. */
export function renderNotificationMail(input: {
  readonly alici: string;
  readonly baslik: string;
  readonly mesaj: string;
  readonly form: FormRef;
  readonly appUrl: string | null;
}): RenderedMail {
  const { alici, baslik, mesaj, form, appUrl } = input;
  const rows: Array<[string, string]> = [
    ['Form', `#${form.id}`],
    ['Başlık', form.baslik],
    ['Sahibi', form.sahip.adSoyad],
    ['Tutar', form.tutar === null ? 'Girilmedi' : formatMoney(form.tutar, form.paraBirimi)],
    ['Durum', STATE_TEXT[form.durum]],
  ];
  const link = formLink(appUrl, form.id);
  const metin = [
    `Merhaba ${alici},`,
    '',
    mesaj,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(link === null ? [] : ['', `Formu açmak için: ${link}`]),
    '',
    'Bu mail Masraf servisi tarafından gönderildi. Bildirim maillerini profilinizden kapatabilirsiniz.',
  ].join('\n');
  const table = rows
    .map(([k, v]) => `<tr><th align="left" style="padding:2px 12px 2px 0;color:#52606d">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
    .join('');
  const html = page(
    baslik,
    `<p>Merhaba ${escapeHtml(alici)},</p><p>${escapeHtml(mesaj)}</p><table cellspacing="0" cellpadding="0">${table}</table>` +
      (link === null ? '' : `<p><a href="${escapeHtml(link)}">Formu panelde aç</a></p>`),
  );
  return { konu: subjectLine(`Masraf: ${baslik} - ${form.baslik}`), metin, html };
}

/** The administrators' test mail. */
export function renderTestMail(appUrl: string | null): RenderedMail {
  const mesaj = 'Bu bir deneme mailidir. Masraf servisinin mail ayarları çalışıyor.';
  const metin = [mesaj, ...(appUrl === null ? [] : ['', `Panel: ${appUrl}`])].join('\n');
  const html = page('Deneme maili', `<p>${escapeHtml(mesaj)}</p>${appUrl === null ? '' : `<p><a href="${escapeHtml(appUrl)}">Paneli aç</a></p>`}`);
  return { konu: 'Masraf: deneme maili', metin, html };
}
