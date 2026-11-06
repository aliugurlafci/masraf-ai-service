// Yeni masraf (#/masraflar/yeni, optionally ?fatura=<record id>) and Masrafı düzenle
// (#/masraflar/:id/duzenle). A form holds up to 20 invoices, each in its own card with its own
// reading state. Every chosen, dropped or pasted file is read through the usual reading flow
// (POST /api/invoices; X-Fatura-Id is the record id). The first invoice read fills the fields the
// user has not typed, and until the user types an amount it is the total of the invoices in the
// form's currency. While the amount or the invoices change, POST /api/onay-akisi/onizle shows who
// the expense would go to.

import * as api from '../api.js';
import { el, icon, ICONS, replay } from '../dom.js';
import { fmtAmountInput, fmtCount, fmtCurrency, fmtDateLong, fmtRateInput, modelName, parseAmount, toCents, todayIso } from '../format.js';
import { approverChain, chainLead, expenseHref, invoicePreview } from '../expense-ui.js';
import { totalChecks } from '../invoice.js';
import { categoryIcon } from '../labels.js';
import { navigate } from '../router.js';
import * as session from '../session.js';
import {
  alertBox,
  applyFieldErrors,
  btn,
  clearFieldErrors,
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

/** The invoice's currency as the server compares it: null when it was not read. */
const invoiceCurrency = (f) => f?.paraBirimi ?? null;

/**
 * Mirrors comparableInvoiceTotal in src/expenses/rules.ts: an invoice adds to the amount when its
 * grand total was read and its currency is the form's (or was not read).
 */
function countsToward(f, cur) {
  const t = f?.genelToplam;
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return false;
  const c = invoiceCurrency(f);
  return c === null || c === cur;
}

const isReady = (card) => card.kind === 'done' || card.kind === 'linked';
const isPending = (card) => card.kind === 'reading' || card.kind === 'loading';

function sameList(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export const expenseFormView = {
  mount(root, { route, signal }) {
    const editing = route.name === 'masraf-duzenle';
    const id = editing ? route.params.id : null;
    const fromInvoice = editing ? null : route.query.get('fatura');

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
    // 'linked' (already on the saved form). Each card keeps its own read token.
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
    const readingHint = el('p', { className: 'form-hint', hidden: true });
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
        sendBtn = btn(editing ? 'Kaydet ve onaya gönder' : 'Onaya gönder', { icon: ICONS.send, kind: 'primary', onClick: () => submit(true) });
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
            } else updateLocalHint();
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
      const differs = o.onayTutari !== null && o.onayTutari !== undefined && local !== null && toCents(o.onayTutari) > toCents(local);
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
      if (full) addText.textContent = `Bir masrafa en çok ${MAX_INVOICES} fatura eklenebilir. Yenisini eklemek için birini kaldırın.`;
      else if (pending > 0) addText.textContent = 'Okuma bir dakika kadar sürebilir. Bu sırada kategori ve açıklamayı girebilirsiniz.';
      else addText.textContent = 'Birden çok dosya seçebilir ya da sürükleyip bırakabilirsiniz.';
      setFileTarget({ label: full ? `En çok ${MAX_INVOICES} fatura eklenebilir` : 'Bırakın, faturalar okunsun', onFiles });
      updateSaveState();
    }

    function blockText(pending, failed) {
      if (pending > 0) return pending === 1 ? 'Fatura okunuyor; okuma bitince kaydedebilirsiniz.' : `${fmtCount(pending)} fatura okunuyor; okumalar bitince kaydedebilirsiniz.`;
      return failed === 1
        ? 'Okunamayan faturayı tekrar deneyin ya da kaldırın; sonra kaydedebilirsiniz.'
        : `Okunamayan ${fmtCount(failed)} faturayı tekrar deneyin ya da kaldırın; sonra kaydedebilirsiniz.`;
    }

    /** Saving waits for every read: a card still reading or failed is never dropped silently. */
    function updateSaveState() {
      const pending = cards.filter(isPending).length;
      const failed = cards.filter((c) => c.kind === 'error').length;
      const blocked = pending > 0 || failed > 0;
      readingHint.hidden = !blocked;
      readingHint.classList.toggle('warn', !pending && failed > 0);
      if (blocked) readingHint.replaceChildren(icon(pending > 0 ? ICONS.clock : ICONS.warn), el('span', { text: blockText(pending, failed) }));
      setBusy(saveBtn, busy);
      if (sendBtn) setBusy(sendBtn, busy);
      if (blocked) {
        saveBtn.disabled = true;
        if (sendBtn) sendBtn.disabled = true;
      }
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
        serverError: null,
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
        onClick: () => removeCard(card),
        attrs: { 'aria-label': `${label}: ${card.name}` },
      });
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
        let lead = 'Bağlı fatura';
        if (card.kind === 'done') lead = card.fromRecord ? 'Okunan fatura bağlandı.' : card.onbellek ? 'Daha önce okunmuş; sonuç kayıttan alındı.' : 'Fatura okundu.';
        card.noteSlot = el('div', { className: 'inv-card-notes' });
        add(
          cardTop(card, numberMark(), el('p', { className: 'inv-status ok' }, icon(ICONS.checkCircle), el('span', { text: lead }))),
          el(
            'dl',
            { className: 'kv compact' },
            kv('Fatura no', f.faturaNo ?? 'Okunamadı'),
            kv('Tarih', fmtDateLong(f.faturaTarihi)),
            kv('Satıcı', f.saticiUnvan),
            kv('Genel toplam', fmtCurrency(f.genelToplam, f.paraBirimi)),
          ),
          card.noteSlot,
          problems.length > 0 ? alertBox('warn', 'Okunan rakamları kontrol edin', problems.map((c) => c.text)) : null,
          previewBlock(card),
          el(
            'div',
            { className: 'inv-actions' },
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

    /** Says when an invoice does not add to the amount (another currency, or no total read). */
    function updateCardNote(card) {
      if (!card.noteSlot) return;
      const f = card.fatura ?? {};
      const cur = controls.paraBirimi.value;
      let text = null;
      if (typeof f.genelToplam !== 'number' || !(f.genelToplam > 0)) {
        text = 'Genel toplam okunamadı; bu fatura tutar toplamına ve onay tutarına katılmaz.';
      } else if (!countsToward(f, cur)) {
        text = `Fatura ${invoiceCurrency(f)} cinsinden. Masraf ${cur} olduğu için tutar toplamına ve onay tutarına katılmaz.`;
      }
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
        readCard(card, card.token).finally(() => {
          readsInFlight--;
          pumpReads();
        });
      }
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
      let r;
      try {
        r = await api.sendOne(file, { force: false, tag });
      } finally {
        unwatch();
      }
      if (!alive || card.token !== token || !cards.includes(card)) return;
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
      const url = URL.createObjectURL(file);
      objectUrls.add(url);
      settle(card, {
        kind: 'done',
        id: r.id,
        fatura: r.body.fatura,
        kalemler: r.body.kalemler,
        onbellek: r.body.olcum?.kaynak === 'kayit' || r.res?.headers.get('X-Fatura-Onbellek') === '1',
        preview: { url, mime: file.type, name: card.name },
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

    function removeCard(card, { announce = true, focusTo = null } = {}) {
      const i = cards.indexOf(card);
      if (i < 0) return;
      const hadFocus = card.node?.contains(document.activeElement);
      cards.splice(i, 1);
      card.token = -1; // a read still running for it is forgotten
      card.node?.remove();
      revokePreview(card);
      if (fillSource === card) fillSource = null;
      markDirty();
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
      cards.push(card);
      renderCard(card);
      renderPanelState();
      const r = await api.getRecord(fid, { signal });
      if (!alive || !cards.includes(card)) return;
      if (!r.ok) {
        if (r.unauthorized || r.aborted) return;
        removeCard(card, { announce: false });
        invAlert.replaceChildren(alertBox('err', 'Fatura açılamadı', [r.error.mesaj]));
        return;
      }
      const f = r.body.fatura ?? {};
      markDirty();
      settle(card, { kind: 'done', fromRecord: true, name: f.faturaNo ? `Fatura ${f.faturaNo}` : 'Okunan fatura', fatura: r.body.fatura, kalemler: r.body.kalemler, previewLoading: true });
      const file = await api.getInvoiceFile(fid, { signal });
      if (!alive || !cards.includes(card)) return;
      card.previewLoading = false;
      if (file.ok) {
        const url = URL.createObjectURL(file.blob);
        objectUrls.add(url);
        card.preview = { url, mime: (file.type ?? '').split(';')[0].trim(), name: f.faturaNo ? `${f.faturaNo}` : `fatura-${fid}` };
      }
      // A closed preview fills itself when it is opened.
      if (card.previewSlot?.closest('details')?.open) fillPreview(card, true);
    }

    // ---------- Filling the form from the invoices ----------

    /** The total of the invoices that add to the amount: { value, count } or null. */
    function invoiceTotal() {
      const cur = controls.paraBirimi.value;
      let cents = 0;
      let count = 0;
      for (const c of readyCards()) {
        if (!countsToward(c.fatura, cur)) continue;
        cents += Math.round(c.fatura.genelToplam * 100);
        count++;
      }
      return count > 0 ? { value: cents / 100, count } : null;
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
      if (amountCleared) return alertBox('info', null, [`${controls.paraBirimi.value} cinsinden tutara katılacak fatura kalmadı; tutarı girin.`]);
      if (ready === 0 || autoFilled.size === 0) return null;
      const many = ready > 1;
      const labels = FILL_ORDER.filter((n) => autoFilled.has(n)).map((n) => (n === 'tutar' && many ? 'tutar (faturaların toplamı)' : autoFilled.get(n)));
      return alertBox('ok', null, [`${many ? 'Faturalardan' : 'Faturadan'} dolduruldu: ${labels.join(', ')}. Göndermeden önce kontrol edin.`]);
    }

    function diffNote() {
      const total = invoiceTotal();
      const typed = parseAmount(controls.tutar.value);
      if (!total || typed.error || typed.value === null || toCents(typed.value) === toCents(total.value)) return null;
      const what = total.count > 1 ? 'faturaların genel toplamından' : 'faturanın genel toplamından';
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
      const left = ready - (total?.count ?? 0);
      invSum.replaceChildren(
        ...[
          el(
            'p',
            { className: 'inv-sum-line' },
            el('span', { text: total ? `Faturaların toplamı · ${fmtCount(total.count)} fatura` : `${cur} cinsinden toplanacak fatura yok` }),
            el('strong', { text: total ? fmtCurrency(total.value, cur) : '—' }),
          ),
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

    function currencyChanged() {
      syncAmount();
      updateLocalHint();
      for (const c of cards) updateCardNote(c);
      renderNotes();
      renderSum();
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
            preview: f.dosyaVar ? { url: api.invoiceFileUrl(f.id), mime: f.mime, name: f.dosyaAdi } : null,
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
      return { errors, data };
    }

    function createBody(data) {
      const b = { baslik: data.baslik, kategoriId: data.kategoriId, masrafTarihi: data.masrafTarihi, tutar: data.tutar, paraBirimi: data.paraBirimi };
      if (data.kur !== null) b.kur = data.kur;
      if (data.satici) b.satici = data.satici;
      if (data.aciklama) b.aciklama = data.aciklama;
      if (data.faturaIdler.length > 0) b.faturaIdler = data.faturaIdler;
      return b;
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
      return p;
    }

    /**
     * alanlar["faturaIdler.<i>"] goes under the i-th invoice sent; alanlar.faturaIdler and a 409
     * without alanlar (two saves racing) go over the list.
     */
    function showServerError(e) {
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
      if (listMessages.length > 0) invAlert.replaceChildren(alertBox('err', null, listMessages));
      const invoiceProblem = firstCard !== null || listMessages.length > 0;

      const fieldCount = alanlar ? Object.keys(alanlar).length : 0;
      const leftovers = alanlar ? applyFieldErrors(alanlar, fieldTargets) : [];
      if (!alanlar) {
        summary.replaceChildren(alertBox('err', null, [e.mesaj]));
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
      const { errors, data } = collect();
      if (Object.keys(errors).length > 0) {
        applyFieldErrors(errors, fieldTargets);
        summary.replaceChildren(alertBox('err', 'Formu kontrol edin', ['İşaretli alanları düzeltin.']));
        return;
      }
      sentCards = readyCards();
      setSaving(true);
      let r;
      if (editing) {
        const patch = patchBody(data, detail);
        r = Object.keys(patch).length > 0 ? await api.updateExpense(id, patch) : { ok: true, body: detail };
      } else {
        r = await api.createExpense(createBody(data));
      }
      if (!alive) return;
      if (!r.ok) {
        setSaving(false);
        if (!r.unauthorized) showServerError(r.error);
        return;
      }
      const saved = r.body;
      dirty = false;
      if (sendAfter) {
        const s = await api.expenseAction(saved.id, 'gonder');
        if (!alive) return;
        if (!s.ok) {
          setSaving(false);
          if (s.unauthorized) return;
          toast(`Masraf kaydedildi ama onaya gönderilemedi: ${s.error.mesaj}`, 'err');
          navigate(`/masraflar/${saved.id}`);
          return;
        }
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
      if (detail) fillFromDetail(detail);
      else {
        controls.masrafTarihi.value = todayIso();
        renderPanelState();
        if (fromInvoice) linkRecord(fromInvoice);
      }
      updateCurrencyUi();
      schedulePreview();
    }
    init();

    return {
      update() {
        return false; // another expense or invoice: start over
      },
      unmount() {
        alive = false;
        readQueue.length = 0;
        for (const c of cards) c.token = -1;
        schedulePreview.cancel();
        setFileTarget(null);
        window.removeEventListener('beforeunload', onBeforeUnload);
        for (const url of objectUrls) URL.revokeObjectURL(url);
        objectUrls.clear();
      },
    };
  },
};
