// Masraf detayı (GET /api/masraflar/:id): fields, the invoices and their files, the files still
// being read in the background (bekleyenFaturalar), the approval steps of the latest round, the
// history, and the actions this user may take. Buttons come only from the server's `izinler`; the
// panel never works out the rules itself. While a file is being read the page asks the server again
// every few seconds, so the reading place and newly read invoices show up without a reload.

import * as api from '../api.js';
import { el, icon, ICONS } from '../dom.js';
import { fmtCount, fmtCurrency, fmtDateLong, fmtDateTime, fmtRateInput, fmtRelative, queueText } from '../format.js';
import { invoicesTotal } from '../equivalents.js';
import { compareView, HEADER_FIELDS, labelOf, missingOf, showValue } from '../invoice-edit.js';
import { entryFields, labelFrom } from '../fields.js';
import { approveDialog, approverChain, chainLead, invoicePreview, rejectDialog } from '../expense-ui.js';
import { bandText, categoryIcon, HISTORY_LABEL, HISTORY_TONE, humanize, STEP_STATUS, statusBadge } from '../labels.js';
import * as session from '../session.js';
import { actionDialog, alertBox, btn, field, loadFailed, openDialog, pageHead, select, setBusy, setPageTitle, setFieldError, showError, toast } from '../ui.js';

const UNDECIDED = new Set(['sirada', 'bekliyor']);
// How often a form with files still being read is asked again; slower after a failed call.
const POLL_MS = 4000;
const POLL_RETRY_MS = 10000;

/** Send refusals the panel explains a little more (the server's own message comes first). */
const SEND_HINTS = {
  okuma_suruyor: 'Faturalar okunuyor. Okumalar bitince yeniden deneyin ya da “Okumalar bitince onaya gönder” seçeneğini açın.',
  okuma_hatali: 'Okunamayan faturayı yeniden okutun ya da masrafı düzenleyip çıkarın.',
  tutar_eksik: 'Masrafı düzenleyip tutarı girin.',
};

const HEADER_KEYS = new Set(HEADER_FIELDS.map((f) => f.key));

/** Files on the form that are not read yet (sirada, okunuyor) or could not be read (hata). */
const pendingOf = (d) => (Array.isArray(d?.bekleyenFaturalar) ? d.bekleyenFaturalar : []);

const noAmount = (d) => d.tutar === null || d.tutar === undefined;

function pendingStatus(b) {
  if (b.durum === 'okunuyor') return 'Okunuyor';
  if (b.durum === 'hata') return b.hata?.mesaj ?? 'Okunamadı';
  return queueText(b.kuyrukSirasi, b.onundeki);
}

/**
 * What a refresh may change without redrawing the page: the reading places and sirada ↔ okunuyor.
 * Anything else (a file read or failed, the amount, the state, the history) redraws it.
 */
function shapeOf(d) {
  return JSON.stringify([
    d.durum,
    d.guncelleme,
    d.tutar,
    d.satici,
    d.okununcaGonder,
    d.faturaIdler,
    pendingOf(d).map((b) => [b.dosyaOzeti, b.durum === 'hata' ? b.hata?.kod ?? 'hata' : 'okuma']),
    d.izinler,
  ]);
}

function backFor(d) {
  const me = session.currentUser();
  if (d && me && d.olusturan?.id === me.id) return { href: '#/masraflar', label: 'Masraflarım' };
  if (session.isFinance()) return { href: '#/tum-masraflar', label: 'Tüm masraflar' };
  return { href: '#/onaylar', label: 'Onaylarım' };
}

/** `odeme` and `sonuclanma` are described only as nullable; show a time, or a {tarih, kullanici} pair. */
function eventText(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return fmtDateTime(v) ?? v;
  if (typeof v === 'object') {
    const when = v.tarih ? fmtDateTime(v.tarih) : null;
    const who = v.kullanici?.adSoyad ?? null;
    return [when, who].filter(Boolean).join(' · ') || null;
  }
  return String(v);
}

function kv(label, value, { wide = false } = {}) {
  if (value === null || value === undefined || value === '') return null;
  return el('div', { className: wide ? 'kv-wide' : null }, el('dt', { text: label }), typeof value === 'string' ? el('dd', { text: value }) : el('dd', {}, value));
}

/** Invoices with empty required fields: [{ n, f, gone }] (n is the 1-based place on the form). */
const incompleteOf = (d) =>
  (Array.isArray(d?.faturalar) ? d.faturalar : [])
    .map((f, i) => ({ n: i + 1, f, gone: Array.isArray(f.eksikAlanlar) ? f.eksikAlanlar : [] }))
    .filter((x) => x.gone.length > 0);

const fixHref = (d, faturaId) => `#/masraflar/${d.id}/duzenle?fatura=${encodeURIComponent(faturaId)}`;

const invoicesOf = (d) => (Array.isArray(d?.faturalar) ? d.faturalar : []);

const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Invoices in a third currency whose base-currency equivalent was not entered (sending is refused). */
const missingEquivalents = (d) => invoicesOf(d).filter((f) => f.karsilikGerekli && !positive(f.yerelKarsilik));

/** The entered equivalents ({ faturaId: amount }); the server keeps only those the form needs. */
function equivalentsOf(d) {
  const out = {};
  for (const f of invoicesOf(d)) if (positive(f.yerelKarsilik)) out[f.id] = f.yerelKarsilik;
  return out;
}

/** Who the saved form would go to if sent now (POST /api/onay-akisi/onizle); a draft without an amount has no preview. */
function previewBody(d) {
  const body = { tutar: d.tutar, paraBirimi: d.paraBirimi };
  if (d.kur !== null && d.kur !== undefined) body.kur = d.kur;
  const ids = Array.isArray(d.faturaIdler) ? d.faturaIdler : invoicesOf(d).map((f) => f.id);
  if (ids.length > 0) body.faturaIdler = ids;
  const eq = equivalentsOf(d);
  if (Object.keys(eq).length > 0) body.yerelKarsiliklar = eq;
  return body;
}

/** The invoices' total in the form's currency (equivalents.js), as tutarFarki.fatura counts it. */
const invoiceTotalOf = (d, base) =>
  invoicesTotal(
    invoicesOf(d).map((f) => ({ fatura: f, equivalent: f.karsilikGerekli ? f.yerelKarsilik : null })),
    d.paraBirimi ?? base,
    base,
    d.kur,
  );

/**
 * Under an invoice: its entered base-currency equivalent, or why it does not add to the amount, or
 * that it adds converted (a base-currency receipt on a foreign-currency form).
 */
function invoiceNote(f, d, base) {
  const cur = d.paraBirimi ?? base;
  const note = (glyph, text) => el('p', { className: 'inv-card-note' }, icon(glyph), el('span', { text }));
  if (f.karsilikGerekli) {
    if (positive(f.yerelKarsilik)) return el('p', { className: 'inv-eq-line' }, el('span', { text: `${base} karşılığı: ` }), el('strong', { text: fmtCurrency(f.yerelKarsilik, base) }));
    return note(
      ICONS.warn,
      d.izinler?.duzenle
        ? `Fatura ${f.paraBirimi} cinsinden ve ${base} karşılığı girilmedi. Onaya göndermeden önce masrafı düzenleyip girin.`
        : `Fatura ${f.paraBirimi} cinsinden ve ${base} karşılığı girilmedi; onay tutarına katılmaz.`,
    );
  }
  if (!positive(f.genelToplam)) return note(ICONS.info, 'Genel toplam okunamadı; onay tutarına katılmaz.');
  if (f.paraBirimi === base && cur !== base) return note(ICONS.info, `Fatura ${base} cinsinden; toplama kurla ${cur} karşılığı olarak katılır.`);
  return null;
}

export const expenseDetailView = {
  mount(root, { route, signal }) {
    const id = route.params.id;
    const page = el('div', { className: 'page' });
    // Outside the page, which is redrawn: says what a background refresh changed.
    const live = el('p', { className: 'visually-hidden', role: 'status' });
    root.append(page, live);
    let base = session.knownBaseCurrency() ?? 'TRY';
    let detail = null;
    let pollTimer = null;
    let drawn = 0; // bumped on every render: a refresh asked before it is out of date
    let fields = null; // GET /api/alanlar: names and order of the receipt fields

    /** A field's name: an invoice header field, the cost centre, or a receipt field from the field list. */
    function fieldLabel(k, { lower = false } = {}) {
      if (HEADER_KEYS.has(k)) return lower ? labelOf(k).toLocaleLowerCase('tr-TR') : labelOf(k);
      if (k === 'masrafMerkezi') return lower ? 'masraf merkezi' : 'Masraf merkezi';
      return labelFrom(fields, k); // a name the manager typed keeps its case
    }

    /**
     * A receipt's own fields (alanlar: { anahtar: { deger, gosterim } }) in the field list's order, the
     * required ones it lacks (eksikAlanlar) marked; null when there is nothing to show.
     */
    function fisFacts(rec, fix) {
      const values = rec.alanlar && typeof rec.alanlar === 'object' ? rec.alanlar : {};
      const gone = (Array.isArray(rec.eksikAlanlar) ? rec.eksikAlanlar : []).filter((k) => !HEADER_KEYS.has(k));
      const keys = fields ? entryFields(fields).map((f) => f.anahtar) : [];
      for (const k of [...Object.keys(values), ...gone]) if (!keys.includes(k)) keys.push(k);
      const rows = keys
        .map((k) => {
          const missing = gone.includes(k);
          const v = values[k];
          const text = v?.gosterim ?? (v?.deger !== null && v?.deger !== undefined ? String(v.deger) : '');
          if (!missing && !text) return null;
          const label = fieldLabel(k);
          const dd = missing
            ? fix
              ? el('dd', {}, el('a', { className: 'missing-link', href: fix, text: 'Eksik', 'aria-label': `${label} eksik; düzenleyip doldurun` }))
              : el('dd', { text: 'Eksik' })
            : el('dd', { text });
          return el('div', { className: missing ? 'is-missing' : null }, el('dt', { text: label }), dd);
        })
        .filter(Boolean);
      if (rows.length === 0) return null;
      return el('div', { className: 'fis-facts' }, el('p', { className: 'fis-facts-title', text: 'Fiş alanları' }), el('dl', { className: 'kv compact' }, ...rows));
    }

    page.append(pageHead({ title: `Masraf #${id}`, back: backFor(null) }), el('div', { className: 'skeleton-detail', role: 'status', 'aria-label': 'Yükleniyor' }, el('span'), el('span'), el('span')));

    async function load() {
      // The field list only names and orders the receipt fields; without it the keys show as they are.
      const [r, b, fl] = await Promise.all([api.getExpense(id, { signal }), session.loadBaseCurrency(), fields ? null : api.listFields(false, { signal })]);
      if (signal.aborted) return;
      base = b;
      if (fl?.ok && Array.isArray(fl.body?.alanlar)) fields = fl.body.alanlar;
      if (!r.ok) {
        if (r.unauthorized) return;
        const hadFocus = page.contains(document.activeElement);
        page.replaceChildren(pageHead({ title: `Masraf #${id}`, back: backFor(null) }), loadFailed(r, r.error.durum === 404 || r.error.durum === 403 ? null : load));
        if (hadFocus) page.querySelector('h1')?.focus();
        return;
      }
      render(r.body);
    }

    // ---------- Files read in the background: ask again while one is waiting or being read ----------

    function schedulePoll(d, ms = POLL_MS) {
      clearTimeout(pollTimer);
      pollTimer = null;
      if (signal.aborted || !pendingOf(d).some((b) => b.durum !== 'hata')) return;
      pollTimer = setTimeout(poll, ms);
    }

    async function poll() {
      pollTimer = null;
      if (!detail) return;
      // A hidden tab waits; it asks again as soon as it is looked at.
      if (document.hidden) {
        schedulePoll(detail);
        return;
      }
      const asked = drawn;
      const r = await api.getExpense(id, { signal });
      if (signal.aborted || !detail) return;
      // An action redrew the page meanwhile (and scheduled the next turn): this answer may be older.
      if (asked !== drawn) return;
      if (!r.ok) {
        if (!r.unauthorized) schedulePoll(detail, POLL_RETRY_MS);
        return;
      }
      refresh(r.body);
    }

    /** Applies a fresh copy: the reading places in place, anything else by redrawing the page. */
    function refresh(d) {
      const before = detail;
      if (before && shapeOf(before) === shapeOf(d)) {
        detail = d;
        drawn++;
        updatePending(d);
        schedulePoll(d);
        return;
      }
      render(d);
      if (!before) return;
      const read = (d.faturalar ?? []).length - (before.faturalar ?? []).length;
      const failed = pendingOf(d).filter((b) => b.durum === 'hata').length - pendingOf(before).filter((b) => b.durum === 'hata').length;
      const news = [];
      if (before.durum !== d.durum && d.durum === 'onayda') news.push('Masraf onaya gönderildi.');
      if (read > 0) news.push(read === 1 ? 'Bir fatura okundu ve masrafa eklendi.' : `${fmtCount(read)} fatura okundu ve masrafa eklendi.`);
      if (failed > 0) news.push(failed === 1 ? 'Bir fatura okunamadı.' : `${fmtCount(failed)} fatura okunamadı.`);
      live.textContent = news.join(' ');
    }

    function updatePending(d) {
      const section = page.querySelector('.pend-card');
      if (!section) return;
      for (const b of pendingOf(d)) {
        const li = [...section.querySelectorAll('.pend-item')].find((x) => x.dataset.hash === b.dosyaOzeti);
        if (!li) continue;
        li.dataset.state = b.durum;
        li.querySelector('.pend-status').textContent = pendingStatus(b);
        li.querySelector('.sheet-glyph')?.classList.toggle('active', b.durum === 'okunuyor');
      }
    }

    // ---------- Actions ----------

    function after(r, message) {
      if (!r) return;
      if (r.body) render(r.body);
      toast(message, 'ok');
      session.refreshMe();
    }

    async function doSend(d) {
      const chainSlot = el('div', { className: 'chain-slot', 'aria-live': 'polite' }, el('p', { className: 'muted', text: 'Onaycılar hesaplanıyor…' }));
      api.previewFlow(previewBody(d)).then((p) => {
        if (!chainSlot.isConnected) return;
        if (p.ok) chainSlot.replaceChildren(el('p', { className: 'dlg-text', text: chainLead(p.body, 'masraf şu onaycılara sırayla gidecek:') }), approverChain(p.body));
        else if (!p.unauthorized) chainSlot.replaceChildren(el('p', { className: 'muted', text: p.error.mesaj }));
      });
      const missing = missingEquivalents(d).length;
      let refused = false;
      const r = await actionDialog({
        title: 'Onaya gönder',
        message: d.tur >= 1 && d.durum === 'reddedildi' ? 'Masraf yeni bir turla yeniden onaya gönderilecek.' : 'Gönderdikten sonra masrafı düzenleyemezsiniz; gerekirse geri çekebilirsiniz.',
        details: [missing > 0 ? alertBox('warn', null, [missingLead(missing)]) : null, chainSlot],
        confirmLabel: 'Onaya gönder',
        confirmIcon: ICONS.send,
        run: async () => {
          const res = await api.expenseAction(d.id, 'gonder');
          if (res.ok) return res;
          refused = !res.unauthorized && !res.aborted;
          // 409 karsilik_eksik names every invoice without its equivalent in alanlar.
          if (res.error?.kod === 'karsilik_eksik') {
            const items = res.error.alanlar ? [...new Set(Object.values(res.error.alanlar).map(String))] : [res.error.mesaj];
            return { ...res, error: { ...res.error, mesaj: `Onaya gönderilemedi. Masrafı düzenleyip ${base} karşılığını girin.`, sorunlar: items } };
          }
          // 409 fatura_eksik / alan_eksik: alanlar names each gap (faturalar.<id>.<alan>,
          // fisAlanlari.<faturaId>.<alan>, masrafMerkeziId); each is said with its invoice's place.
          if ((res.error?.kod === 'alan_eksik' || res.error?.kod === 'fatura_eksik') && res.error.alanlar) {
            const list = invoicesOf(d);
            const items = Object.entries(res.error.alanlar).map(([key, message]) => {
              const m = /^(?:faturalar|fisAlanlari)\.([^.]+)\./.exec(key);
              const n = m ? list.findIndex((f) => f.id === m[1]) + 1 : 0;
              return n > 0 ? `${n}. fatura: ${message}` : String(message);
            });
            return { ...res, error: { ...res.error, sorunlar: [...new Set(items), 'Masrafı düzenleyip eksik alanları doldurun.'] } };
          }
          // 409 okuma_suruyor, okuma_hatali, tutar_eksik: the server's message and what to do next.
          const hint = SEND_HINTS[res.error?.kod];
          if (hint) return { ...res, error: { ...res.error, sorunlar: [hint] } };
          return res;
        },
      });
      if (r) after(r, 'Masraf onaya gönderildi.');
      else if (refused) load(); // the form may have moved on (a file read, the amount filled): show it
    }

    function missingLead(n) {
      return `${n === 1 ? 'Bir faturanın' : `${n} faturanın`} ${base} karşılığı girilmedi. Göndermeden önce düzenleyip ${base} karşılığını girin.`;
    }

    async function doSimple(d, action) {
      const defs = {
        'geri-cek': {
          title: 'Masrafı geri çek',
          message: 'Onay süreci durur ve masraf taslağa döner. Düzenleyip yeniden gönderebilirsiniz.',
          confirmLabel: 'Geri çek',
          confirmIcon: ICONS.undo,
          kind: 'primary',
          done: 'Masraf geri çekildi; şimdi taslak.',
        },
        iptal: {
          title: 'Masrafı iptal et',
          message: [
            'İptal edilen masraf geri alınamaz.',
            invoicesOf(d).length > 1 ? 'Bağlı faturalar başka bir masrafta kullanılabilir hale gelir.' : invoicesOf(d).length === 1 ? 'Bağlı fatura başka bir masrafta kullanılabilir hale gelir.' : null,
            pendingOf(d).length > 0 ? 'Okunmayı bekleyen faturalar masraftan çıkarılır; okunanlar fatura listenizde kalır.' : null,
          ]
            .filter(Boolean)
            .join(' '),
          confirmLabel: 'İptal et',
          confirmIcon: ICONS.ban,
          kind: 'danger',
          done: 'Masraf iptal edildi.',
        },
        odendi: {
          title: 'Ödendi olarak işaretle',
          message: `${fmtCurrency(d.yerelTutar ?? d.tutar, d.yerelTutar !== null && d.yerelTutar !== undefined ? base : d.paraBirimi)} tutarındaki masraf ödendi olarak işaretlenecek.`,
          confirmLabel: 'Ödendi işaretle',
          confirmIcon: ICONS.cash,
          kind: 'primary',
          done: 'Masraf ödendi olarak işaretlendi.',
        },
      };
      const def = defs[action];
      const r = await actionDialog({ ...def, run: () => api.expenseAction(d.id, action) });
      if (r) after(r, def.done);
      else load(); // the state may have moved on (409); show the current one
    }

    async function doDecision(d, kind) {
      const result = kind === 'onayla' ? await approveDialog(d, base) : await rejectDialog(d, base);
      if (result && typeof result === 'object') {
        render(result);
        toast(kind === 'onayla' ? 'Masraf onaylandı.' : 'Masraf reddedildi.', 'ok');
        session.refreshMe();
      } else {
        load();
      }
    }

    async function doTransfer(d) {
      const steps = (d.onaylar ?? []).filter((s) => UNDECIDED.has(s.durum));
      if (steps.length === 0) {
        toast('Devredilecek, karar verilmemiş bir adım yok.', 'err');
        return;
      }
      const stepSelect = select(
        steps.map((s) => ({ value: s.id, label: `${s.sira}. adım · ${s.onayci?.adSoyad ?? 'Onaycı'}${s.durum === 'bekliyor' ? ' (karar bekliyor)' : ''}` })),
        { name: 'onayId' },
      );
      const userSelect = select([{ value: '', label: 'Kullanıcılar yükleniyor…' }], { name: 'yeniOnayciId', disabled: true });
      const users = await api.listUsers();
      if (!users.ok) {
        if (!users.unauthorized) toast(users.error.mesaj, 'err');
        return;
      }
      const active = users.body.filter((u) => u.aktif);
      const fill = () => {
        const step = steps.find((s) => String(s.id) === stepSelect.value);
        userSelect.replaceChildren(el('option', { value: '', text: 'Yeni onaycıyı seçin' }));
        for (const u of active) {
          if (u.id === step?.onayci?.id) continue;
          userSelect.append(el('option', { value: u.id, text: `${u.adSoyad}${u.departman ? ` · ${u.departman}` : ''}` }));
        }
        userSelect.disabled = false;
      };
      fill();
      stepSelect.addEventListener('change', fill);
      userSelect.addEventListener('change', () => setFieldError(userSelect, null));
      const result = await openDialog({
        title: 'Onayı devret',
        description: 'Karar verilmemiş bir adımın onaycısı değişir. Yeni onaycı masrafı Onaylarım listesinde görür.',
        body: [field({ label: 'Adım', input: stepSelect }), field({ label: 'Yeni onaycı', input: userSelect })],
        submitLabel: 'Devret',
        submitIcon: ICONS.transfer,
        onSubmit: async (ctl) => {
          if (!userSelect.value) {
            setFieldError(userSelect, 'Yeni onaycıyı seçin.');
            userSelect.focus();
            return false;
          }
          const r = await api.expenseAction(d.id, 'devret', { onayId: Number(stepSelect.value), yeniOnayciId: Number(userSelect.value) });
          if (r.ok) return r;
          if (r.unauthorized) return null;
          if (r.error.alanlar?.yeniOnayciId) setFieldError(userSelect, r.error.alanlar.yeniOnayciId);
          else ctl.setError(r.error.mesaj);
          return false;
        },
      }).done;
      if (result && result !== true) after(result, 'Onay devredildi.');
    }

    async function downloadPdf(d, button) {
      button.disabled = true;
      const r = await api.getExpensePdf(d.id);
      button.disabled = false;
      if (!r.ok) {
        if (!r.unauthorized && !r.aborted) toast(r.error.mesaj, 'err');
        return;
      }
      const url = URL.createObjectURL(r.blob);
      const a = el('a', { href: url, download: r.filename ?? `masraf-${d.id}-onay-belgesi.pdf`, hidden: true });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }

    /** POST /api/masraflar/:id/yeniden-oku: every file that could not be read goes back in line. */
    async function doReread(d, button) {
      setBusy(button, true);
      const r = await api.expenseAction(d.id, 'yeniden-oku');
      if (signal.aborted) return;
      setBusy(button, false);
      if (!r.ok) {
        showError(r);
        return;
      }
      const n = pendingOf(d).filter((b) => b.durum === 'hata').length;
      refresh(r.body);
      toast(n > 1 ? 'Okunamayan faturalar yeniden okuma sırasına girdi.' : 'Fatura yeniden okuma sırasına girdi.', 'ok');
    }

    /** PATCH { okununcaGonder }: send the form by itself once every file is read. */
    async function toggleSendWhenRead(d, sw) {
      const next = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-busy', 'true');
      sw.disabled = true;
      const r = await api.updateExpense(d.id, { okununcaGonder: next });
      if (signal.aborted) return;
      sw.removeAttribute('aria-busy');
      sw.disabled = false;
      if (!r.ok) {
        showError(r);
        return;
      }
      refresh(r.body);
      page.querySelector('#okg-switch')?.focus();
      if (r.body.durum === 'onayda') toast('Masraf onaya gönderildi.', 'ok');
      else toast(next ? 'Okumalar bitince masraf onaya gönderilecek.' : 'Masraf okumalar bitince gönderilmeyecek; siz gönderirsiniz.', 'ok');
      session.refreshMe();
    }

    /** Why the send button is off: files still being read or failed, or no amount yet (the server's state, not a rule worked out here). */
    function sendBlockedText(d, reading, failed) {
      const parts = [d.durum === 'reddedildi' ? 'Masraf reddedildi.' : null];
      const many = (n) => (n === 1 ? 'Bir fatura' : `${fmtCount(n)} fatura`);
      if (reading > 0) {
        parts.push(d.okununcaGonder && failed === 0 ? `${many(reading)} okunuyor. Okumalar bitince masraf kendiliğinden onaya gönderilecek.` : `${many(reading)} okunuyor; okumalar bitince onaya gönderebilirsiniz.`);
      }
      if (failed > 0) parts.push(`${many(failed)} okunamadı; yeniden okutun ya da masrafı düzenleyip çıkarın.`);
      if (failed > 0 && reading === 0 && d.okununcaGonder) parts.push('Sorun giderilince masraf kendiliğinden onaya gönderilecek.');
      if (noAmount(d)) parts.push(pendingOf(d).length > 0 ? 'Tutar faturalar okununca dolacak.' : 'Tutar girilmedi; onaya göndermeden önce masrafı düzenleyip tutarı girin.');
      return parts.filter(Boolean).join(' ');
    }

    function actionBar(d) {
      const iz = d.izinler ?? {};
      const pend = pendingOf(d);
      const failed = pend.filter((b) => b.durum === 'hata').length;
      const reading = pend.length - failed;
      // izinler.gonder stays true while files are being read; the server would answer 409
      // okuma_suruyor / okuma_hatali / tutar_eksik, so the button is shown switched off with the reason.
      const blocked = Boolean(iz.gonder) && (pend.length > 0 || noAmount(d));
      const incomplete = iz.gonder && !blocked ? incompleteOf(d) : [];
      // Form-level gaps (the cost centre) the server reports in eksikAlanlar.
      const formGaps = iz.gonder && !blocked && Array.isArray(d.eksikAlanlar) ? d.eksikAlanlar : [];
      const needsFix = incomplete.length > 0 || formGaps.length > 0;
      const leadId = `action-lead-${d.id}`;
      const buttons = [
        iz.onayla ? btn('Onayla', { icon: ICONS.check, kind: 'ok', onClick: () => doDecision(d, 'onayla') }) : null,
        iz.reddet ? btn('Reddet', { icon: ICONS.close, kind: 'danger', onClick: () => doDecision(d, 'reddet') }) : null,
        iz.gonder && !needsFix
          ? btn('Onaya gönder', { icon: ICONS.send, kind: 'primary', disabled: blocked, onClick: () => doSend(d), attrs: blocked ? { 'aria-describedby': leadId } : {} })
          : null,
        iz.odendi ? btn('Ödendi işaretle', { icon: ICONS.cash, kind: 'primary', onClick: () => doSimple(d, 'odendi') }) : null,
        iz.gonder && needsFix
          ? btn('Eksikleri tamamla', { icon: ICONS.edit, kind: 'primary', href: incomplete.length > 0 ? fixHref(d, incomplete[0].f.id) : `#/masraflar/${d.id}/duzenle` })
          : null,
        iz.duzenle ? btn('Düzenle', { icon: ICONS.edit, href: `#/masraflar/${d.id}/duzenle` }) : null,
        iz.geriCek ? btn('Geri çek', { icon: ICONS.undo, onClick: () => doSimple(d, 'geri-cek') }) : null,
        iz.devret ? btn('Devret', { icon: ICONS.transfer, onClick: () => doTransfer(d) }) : null,
        iz.iptal ? btn('İptal et', { icon: ICONS.ban, kind: 'danger-ghost', onClick: () => doSimple(d, 'iptal') }) : null,
        d.durum === 'onaylandi' || d.durum === 'odendi' ? btn('Onay belgesi (PDF)', { icon: ICONS.download, onClick: (e) => downloadPdf(d, e.currentTarget) }) : null,
      ].filter(Boolean);
      if (buttons.length === 0) return null;
      let lead = null;
      let warnLead = false;
      const missing = iz.gonder ? missingEquivalents(d).length : 0;
      if (iz.onayla || iz.reddet) lead = 'Sıra sizde: bu masrafı inceleyip onaylayın ya da reddedin.';
      else if (iz.odendi) lead = 'Masraf onaylandı; ödeme yapıldığında işaretleyin.';
      else if (blocked) {
        lead = sendBlockedText(d, reading, failed);
        warnLead = failed > 0 || (pend.length === 0 && noAmount(d));
      } else if (needsFix) {
        // Missing fields come first (the server checks them first); a missing equivalent is said too,
        // so the user sees everything that stands between the form and sending it.
        const gaps = [
          ...formGaps.map((k) => fieldLabel(k, { lower: true })),
          ...incomplete.map((x) => `${x.n}. fatura: ${x.gone.map((k) => fieldLabel(k, { lower: true })).join(', ')}`),
        ];
        const text = `Onaya göndermeden önce eksik bilgileri tamamlayın: ${gaps.join('; ')}.`;
        lead = [d.durum === 'reddedildi' ? 'Masraf reddedildi.' : null, text, missing > 0 ? missingLead(missing) : null].filter(Boolean).join(' ');
        warnLead = true;
      } else if (missing > 0) lead = d.durum === 'reddedildi' ? `Masraf reddedildi. ${missingLead(missing)}` : missingLead(missing);
      else if (iz.gonder && d.durum === 'reddedildi') lead = 'Masraf reddedildi. Düzenleyip yeniden gönderebilirsiniz.';
      else if (iz.gonder) lead = 'Masraf taslak. Hazır olduğunda onaya gönderin.';
      else if (iz.geriCek) {
        const waiting = (d.onaylar ?? []).find((s) => s.durum === 'bekliyor');
        lead = waiting?.onayci?.adSoyad
          ? `${waiting.onayci.adSoyad} kararını bekliyor. Geri çekerseniz masraf taslağa döner.`
          : 'Masraf onayda. Geri çekerseniz taslağa döner.';
      } else if (iz.devret) lead = 'Onaycı karar veremiyorsa onayı başka birine devredebilirsiniz.';
      return el(
        'div',
        { className: `action-bar${iz.onayla ? ' is-turn' : ''}`, role: 'group', 'aria-label': 'İşlemler' },
        lead ? el('p', { className: warnLead ? 'action-lead warn' : 'action-lead', id: leadId, text: lead }) : null,
        el('div', { className: 'action-buttons' }, ...buttons),
      );
    }

    // ---------- Files still being read (bekleyenFaturalar) ----------

    function pendingItem(b, d) {
      const failed = b.durum === 'hata';
      return el(
        'li',
        { className: 'pend-item', 'data-state': b.durum, 'data-hash': b.dosyaOzeti },
        failed
          ? el('span', { className: 'pend-glyph', 'aria-hidden': 'true' }, icon(ICONS.alert))
          : el('span', { className: `sheet-glyph${b.durum === 'okunuyor' ? ' active' : ''}`, 'aria-hidden': 'true' }, el('span', { className: 'scan' })),
        el(
          'div',
          { className: 'pend-text' },
          el('p', { className: 'pend-name', text: b.dosyaAdi || 'Fatura' }),
          el('p', { className: 'pend-status', text: pendingStatus(b) }),
          // Its receipt fields can be filled before the read ends (on the edit page).
          fisFacts(b, d.izinler?.duzenle ? `#/masraflar/${d.id}/duzenle` : null),
        ),
      );
    }

    /** The "send when read" option: a switch for the owner while the form can be edited, a note for everyone else. */
    function sendWhenReadBlock(d) {
      if (d.izinler?.duzenle) {
        const sw = el(
          'button',
          { className: 'switch', type: 'button', role: 'switch', id: 'okg-switch', 'aria-checked': String(Boolean(d.okununcaGonder)), 'aria-labelledby': 'okg-l', 'aria-describedby': 'okg-d' },
          el('span', { className: 'switch-knob', 'aria-hidden': 'true' }),
        );
        sw.addEventListener('click', () => toggleSendWhenRead(d, sw));
        return el(
          'div',
          { className: 'pref-row okg-row' },
          el(
            'div',
            {},
            el('p', { className: 'pref-label', id: 'okg-l', text: 'Okumalar bitince onaya gönder' }),
            el('p', { className: 'muted small', id: 'okg-d', text: 'Bütün faturalar okununca masraf kendiliğinden onaya gönderilir. Gönderilemezse nedeniyle birlikte bildirim gelir.' }),
          ),
          sw,
        );
      }
      if (!d.okununcaGonder) return null;
      return el('p', { className: 'inv-card-note' }, icon(ICONS.send), el('span', { text: 'Okumalar bitince onaya gönderilecek.' }));
    }

    function pendingSection(d) {
      const list = pendingOf(d);
      if (list.length === 0) return null;
      const failed = list.filter((b) => b.durum === 'hata').length;
      const reading = list.length - failed;
      const lead =
        reading > 0
          ? 'Faturalar arka planda okunuyor; bu sayfadan çıkabilirsiniz. Okunan fatura masrafa eklenir, hepsi bitince size bildirim gelir.'
          : 'Okunamayan faturaları yeniden okutun ya da masrafı düzenleyip çıkarın; sonra onaya gönderebilirsiniz.';
      const edit = d.izinler?.duzenle;
      return el(
        'section',
        { className: 'card pend-card', 'aria-labelledby': 'pend-title' },
        el('div', { className: 'card-head' }, el('h2', { className: 'card-title', id: 'pend-title', text: 'Okunmayı bekleyen faturalar' }), el('span', { className: 'tag', text: `${fmtCount(list.length)} fatura` })),
        el('p', { className: 'muted small pend-lead', text: lead }),
        el('ul', { className: 'pend-list', role: 'list' }, ...list.map((b) => pendingItem(b, d))),
        edit && failed > 0
          ? el(
              'div',
              { className: 'inv-actions' },
              btn(failed > 1 ? 'Okunamayanları yeniden oku' : 'Yeniden oku', { icon: ICONS.refresh, size: 'sm', onClick: (e) => doReread(d, e.currentTarget) }),
              btn('Düzenle', { icon: ICONS.edit, size: 'sm', href: `#/masraflar/${d.id}/duzenle` }),
            )
          : null,
        sendWhenReadBlock(d),
      );
    }

    // ---------- Sections ----------

    /** The form's cost centre; an empty one the server reports missing is marked (with a link for the owner). */
    function costCentreRow(d) {
      const mm = d.masrafMerkezi;
      if (mm) {
        return kv('Masraf merkezi', el('span', { className: 'with-tag' }, el('span', { text: mm.gosterim ?? mm.kod }), mm.aktif === false ? el('span', { className: 'tag off', text: 'Pasif' }) : null));
      }
      if (!(Array.isArray(d.eksikAlanlar) && d.eksikAlanlar.includes('masrafMerkezi'))) return null;
      const dd = d.izinler?.duzenle
        ? el('dd', {}, el('a', { className: 'missing-link', href: `#/masraflar/${d.id}/duzenle`, text: 'Seçilmedi', 'aria-label': 'Masraf merkezi seçilmedi; düzenleyip seçin' }))
        : el('dd', { text: 'Seçilmedi' });
      return el('div', { className: 'is-missing' }, el('dt', { text: 'Masraf merkezi' }), dd);
    }

    function infoCard(d) {
      const foreign = d.paraBirimi && d.paraBirimi !== base;
      const onay = d.onayTutari !== null && d.onayTutari !== undefined && d.onayTutari !== d.yerelTutar ? fmtCurrency(d.onayTutari, base) : null;
      const org = d.organizasyon;
      return el(
        'section',
        { className: 'card', 'aria-labelledby': 'info-title' },
        el('h2', { className: 'card-title', id: 'info-title', text: 'Bilgiler' }),
        el(
          'dl',
          { className: 'kv' },
          kv('Kategori', d.kategori ? el('span', { className: 'with-icon' }, categoryIcon(d.kategori.simge), el('span', { text: d.kategori.ad })) : 'Kategorisiz'),
          costCentreRow(d),
          org ? kv('Organizasyon', el('span', { className: 'with-tag' }, el('span', { text: org.ad || org.kod, title: org.kod || null }), org.aktif === false ? el('span', { className: 'tag off', text: 'Pasif' }) : null)) : null,
          kv('Masraf tarihi', fmtDateLong(d.masrafTarihi)),
          kv('Tutar', noAmount(d) ? (pendingOf(d).length > 0 ? 'Girilmedi; faturalar okununca dolacak' : 'Girilmedi') : fmtCurrency(d.tutar, d.paraBirimi)),
          foreign && d.kur !== null && d.kur !== undefined ? kv('Kur', `1 ${d.paraBirimi} = ${fmtRateInput(d.kur)} ${base}`) : null,
          foreign ? kv('Yerel tutar', fmtCurrency(d.yerelTutar, base)) : null,
          onay ? kv('Onay tutarı', onay) : null,
          kv('Satıcı', d.satici),
          kv('Oluşturan', d.olusturan?.adSoyad),
          kv('Oluşturma', fmtDateTime(d.olusturma)),
          kv('Gönderim', fmtDateTime(d.gonderim)),
          kv('Sonuçlanma', eventText(d.sonuclanma)),
          kv('Ödeme', eventText(d.odeme)),
          d.tur > 1 ? kv('Onay turu', `${d.tur}. tur`) : null,
          kv('Açıklama', d.aciklama, { wide: true }),
        ),
      );
    }

    /** Every header field of the valid data (a correction wins over the read value), then the lines. */
    function invoiceFacts(f, compact) {
      const gone = Array.isArray(f.eksikAlanlar) ? f.eksikAlanlar : missingOf(f);
      const rows = HEADER_FIELDS.map((def) => {
        const missing = gone.includes(def.key);
        const text = def.key === 'genelToplam' || def.key === 'araToplam' || def.key === 'kdvToplam' ? fmtCurrency(f[def.key], f.paraBirimi) : showValue(def.key, f[def.key], f.paraBirimi);
        if (!missing && !text) return null;
        const dd = missing
          ? detail?.izinler?.duzenle
            ? el('dd', {}, el('a', { className: 'missing-link', href: fixHref(detail, f.id), text: 'Eksik', 'aria-label': `${def.label} eksik; düzenleyip doldurun` }))
            : el('dd', { text: 'Eksik' })
          : el('dd', { text });
        return el('div', { className: missing ? 'is-missing' : null }, el('dt', { text: def.label }), dd);
      });
      return el('dl', { className: compact ? 'kv compact' : 'kv' }, ...rows.filter(Boolean));
    }

    const LINE_HEADS = [
      ['aciklama', 'Açıklama', false],
      ['miktar', 'Miktar', true],
      ['birim', 'Birim', false],
      ['birimFiyat', 'Birim fiyat', true],
      ['kdvOrani', 'KDV %', true],
      ['tutar', 'Tutar', true],
    ];

    function linesTable(f) {
      const lines = Array.isArray(f.kalemler) ? f.kalemler : [];
      if (lines.length === 0) return null;
      return el(
        'details',
        { className: 'inv-lines' },
        el('summary', {}, icon(ICONS.chevronDown), el('span', { text: `Kalemler (${lines.length})` })),
        el(
          'div',
          { className: 'table-scroll' },
          el(
            'table',
            { className: 'data-table lines-table' },
            el('caption', { className: 'visually-hidden', text: 'Fatura kalemleri' }),
            el('thead', {}, el('tr', {}, ...LINE_HEADS.map(([, label, num]) => el('th', { scope: 'col', className: num ? 'num' : null, text: label })))),
            el(
              'tbody',
              {},
              ...lines.map((l) =>
                el(
                  'tr',
                  {},
                  ...LINE_HEADS.map(([key, label, num]) => el('td', { className: num ? 'num' : null, 'data-label': label, text: showValue(key, l[key], f.paraBirimi) ?? '—' })),
                ),
              ),
            ),
          ),
        ),
      );
    }

    /** "Düzeltildi" badge and the differing fields, read value next to valid value. */
    function correctionBlock(f) {
      if (!f.duzeltildi) return null;
      const table = f.okunan ? compareView(f.okunan, { fatura: f, kalemler: f.kalemler }) : null;
      return el(
        'details',
        { className: 'inv-compare', open: true },
        el('summary', {}, icon(ICONS.chevronDown), el('span', { text: 'Okunan ve düzeltilmiş değerler' })),
        table ?? el('p', { className: 'muted small', text: 'Okunan değerlerden farklı alan yok.' }),
      );
    }

    const correctedTag = (f) => (f.duzeltildi ? el('span', { className: 'tag accent', text: 'Düzeltildi' }) : null);

    const filePreview = (f) => invoicePreview({ url: api.invoiceFileUrl(f.id), mime: f.mime, name: f.dosyaAdi });

    /** In a list the file loads only when its preview is opened. */
    function lazyPreview(f, name) {
      const slot = el('div', { className: 'inv-preview-body' });
      const details = el('details', { className: 'inv-preview' }, el('summary', {}, icon(ICONS.chevronDown), el('span', { text: 'Önizleme' }), el('span', { className: 'visually-hidden', text: `: ${name}` })), slot);
      details.addEventListener('toggle', () => {
        if (details.open && !slot.firstChild) slot.append(filePreview(f));
      });
      return details;
    }

    /** The invoices' total in the form's currency: equivalents and base-currency invoices converted by the rate. */
    function invoiceSum(d, list) {
      const total = invoiceTotalOf(d, base);
      const left = list.length - total.count;
      return el(
        'div',
        { className: 'inv-sum' },
        el(
          'p',
          { className: 'inv-sum-line' },
          el('span', { text: total.count > 0 ? `Faturaların toplamı · ${total.count} fatura` : 'Toplanacak fatura yok' }),
          el('strong', { text: total.count > 0 ? fmtCurrency(total.value, d.paraBirimi) : '—' }),
        ),
        left > 0 ? el('p', { className: 'inv-sum-note', text: `${left} fatura onay tutarına katılmıyor; nedeni altında yazıyor.` }) : null,
      );
    }

    function invoiceCard(d) {
      const list = invoicesOf(d);
      const title = el('h2', { className: 'card-title', id: 'inv-title', text: list.length > 1 ? 'Faturalar' : 'Fatura' });
      // Every file is still being read: the section above says so; read ones appear here.
      if (list.length === 0 && pendingOf(d).length > 0) return null;
      if (list.length === 0) {
        return el(
          'section',
          { className: 'card', 'aria-labelledby': 'inv-title' },
          title,
          el('p', { className: 'muted', text: 'Bu masrafa fatura eklenmemiş.' }),
          d.izinler?.duzenle ? btn('Fatura ekle', { icon: ICONS.upload, href: `#/masraflar/${d.id}/duzenle` }) : null,
        );
      }
      if (list.length === 1) {
        const f = list[0];
        return el(
          'section',
          { className: 'card', 'aria-labelledby': 'inv-title' },
          el('div', { className: 'card-head' }, el('div', { className: 'head-tags' }, title, correctedTag(f)), el('a', { className: 'card-link', href: `#/okuma/${encodeURIComponent(f.id)}`, text: 'Okunan faturayı aç' })),
          invoiceFacts(f, false),
          fisFacts(f, d.izinler?.duzenle ? fixHref(d, f.id) : null),
          invoiceNote(f, d, base),
          linesTable(f),
          correctionBlock(f),
          f.dosyaVar ? filePreview(f) : el('p', { className: 'muted', text: 'Bu faturanın orijinal dosyası saklanmamış.' }),
        );
      }
      const items = list.map((f, i) => {
        const name = f.dosyaAdi || (f.faturaNo ? `Fatura ${f.faturaNo}` : `${i + 1}. fatura`);
        return el(
          'li',
          { className: 'inv-item' },
          el(
            'div',
            { className: 'inv-item-head' },
            el('span', { className: 'inv-n', 'aria-hidden': 'true' }),
            el('p', { className: 'inv-item-title', text: name }),
            correctedTag(f),
            el('a', { className: 'card-link', href: `#/okuma/${encodeURIComponent(f.id)}`, text: 'Okunan faturayı aç', 'aria-label': `Okunan faturayı aç: ${name}` }),
          ),
          invoiceFacts(f, true),
          fisFacts(f, d.izinler?.duzenle ? fixHref(d, f.id) : null),
          invoiceNote(f, d, base),
          linesTable(f),
          correctionBlock(f),
          f.dosyaVar ? lazyPreview(f, name) : el('p', { className: 'muted small', text: 'Bu faturanın orijinal dosyası saklanmamış.' }),
        );
      });
      return el(
        'section',
        { className: 'card', 'aria-labelledby': 'inv-title' },
        el('div', { className: 'card-head' }, title, el('span', { className: 'tag', text: `${list.length} fatura` })),
        el('ol', { className: 'inv-items', role: 'list' }, ...items),
        invoiceSum(d, list),
      );
    }

    function stepsCard(d) {
      const steps = d.onaylar ?? [];
      const card = el(
        'section',
        { className: 'card', 'aria-labelledby': 'steps-title' },
        el('div', { className: 'card-head' }, el('h2', { className: 'card-title', id: 'steps-title', text: 'Onay adımları' }), d.tur > 1 ? el('span', { className: 'tag', text: `${d.tur}. tur` }) : null),
      );
      if (steps.length === 0) {
        if (d.izinler?.gonder && noAmount(d)) {
          card.append(el('p', { className: 'muted', text: 'Henüz onaya gönderilmedi. Tutar dolunca masrafın gideceği onaycılar burada görünür.' }));
        } else if (d.izinler?.gonder) {
          const slot = el('div', { className: 'chain-slot', 'aria-live': 'polite' }, el('p', { className: 'muted', text: 'Onaycılar hesaplanıyor…' }));
          card.append(slot);
          api.previewFlow(previewBody(d), { signal }).then((p) => {
            if (!slot.isConnected || !p.ok) {
              if (slot.isConnected) slot.replaceChildren(el('p', { className: 'muted', text: 'Henüz onaya gönderilmedi.' }));
              return;
            }
            slot.replaceChildren(el('p', { className: 'muted', text: chainLead(p.body, 'gönderildiğinde şu onaycılara sırayla gidecek:') }), approverChain(p.body));
          });
        } else {
          card.append(el('p', { className: 'muted', text: 'Henüz onaya gönderilmedi.' }));
        }
        return card;
      }
      const list = el('ol', { className: 'timeline' });
      for (const s of steps) {
        const st = STEP_STATUS[s.durum] ?? { label: humanize(s.durum), tone: 'muted', icon: ICONS.info };
        list.append(
          el(
            'li',
            { className: `tl-item ${st.tone}`, 'data-state': s.durum },
            el('span', { className: 'tl-dot', 'aria-hidden': 'true' }, icon(st.icon)),
            el(
              'div',
              { className: 'tl-body' },
              el(
                'p',
                { className: 'tl-title' },
                el('strong', { text: s.onayci?.adSoyad ?? 'Onaycı' }),
                s.yedek ? el('span', { className: 'tag', text: 'Yedek yönetici' }) : null,
                statusBadge(s.durum, { map: STEP_STATUS, className: 'sm' }),
              ),
              el('p', { className: 'tl-meta', text: [`${s.sira}. adım`, s.yedek ? null : `Aralık: ${bandText(s.altLimit, s.ustLimit, base).toLocaleLowerCase('tr-TR')}`, s.kararTarihi ? fmtDateTime(s.kararTarihi) : null].filter(Boolean).join(' · ') }),
              s.aciklama ? el('blockquote', { className: 'tl-note', text: s.aciklama }) : null,
            ),
          ),
        );
      }
      card.append(list);
      return card;
    }

    function historyCard(d) {
      const items = d.gecmis ?? [];
      if (items.length === 0) return null;
      const list = el('ol', { className: 'history-list' });
      for (const h of items) {
        list.append(
          el(
            'li',
            { className: HISTORY_TONE[h.islem] ?? '' },
            el('span', { className: 'hl-dot', 'aria-hidden': 'true' }),
            el(
              'div',
              {},
              // kullanici null: the server itself (a file read in the background, "send when read").
              el('p', { className: 'hl-title' }, el('strong', { text: HISTORY_LABEL[h.islem] ?? humanize(h.islem) }), el('span', { text: ` · ${h.kullanici?.adSoyad ?? 'Sistem'}` })),
              el('p', { className: 'hl-time' }, el('time', { datetime: h.tarih, title: fmtDateTime(h.tarih), text: fmtRelative(h.tarih) ?? '' })),
              h.aciklama ? el('p', { className: 'hl-note', text: h.aciklama }) : null,
            ),
          ),
        );
      }
      return el('section', { className: 'card', 'aria-labelledby': 'hist-title' }, el('h2', { className: 'card-title', id: 'hist-title', text: 'Geçmiş' }), list);
    }

    function render(d) {
      detail = d;
      drawn++;
      const hadFocus = page.contains(document.activeElement) && document.activeElement.tagName === 'H1';
      setPageTitle(d.baslik);
      window.dispatchEvent(new CustomEvent('nav-highlight', { detail: backFor(d).href.slice(1) }));
      const foreign = d.paraBirimi && d.paraBirimi !== base && d.yerelTutar !== null && d.yerelTutar !== undefined;

      let rejection = null;
      if (d.durum === 'reddedildi') {
        const step = (d.onaylar ?? []).find((s) => s.durum === 'reddedildi');
        if (step) rejection = alertBox('err', `${step.onayci?.adSoyad ?? 'Onaycı'} masrafı reddetti`, [step.aciklama ? `Neden: ${step.aciklama}` : null]);
      }
      const many = invoicesOf(d).length > 1;
      let diff = null;
      if (d.tutarFarki) {
        // Both figures are in the form's own currency (contract: tutarFarki). `fatura` is the total of
        // the invoices that count, base-currency amounts and equivalents converted with the form's rate.
        const cur = d.paraBirimi ?? base;
        const money = (v) => fmtCurrency(v, cur);
        const larger = money(Math.max(d.tutarFarki.fatura, d.tutarFarki.beyan));
        const converted = cur !== base && invoicesOf(d).some((f) => f.karsilikGerekli || f.paraBirimi === base);
        diff = alertBox('warn', many ? 'Beyan edilen tutar faturalardan farklı' : 'Beyan edilen tutar faturadan farklı', [
          `${many ? 'Faturaların toplamı' : 'Faturanın tutarı'} ${money(d.tutarFarki.fatura)}, beyan edilen tutar ${money(d.tutarFarki.beyan)}.${converted ? ` ${base} tutarlar masrafın kuruyla ${cur} karşılığına çevrildi.` : ''}`,
          d.onayTutari !== null && d.onayTutari !== undefined
            ? `Onay tutarı ikisinden büyük olan ${larger} üzerinden belirlendi.`
            : `Onaya gönderildiğinde ikisinden büyük olan ${larger} esas alınır.`,
        ]);
      }

      page.replaceChildren(...[
        pageHead({
          back: backFor(d),
          eyebrow: `#${d.id}${d.kategori ? ` · ${d.kategori.ad}` : ''}`,
          title: d.baslik,
          sub: el(
            'p',
            { className: 'page-sub with-badge' },
            statusBadge(d.durum),
            el('span', {
              text: [
                d.olusturan?.adSoyad,
                d.organizasyon ? d.organizasyon.ad || d.organizasyon.kod : null,
                d.masrafMerkezi ? `Masraf merkezi ${d.masrafMerkezi.gosterim ?? d.masrafMerkezi.kod}` : null,
                fmtDateLong(d.masrafTarihi),
              ]
                .filter(Boolean)
                .join(' · '),
            }),
          ),
          actions: [
            el(
              'div',
              { className: 'head-amount' },
              noAmount(d)
                ? el('span', { className: 'amount-main is-empty', text: pendingOf(d).length > 0 ? 'Tutar okununca dolacak' : 'Tutar girilmedi' })
                : el('span', { className: 'amount-main', text: fmtCurrency(d.tutar, d.paraBirimi) ?? '—' }),
              foreign ? el('span', { className: 'amount-local', text: `≈ ${fmtCurrency(d.yerelTutar, base)}` }) : null,
            ),
          ],
        }),
        actionBar(d),
        rejection,
        diff,
        el(
          'div',
          { className: 'detail-grid' },
          el('div', { className: 'detail-col' }, infoCard(d), pendingSection(d), invoiceCard(d)),
          el('div', { className: 'detail-col' }, stepsCard(d), historyCard(d)),
        ),
      ].filter(Boolean)); // native replaceChildren would print "null" for the missing parts
      if (hadFocus) page.querySelector('h1')?.focus();
      schedulePoll(d);
    }

    load();
    return {
      unmount() {
        clearTimeout(pollTimer);
        pollTimer = null;
        detail = null;
      },
    };
  },
};
