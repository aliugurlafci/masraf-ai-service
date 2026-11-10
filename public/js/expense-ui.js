// Pieces several expense screens share: a compact expense row, the invoice file preview, the
// approver chain from a preview (POST /api/onay-akisi/onizle), and the approve / reject dialogs.

import * as api from './api.js';
import { el, icon, ICONS } from './dom.js';
import { safeType } from './files.js';
import { fmtCurrency, fmtDateShort } from './format.js';
import { amountTexts, categoryIcon, readingTags, statusBadge } from './labels.js';
import { field, openDialog, setFieldError, textarea } from './ui.js';

export const expenseHref = (id) => `#/masraflar/${encodeURIComponent(String(id))}`;

/** One line of an expense list that links to its detail (dashboard, small lists). */
export function expenseMiniRow(m, base, { showOwner = false } = {}) {
  const { main, local, empty } = amountTexts(m, base);
  const sub = [showOwner ? m.olusturan?.adSoyad : null, m.kategori?.ad, fmtDateShort(m.masrafTarihi)].filter(Boolean).join(' · ');
  return el(
    'li',
    {},
    el(
      'a',
      { className: 'mini-row', href: expenseHref(m.id) },
      categoryIcon(m.kategori?.simge),
      el('span', { className: 'mini-main' }, el('span', { className: 'mini-title', text: m.baslik }), el('span', { className: 'mini-sub', text: sub })),
      el(
        'span',
        { className: 'mini-end' },
        el('span', { className: `mini-amount${empty ? ' is-empty' : ''}`, text: main ?? '' }),
        local ? el('span', { className: 'mini-sub', text: `≈ ${local}` }) : null,
        statusBadge(m.durum, { className: 'sm' }),
        readingTags(m.okuma),
      ),
    ),
  );
}

/** A card that names the expense inside a dialog. */
export function expenseSummary(m, base) {
  const { main, local } = amountTexts(m, base);
  return el(
    'div',
    { className: 'dlg-summary' },
    categoryIcon(m.kategori?.simge),
    el(
      'div',
      { className: 'dlg-summary-main' },
      el('p', { className: 'dlg-summary-title', text: m.baslik }),
      el('p', { className: 'dlg-summary-sub', text: [m.olusturan?.adSoyad, m.kategori?.ad, fmtDateShort(m.masrafTarihi)].filter(Boolean).join(' · ') }),
    ),
    el('p', { className: 'dlg-summary-amount' }, el('span', { text: main ?? '' }), local ? el('span', { className: 'dlg-summary-sub', text: `≈ ${local}` }) : null),
  );
}

// ---------- Invoice file preview ----------

/**
 * An image or a PDF, with a link that opens the file in a new tab. Only the type decides (never the
 * file name), and only PDF and the invoice image types are shown or opened; anything else is offered
 * as a download.
 */
export function invoicePreview({ url, mime, name }) {
  if (!url) return null;
  const label = name || 'fatura';
  const type = safeType(mime);
  const isPdf = type === 'application/pdf';
  const isImage = type.startsWith('image/');
  let media = null;
  if (isPdf) {
    media = el('iframe', { className: 'preview-frame', src: url, title: `Fatura dosyası: ${label}` });
  } else if (isImage) {
    media = el('img', { className: 'preview-img', src: url, alt: `Fatura dosyası: ${label}`, loading: 'lazy' });
    media.addEventListener('error', () => {
      media.replaceWith(el('p', { className: 'preview-missing', text: 'Önizleme yüklenemedi. Dosyayı yeni sekmede açmayı deneyin.' }));
    });
  }
  return el(
    'figure',
    { className: 'preview' },
    media ?? el('p', { className: 'preview-missing', text: 'Bu dosya türü burada önizlenemiyor.' }),
    el(
      'figcaption',
      {},
      el('span', { className: 'preview-name', text: label }),
      isPdf || isImage
        ? el('a', { className: 'link-ext', href: url, target: '_blank', rel: 'noopener' }, el('span', { text: 'Yeni sekmede aç' }), icon(ICONS.external))
        : el('a', { className: 'link-ext', href: url, download: label }, el('span', { text: 'İndir' }), icon(ICONS.download)),
    ),
  );
}

// ---------- Approver chain ----------

/**
 * The line over a preview chain, naming the flow the preview used when the server says it:
 * chainLead(o, 'bu masraf şu onaycılara sırayla gidecek:') → '“Satış” akışına göre bu masraf …'.
 */
export function chainLead(o, rest) {
  const name = o?.akis?.ad;
  if (name) return `“${name}” akışına göre ${rest}`;
  return rest.charAt(0).toLocaleUpperCase('tr-TR') + rest.slice(1);
}

/**
 * The approvers an amount would go to, in order. o: Onizleme { onayTutari, paraBirimi, adimlar }.
 * The signed-in user's own step shows as skipped; a fallback manager is marked "Yedek".
 */
export function approverChain(o) {
  const steps = o?.adimlar ?? [];
  if (steps.length === 0) {
    // The server explains why in `uyari` (Turkish); the fixed text covers a missing one.
    return el('p', { className: 'chain-empty' }, icon(ICONS.warn), el('span', { text: o?.uyari || 'Bu tutar için onaycı bulunamadı; gönderim reddedilir. Yöneticinize başvurun.' }));
  }
  const list = el('ol', { className: 'chain' });
  for (const s of steps) {
    const skipped = s.durum === 'atlandi';
    list.append(
      el(
        'li',
        { className: `chain-step${skipped ? ' skipped' : ''}` },
        el('span', { className: 'chain-n', text: String(s.sira) }),
        el('span', { className: 'chain-name', text: s.onayci?.adSoyad ?? 'Onaycı' }),
        s.yedek ? el('span', { className: 'tag', text: 'Yedek yönetici' }) : null,
        skipped ? el('span', { className: 'tag', text: 'Sizin adımınız, atlanır' }) : null,
      ),
    );
  }
  return list;
}

// ---------- Approve and reject ----------

/**
 * Resolves with the updated MasrafDetay, null when cancelled, or 'failed' when the server refused
 * (e.g. 409 onay_beklemiyor: someone decided first), so the caller can reload.
 */
export function approveDialog(m, base) {
  const note = textarea({ name: 'aciklama', rows: 3, maxlength: 1000, placeholder: 'Örn. Uygundur.' });
  let failed = false;
  const ctl = openDialog({
    title: 'Masrafı onayla',
    description: `${m.baslik} onaylanacak. Akışta sıradaki onaycı varsa masraf ona geçer.`,
    body: [expenseSummary(m, base), field({ label: 'Açıklama', input: note, optional: true })],
    submitLabel: 'Onayla',
    submitKind: 'ok',
    submitIcon: ICONS.check,
    focus: 'submit',
    onSubmit: async (dlg) => {
      const text = note.value.trim();
      const r = await api.expenseAction(m.id, 'onayla', text ? { aciklama: text } : {});
      if (r.ok) return r.body;
      if (r.unauthorized || r.aborted) return null;
      if (r.error.alanlar?.aciklama) {
        setFieldError(note, r.error.alanlar.aciklama);
        note.focus();
      } else {
        failed = true;
        dlg.setError(r.error.mesaj);
      }
      return false;
    },
  });
  return ctl.done.then((v) => v ?? (failed ? 'failed' : null));
}

/** The reason is required (at least 3 characters); resolves like approveDialog. */
export function rejectDialog(m, base) {
  const note = textarea({ name: 'aciklama', rows: 4, maxlength: 1000, required: true, placeholder: 'Örn. Fatura masraf tarihiyle uyuşmuyor.' });
  note.addEventListener('input', () => setFieldError(note, null));
  let failed = false;
  const ctl = openDialog({
    title: 'Masrafı reddet',
    description: 'Ret nedeni masraf sahibine gösterilir. Sahibi masrafı düzenleyip yeniden gönderebilir.',
    body: [expenseSummary(m, base), field({ label: 'Ret nedeni', input: note, hint: 'En az 3 karakter.' })],
    submitLabel: 'Reddet',
    submitKind: 'danger',
    submitIcon: ICONS.close,
    onSubmit: async (dlg) => {
      const text = note.value.trim();
      if (text.length < 3) {
        setFieldError(note, 'Ret nedenini en az 3 karakterle yazın.');
        note.focus();
        return false;
      }
      const r = await api.expenseAction(m.id, 'reddet', { aciklama: text });
      if (r.ok) return r.body;
      if (r.unauthorized || r.aborted) return null;
      if (r.error.alanlar?.aciklama) {
        setFieldError(note, r.error.alanlar.aciklama);
        note.focus();
      } else {
        failed = true;
        dlg.setError(r.error.mesaj);
      }
      return false;
    },
  });
  return ctl.done.then((v) => v ?? (failed ? 'failed' : null));
}

/** "1.800,00 ₺" with the local amount under it when the currency differs. */
export function amountBlock(m, base, className = 'amount-block') {
  const { main, local, empty } = amountTexts(m, base);
  return el('div', { className }, el('span', { className: `amount-main${empty ? ' is-empty' : ''}`, text: main ?? '—' }), local ? el('span', { className: 'amount-local', text: `≈ ${local}` }) : null);
}

export const money = (v, cur) => fmtCurrency(v, cur) ?? '—';
