// Yeni masraf (#/masraflar/yeni, optionally ?fatura=<record id>) and Masrafı düzenle
// (#/masraflar/:id/duzenle). A form holds up to 20 invoices, each in its own card with its own
// reading state. Every chosen, dropped or pasted file is read through the usual reading flow
// (POST /api/invoices; X-Fatura-Id is the record id). The first invoice read fills the fields the
// user has not typed, and until the user types an amount it is the invoices' total in the form's
// currency (equivalents.js). An invoice in a third currency (neither the form's nor the base one) asks
// for its base-currency equivalent; without it the expense can be saved as a draft but not sent.
// While the amount or the invoices change, POST /api/onay-akisi/onizle shows who the expense would
// go to.

import * as api from '../api.js';
import { el, icon, ICONS, replay } from '../dom.js';
import { fmtAmountInput, fmtCount, fmtCurrency, fmtDateLong, fmtRateInput, modelName, parseAmount, toCents, todayIso } from '../format.js';
import { approverChain, chainLead, expenseHref, invoicePreview } from '../expense-ui.js';
import { invoicesTotal, needsEquivalent } from '../equivalents.js';
import { editInvoiceDialog, labelOf, missingOf, pathLabel, pickInvoice, sameInvoice } from '../invoice-edit.js';
import { sniffType, typedObjectUrl } from '../files.js';
import { totalChecks } from '../invoice.js';
import { categoryIcon } from '../labels.js';
import { navigate } from '../router.js';
import * as session from '../session.js';
import {
  alertBox,
  applyFieldErrors,
  btn,
  clearFieldErrors,
  confirmDialog,
  debounce,
  field,
  fieldset,
  input,
  loadFailed,
  pageHead,
  select,
  setBusy,
  setFieldError,
  setFileTarget,
  setPageTitle,
  textarea,
  tickClocks,
  toast,
} from '../ui.js';
import { rememberSent, watchTag } from './okuma.js';

const ACCEPT = 'application/pdf,image/png,image/jpeg,image/webp,image/gif';
const CURRENCIES = ['TRY', 'USD', 'EUR', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD', 'SAR', 'AED', 'RUB', 'CNY'];
// Sending these again gives the same answer, so they get no retry button.
const FINAL_ERRORS = new Set(['desteklenmeyen_dosya', 'dosya_cok_buyuk']);
// docs/onay-sistemi.md, section 3: at most 20 invoices on one form, each once.
const MAX_INVOICES = 20;
// A read keeps its request open until Claude is done, and the browser opens at most six
// connections to one origin. Four reads at a time leave room for the live stream, the approver
// preview and saving. The server still decides the reading order (CLAUDE_MAX_CONCURRENT is 1–4).
const MAX_PARALLEL_READS = 4;

let currencyNames = null;
try {
  currencyNames = new Intl.DisplayNames(['tr'], { type: 'currency' });
} catch {
  currencyNames = null;
}
const currencyLabel = (code) => {
  const name = currencyNames?.of(code);
  return name && name !== code ? `${code} · ${name}` : code;
};

const RATE = { decimals: 6, dotThousands: false };

function kv(label, value) {
  if (value === null || value === undefined || value === '') return null;
  return el('div', {}, el('dt', { text: label }), el('dd', { text: value }));
}

function activityText(a) {
  if (!a) return 'Gönderiliyor…';
  if (a.durum === 'sirada') return 'Sırada; boş bir okuma hattı bekleniyor.';
  if (a.durum === 'okunuyor') {
    if (!a.model) return 'Claude okumaya başlıyor.';
    if ((a.modeller?.length ?? 0) > 1) return `Kontroller tutmadı; ${modelName(a.model)} yeniden okuyor.`;
    return `${modelName(a.model)} okuyor.`;
  }
  if (a.durum === 'bitti') return 'Okundu; sonuç geliyor.';
  if (a.durum === 'hata') return a.hata?.mesaj ?? 'Okunamadı.';
  return 'Okunuyor…';
}

const readingText = (card) => (card.waiting ? 'Sırada; önceki faturalar gönderiliyor.' : activityText(card.activity));

const hasTotal = (f) => typeof f?.genelToplam === 'number' && Number.isFinite(f.genelToplam) && f.genelToplam > 0;

const isReady = (card) => card.kind === 'done' || card.kind === 'linked';
const isPending = (card) => card.kind === 'reading' || card.kind === 'loading';

function sameList(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Same keys with the same amounts (to the cent). */
function sameAmounts(a, b) {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => k in b && toCents(a[k]) === toCents(b[k]));
}

export const expenseFormView = {
  mount(root, { route, signal }) {
    const editing = route.name === 'masraf-duzenle';
    const id = editing ? route.params.id : null;
    const fromInvoice = editing ? null : route.query.get('fatura');
    const focusInvoice = editing ? route.query.get('fatura') : null; // opens that invoice's editor

    let alive = true;
    let base = session.knownBaseCurrency() ?? 'TRY';
    let detail = null;
    let categories = [];
    let dirty = false;
    let busy = false;
    let previewToken = 0;
    const objectUrls = new Set();
    const touched = new Set();

    // ---------- Invoice state ----------
    // cards: the form's invoices in list order, which is the order they are saved in (faturaIdler).
    // kind: 'loading' (a ?fatura= record being fetched) | 'reading' | 'error' | 'done' (read here) |
    // 'linked' (already on the saved form). Each card keeps its own read token, an AbortController
    // for its request (abort) and, while its file is being sent, one of the read slots (slot).
    const cards = [];
    let cardSeq = 0;
    let readSeq = 0;
    let readsInFlight = 0;
    const readQueue = [];
    let fillSource = null; // the card whose date, vendor, title and currency went into the form
    let amountAuto = false; // the amount field holds the invoices' total rather than a typed amount
    const autoFilled = new Map(); // control name -> label, for fields that hold a value from the invoices
    let amountCleared = false; // the invoices' total went away, so the amount was emptied
    let sentCards = []; // ready cards in the order of the last save, for alanlar["faturaIdler.<i>"]

    const readyCards = () => cards.filter(isReady);

    const page = el('div', { className: 'page wide' });
    const content = el('div', { className: 'form-skeleton', role: 'status', 'aria-label': 'Yükleniyor' }, el('span'), el('span'), el('span'));
    page.append(
      pageHead({
        title: editing ? 'Masrafı düzenle' : 'Yeni masraf',
        sub: editing ? 'Taslak ve reddedilmiş masraflar düzenlenebilir.' : 'Faturaları yükleyin; tutar, tarih ve satıcı kendiliğinden dolsun. Faturasız masraf da girebilirsiniz.',
        back: editing ? { href: expenseHref(id), label: 'Masrafa dön' } : { href: '#/masraflar', label: 'Masraflarım' },
      }),
      content,
    );
    root.append(page);

    // ---------- Controls ----------

    const controls = {
      baslik: input({ name: 'baslik', maxlength: 120, autocomplete: 'off', required: true, placeholder: 'Örn. Müşteri yemeği' }),
      masrafTarihi: input({ type: 'date', name: 'masrafTarihi', max: todayIso(), required: true }),
      tutar: input({ name: 'tutar', inputmode: 'decimal', autocomplete: 'off', placeholder: '0,00', required: true, className: 'input num' }),
      paraBirimi: select(
        CURRENCIES.map((c) => ({ value: c, label: currencyLabel(c) })),
        { name: 'paraBirimi' },
      ),
      kur: input({ name: 'kur', inputmode: 'decimal', autocomplete: 'off', placeholder: '0,00', className: 'input num' }),
      satici: input({ name: 'satici', maxlength: 200, autocomplete: 'off' }),
      aciklama: textarea({ name: 'aciklama', rows: 3, maxlength: 1000, placeholder: 'Örn. ABC firmasıyla proje toplantısı' }),
    };
    const catGrid = el('div', { className: 'cat-grid' });
    const catFieldset = fieldset({ legend: 'Kategori', content: catGrid, id: 'masraf-kategori' });
    const kurHint = el('span');
    const kurField = field({ label: 'Kur', input: controls.kur, hint: kurHint, className: 'kur-field' });
    const fieldTargets = { ...controls, kategoriId: catFieldset };

    const summary = el('div', { className: 'form-alert', tabindex: '-1' });
    const approversBody = el('div', { className: 'approvers-body', 'aria-live': 'polite' });
    const readingHint = el('p', { className: 'form-hint', id: 'save-hint', hidden: true });
    const saveBtn = btn(editing ? 'Kaydet' : 'Taslak kaydet', { icon: ICONS.check, type: 'submit' });
    let sendBtn = null;

    const fileInput = el('input', { type: 'file', accept: ACCEPT, multiple: true, hidden: true });
    const invCount = el('span', { className: 'muted small inv-count' });
    const invAlert = el('div', { className: 'inv-alert', tabindex: '-1' });
    const invDrop = dropZone();
    const invList = el('ol', { className: 'inv-list', role: 'list', 'aria-labelledby': 'inv-h', hidden: true });
    const invSum = el('div', { className: 'inv-sum', hidden: true });
    const addBtn = btn('Fatura ekle', { icon: ICONS.plus, size: 'sm', onClick: () => fileInput.click() });
    const addText = el('p', { className: 'inv-add-text' });
    const invAdd = el('div', { className: 'inv-add', hidden: true }, addBtn, addText);
    const invNote = el('div', { className: 'inv-note', 'aria-live': 'polite' });
    const invLive = el('p', { className: 'visually-hidden', role: 'status' });
    const invPanel = el(
      'section',
      { className: 'card inv-panel', 'aria-labelledby': 'inv-h' },
      el('div', { className: 'card-head' }, el('h2', { className: 'card-title', id: 'inv-h', text: 'Faturalar' }), invCount),
      invAlert,
      invDrop,
      invList,
      invSum,
      invAdd,
      invNote,
      invLive,
      fileInput,
    );

    function ensureCurrencyOption(code) {
      if (!code || !/^[A-Z]{3}$/.test(code)) return;
      if (![...controls.paraBirimi.options].some((o) => o.value === code)) controls.paraBirimi.append(el('option', { value: code, text: currencyLabel(code) }));
    }

    function setCategory(catId) {
      for (const r of catGrid.querySelectorAll('input[type="radio"]')) r.checked = String(catId) === r.value;
    }

    function markDirty() {
      dirty = true;
    }

    /** A short message for screen readers (reads finishing, cards going away). */
    function say(text) {
      invLive.textContent = text;
    }

    // ---------- Build ----------

    function build() {
      catGrid.replaceChildren(
        ...categories.map((c) =>
          el(
            'label',
            { className: `cat-option${c.aktif === false ? ' inactive' : ''}` },
            el('input', { type: 'radio', name: 'kategoriId', value: c.id }),
            categoryIcon(c.simge),
            el('span', { className: 'cat-name', text: c.ad }),
          ),
        ),
      );
      if (categories.length === 0) catGrid.append(el('p', { className: 'muted', text: 'Tanımlı kategori yok. Yöneticinizden kategori eklemesini isteyin.' }));

      ensureCurrencyOption(base);
      controls.paraBirimi.value = base;

      if (!editing || detail?.izinler?.gonder) {
        sendBtn = btn(editing ? 'Kaydet ve onaya gönder' : 'Onaya gönder', { icon: ICONS.send, kind: 'primary', onClick: () => submit(true), attrs: { 'aria-describedby': 'save-hint' } });
      }

      const form = el(
        'form',
        { className: 'exp-form', novalidate: true },
        el(
          'div',
          { className: 'form-grid' },
          invPanel,
          el(
            'div',
            { className: 'form-main' },
            summary,
            el(
              'section',
              { className: 'card', 'aria-labelledby': 'fields-h' },
              el('h2', { className: 'card-title', id: 'fields-h', text: 'Masraf bilgileri' }),
              field({ label: 'Başlık', input: controls.baslik, hint: 'En çok 120 karakter.' }),
              catFieldset,
              el(
                'div',
                { className: 'field-row money-row' },
                field({ label: 'Masraf tarihi', input: controls.masrafTarihi, className: 'date-field' }),
                field({ label: 'Tutar', input: controls.tutar }),
                field({ label: 'Para birimi', input: controls.paraBirimi, className: 'cur-field' }),
              ),
              kurField,
              field({ label: 'Satıcı', input: controls.satici, optional: true }),
              field({ label: 'Açıklama', input: controls.aciklama, optional: true }),
            ),
            el('section', { className: 'card approvers', 'aria-labelledby': 'approvers-h' }, el('h2', { className: 'card-title', id: 'approvers-h', text: 'Onaycılar' }), approversBody),
            el(
              'div',
              { className: 'form-actions' },
              readingHint,
              el('div', { className: 'form-buttons' }, btn('Vazgeç', { kind: 'ghost', href: editing ? expenseHref(id) : '#/masraflar' }), saveBtn, sendBtn),
            ),
          ),
        ),
      );

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        submit(false);
      });
      for (const [name, c] of Object.entries(controls)) {
        c.addEventListener('input', () => {
          touched.add(name);
          markDirty();
          setFieldError(c, null);
          if (name === 'tutar') {
            amountAuto = false;
            amountCleared = false;
          }
          if (autoFilled.delete(name)) renderNotes();
          if (name === 'tutar' || name === 'kur' || name === 'paraBirimi') {
            if (name === 'paraBirimi') {
              updateCurrencyUi();
              currencyChanged();
            } else if (name === 'kur') currencyChanged();
            else updateLocalHint();
            schedulePreview();
          }
        });
      }
      controls.tutar.addEventListener('blur', () => {
        const p = parseAmount(controls.tutar.value);
        if (!p.error && p.value !== null) controls.tutar.value = fmtAmountInput(p.value);
      });
      controls.tutar.addEventListener('change', renderNotes);
      controls.kur.addEventListener('blur', () => {
        const p = parseAmount(controls.kur.value, RATE);
        if (!p.error && p.value !== null) controls.kur.value = fmtRateInput(p.value);
      });
      catGrid.addEventListener('change', () => {
        touched.add('kategoriId');
        markDirty();
        setFieldError(catFieldset, null);
      });
      fileInput.addEventListener('change', () => {
        const files = [...(fileInput.files ?? [])];
        fileInput.value = '';
        onFiles(files);
      });

      content.replaceWith(form);
    }

    // ---------- Currency and local amount ----------

    function updateCurrencyUi() {
      const cur = controls.paraBirimi.value;
      const foreign = cur !== base;
      kurField.hidden = !foreign;
      kurField.querySelector('label').textContent = `Kur (1 ${cur} kaç ${base}?)`;
      if (!foreign) setFieldError(controls.kur, null);
      updateLocalHint();
    }

    function localAmount() {
      const t = parseAmount(controls.tutar.value);
      if (t.error || t.value === null) return null;
      if (controls.paraBirimi.value === base) return t.value;
      const k = parseAmount(controls.kur.value, RATE);
      return k.error || !k.value ? null : Math.round(t.value * k.value * 100) / 100;
    }

    function updateLocalHint() {
      const cur = controls.paraBirimi.value;
      if (cur === base) return;
      const local = localAmount();
      kurHint.textContent = local !== null ? `Yerel tutar: ${fmtCurrency(local, base)}` : `Onay limitleri ${base} cinsindendir; kuru girin.`;
    }

    // ---------- Who it would go to ----------

    function showApprovers(kind, payload) {
      approversBody.classList.toggle('is-loading', kind === 'loading');
      if (kind === 'loading') {
        if (!approversBody.firstChild) approversBody.append(el('p', { className: 'muted', text: 'Onaycılar hesaplanıyor…' }));
        return;
      }
      if (kind === 'idle' || kind === 'error') {
        approversBody.replaceChildren(el('p', { className: 'muted', text: payload }));
        return;
      }
      const o = payload;
      const local = localAmount();
      // When the amount equals the invoices' total in the form's currency, a larger approval amount
      // is only the rate's rounding (689,23 $ × 32,5 against 22.400 ₺): nothing to explain.
      const total = invoiceTotal();
      const typed = parseAmount(controls.tutar.value);
      const same = total !== null && !typed.error && typed.value !== null && toCents(total.value) === toCents(typed.value);
      const differs = !same && o.onayTutari !== null && o.onayTutari !== undefined && local !== null && toCents(o.onayTutari) > toCents(local);
      const which = readyCards().length > 1 ? 'faturaların toplamı' : 'fatura toplamı';
      // Native replaceChildren would print "null": keep only real nodes.
      approversBody.replaceChildren(
        ...[
          o.adimlar?.length ? el('p', { className: 'approvers-lead', text: chainLead(o, 'bu masraf şu onaycılara sırayla gidecek:') }) : null,
          approverChain(o),
          !o.adimlar?.length && o.akis?.ad ? el('p', { className: 'muted small', text: `Onay akışınız: “${o.akis.ad}”.` }) : null,
          differs ? el('p', { className: 'muted small', text: `Onay tutarı ${fmtCurrency(o.onayTutari, o.paraBirimi ?? base)}: ${which} beyan edilen tutardan büyük olduğu için o esas alınır.` }) : null,
        ].filter(Boolean),
      );
    }

    async function runPreview() {
      if (!alive) return;
      const t = parseAmount(controls.tutar.value);
      const cur = controls.paraBirimi.value;
      const foreign = cur !== base;
      const k = foreign ? parseAmount(controls.kur.value, RATE) : { value: null };
      if (t.error || !t.value || t.value <= 0) {
        previewToken++;
        showApprovers('idle', 'Tutarı girdiğinizde masrafın gideceği onaycılar burada görünür.');
        return;
      }
      if (foreign && (k.error || !k.value)) {
        previewToken++;
        showApprovers('idle', 'Kur girildiğinde onaycılar gösterilir.');
        return;
      }
      const my = ++previewToken;
      showApprovers('loading');
      const body = { tutar: t.value, paraBirimi: cur };
      if (foreign) body.kur = k.value;
      const ids = readyCards().map((c) => c.id);
      if (ids.length > 0) body.faturaIdler = ids;
      const eq = equivalents().given;
      if (Object.keys(eq).length > 0) body.yerelKarsiliklar = eq;
      const fix = corrections({ forPreview: true });
      if (Object.keys(fix).length > 0) body.faturaDuzeltmeleri = fix;
      const r = await api.previewFlow(body, { signal });
      if (!alive || my !== previewToken) return;
      if (!r.ok) {
        if (!r.unauthorized && !r.aborted) showApprovers('error', r.error.mesaj);
        return;
      }
      session.setBaseCurrency(r.body.paraBirimi);
      showApprovers('ok', r.body);
    }
    const schedulePreview = debounce(runPreview, 450);

    // ---------- The invoice panel ----------

    function dropZone() {
      return el(
        'div',
        { className: 'inv-drop' },
        el('span', { className: 'sheet-glyph large', 'aria-hidden': 'true' }, el('span', { className: 'scan' })),
        el('p', { className: 'inv-drop-title', text: 'Faturaları sürükleyip bırakın' }),
        el('p', {
          className: 'inv-drop-text',
          text: `PDF ya da fotoğraf (PNG, JPEG, WEBP, GIF). Birden çok dosya seçebilirsiniz; bir masrafa en çok ${MAX_INVOICES} fatura eklenir. Ekran görüntüsünü Ctrl+V ile yapıştırabilirsiniz.`,
        }),
        btn('Dosya seç', { icon: ICONS.upload, kind: 'primary', onClick: () => fileInput.click() }),
        el('p', { className: 'inv-drop-foot', text: 'Faturasız masraf için yalnızca formu doldurun.' }),
      );
    }

    /** Empty state or list, the counter, the add row, the drop target and the save buttons. */
    function renderPanelState() {
      if (!alive) return;
      const n = cards.length;
      const full = n >= MAX_INVOICES;
      const pending = cards.filter(isPending).length;
      invDrop.hidden = n > 0;
      invList.hidden = n === 0;
      invAdd.hidden = n === 0;
      // A long list cannot stay pinned beside the form; it scrolls with the page.
      invPanel.classList.toggle('multi', n > 1);
      invCount.replaceChildren(
        n === 0
          ? document.createTextNode('İsteğe bağlı')
          : el('span', {}, el('span', { 'aria-hidden': 'true', text: `${fmtCount(n)} / ${MAX_INVOICES}` }), el('span', { className: 'visually-hidden', text: `${fmtCount(n)} fatura; en çok ${MAX_INVOICES}` })),
      );
      addBtn.disabled = full || busy;
      // While the expense is being saved the invoice list is fixed: no adding, removing or retrying.
      const pick = invDrop.querySelector('button');
      if (pick) pick.disabled = busy;
      for (const b of invList.querySelectorAll('.inv-actions button')) b.disabled = busy;
      if (full) addText.textContent = `Bir masrafa en çok ${MAX_INVOICES} fatura eklenebilir. Yenisini eklemek için birini kaldırın.`;
      else if (pending > 0) addText.textContent = 'Okuma bir dakika kadar sürebilir. Bu sırada kategori ve açıklamayı girebilirsiniz.';
      else addText.textContent = 'Birden çok dosya seçebilir ya da sürükleyip bırakabilirsiniz.';
      setFileTarget(busy ? null : { label: full ? `En çok ${MAX_INVOICES} fatura eklenebilir` : 'Bırakın, faturalar okunsun', onFiles });
      updateSaveState();
    }

    function blockText(pending, failed) {
      if (pending > 0) return pending === 1 ? 'Fatura okunuyor; okuma bitince kaydedebilirsiniz.' : `${fmtCount(pending)} fatura okunuyor; okumalar bitince kaydedebilirsiniz.`;
      return failed === 1
        ? 'Okunamayan faturayı tekrar deneyin ya da kaldırın; sonra kaydedebilirsiniz.'
        : `Okunamayan ${fmtCount(failed)} faturayı tekrar deneyin ya da kaldırın; sonra kaydedebilirsiniz.`;
    }

    function missingText(n) {
      const who = n === 1 ? 'Bir faturanın' : `${fmtCount(n)} faturanın`;
      return `${who} ${base} karşılığı girilmedi; onaya göndermek için girin. Taslak olarak kaydedebilirsiniz.`;
    }

    /**
     * Saving waits for every read: a card still reading or failed is never dropped silently. A missing
     * equivalent blocks only sending (the server would answer 409 karsilik_eksik); a draft can be saved.
     */
    function updateSaveState() {
      const pending = cards.filter(isPending).length;
      const failed = cards.filter((c) => c.kind === 'error').length;
      const blocked = pending > 0 || failed > 0;
      const missing = sendBtn ? equivalents().missing.length : 0;
      // Only a hint: the server decides whether the form can be sent.
      const incomplete = sendBtn ? readyCards().filter((c) => missingFor(c).length > 0).length : 0;
      readingHint.hidden = !blocked && missing === 0 && incomplete === 0;
      readingHint.classList.toggle('warn', !pending && (failed > 0 || missing > 0 || incomplete > 0));
      if (blocked) readingHint.replaceChildren(icon(pending > 0 ? ICONS.clock : ICONS.warn), el('span', { text: blockText(pending, failed) }));
      else if (missing > 0) readingHint.replaceChildren(icon(ICONS.warn), el('span', { text: missingText(missing) }));
      else if (incomplete > 0) {
        readingHint.replaceChildren(
          icon(ICONS.warn),
          el('span', { text: `${incomplete === 1 ? 'Bir faturada' : `${fmtCount(incomplete)} faturada`} zorunlu alan (fatura no, tarih, satıcı, genel toplam) boş; onaya göndermeden önce “Eksikleri doldur” ile tamamlayın. Taslak olarak kaydedebilirsiniz.` }),
        );
      }
      setBusy(saveBtn, busy);
      if (sendBtn) setBusy(sendBtn, busy);
      if (blocked) saveBtn.disabled = true;
      if (sendBtn && (blocked || missing > 0)) sendBtn.disabled = true;
    }

    // ---------- One invoice card ----------

    function newCard(props) {
      return {
        key: ++cardSeq,
        kind: 'reading',
        id: null,
        name: 'Fatura',
        file: null,
        token: 0,
        abort: null,
        slot: null,
        since: new Date().toISOString(),
        waiting: false,
        activity: null,
        error: null,
        fatura: null,
        kalemler: null,
        onbellek: false,
        fromRecord: false,
        preview: null,
        previewLoading: false,
        previewOpen: null,
        eqText: '', // the base-currency equivalent as typed; kept while the form's currency makes it unneeded
        eq: null, // { field, input, hint }: built once, so typing never loses the focus
        serverError: null,
        original: null, // { fatura, kalemler }: what was read, which "Okunan değere dön" goes back to
        corr: undefined, // the correction to send: undefined = untouched, null = remove it, { fatura, kalemler }
        duzeltildi: false, // the saved form already holds a correction for this invoice
        eksik: null, // required fields the server reports empty (saved invoices, until edited here)
        pathErrors: {}, // server messages by path inside the correction ("fatura.faturaTarihi")
        node: null,
        statusNode: null,
        noteSlot: null,
        errSlot: null,
        previewSlot: null,
        ...props,
      };
    }

    /** Draws the card again in place; a focused card keeps the focus on its actions. */
    function renderCard(card) {
      const hadFocus = card.node?.contains(document.activeElement);
      const next = cardNode(card);
      if (card.node?.isConnected) card.node.replaceWith(next);
      else {
        next.classList.add('enter');
        invList.append(next);
      }
      card.node = next;
      if (hadFocus) (next.querySelector('.inv-actions > :first-child') ?? next).focus();
    }

    function cardTop(card, mark, status) {
      return el('div', { className: 'inv-card-top' }, mark, el('div', { className: 'inv-card-text' }, el('p', { className: 'inv-file', text: card.name }), status));
    }

    const numberMark = () => el('span', { className: 'inv-n', 'aria-hidden': 'true' });

    function removeButton(card, label = 'Kaldır') {
      const danger = label === 'Kaldır';
      return btn(label, {
        icon: danger ? ICONS.trash : null,
        size: 'sm',
        kind: danger ? 'danger-ghost' : 'ghost',
        onClick: () => {
          if (!busy) removeCard(card);
        },
        attrs: { 'aria-label': `${label}: ${card.name}` },
      });
    }

    const isCorrected = (card) => (card.corr !== undefined ? card.corr !== null : card.duzeltildi);

    /** Empty required fields: the server's list for a saved invoice until it is edited here, else worked out from the data. */
    const missingFor = (card) => (card.corr === undefined && card.eksik ? card.eksik : missingOf(card.fatura));

    /** The invoice's valid data as the schema's shape. */
    const validData = (card) => pickInvoice(card.fatura, card.kalemler);

    async function openEditor(card) {
      if (busy || !isReady(card)) return;
      const result = await editInvoiceDialog({
        title: `Fatura bilgileri: ${card.name}`,
        current: validData(card),
        errors: card.pathErrors,
        canRevert: isCorrected(card),
      });
      if (!alive || !cards.includes(card) || result === null) return;
      const original = card.original ?? validData(card);
      if (result === 'revert') {
        markDirty();
        settle(card, { fatura: { ...card.fatura, ...original.fatura }, kalemler: original.kalemler, corr: null, eksik: null, pathErrors: {}, serverError: null });
        say(`${card.name}: okunan değerlere dönüldü.`);
        return;
      }
      if (sameInvoice(result, validData(card))) return;
      markDirty();
      settle(card, { fatura: { ...card.fatura, ...result.fatura }, kalemler: result.kalemler, corr: sameInvoice(result, original) ? null : result, eksik: null, pathErrors: {}, serverError: null });
      say(`${card.name} düzeltildi.`);
      offerNextIncomplete(card);
    }

    /** After "Uygula": points at the next invoice that still has empty required fields. */
    function offerNextIncomplete(after) {
      const rest = readyCards().filter((c) => c !== after && missingFor(c).length > 0);
      if (rest.length === 0) return;
      const next = rest.find((c) => cards.indexOf(c) > cards.indexOf(after)) ?? rest[0];
      const n = cards.indexOf(next) + 1;
      invAlert.replaceChildren(
        el('div', { className: 'inv-next' }, el('p', { text: `Sıradaki eksik fatura: ${n}. fatura` }), btn(`${n}. faturaya geç`, { size: 'sm', kind: 'primary', onClick: () => openEditor(next) })),
      );
    }

    /** What the preview and the save send for this invoice: a correction, or nothing. */
    function correctionFor(card) {
      if (card.corr) return card.corr;
      if (card.corr === undefined && card.duzeltildi) return validData(card);
      return undefined;
    }

    function cardNode(card) {
      const li = el('li', { className: 'inv-card', 'data-state': card.kind, tabindex: '-1' });
      // Native append would print "null" for the parts a card does not have.
      const add = (...parts) => li.append(...parts.filter(Boolean));
      card.statusNode = null;
      card.noteSlot = null;
      card.previewSlot = null;
      card.errSlot = el('div', { className: 'inv-card-err' });

      if (card.kind === 'loading') {
        add(
          cardTop(card, numberMark(), el('p', { className: 'inv-status', text: 'Okunan fatura yükleniyor…' })),
          el('div', { className: 'form-skeleton small', role: 'status', 'aria-label': 'Fatura yükleniyor' }, el('span'), el('span')),
          el('div', { className: 'inv-actions' }, removeButton(card, 'Vazgeç')),
        );
      } else if (card.kind === 'reading') {
        card.statusNode = el('p', { className: 'inv-status', role: 'status', text: readingText(card) });
        add(
          el(
            'div',
            { className: 'inv-card-top' },
            el('span', { className: `sheet-glyph${card.waiting ? '' : ' active'}`, 'aria-hidden': 'true' }, el('span', { className: 'scan' })),
            el('div', { className: 'inv-card-text' }, el('p', { className: 'inv-file', text: card.name }), card.statusNode),
            el('span', { className: 'inv-clock', 'data-since': card.since, 'data-fmt': 'clock', text: '0:00' }),
          ),
          el('div', { className: 'inv-actions' }, removeButton(card, 'Vazgeç')),
        );
      } else if (card.kind === 'error') {
        const retriable = !FINAL_ERRORS.has(card.error?.kod) && card.file;
        add(
          cardTop(card, numberMark(), el('p', { className: 'inv-status', text: 'Okunamadı' })),
          alertBox('err', null, [card.error?.mesaj ?? 'Bilinmeyen bir hata oluştu.']),
          el(
            'div',
            { className: 'inv-actions' },
            retriable ? btn('Tekrar dene', { icon: ICONS.refresh, size: 'sm', onClick: () => retryCard(card), attrs: { 'aria-label': `Tekrar dene: ${card.name}` } }) : null,
            removeButton(card),
          ),
        );
      } else {
        const f = card.fatura ?? {};
        const problems = card.kalemler ? totalChecks({ fatura: f, kalemler: card.kalemler }).filter((c) => !c.ok) : [];
        const gone = missingFor(card);
        let lead = 'Bağlı fatura';
        if (card.kind === 'done') lead = card.fromRecord ? 'Okunan fatura bağlandı.' : card.onbellek ? 'Daha önce okunmuş; sonuç kayıttan alındı.' : 'Fatura okundu.';
        card.noteSlot = el('div', { className: 'inv-card-notes' });
        const status = el('p', { className: 'inv-status ok' }, icon(ICONS.checkCircle), el('span', { text: lead }), isCorrected(card) ? el('span', { className: 'tag accent', text: 'Düzeltildi' }) : null);
        const fact = (key, label, value) => {
          const isGone = gone.includes(key);
          return el('div', { className: isGone ? 'is-missing' : null }, el('dt', { text: label }), el('dd', { text: isGone ? 'Eksik' : (value ?? '—') }));
        };
        add(
          cardTop(card, numberMark(), status),
          el(
            'dl',
            { className: 'kv compact' },
            fact('faturaNo', 'Fatura no', f.faturaNo),
            fact('faturaTarihi', 'Tarih', fmtDateLong(f.faturaTarihi)),
            fact('saticiUnvan', 'Satıcı', f.saticiUnvan),
            fact('genelToplam', 'Genel toplam', fmtCurrency(f.genelToplam, f.paraBirimi)),
          ),
          gone.length > 0
            ? el('p', { className: 'inv-missing', role: 'status' }, icon(ICONS.alert), el('span', { text: `Boş zorunlu alan: ${gone.map((k) => labelOf(k).toLocaleLowerCase('tr-TR')).join(', ')}. “Eksikleri doldur” ile tamamlayın; onaya göndermek için gerekli.` }))
            : null,
          card.noteSlot,
          problems.length > 0 ? alertBox('warn', 'Okunan rakamları kontrol edin', problems.map((c) => c.text)) : null,
          previewBlock(card),
          el(
            'div',
            { className: 'inv-actions' },
            gone.length > 0 ? btn('Eksikleri doldur', { icon: ICONS.edit, size: 'sm', kind: 'primary', onClick: () => openEditor(card), attrs: { 'aria-label': `Eksikleri doldur: ${card.name}`, 'aria-haspopup': 'dialog' } }) : null,
            btn('Bilgileri düzenle', { icon: ICONS.edit, size: 'sm', onClick: () => openEditor(card), attrs: { 'aria-label': `Bilgileri düzenle: ${card.name}`, 'aria-haspopup': 'dialog' } }),
            card.id
              ? btn('Okunan faturayı aç', {
                  icon: ICONS.external,
                  size: 'sm',
                  href: `#/okuma/${encodeURIComponent(card.id)}`,
                  attrs: { target: '_blank', rel: 'noopener', 'aria-label': `Okunan faturayı aç: ${card.name}` },
                })
              : null,
            removeButton(card),
          ),
        );
        updateCardNote(card);
      }
      li.append(card.errSlot);
      showCardError(card, li);
      if (busy) for (const b of li.querySelectorAll('.inv-actions button')) b.disabled = true;
      return li;
    }

    /** Lazily built: a list of twenty PDFs should not load twenty viewers. */
    function previewBlock(card) {
      if (!card.preview && !card.previewLoading) {
        return card.kind === 'linked' ? el('p', { className: 'muted small', text: 'Bu faturanın orijinal dosyası saklanmamış.' }) : null;
      }
      const slot = el('div', { className: 'inv-preview-body' });
      card.previewSlot = slot;
      const open = card.previewOpen ?? cards.length === 1;
      const details = el(
        'details',
        { className: 'inv-preview', open },
        el('summary', {}, icon(ICONS.chevronDown), el('span', { text: 'Önizleme' }), el('span', { className: 'visually-hidden', text: `: ${card.name}` })),
        slot,
      );
      details.addEventListener('toggle', () => {
        card.previewOpen = details.open;
        if (details.open) fillPreview(card);
      });
      if (open) fillPreview(card);
      return details;
    }

    function fillPreview(card, force = false) {
      const slot = card.previewSlot;
      if (!slot || (!force && slot.dataset.filled === '1')) return;
      if (card.preview) {
        slot.replaceChildren(invoicePreview(card.preview));
        slot.dataset.filled = '1';
      } else if (card.previewLoading) {
        slot.replaceChildren(el('div', { className: 'form-skeleton small', role: 'status', 'aria-label': 'Önizleme yükleniyor' }, el('span')));
      } else {
        slot.replaceChildren(el('p', { className: 'preview-missing', text: 'Önizleme yüklenemedi. Okunan faturayı açıp orijinal dosyaya bakabilirsiniz.' }));
        slot.dataset.filled = '1';
      }
    }

    /** True when this invoice needs its base-currency equivalent on the form as it is now. */
    const needsEq = (card) => isReady(card) && needsEquivalent(controls.paraBirimi.value, base, card.fatura);

    /** The typed equivalent: { value } (a positive amount), { error }, or {} when empty. */
    function readEquivalent(card) {
      const p = parseAmount(card.eqText);
      if (p.error) return { error: p.error };
      if (p.value === null) return {};
      if (p.value <= 0) return { error: "Karşılık 0'dan büyük olmalı." };
      return { value: p.value };
    }

    /**
     * The equivalents the form needs now: given (faturaId -> amount, for the API), missing (cards
     * with nothing typed) and invalid (cards with something that is not an amount).
     */
    function equivalents() {
      const given = {};
      const missing = [];
      const invalid = [];
      for (const card of cards) {
        if (!needsEq(card)) continue;
        const r = readEquivalent(card);
        if (r.value !== undefined) given[card.id] = r.value;
        else if (r.error) invalid.push({ card, error: r.error });
        else missing.push(card);
      }
      return { given, missing, invalid };
    }

    function equivalentHint(card) {
      const cur = controls.paraBirimi.value;
      const r = readEquivalent(card);
      const parts = [`Kart ekstrenizdeki ya da bankanızın uyguladığı ${base} tutarı.`];
      if (r.value === undefined && !r.error) parts.push('Girilmezse masraf onaya gönderilemez; taslak olarak kaydedebilirsiniz.');
      else if (r.value !== undefined && cur !== base) {
        const k = parseAmount(controls.kur.value, RATE);
        parts.push(!k.error && k.value > 0 ? `Toplama ${fmtCurrency(Math.round((r.value / k.value) * 100) / 100, cur)} olarak katılır.` : 'Kur girilince toplama katılır.');
      }
      card.eq.hint.textContent = parts.join(' ');
      card.eq.field.classList.toggle('needs-value', r.value === undefined && !r.error);
    }

    /** The equivalent input of a card, built once and moved with the card when it is drawn again. */
    function equivalentField(card) {
      if (card.eq) return card.eq.field;
      const inputEl = input({ name: `yerelKarsilik-${card.key}`, inputmode: 'decimal', autocomplete: 'off', placeholder: '0,00', className: 'input num', value: card.eqText });
      const hint = el('span');
      const label = el('span', {}, el('span', { text: `${base} karşılığı` }), el('span', { className: 'visually-hidden', text: `: ${card.name}` }));
      const box = field({ label, input: inputEl, hint, className: 'inv-eq' });
      card.eq = { field: box, input: inputEl, hint };
      inputEl.addEventListener('input', () => {
        card.eqText = inputEl.value;
        markDirty();
        setFieldError(inputEl, null);
        if (card.serverError) setCardError(card, null);
        equivalentHint(card);
        equivalentsChanged();
      });
      inputEl.addEventListener('blur', () => {
        const r = readEquivalent(card);
        if (r.error) setFieldError(inputEl, r.error);
        else if (r.value !== undefined) inputEl.value = card.eqText = fmtAmountInput(r.value);
      });
      equivalentHint(card);
      return box;
    }

    /**
     * Under the invoice's facts: the equivalent input when the form needs one, otherwise a note when
     * the invoice does not add to the amount (no total read) or adds to it converted.
     */
    function updateCardNote(card) {
      if (!card.noteSlot) return;
      const f = card.fatura ?? {};
      const cur = controls.paraBirimi.value;
      if (needsEq(card)) {
        const box = equivalentField(card);
        equivalentHint(card);
        // Moving a focused input would blur it: leave it where it is.
        if (card.noteSlot.firstChild !== box || card.noteSlot.childNodes.length !== 1) card.noteSlot.replaceChildren(box);
        return;
      }
      if (card.eq) setFieldError(card.eq.input, null);
      let text = null;
      if (!hasTotal(f)) text = 'Genel toplam okunamadı; bu fatura tutar toplamına ve onay tutarına katılmaz.';
      else if (f.paraBirimi === base && cur !== base) text = `Fatura ${base} cinsinden; toplama kurla ${cur} karşılığı olarak katılır.`;
      card.noteSlot.replaceChildren(...(text ? [el('p', { className: 'inv-card-note' }, icon(ICONS.info), el('span', { text }))] : []));
    }

    function showCardError(card, node = card.node) {
      if (!card.errSlot) return;
      node?.classList.toggle('has-error', Boolean(card.serverError));
      card.errSlot.replaceChildren(...(card.serverError ? [el('p', { className: 'field-error', role: 'alert' }, icon(ICONS.alert), el('span', { text: card.serverError }))] : []));
    }

    function setCardError(card, message) {
      card.serverError = message;
      showCardError(card);
    }

    function clearCardErrors() {
      for (const c of cards) if (c.serverError) setCardError(c, null);
    }

    function updateReading(card) {
      if (card.statusNode) card.statusNode.textContent = readingText(card);
      card.node?.querySelector('.sheet-glyph')?.classList.toggle('active', !card.waiting);
    }

    // ---------- Adding, reading and removing ----------

    function onFiles(files) {
      const list = files.filter(Boolean);
      if (list.length === 0 || !alive) return;
      if (busy) {
        toast('Masraf kaydediliyor; faturayı kayıttan sonra ekleyin.', 'err');
        return;
      }
      const room = MAX_INVOICES - cards.length;
      if (room <= 0) {
        toast(`Bir masrafa en çok ${MAX_INVOICES} fatura eklenebilir. Yenisini eklemek için birini kaldırın.`, 'err');
        return;
      }
      const accepted = list.slice(0, room);
      if (list.length > room) toast(`Bir masrafa en çok ${MAX_INVOICES} fatura eklenebilir; ${fmtCount(list.length - room)} dosya eklenmedi.`, 'err');
      for (const file of accepted) {
        const card = newCard({ kind: 'reading', file, name: file.name || 'Fatura' });
        cards.push(card);
        startRead(card);
      }
      markDirty();
      tickClocks();
      say(accepted.length === 1 ? `${accepted[0].name || 'Fatura'} okunuyor.` : `${fmtCount(accepted.length)} fatura okunuyor.`);
      renderPanelState();
      pumpReads();
    }

    function startRead(card) {
      card.token = ++readSeq;
      card.waiting = true;
      card.activity = null;
      renderCard(card);
      readQueue.push(card);
    }

    function pumpReads() {
      while (alive && readsInFlight < MAX_PARALLEL_READS && readQueue.length > 0) {
        const card = readQueue.shift();
        if (card.kind !== 'reading' || !cards.includes(card)) continue;
        readsInFlight++;
        const slot = { held: true };
        card.slot = slot;
        readCard(card, card.token).finally(() => releaseSlot(card, slot));
      }
    }

    /** Gives a read slot back once (when the answer comes, or at once when the read is cancelled). */
    function releaseSlot(card, slot) {
      if (!slot?.held) return;
      slot.held = false;
      if (card.slot === slot) card.slot = null;
      readsInFlight--;
      pumpReads();
    }

    /**
     * Forgets the card's request and aborts it, so its connection and its slot go to the next file
     * at once. The server still finishes a read it has started and keeps the record; the reading
     * screen shows it.
     */
    function cancelRead(card) {
      card.token = -1;
      const ctl = card.abort;
      card.abort = null;
      ctl?.abort();
      releaseSlot(card, card.slot);
    }

    async function readCard(card, token) {
      const file = card.file;
      const tag = api.newTag();
      rememberSent(tag, [file]);
      card.waiting = false;
      updateReading(card);
      const unwatch = watchTag(tag, (a) => {
        if (card.token !== token) return;
        card.activity = a;
        updateReading(card);
      });
      const ctl = new AbortController();
      card.abort = ctl;
      let r;
      try {
        r = await api.sendOne(file, { force: false, tag, signal: ctl.signal });
      } finally {
        unwatch();
        if (card.abort === ctl) card.abort = null;
      }
      // Removed, retried or the view went away: an aborted request is not an error.
      if (r.aborted || !alive || card.token !== token || !cards.includes(card)) return;
      if (!r.ok) {
        if (r.unauthorized) return;
        settle(card, { kind: 'error', error: r.error });
        say(`${card.name} okunamadı.`);
        return;
      }
      if (!r.id) {
        settle(card, { kind: 'error', error: { kod: 'kimlik_yok', mesaj: 'Fatura okundu ama kayıt kimliği alınamadı. Fatura okuma ekranından deneyin.' } });
        return;
      }
      // The preview's type comes from the file's first bytes, never from its name (files.js).
      const type = await sniffType(file);
      if (!alive || card.token !== token || !cards.includes(card)) return;
      const twin = cards.find((c) => c !== card && c.id === r.id);
      if (twin) {
        const n = cards.indexOf(twin) + 1;
        removeCard(card, { announce: false, focusTo: twin });
        toast(`Bu fatura zaten ekli (${fmtCount(n)}. fatura); “${card.name}” ikinci kez eklenmedi.`);
        if (twin.node) {
          replay(twin.node, 'flash');
          twin.node.scrollIntoView({ block: 'nearest' });
        }
        return;
      }
      const { url, mime } = typedObjectUrl(file, type);
      objectUrls.add(url);
      settle(card, {
        kind: 'done',
        id: r.id,
        fatura: r.body.fatura,
        kalemler: r.body.kalemler,
        original: pickInvoice(r.body.fatura, r.body.kalemler),
        onbellek: r.body.olcum?.kaynak === 'kayit' || r.res?.headers.get('X-Fatura-Onbellek') === '1',
        preview: { url, mime, name: card.name },
      });
      say(`${card.name} okundu.`);
    }

    function settle(card, props) {
      Object.assign(card, props);
      renderCard(card);
      afterInvoicesChanged();
    }

    function retryCard(card) {
      if (busy) return;
      Object.assign(card, { kind: 'reading', error: null, since: new Date().toISOString() });
      startRead(card);
      tickClocks();
      renderPanelState();
      pumpReads();
    }

    function revokePreview(card) {
      const url = card.preview?.url;
      if (url && objectUrls.has(url)) {
        URL.revokeObjectURL(url);
        objectUrls.delete(url);
      }
    }

    /** userChange: false when the panel takes back a card it added itself (a ?fatura= that failed). */
    function removeCard(card, { announce = true, focusTo = null, userChange = true } = {}) {
      const i = cards.indexOf(card);
      if (i < 0) return;
      const hadFocus = card.node?.contains(document.activeElement);
      cards.splice(i, 1);
      cancelRead(card);
      card.node?.remove();
      revokePreview(card);
      if (fillSource === card) fillSource = null;
      if (userChange) markDirty();
      if (announce) say(`${card.name} kaldırıldı. ${cards.length === 0 ? 'Fatura kalmadı.' : `${fmtCount(cards.length)} fatura kaldı.`}`);
      afterInvoicesChanged();
      if (hadFocus) {
        const next = focusTo ?? cards[i] ?? cards[i - 1];
        const target = next?.node?.querySelector('.inv-actions > :last-child') ?? (cards.length > 0 ? addBtn : invDrop.querySelector('button'));
        target?.focus();
      }
    }

    /** ?fatura=<id> from the reading screen: the record that was already read becomes the first card. */
    async function linkRecord(fid) {
      if (!api.ID_PATTERN.test(fid)) {
        invAlert.replaceChildren(alertBox('err', null, ['Fatura bağlantısı geçersiz; dosyayı yeniden yükleyin.']));
        return;
      }
      const card = newCard({ kind: 'loading', id: fid, name: 'Okunan fatura' });
      // "Vazgeç", "Kaldır" and leaving the view abort these requests (cancelRead).
      const ctl = new AbortController();
      card.abort = ctl;
      cards.push(card);
      renderCard(card);
      renderPanelState();
      const r = await api.getRecord(fid, { signal: ctl.signal });
      if (r.aborted || !alive || !cards.includes(card)) return;
      if (!r.ok) {
        if (r.unauthorized) return;
        // Nothing the user did changed the form: leaving it afterwards does not ask.
        removeCard(card, { announce: false, userChange: false });
        invAlert.replaceChildren(alertBox('err', 'Fatura açılamadı', [r.error.mesaj]));
        return;
      }
      const f = r.body.fatura ?? {};
      markDirty();
      settle(card, { kind: 'done', fromRecord: true, name: f.faturaNo ? `Fatura ${f.faturaNo}` : 'Okunan fatura', fatura: r.body.fatura, kalemler: r.body.kalemler, original: pickInvoice(r.body.fatura, r.body.kalemler), previewLoading: true });
      const file = await api.getInvoiceFile(fid, { signal: ctl.signal });
      const type = file.ok ? await sniffType(file.blob) : null;
      if (file.aborted || !alive || !cards.includes(card)) return;
      if (card.abort === ctl) card.abort = null;
      card.previewLoading = false;
      if (file.ok) {
        // Typed by its content like a local file; the server sends only these types anyway.
        const { url, mime } = typedObjectUrl(file.blob, type);
        objectUrls.add(url);
        card.preview = { url, mime, name: f.faturaNo ? `${f.faturaNo}` : `fatura-${fid}` };
      }
      // A closed preview fills itself when it is opened.
      if (card.previewSlot?.closest('details')?.open) fillPreview(card, true);
    }

    // ---------- Filling the form from the invoices ----------

    /**
     * The invoices' total in the form's currency, with base-currency invoices and entered equivalents
     * converted by the rate: { value, count, unconverted } or null when no invoice adds to it.
     */
    function invoiceTotal() {
      const cur = controls.paraBirimi.value;
      const k = cur === base ? null : parseAmount(controls.kur.value, RATE);
      const rate = k && !k.error ? k.value : null;
      const items = readyCards().map((c) => ({ fatura: c.fatura, equivalent: needsEq(c) ? (readEquivalent(c).value ?? null) : null }));
      const t = invoicesTotal(items, cur, base, rate);
      return t.count > 0 ? t : null;
    }

    /** Invoices that would count once the rate is entered (base-currency ones and equivalents). */
    function waitingForRate() {
      const cur = controls.paraBirimi.value;
      if (cur === base) return 0;
      const k = parseAmount(controls.kur.value, RATE);
      if (!k.error && k.value > 0) return 0;
      return invoicesTotal(readyCards().map((c) => ({ fatura: c.fatura, equivalent: needsEq(c) ? (readEquivalent(c).value ?? null) : null })), cur, base, null).unconverted;
    }

    /**
     * The first invoice read fills the date, vendor, title and currency the user has not typed (as
     * one invoice always did). It stays the source until it is removed; then the first invoice left
     * in the list takes over.
     */
    function fillFromSource() {
      if (fillSource && cards.includes(fillSource) && isReady(fillSource)) return false;
      fillSource = readyCards()[0] ?? null;
      if (!fillSource) return false;
      let changed = false;
      const f = fillSource.fatura ?? {};
      const fill = (name, value, label) => {
        if (value === null || value === undefined || value === '') return;
        const c = controls[name];
        if (touched.has(name) && c.value.trim() !== '') return;
        if (c.value === value) return;
        if (name === 'paraBirimi') ensureCurrencyOption(value);
        c.value = value;
        setFieldError(c, null);
        replay(c, 'autofilled');
        autoFilled.set(name, label);
        changed = true;
      };
      if (typeof f.paraBirimi === 'string' && /^[A-Z]{3}$/.test(f.paraBirimi)) fill('paraBirimi', f.paraBirimi, 'para birimi');
      if (f.faturaTarihi && f.faturaTarihi <= todayIso()) fill('masrafTarihi', f.faturaTarihi, 'tarih');
      if (f.saticiUnvan) fill('satici', f.saticiUnvan, 'satıcı');
      if (f.saticiUnvan) fill('baslik', f.saticiUnvan.slice(0, 120), 'başlık');
      return changed;
    }

    /**
     * Until the user types an amount, the amount is the total of the invoices in the form's currency.
     * Returns 'filled', 'cleared' (no invoice adds to it any more) or null.
     */
    function syncAmount() {
      const c = controls.tutar;
      // Typing clears amountAuto; an empty field is filled again, as one invoice always did.
      if (touched.has('tutar') && !amountAuto && c.value.trim() !== '') return null;
      const total = invoiceTotal();
      if (!total) {
        if (!amountAuto || c.value === '') {
          amountAuto = false;
          return null;
        }
        c.value = '';
        amountAuto = false;
        amountCleared = true;
        autoFilled.delete('tutar');
        return 'cleared';
      }
      amountAuto = true;
      amountCleared = false;
      const next = fmtAmountInput(total.value);
      if (c.value === next) return null;
      c.value = next;
      setFieldError(c, null);
      replay(c, 'autofilled');
      autoFilled.set('tutar', 'tutar');
      return 'filled';
    }

    const FILL_ORDER = ['tutar', 'paraBirimi', 'masrafTarihi', 'satici', 'baslik'];

    /** Which fields hold values from the invoices; gone when the user types into them. */
    function fillNote() {
      const ready = readyCards().length;
      if (amountCleared) return alertBox('info', null, ['Tutara katılacak fatura kalmadı; tutarı girin.']);
      if (ready === 0 || autoFilled.size === 0) return null;
      const many = ready > 1;
      const labels = FILL_ORDER.filter((n) => autoFilled.has(n)).map((n) => (n === 'tutar' && many ? 'tutar (faturaların toplamı)' : autoFilled.get(n)));
      return alertBox('ok', null, [`${many ? 'Faturalardan' : 'Faturadan'} dolduruldu: ${labels.join(', ')}. Göndermeden önce kontrol edin.`]);
    }

    function diffNote() {
      const total = invoiceTotal();
      const typed = parseAmount(controls.tutar.value);
      if (!total || typed.error || typed.value === null || toCents(typed.value) === toCents(total.value)) return null;
      const what = total.count > 1 ? 'faturaların toplamından' : 'faturanın tutarından';
      return alertBox('warn', null, [
        `Formdaki tutar ${what} (${fmtCurrency(total.value, controls.paraBirimi.value)}) farklı. Onay, ikisinden büyük olan tutar üzerinden yapılır ve onaycılar farkı görür.`,
      ]);
    }

    function renderNotes() {
      invNote.replaceChildren(...[fillNote(), diffNote()].filter(Boolean));
    }

    function renderSum() {
      const ready = readyCards().length;
      invSum.hidden = ready < 2;
      if (ready < 2) return;
      const cur = controls.paraBirimi.value;
      const total = invoiceTotal();
      const waiting = waitingForRate();
      const left = ready - (total?.count ?? 0) - waiting;
      invSum.replaceChildren(
        ...[
          el(
            'p',
            { className: 'inv-sum-line' },
            el('span', { text: total ? `Faturaların toplamı · ${fmtCount(total.count)} fatura` : 'Toplanacak fatura yok' }),
            el('strong', { text: total ? fmtCurrency(total.value, cur) : '—' }),
          ),
          waiting > 0 ? el('p', { className: 'inv-sum-note', text: `${fmtCount(waiting)} fatura kur girilince toplama katılır.` }) : null,
          left > 0 ? el('p', { className: 'inv-sum-note', text: `${fmtCount(left)} fatura toplama katılmıyor; nedeni kartında yazıyor.` }) : null,
        ].filter(Boolean),
      );
    }

    /** Everything that follows the list of read invoices: fields, notes, total, buttons, approvers. */
    function afterInvoicesChanged() {
      if (!alive) return;
      if (fillFromSource()) updateCurrencyUi();
      syncAmount();
      updateLocalHint();
      for (const c of cards) updateCardNote(c);
      renderNotes();
      renderSum();
      renderPanelState();
      schedulePreview();
    }

    /** The form's currency or rate changed: which invoices need an equivalent, and what they add. */
    function currencyChanged() {
      syncAmount();
      updateLocalHint();
      for (const c of cards) updateCardNote(c);
      renderNotes();
      renderSum();
      updateSaveState();
    }

    /** An equivalent was typed: the amount, the total, the send button and the approvers follow. */
    function equivalentsChanged() {
      syncAmount();
      updateLocalHint();
      for (const c of cards) if (c.eq && needsEq(c) && c.eq.input !== document.activeElement) equivalentHint(c);
      renderNotes();
      renderSum();
      updateSaveState();
      schedulePreview();
    }

    function fillFromDetail(d) {
      controls.baslik.value = d.baslik ?? '';
      setCategory(d.kategori?.id);
      controls.masrafTarihi.value = d.masrafTarihi ?? '';
      controls.tutar.value = fmtAmountInput(d.tutar);
      ensureCurrencyOption(d.paraBirimi);
      controls.paraBirimi.value = d.paraBirimi ?? base;
      controls.kur.value = d.kur !== null && d.kur !== undefined ? fmtRateInput(d.kur) : '';
      controls.satici.value = d.satici ?? '';
      controls.aciklama.value = d.aciklama ?? '';
      for (const [name, c] of Object.entries(controls)) if (c.value) touched.add(name);
      if (d.kategori) touched.add('kategoriId');
      for (const f of d.faturalar ?? []) {
        cards.push(
          newCard({
            kind: 'linked',
            id: f.id,
            name: f.dosyaAdi || (f.faturaNo ? `Fatura ${f.faturaNo}` : 'Fatura'),
            fatura: f,
            kalemler: f.kalemler ?? [],
            original: f.duzeltildi && f.okunan ? pickInvoice(f.okunan.fatura, f.okunan.kalemler) : pickInvoice(f, f.kalemler),
            duzeltildi: Boolean(f.duzeltildi),
            eksik: Array.isArray(f.eksikAlanlar) ? f.eksikAlanlar : [],
            preview: f.dosyaVar ? { url: api.invoiceFileUrl(f.id), mime: f.mime, name: f.dosyaAdi } : null,
            eqText: f.yerelKarsilik !== null && f.yerelKarsilik !== undefined ? fmtAmountInput(f.yerelKarsilik) : '',
          }),
        );
      }
      for (const card of cards) renderCard(card); // after the push: the preview opens only for a lone invoice
      // The saved invoices already filled the form once; a newly added one fills only empty fields.
      fillSource = cards[0] ?? null;
      // A saved amount that equals the invoices' total keeps following them as invoices change.
      const total = invoiceTotal();
      if (total && toCents(total.value) === toCents(d.tutar)) {
        touched.delete('tutar');
        amountAuto = true;
      }
      afterInvoicesChanged();
    }

    // ---------- Saving ----------

    function collect() {
      const errors = {};
      const baslik = controls.baslik.value.trim();
      if (!baslik) errors.baslik = 'Başlık girin.';
      else if (baslik.length > 120) errors.baslik = 'Başlık en çok 120 karakter olabilir.';

      const checked = catGrid.querySelector('input:checked');
      const kategoriId = checked ? Number(checked.value) : null;
      if (kategoriId === null) errors.kategoriId = 'Bir kategori seçin.';

      const masrafTarihi = controls.masrafTarihi.value;
      if (!masrafTarihi) errors.masrafTarihi = 'Masraf tarihini girin.';
      else if (masrafTarihi > todayIso()) errors.masrafTarihi = 'Masraf tarihi gelecekte olamaz.';

      const t = parseAmount(controls.tutar.value);
      if (t.error) errors.tutar = t.error;
      else if (t.value === null) errors.tutar = 'Tutarı girin.';
      else if (t.value <= 0) errors.tutar = "Tutar 0'dan büyük olmalı.";

      const paraBirimi = controls.paraBirimi.value;
      let kur = null;
      if (paraBirimi !== base) {
        const k = parseAmount(controls.kur.value, RATE);
        if (k.error) errors.kur = k.error;
        else if (!k.value || k.value <= 0) errors.kur = `${paraBirimi} için ${base} karşılığı kuru girin.`;
        else kur = k.value;
      }

      const data = {
        baslik,
        kategoriId,
        masrafTarihi,
        tutar: t.value,
        paraBirimi,
        kur,
        satici: controls.satici.value.trim() || null,
        aciklama: controls.aciklama.value.trim() || null,
        faturaIdler: readyCards().map((c) => c.id),
      };
      // Equivalents only for the invoices that need one on this form; a typed value that is not an
      // amount stops saving, an empty one only sending.
      const eq = equivalents();
      for (const { card, error } of eq.invalid) errors[`yerelKarsiliklar.${card.id}`] = error;
      data.yerelKarsiliklar = eq.given;
      data.faturaDuzeltmeleri = corrections();
      return { errors, data, missing: eq.missing };
    }

    /**
     * faturaDuzeltmeleri: { faturaId: { fatura, kalemler } | null }. Only invoices the user touched go
     * in; null removes a correction the saved form holds. The preview also needs the saved ones, since
     * it has no form to read them from.
     */
    function corrections({ forPreview = false } = {}) {
      const out = {};
      for (const card of readyCards()) {
        if (forPreview) {
          const c = correctionFor(card);
          if (c) out[card.id] = c;
        } else if (card.corr) out[card.id] = card.corr;
        else if (card.corr === null && card.duzeltildi) out[card.id] = null;
      }
      return out;
    }

    /** Field names to controls, the equivalent inputs included (yerelKarsiliklar.<faturaId>). */
    function errorTargets() {
      const targets = { ...fieldTargets };
      for (const c of cards) if (c.eq && needsEq(c)) targets[`yerelKarsiliklar.${c.id}`] = c.eq.input;
      return targets;
    }

    function createBody(data) {
      const b = { baslik: data.baslik, kategoriId: data.kategoriId, masrafTarihi: data.masrafTarihi, tutar: data.tutar, paraBirimi: data.paraBirimi };
      if (data.kur !== null) b.kur = data.kur;
      if (data.satici) b.satici = data.satici;
      if (data.aciklama) b.aciklama = data.aciklama;
      if (data.faturaIdler.length > 0) b.faturaIdler = data.faturaIdler;
      if (Object.keys(data.yerelKarsiliklar).length > 0) b.yerelKarsiliklar = data.yerelKarsiliklar;
      if (Object.keys(data.faturaDuzeltmeleri).length > 0) b.faturaDuzeltmeleri = data.faturaDuzeltmeleri;
      return b;
    }

    /** The equivalents the saved form holds (the server keeps only those its invoices need). */
    function savedEquivalents(d) {
      const out = {};
      for (const f of d.faturalar ?? []) if (f.yerelKarsilik !== null && f.yerelKarsilik !== undefined) out[f.id] = f.yerelKarsilik;
      return out;
    }

    /** Only the fields that changed; a cleared optional field is sent as null, a changed invoice list in full. */
    function patchBody(data, d) {
      const p = {};
      if (data.baslik !== d.baslik) p.baslik = data.baslik;
      if (data.kategoriId !== (d.kategori?.id ?? null)) p.kategoriId = data.kategoriId;
      if (data.masrafTarihi !== d.masrafTarihi) p.masrafTarihi = data.masrafTarihi;
      if (toCents(data.tutar) !== toCents(d.tutar)) p.tutar = data.tutar;
      if (data.paraBirimi !== d.paraBirimi) p.paraBirimi = data.paraBirimi;
      if ((data.kur ?? null) !== (d.kur ?? null)) p.kur = data.kur;
      if ((data.satici ?? null) !== (d.satici ?? null)) p.satici = data.satici;
      if ((data.aciklama ?? null) !== (d.aciklama ?? null)) p.aciklama = data.aciklama;
      const saved = d.faturaIdler ?? (d.faturalar ?? []).map((f) => f.id);
      if (!sameList(data.faturaIdler, saved)) p.faturaIdler = data.faturaIdler;
      // Sent, the map replaces every equivalent; so it goes in full, with a changed list too.
      if (p.faturaIdler || !sameAmounts(data.yerelKarsiliklar, savedEquivalents(d))) p.yerelKarsiliklar = data.yerelKarsiliklar;
      // Listed invoices change; the others keep their correction on the server.
      if (Object.keys(data.faturaDuzeltmeleri).length > 0) p.faturaDuzeltmeleri = data.faturaDuzeltmeleri;
      return p;
    }

    /**
     * alanlar["faturaIdler.<i>"] goes under the i-th invoice sent; alanlar.faturaIdler and a 409
     * without alanlar (two saves racing) go over the list. alanlar["yerelKarsiliklar.<faturaId>"]
     * (400, or 409 karsilik_eksik when sending) goes under that invoice's equivalent input.
     */
    function showServerError(e, { unsaved = false } = {}) {
      const alanlar = e.alanlar ? { ...e.alanlar } : null;
      const listMessages = [];
      let firstCard = null;
      if (alanlar) {
        for (const [key, message] of Object.entries(alanlar)) {
          const m = /^faturaIdler(?:\.(\d+))?$/.exec(key);
          if (!m) continue;
          delete alanlar[key];
          const card = m[1] !== undefined ? sentCards[Number(m[1])] : null;
          if (card && cards.includes(card)) {
            setCardError(card, String(message));
            firstCard ??= card;
          } else {
            listMessages.push(String(message));
          }
        }
      } else if (e.kod === 'fatura_kullaniliyor') {
        listMessages.push(e.mesaj);
      }
      // alanlar["faturalar.<id>.<alan>"] (409 fatura_eksik), alanlar["faturalar.<id>"] (409 fatura_mukerrer)
      // and alanlar["faturaDuzeltmeleri.<id>.<yol>"] (400) go under that invoice; the editor shows them by field.
      const perCard = new Map();
      if (alanlar) {
        for (const [key, message] of Object.entries(alanlar)) {
          const m = /^(faturalar|faturaDuzeltmeleri)\.([^.]+)(?:\.(.+))?$/.exec(key);
          if (!m) continue;
          delete alanlar[key];
          const card = cards.find((c) => c.id === m[2]);
          if (!card) {
            listMessages.push(String(message));
            continue;
          }
          const rest = m[3] ?? null;
          const entry = perCard.get(card) ?? { lines: [], paths: {} };
          entry.lines.push(rest ? `${pathLabel(rest)}: ${message}` : String(message));
          if (rest) entry.paths[m[1] === 'faturalar' ? `fatura.${rest}` : rest] = String(message);
          perCard.set(card, entry);
        }
        for (const [card, entry] of perCard) {
          card.pathErrors = entry.paths;
          setCardError(card, entry.lines.join(' '));
          firstCard ??= card;
        }
      }
      if (listMessages.length > 0) invAlert.replaceChildren(alertBox('err', null, listMessages));
      const invoiceProblem = firstCard !== null || listMessages.length > 0;

      const fieldCount = alanlar ? Object.keys(alanlar).length : 0;
      const leftovers = alanlar ? applyFieldErrors(alanlar, errorTargets()) : [];
      if (!alanlar) {
        // A refused send on a new form created nothing; it can still be kept as a draft.
        summary.replaceChildren(alertBox('err', null, [e.mesaj, unsaved && e.durum === 409 ? 'Masraf kaydedilmedi; taslak olarak kaydedebilirsiniz.' : null].filter(Boolean)));
      } else if (e.kod === 'fatura_eksik' || e.kod === 'fatura_mukerrer') {
        const lead = e.kod === 'fatura_eksik' ? 'Bazı faturalarda zorunlu alanlar boş. İşaretli faturanın “Eksikleri doldur” düğmesiyle tamamlayın ya da taslak olarak kaydedin.' : 'Bir fatura başka bir masrafta ya da bu masrafta zaten kayıtlı. İşaretli faturayı kaldırın veya düzeltin.';
        summary.replaceChildren(alertBox('err', 'Onaya gönderilemedi', [e.mesaj, lead, unsaved && e.durum === 409 ? 'Masraf kaydedilmedi; taslak olarak kaydedebilirsiniz.' : null].filter(Boolean)));
      } else if (e.kod === 'karsilik_eksik') {
        const items = [...new Set(Object.values(alanlar).map(String))];
        summary.replaceChildren(alertBox('err', 'Onaya gönderilemedi', [...items, 'Karşılıkları girip yeniden gönderin ya da taslak olarak kaydedin.']));
      } else {
        const items = [...leftovers];
        if (items.length === 0) items.push(invoiceProblem && fieldCount === 0 ? 'Faturalar bölümünde işaretli faturaları düzeltin.' : 'İşaretli alanları düzeltin.');
        summary.replaceChildren(alertBox('err', 'Formu kontrol edin', items));
      }
      if (fieldCount > leftovers.length) return; // applyFieldErrors focused the first field
      const target = firstCard?.node ?? (alanlar && listMessages.length > 0 ? invAlert : summary);
      target.scrollIntoView({ block: 'nearest' });
      target.focus({ preventScroll: true });
    }

    /** After a save that keeps the page open: the corrections are on the server now. */
    function syncFromSaved(d) {
      for (const card of cards) {
        const f = (d.faturalar ?? []).find((x) => x.id === card.id);
        if (!f) continue;
        card.corr = undefined;
        card.duzeltildi = Boolean(f.duzeltildi);
        card.eksik = Array.isArray(f.eksikAlanlar) ? f.eksikAlanlar : [];
        card.original = f.duzeltildi && f.okunan ? pickInvoice(f.okunan.fatura, f.okunan.kalemler) : pickInvoice(f, f.kalemler);
        card.pathErrors = {};
        renderCard(card);
      }
    }

    function setSaving(on) {
      busy = on;
      renderPanelState();
    }

    async function submit(sendAfter) {
      if (busy) return;
      const form = page.querySelector('form');
      if (!form) return;
      clearFieldErrors(form);
      summary.replaceChildren();
      invAlert.replaceChildren();
      clearCardErrors();
      const pending = cards.filter(isPending).length;
      const failed = cards.filter((c) => c.kind === 'error');
      if (pending > 0) {
        summary.replaceChildren(alertBox('info', null, [blockText(pending, 0)]));
        return;
      }
      if (failed.length > 0) {
        summary.replaceChildren(alertBox('err', null, [blockText(0, failed.length)]));
        failed[0].node?.scrollIntoView({ block: 'nearest' });
        failed[0].node?.focus({ preventScroll: true });
        return;
      }
      const { errors, data, missing } = collect();
      if (Object.keys(errors).length > 0) {
        applyFieldErrors(errors, errorTargets());
        summary.replaceChildren(alertBox('err', 'Formu kontrol edin', ['İşaretli alanları düzeltin.']));
        return;
      }
      // The send button is off while an equivalent is missing; this covers Enter and other routes.
      if (sendAfter && missing.length > 0) {
        for (const c of missing) setFieldError(c.eq?.input, `${base} karşılığını girin.`);
        summary.replaceChildren(alertBox('err', 'Onaya gönderilemez', [missingText(missing.length)]));
        missing[0].eq?.input.focus();
        return;
      }
      if (sendAfter) {
        // Nothing goes to the server; the server still enforces the rule. This only leads the user to the field.
        const incomplete = readyCards().filter((c) => missingFor(c).length > 0);
        if (incomplete.length > 0) {
          toast('Göndermeden önce eksik bilgileri doldurun.');
          incomplete[0].node?.scrollIntoView({ block: 'nearest' });
          openEditor(incomplete[0]);
          return;
        }
      }
      sentCards = readyCards();
      setSaving(true);
      let r;
      if (editing) {
        const patch = patchBody(data, detail);
        r = Object.keys(patch).length > 0 ? await api.updateExpense(id, patch) : { ok: true, body: detail };
      } else {
        // gonder: true creates and sends in one step; if sending is refused nothing is created and the
        // form stays as it is (docs/onay-sistemi.md: POST /api/masraflar).
        r = await api.createExpense({ ...createBody(data), ...(sendAfter ? { gonder: true } : {}) });
      }
      if (!alive) return;
      if (!r.ok) {
        setSaving(false);
        if (!r.unauthorized) showServerError(r.error, { unsaved: sendAfter && !editing });
        return;
      }
      const saved = r.body;
      dirty = false;
      if (sendAfter && editing) {
        const s = await api.expenseAction(saved.id, 'gonder');
        if (!alive) return;
        if (!s.ok) {
          setSaving(false);
          if (s.unauthorized) return;
          if (['karsilik_eksik', 'fatura_eksik', 'fatura_mukerrer'].includes(s.error.kod)) {
            // The changes are saved; stay on the form so the missing equivalents can be entered. The
            // saved form may differ from what this page loaded (another tab), so compare the next save
            // with the server's copy; failing that, with the equivalents it reported missing removed.
            const fresh = await api.getExpense(id, { signal });
            if (!alive) return;
            const gone = new Set(Object.keys(s.error.alanlar ?? {}).map((k) => k.replace(/^yerelKarsiliklar\./, '')));
            detail = fresh.ok ? fresh.body : { ...saved, faturalar: (saved.faturalar ?? []).map((f) => (gone.has(f.id) ? { ...f, yerelKarsilik: null } : f)) };
            syncFromSaved(detail);
            toast('Değişiklikler kaydedildi ama masraf onaya gönderilemedi.', 'err');
            showServerError(s.error);
            return;
          }
          toast(`Masraf kaydedildi ama onaya gönderilemedi: ${s.error.mesaj}`, 'err');
          navigate(`/masraflar/${saved.id}`);
          return;
        }
        toast('Masraf onaya gönderildi.', 'ok');
      } else if (sendAfter) {
        toast('Masraf onaya gönderildi.', 'ok');
      } else {
        toast(editing ? 'Değişiklikler kaydedildi.' : 'Masraf taslak olarak kaydedildi.', 'ok');
      }
      session.refreshMe();
      navigate(`/masraflar/${saved.id}`);
    }

    // ---------- Start ----------

    const onBeforeUnload = (e) => {
      if (dirty && !busy) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    async function init() {
      const tasks = [api.listCategories(false, { signal }), session.loadBaseCurrency()];
      if (editing) tasks.push(api.getExpense(id, { signal }));
      const [cats, b, d] = await Promise.all(tasks);
      if (!alive) return;
      base = b;
      if (editing) {
        if (!d.ok) {
          if (!d.unauthorized) content.replaceChildren(loadFailed(d, d.error.durum === 404 || d.error.durum === 403 ? null : init));
          return;
        }
        detail = d.body;
        setPageTitle(`Düzenle: ${detail.baslik}`);
        if (!detail.izinler?.duzenle) {
          content.replaceChildren(
            el(
              'div',
              { className: 'notice neutral' },
              el('h2', { text: 'Bu masraf düzenlenemez' }),
              el('p', { text: 'Yalnızca taslak ya da reddedilmiş masraflar, sahibi tarafından düzenlenebilir.' }),
              el('div', { className: 'buttons' }, btn('Masrafa dön', { href: expenseHref(id), kind: 'primary' })),
            ),
          );
          return;
        }
      }
      if (!cats.ok) {
        if (!cats.unauthorized) content.replaceChildren(loadFailed(cats, init));
        return;
      }
      categories = (Array.isArray(cats.body) ? cats.body : []).filter((c) => c.aktif !== false).sort((a, b2) => (a.sira ?? 0) - (b2.sira ?? 0));
      if (detail?.kategori && !categories.some((c) => c.id === detail.kategori.id)) categories.push({ ...detail.kategori, aktif: false });

      build();
      if (detail) {
        fillFromDetail(detail);
        const target = focusInvoice ? cards.find((c) => c.id === focusInvoice) : null;
        if (target) openEditor(target);
      }
      else {
        controls.masrafTarihi.value = todayIso();
        renderPanelState();
        if (fromInvoice) linkRecord(fromInvoice);
      }
      updateCurrencyUi();
      schedulePreview();
    }
    init();

    /** The confirmation for leaving with unsaved changes; says what happens to reads under way. */
    function leaveMessage() {
      const parts = [editing ? 'Masraftaki değişiklikler kaydedilmedi. Devam ederseniz kaybolur.' : 'Masraf henüz kaydedilmedi. Devam ederseniz girdikleriniz kaybolur.'];
      const started = cards.filter((c) => c.kind === 'reading' && c.slot).length;
      const queued = cards.filter((c) => c.kind === 'reading' && !c.slot).length;
      if (started > 0) parts.push(started === 1 ? 'Okuması başlamış fatura, Fatura okuma ekranında tamamlanır.' : `Okuması başlamış ${fmtCount(started)} fatura, Fatura okuma ekranında tamamlanır.`);
      if (queued > 0) parts.push(queued === 1 ? 'Sırada bekleyen fatura gönderilmez.' : `Sırada bekleyen ${fmtCount(queued)} fatura gönderilmez.`);
      return parts.join(' ');
    }

    return {
      update() {
        return false; // another expense or invoice: start over
      },
      canLeave() {
        // A save under way navigates by itself; after a save dirty is false.
        if (!alive || !dirty || busy) return true;
        return confirmDialog({
          title: 'Kaydedilmemiş değişiklikler',
          message: leaveMessage(),
          confirmLabel: 'Değişiklikleri at',
          kind: 'danger',
        });
      },
      unmount() {
        alive = false;
        readQueue.length = 0;
        for (const c of cards) cancelRead(c); // frees the connections; the server keeps reading
        schedulePreview.cancel();
        setFileTarget(null);
        window.removeEventListener('beforeunload', onBeforeUnload);
        for (const url of objectUrls) URL.revokeObjectURL(url);
        objectUrls.clear();
      },
    };
  },
};
