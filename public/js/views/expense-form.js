// Yeni masraf (#/masraflar/yeni, optionally ?fatura=<record id>) and Masrafı düzenle
// (#/masraflar/:id/duzenle). A form holds up to 20 invoices, each in its own card with its own
// reading state. Chosen, dropped or pasted files go to the shared reading line with
// POST /api/invoices/toplu; GET /api/invoices/toplu/:id is asked every few seconds until each file is
// read or failed, and each card shows its place in the line ("Sırada 3. · önünde 4 fatura var").
// The first invoice read fills the fields the user has not typed, and until the user types an amount
// it is the invoices' total in the form's currency (equivalents.js). An invoice in a third currency
// (neither the form's nor the base one) asks for its base-currency equivalent; without it the expense
// can be saved as a draft but not sent. While the amount or the invoices change,
// POST /api/onay-akisi/onizle shows who the expense would go to.
//
// The user need not wait for the reads (docs/onay-sistemi.md, "Arka planda okuma"): a draft can be
// saved with the files still being read (bekleyenFaturalar, by their SHA-256 dosyaOzeti) and with
// no amount; the server keeps reading, adds each invoice to the form and, if asked
// (okununcaGonder), sends the form once every file is read. When an expense with such files is
// edited, they show as cards of their own and GET /api/masraflar/:id is asked every few seconds.

import * as api from '../api.js';
import { listSearch, searchSelect } from '../combo.js';
import { el, icon, ICONS, replay } from '../dom.js';
import { fmtAmountInput, fmtCount, fmtCurrency, fmtDateLong, fmtRateInput, modelName, parseAmount, queueText, toCents, todayIso } from '../format.js';
import { approverChain, chainLead, expenseHref, invoicePreview } from '../expense-ui.js';
import { invoicesTotal, needsEquivalent } from '../equivalents.js';
import { entryFields, formRequired, hasValue, labelFrom, receiptMissing, receiptRequired, shownOf, TEXT_MAX, valuesOf } from '../fields.js';
import { editInvoiceDialog, HEADER_FIELDS, labelOf, missingOf, pathLabel, pickInvoice, REQUIRED, sameInvoice } from '../invoice-edit.js';
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
// docs/onay-sistemi.md, section 3: at most 20 invoices on one form, each once (files still being
// read count too).
const MAX_INVOICES = 20;
// How often a multi-file send (or, when editing, the saved form) is asked again while a file is
// waiting or being read; slower after a failed call.
const POLL_MS = 3000;
const DETAIL_POLL_MS = 4000;
const POLL_RETRY_MS = 8000;

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

/** The live activity of a file being read (okuma.js watchTag): which model reads it. */
function modelText(a) {
  if (!a?.model) return 'Claude okumaya başlıyor.';
  if ((a.modeller?.length ?? 0) > 1) return `Kontroller tutmadı; ${modelName(a.model)} yeniden okuyor.`;
  return `${modelName(a.model)} okuyor.`;
}

/**
 * The status line of a card still being read. card.queue ({ durum, kuyrukSirasi, onundeki }) comes
 * from the multi-file send, the live feed or (saved files) the expense itself.
 */
function readingText(card) {
  const q = card.queue;
  if (card.source === 'server') {
    if (q?.durum === 'okunuyor') return 'Okunuyor. Sayfadan çıksanız da okuma sürer.';
    return queueText(q?.kuyrukSirasi, q?.onundeki);
  }
  if (!q) return card.uploading ? 'Sunucuya gönderiliyor…' : 'Sırada';
  if (q.durum === 'sirada') return queueText(q.kuyrukSirasi, q.onundeki);
  if (q.durum === 'okunuyor') return modelText(card.activity?.durum === 'okunuyor' ? card.activity : null);
  if (q.durum === 'bitti') return 'Okundu; sonuç geliyor.';
  return 'Okunuyor…';
}

const hasTotal = (f) => typeof f?.genelToplam === 'number' && Number.isFinite(f.genelToplam) && f.genelToplam > 0;

const isReady = (card) => card.kind === 'done' || card.kind === 'linked';
/** Not on the server yet: a ?fatura= record being fetched, or a file still being uploaded. */
const isUploading = (card) => card.kind === 'loading' || (card.kind === 'reading' && card.source !== 'server' && !card.hash);
/** Saved with the form as a file still being read (bekleyenFaturalar): reading, or failed on the server. */
const isAwaiting = (card) => (card.kind === 'reading' && Boolean(card.hash)) || (card.kind === 'error' && card.source === 'server');
/** Failed here (upload or read of a file sent from this page): retried or removed before saving. */
const isLocalError = (card) => card.kind === 'error' && card.source !== 'server';
const isReadingNow = (card) => card.kind === 'reading' && card.queue?.durum === 'okunuyor';

/** null-safe amount comparison to the cent (a draft's amount may be empty). */
function sameMoney(a, b) {
  const na = a === null || a === undefined;
  const nb = b === null || b === undefined;
  return na || nb ? na === nb : toCents(a) === toCents(b);
}

function sameList(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Same keys with the same amounts (to the cent). */
function sameAmounts(a, b) {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => k in b && toCents(a[k]) === toCents(b[k]));
}

const HEADER_KEYS = new Set(HEADER_FIELDS.map((f) => f.key));

/** A number typed the Turkish way (-1.800,5) or plainly (1800.5): { value } (null when empty) or { error }. */
function parseNumber(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return { value: null };
  const negative = raw.startsWith('-');
  const p = parseAmount(negative ? raw.slice(1) : raw, { decimals: 10 });
  if (p.error || p.value === null) return { error: 'Geçerli bir sayı girin.' };
  return { value: negative ? -p.value : p.value };
}

/**
 * One receipt's values as fisAlanlari sends them: an option id for 'liste', a number for 'sayi',
 * trimmed text otherwise; empty values are left out. → { values, errors } (errors by field key).
 */
function normalizeValues(defs, raw) {
  const values = {};
  const errors = {};
  for (const f of defs) {
    const v = raw?.[f.anahtar];
    if (!hasValue(v)) continue;
    if (f.tur === 'liste') values[f.anahtar] = Number(v);
    else if (f.tur === 'sayi') {
      const p = typeof v === 'number' ? { value: v } : parseNumber(v);
      if (p.error) errors[f.anahtar] = p.error;
      else if (p.value !== null) values[f.anahtar] = p.value;
    } else {
      const text = String(v).trim();
      const max = TEXT_MAX[f.tur];
      if (max && text.length > max) errors[f.anahtar] = `En çok ${max} karakter olabilir.`;
      else if (text) values[f.anahtar] = text;
    }
  }
  return { values, errors };
}

const sameValues = (a, b) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => k in b && a[k] === b[k]);
};

/** The mark after a required field's name; hidden while the field is optional. */
const reqMark = () => el('span', { className: 'req', 'aria-hidden': 'true', hidden: true, text: ' *' });

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
    // cards: the form's invoices in list order; ready ones are saved in this order (faturaIdler),
    // files still being read in theirs (bekleyenFaturalar).
    // kind: 'loading' (a ?fatura= record being fetched) | 'reading' | 'error' | 'done' (read here) |
    // 'linked' (already on the saved form). source 'server' marks a file the saved form holds as still
    // being read (bekleyenFaturalar); its 'error' is the server's and "Yeniden oku" retries it. Any other
    // reading card was sent from this page in a batch (one POST /api/invoices/toplu) and carries its
    // place there (batch, sira) and, once the server answered, its SHA-256 (hash = dosyaOzeti).
    const cards = [];
    let cardSeq = 0;
    const batches = new Set(); // { tag, id, cards, ctl, timer, polling, ended, unwatch }
    let fillSource = null; // the card whose date, vendor, title and currency went into the form
    let amountAuto = false; // the amount field holds the invoices' total rather than a typed amount
    const autoFilled = new Map(); // control name -> label, for fields that hold a value from the invoices
    let amountCleared = false; // the invoices' total went away, so the amount was emptied
    let sentCards = []; // ready cards in the order of the last save, for alanlar["faturaIdler.<i>"]
    let sentPending = []; // awaiting cards in the order of the last save, for alanlar["bekleyenFaturalar.<i>"]
    let detailTimer = null; // editing: asks the saved form again while its files are being read
    let rereading = false; // editing: POST yeniden-oku under way
    let droppedPending = false; // editing: the user took a saved file-being-read off the list
    let sendWhenReadTouched = false; // the user changed the "send when read" box
    let locked = false; // editing: the form was sent (or changed) elsewhere and can no longer be saved
    // Field management (docs section 3, "Fiş alanları"): GET /api/alanlar (active fields and rules);
    // null until loaded, or when it could not be loaded (then only the four classic invoice fields count).
    let fieldInfo = null;
    let entry = []; // the active receipt fields a sender fills in, in order
    let myCentres = []; // Kullanici.masrafMerkezleri of the signed-in user

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
      // Not required for a draft: with invoices still being read it is filled once they are read.
      tutar: input({ name: 'tutar', inputmode: 'decimal', autocomplete: 'off', placeholder: '0,00', className: 'input num' }),
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
    const tutarHint = el('span');
    // Masraf merkezi: one of the user's active cost centres; hidden while the field is inactive.
    const mmSelect = select([], { name: 'masrafMerkeziId' });
    const mmReq = reqMark();
    const mmHint = el('span');
    const mmField = field({ label: el('span', {}, el('span', { text: 'Masraf merkezi' }), mmReq), input: mmSelect, hint: mmHint, className: 'mm-field' });
    mmField.hidden = true;
    const fieldTargets = { ...controls, kategoriId: catFieldset, masrafMerkeziId: mmSelect };
    const fieldsNote = el('div', { className: 'fields-note' });

    const summary = el('div', { className: 'form-alert', tabindex: '-1' });
    const approversBody = el('div', { className: 'approvers-body', 'aria-live': 'polite' });
    const readingHint = el('p', { className: 'form-hint', id: 'save-hint', hidden: true });
    const saveBtn = btn(editing ? 'Kaydet' : 'Taslak kaydet', { icon: ICONS.check, type: 'submit' });
    let sendBtn = null;

    // "Okumalar bitince onaya gönder" (okununcaGonder): offered while files are being read.
    const sendWhenRead = el('input', { type: 'checkbox', className: 'check', id: 'okg', name: 'okununcaGonder', 'aria-describedby': 'okg-hint' });
    const sendWhenReadBox = el(
      'div',
      { className: 'okg', hidden: true },
      el('label', { className: 'check-label', for: 'okg' }, sendWhenRead, el('span', { text: 'Okumalar bitince onaya gönder' })),
      el('p', { className: 'hint', id: 'okg-hint', text: 'Bütün faturalar okununca masraf kendiliğinden onaya gönderilir. Gönderilemezse nedeniyle birlikte bildirim gelir.' }),
    );
    sendWhenRead.addEventListener('change', () => {
      sendWhenReadTouched = true;
      markDirty();
    });

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

    // ---------- Field management: the cost centre and each receipt's fields ----------
    // docs section 3: the form has one cost centre; every receipt (a read invoice, or a file still
    // being read) carries its own values. fields.js mirrors the server's required-field rule only for
    // the asterisks and the warnings.

    const mmActive = () => Boolean(fieldInfo?.list.some((f) => f.anahtar === 'masrafMerkezi'));

    /** What the rules look at on the form. */
    function formState() {
      const checked = catGrid.querySelector('input:checked');
      return {
        kategoriId: checked ? Number(checked.value) : null,
        masrafMerkeziId: mmActive() && mmSelect.value !== '' ? Number(mmSelect.value) : null,
      };
    }

    /** The invoice id once read, the file's SHA-256 while it is read (fisAlanlari keys). */
    const receiptKey = (card) => (isReady(card) ? card.id : card.hash);

    /** The user's active cost centres, plus a saved one that is no longer among them (kept, shown, sendable). */
    function fillCentres(saved) {
      mmField.hidden = !mmActive();
      if (mmField.hidden) return;
      const active = myCentres.filter((m) => m.aktif !== false);
      const options = [el('option', { value: '', text: active.length === 0 && !saved ? 'Size tanımlı masraf merkezi yok' : 'Seçin…' })];
      for (const m of active) options.push(el('option', { value: String(m.id), text: m.gosterim ?? m.kod }));
      if (saved && !active.some((m) => m.id === saved.id)) {
        options.push(el('option', { value: String(saved.id), text: `${saved.gosterim ?? saved.kod} (${saved.aktif === false ? 'pasif' : 'size artık tanımlı değil'})` }));
      }
      mmSelect.replaceChildren(...options);
      // A single centre is chosen for the user (the server does the same on a new form).
      mmSelect.value = saved ? String(saved.id) : active.length === 1 ? String(active[0].id) : '';
      mmSelect.disabled = options.length === 1;
      const about = fieldInfo.list.find((f) => f.anahtar === 'masrafMerkezi')?.aciklama ?? '';
      let hint = about;
      if (active.length === 0) hint = 'Size tanımlı aktif masraf merkezi yok; yöneticinizden tanımlamasını isteyin.';
      else if (saved && !active.some((m) => m.id === saved.id)) hint = 'Kayıtlı masraf merkezi artık seçilemiyor; onaya göndermek için size tanımlı olanlardan birini seçin.';
      mmHint.textContent = hint;
      if (mmHint.parentElement) mmHint.parentElement.hidden = hint === '';
    }

    /** The invoice header fields required on this receipt now (asterisks in the invoice editor). */
    function requiredHeader(card) {
      if (!fieldInfo) return REQUIRED;
      const req = receiptRequired(fieldInfo.list, fieldInfo.rules, formState(), card.values);
      return HEADER_FIELDS.map((f) => f.key).filter((k) => req.has(k));
    }

    /** Required receipt fields (not the invoice header) that are empty on this receipt. */
    function fisMissing(card) {
      if (!fieldInfo) return [];
      return receiptMissing(fieldInfo.list, fieldInfo.rules, formState(), { values: card.values, invoice: null }).filter((k) => !HEADER_KEYS.has(k));
    }

    const textOf = (f, v) => (!hasValue(v) ? '' : f.tur === 'sayi' && typeof v === 'number' ? fmtRateInput(v) : String(v));

    /** One receipt field's control; its value lives on the card, so it survives the card turning into an invoice. */
    function fisControl(card, f) {
      const k = f.anahtar;
      const req = reqMark();
      const label = el('span', {}, el('span', { text: f.ad }), req);
      const changed = (value, shown) => {
        if (hasValue(value)) card.values[k] = value;
        else delete card.values[k];
        if (shown !== undefined) {
          if (shown) card.shown[k] = shown;
          else delete card.shown[k];
        }
        card.fisTouched = true;
        markDirty();
        refreshCard(card);
        updateSaveState();
      };
      let inputEl;
      let control;
      let combo = null;
      if (f.tur === 'liste') {
        const v = card.values[k];
        combo = searchSelect({
          value: hasValue(v) ? { id: v, label: card.shown[k] ?? `#${v}` } : null,
          placeholder: 'Arayın ve seçin…',
          label: f.ad,
          search: listSearch((p, o) => api.listOptions(k, p, o), (s) => ({ id: s.id, label: s.gosterim ?? s.kod })),
          onChange: (it) => {
            setFieldError(combo.input, null);
            changed(it ? it.id : null, it ? it.label : null);
          },
        });
        inputEl = combo.input;
        control = combo.node;
      } else if (f.tur === 'uzun_metin') {
        inputEl = textarea({ name: `fis-${card.key}-${k}`, rows: 2, maxlength: TEXT_MAX.uzun_metin });
        inputEl.value = textOf(f, card.values[k]);
      } else {
        const props = { name: `fis-${card.key}-${k}`, autocomplete: 'off', value: textOf(f, card.values[k]) };
        if (f.tur === 'tarih') props.type = 'date';
        else if (f.tur === 'sayi') Object.assign(props, { inputmode: 'decimal', className: 'input num' });
        else props.maxlength = TEXT_MAX.metin;
        inputEl = input(props);
      }
      if (!combo) {
        inputEl.addEventListener('input', () => {
          setFieldError(inputEl, null);
          changed(inputEl.value);
        });
        if (f.tur === 'sayi') {
          inputEl.addEventListener('blur', () => {
            const p = parseNumber(inputEl.value);
            if (p.error) setFieldError(inputEl, p.error);
          });
        }
      }
      const box = field({ label, input: inputEl, control, hint: f.aciklama || null, className: `fis-field fis-${f.tur}` });
      return { field: box, input: inputEl, req, combo, def: f };
    }

    /** The receipt fields of a card: built once and moved with the card, so typing never loses the focus. */
    function fisBlock(card) {
      if (!fieldInfo || entry.length === 0) return null;
      if (card.fis) return card.fis.node;
      const controls = {};
      const grid = el('div', { className: 'fis-grid' });
      for (const f of entry) {
        controls[f.anahtar] = fisControl(card, f);
        grid.append(controls[f.anahtar].field);
      }
      const missing = el('p', { className: 'fis-missing', hidden: true }, icon(ICONS.alert), el('span'));
      const titleId = `fis-h-${card.key}`;
      const node = el(
        'div',
        { className: 'fis-block', role: 'group', 'aria-labelledby': titleId },
        el('p', { className: 'fis-title', id: titleId }, el('span', { text: 'Fiş alanları' }), el('span', { className: 'visually-hidden', text: `: ${card.name}` })),
        grid,
        missing,
      );
      card.fis = { node, controls, missing };
      markFis(card);
      return node;
    }

    /** Asterisks and the "empty required" line of one card's receipt fields. */
    function markFis(card, form = formState()) {
      if (!card.fis || !fieldInfo) return;
      const req = receiptRequired(fieldInfo.list, fieldInfo.rules, form, card.values);
      const gaps = [];
      for (const f of entry) {
        const c = card.fis.controls[f.anahtar];
        if (!c) continue;
        const on = req.has(f.anahtar);
        c.req.hidden = !on;
        c.input.setAttribute('aria-required', String(on));
        if (on && !hasValue(card.values[f.anahtar])) gaps.push(f.ad);
      }
      card.fis.missing.hidden = gaps.length === 0;
      card.fis.missing.lastChild.textContent = gaps.length > 0 ? `Zorunlu alan boş: ${gaps.join(', ')}. Onaya göndermek için doldurun.` : '';
    }

    /** One card after its values (or the form) changed: its marks, and the header line if it moved. */
    function refreshCard(card, form = formState()) {
      markFis(card, form);
      if (isReady(card) && card.headerShown !== undefined && card.headerShown !== missingFor(card).join(',')) renderCard(card);
    }

    /** The category or the cost centre changed: every asterisk may move. */
    function refreshRequired() {
      if (!fieldInfo) return;
      const form = formState();
      const mmOn = formRequired(fieldInfo.list, fieldInfo.rules, form).has('masrafMerkezi');
      mmReq.hidden = !mmOn;
      mmSelect.setAttribute('aria-required', String(mmOn));
      for (const card of cards) refreshCard(card, form);
      updateSaveState();
    }

    /** Values the server holds for a receipt; they show unless the user already typed on this page. */
    function adoptValues(card, alanlar) {
      card.savedValues = valuesOf(alanlar);
      if (card.fisTouched) return;
      card.values = { ...card.savedValues };
      card.shown = shownOf(alanlar);
      if (!card.fis) return;
      for (const f of entry) {
        const c = card.fis.controls[f.anahtar];
        if (!c || c.input === document.activeElement) continue;
        const v = card.values[f.anahtar];
        if (c.combo) c.combo.setValue(hasValue(v) ? { id: v, label: card.shown[f.anahtar] ?? `#${v}` } : null);
        else c.input.value = textOf(f, v);
      }
      markFis(card);
    }

    /** Leads to a receipt's first empty required field, marking each empty one. */
    function showFisGaps(card) {
      const gaps = fisMissing(card);
      if (!card.fis || gaps.length === 0) return false;
      for (const k of gaps) setFieldError(card.fis.controls[k]?.input, `${fieldInfo.list.find((f) => f.anahtar === k)?.ad ?? k} zorunlu.`);
      const first = card.fis.controls[gaps[0]]?.input;
      card.node?.scrollIntoView({ block: 'nearest' });
      first?.focus();
      return true;
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
              mmField,
              fieldsNote,
              el(
                'div',
                { className: 'field-row money-row' },
                field({ label: 'Masraf tarihi', input: controls.masrafTarihi, className: 'date-field' }),
                field({ label: 'Tutar', input: controls.tutar, hint: tutarHint }),
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
              sendWhenReadBox,
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
            else {
              updateLocalHint();
              updateSaveState(); // an empty amount keeps the send button off
            }
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
        refreshRequired(); // a rule may hang on the category
      });
      mmSelect.addEventListener('change', () => {
        markDirty();
        setFieldError(mmSelect, null);
        refreshRequired();
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
        const waiting = cards.some((c) => c.kind === 'reading');
        showApprovers('idle', waiting ? 'Tutar faturalar okununca dolar; onaycılar o zaman burada görünür. İsterseniz tutarı şimdi girebilirsiniz.' : 'Tutarı girdiğinizde masrafın gideceği onaycılar burada görünür.');
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
      const pending = cards.filter((c) => c.kind === 'reading' || c.kind === 'loading').length;
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
      addBtn.disabled = full || busy || locked;
      // While the expense is being saved the invoice list is fixed: no adding, removing or retrying.
      const pick = invDrop.querySelector('button');
      if (pick) pick.disabled = busy || locked;
      for (const b of invList.querySelectorAll('.inv-actions button')) b.disabled = busy || locked || (rereading && b.dataset.reread !== undefined);
      if (full) addText.textContent = `Bir masrafa en çok ${MAX_INVOICES} fatura eklenebilir. Yenisini eklemek için birini kaldırın.`;
      else if (pending > 0) addText.textContent = 'Okumayı beklemeniz gerekmez: masrafı taslak olarak kaydedip çıkabilirsiniz; faturalar okununca bildirim gelir.';
      else addText.textContent = 'Birden çok dosya seçebilir ya da sürükleyip bırakabilirsiniz.';
      setFileTarget(busy || locked ? null : { label: full ? `En çok ${MAX_INVOICES} fatura eklenebilir` : 'Bırakın, faturalar okunsun', onFiles });
      updateSaveState();
    }

    function failedText(failed) {
      return failed === 1
        ? 'Okunamayan faturayı tekrar deneyin ya da kaldırın; sonra kaydedebilirsiniz.'
        : `Okunamayan ${fmtCount(failed)} faturayı tekrar deneyin ya da kaldırın; sonra kaydedebilirsiniz.`;
    }

    const uploadingText = (n) => (n === 1 ? 'Dosya sunucuya gönderiliyor; birazdan kaydedebilirsiniz.' : `${fmtCount(n)} dosya sunucuya gönderiliyor; birazdan kaydedebilirsiniz.`);

    function readingNote(n) {
      const who = n === 1 ? 'Bir fatura' : `${fmtCount(n)} fatura`;
      return `${who} okunuyor. Onaya göndermek için okumaların bitmesi gerekir; şimdi kaydedip çıkabilirsiniz, okununca bildirim gelir.`;
    }

    function serverFailedText(n) {
      const who = n === 1 ? 'Bir fatura' : `${fmtCount(n)} fatura`;
      return `${who} okunamadı. Onaya göndermeden önce yeniden okutun ya da kaldırın; masrafı bu haliyle kaydedebilirsiniz.`;
    }

    function missingText(n) {
      const who = n === 1 ? 'Bir faturanın' : `${fmtCount(n)} faturanın`;
      return `${who} ${base} karşılığı girilmedi; onaya göndermek için girin. Taslak olarak kaydedebilirsiniz.`;
    }

    /** An empty amount may be saved on a new form or a draft; a rejected form keeps its amount. */
    const amountMayBeEmpty = () => !editing || detail?.durum === 'taslak';

    /**
     * Saving waits for files still being uploaded and for failed reads of files sent from here (a card
     * is never dropped silently); files that are on the server go with the draft and are read there.
     * Sending also waits for every read and an amount; a missing equivalent blocks only sending (the
     * server would answer 409 karsilik_eksik). The hint says the first thing that stands in the way.
     */
    function updateSaveState() {
      const uploading = cards.filter(isUploading).length;
      const failed = cards.filter(isLocalError).length;
      const reading = cards.filter((c) => c.kind === 'reading' && Boolean(c.hash)).length;
      const serverFailed = cards.filter((c) => c.kind === 'error' && c.source === 'server').length;
      const saveBlocked = locked || uploading > 0 || failed > 0;
      const amountEmpty = parseAmount(controls.tutar.value).value === null;
      const missing = sendBtn ? equivalents().missing.length : 0;
      // Only a hint: the server decides whether the form can be sent.
      const incomplete = sendBtn ? readyCards().filter((c) => missingFor(c).length > 0).length : 0;
      // Receipt fields and the cost centre only warn: the server answers 409 alan_eksik and the panel marks the fields.
      const fisGaps = sendBtn && fieldInfo ? cards.filter((c) => (isReady(c) || isAwaiting(c)) && fisMissing(c).length > 0).length : 0;
      const mmGap = Boolean(sendBtn && mmActive() && !mmReq.hidden && mmSelect.value === '');
      const sendBlocked = saveBlocked || reading > 0 || serverFailed > 0 || amountEmpty || missing > 0;

      let line = null; // [glyph, text, warn]
      if (locked) line = null;
      else if (uploading > 0) line = [ICONS.clock, uploadingText(uploading), false];
      else if (failed > 0) line = [ICONS.warn, failedText(failed), true];
      else if (reading > 0) line = [ICONS.clock, readingNote(reading), false];
      else if (sendBtn && serverFailed > 0) line = [ICONS.warn, serverFailedText(serverFailed), true];
      else if (sendBtn && amountEmpty) line = [ICONS.info, 'Onaya göndermek için tutarı girin. Taslak olarak kaydedebilirsiniz.', false];
      else if (missing > 0) line = [ICONS.warn, missingText(missing), true];
      else if (incomplete > 0) {
        line = [
          ICONS.warn,
          `${incomplete === 1 ? 'Bir faturada' : `${fmtCount(incomplete)} faturada`} zorunlu fatura bilgisi boş; onaya göndermeden önce “Eksikleri doldur” ile tamamlayın. Taslak olarak kaydedebilirsiniz.`,
          true,
        ];
      } else if (mmGap || fisGaps > 0) {
        const parts = [mmGap ? 'Masraf merkezi seçilmedi' : null, fisGaps > 0 ? `${fisGaps === 1 ? 'bir fişte' : `${fmtCount(fisGaps)} fişte`} zorunlu alan boş` : null].filter(Boolean);
        const text = parts.join(' ve ');
        line = [ICONS.warn, `${text.charAt(0).toLocaleUpperCase('tr-TR')}${text.slice(1)}; onaya göndermek için doldurun. Taslak olarak kaydedebilirsiniz.`, true];
      }
      readingHint.hidden = line === null;
      if (line) {
        readingHint.classList.toggle('warn', line[2]);
        readingHint.replaceChildren(icon(line[0]), el('span', { text: line[1] }));
      }

      // The amount may stay empty while invoices are being read: the server fills it.
      const awaiting = cards.filter(isAwaiting).length + uploading;
      let tutarHintText = '';
      if (awaiting > 0 && amountMayBeEmpty()) {
        if (amountEmpty) tutarHintText = 'Boş bırakabilirsiniz; faturalar okununca toplamları yazılır.';
        else if (amountAuto) tutarHintText = 'Şimdilik okunan faturaların toplamı; bütün faturalar okununca güncellenir.';
      }
      if (tutarHint.textContent !== tutarHintText) tutarHint.textContent = tutarHintText;
      if (tutarHint.parentElement) tutarHint.parentElement.hidden = tutarHintText === '';

      // "Send when read" makes sense only while something is still to be read.
      const offer = !locked && cards.some((c) => c.kind === 'reading' || (c.kind === 'error' && c.source === 'server'));
      sendWhenReadBox.hidden = !offer;
      sendWhenRead.disabled = busy;

      setBusy(saveBtn, busy);
      if (sendBtn) setBusy(sendBtn, busy);
      if (saveBlocked) saveBtn.disabled = true;
      if (sendBtn && sendBlocked) sendBtn.disabled = true;
    }

    // ---------- One invoice card ----------

    function newCard(props) {
      return {
        key: ++cardSeq,
        kind: 'reading',
        id: null,
        name: 'Fatura',
        file: null,
        abort: null, // the ?fatura= record fetch
        source: null, // 'server': a file the saved form holds as still being read
        hash: null, // dosyaOzeti (SHA-256) once the server has the file
        batch: null, // the multi-file send this file went out in, and its place there (sira, 1-based)
        sira: 0,
        uploading: false,
        finishing: false, // its result is being fetched; later answers are ignored
        queue: null, // { durum, kuyrukSirasi, onundeki }
        since: new Date().toISOString(),
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
        // Receipt fields (fisAlanlari): this receipt's values ({ anahtar: deger }), the labels of chosen
        // options, what the server holds, whether the user typed here, and the controls (built once).
        values: {},
        shown: {},
        savedValues: {},
        fisTouched: false,
        fis: null,
        headerShown: undefined, // the empty header fields the card shows, to redraw it when they change
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
      const active = document.activeElement;
      const hadFocus = card.node?.contains(active);
      // A receipt field being typed into moves with the card (a read finishing): it keeps the focus and the caret.
      const inFis = Boolean(hadFocus && card.fis?.node.contains(active));
      let caret = null;
      try {
        caret = inFis && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
      } catch {
        caret = null;
      }
      const next = cardNode(card);
      if (card.node?.isConnected) card.node.replaceWith(next);
      else {
        next.classList.add('enter');
        invList.append(next);
      }
      card.node = next;
      if (inFis && active.isConnected) {
        active.focus({ preventScroll: true });
        try {
          if (caret) active.setSelectionRange(caret[0], caret[1]);
        } catch {
          // date inputs have no caret
        }
      } else if (hadFocus) (next.querySelector('.inv-actions > :first-child') ?? next).focus();
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
          if (!busy && !locked) removeCard(card);
        },
        attrs: { 'aria-label': `${label}: ${card.name}` },
      });
    }

    const isCorrected = (card) => (card.corr !== undefined ? card.corr !== null : card.duzeltildi);

    /**
     * Empty required invoice header fields. With the field list: worked out like the server does
     * (fields.js, the valid data, the form's category and cost centre, the receipt's values). Without
     * it: the server's list for a saved invoice until it is edited here, else the four classic fields.
     */
    const missingFor = (card) => {
      if (fieldInfo) return receiptMissing(fieldInfo.list, fieldInfo.rules, formState(), { values: card.values, invoice: card.fatura ?? {} }).filter((k) => HEADER_KEYS.has(k));
      return card.corr === undefined && card.eksik ? card.eksik.filter((k) => HEADER_KEYS.has(k)) : missingOf(card.fatura);
    };

    /** The invoice's valid data as the schema's shape. */
    const validData = (card) => pickInvoice(card.fatura, card.kalemler);

    async function openEditor(card) {
      if (busy || !isReady(card)) return;
      const result = await editInvoiceDialog({
        title: `Fatura bilgileri: ${card.name}`,
        current: validData(card),
        errors: card.pathErrors,
        canRevert: isCorrected(card),
        required: requiredHeader(card),
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
        // The place in the line changes every few seconds: not a live region (the outcome is announced).
        card.statusNode = el('p', { className: 'inv-status', text: readingText(card) });
        const server = card.source === 'server';
        add(
          el(
            'div',
            { className: 'inv-card-top' },
            el('span', { className: `sheet-glyph${isReadingNow(card) ? ' active' : ''}`, 'aria-hidden': 'true' }, el('span', { className: 'scan' })),
            el('div', { className: 'inv-card-text' }, el('p', { className: 'inv-file', text: card.name }), card.statusNode),
            server ? null : el('span', { className: 'inv-clock', 'data-since': card.since, 'data-fmt': 'clock', text: '0:00' }),
          ),
          server ? el('p', { className: 'inv-card-note' }, icon(ICONS.info), el('span', { text: 'Masrafa kayıtlı; arka planda okunuyor. Okununca bu listeye fatura olarak eklenir.' })) : null,
          // The receipt's fields can be filled while it is read; the values stay when it becomes an invoice.
          fisBlock(card),
          el('div', { className: 'inv-actions' }, removeButton(card, server ? 'Kaldır' : 'Vazgeç')),
        );
      } else if (card.kind === 'error') {
        // A saved file the server could not read goes back in line with POST yeniden-oku; a file sent
        // from here is sent again.
        const server = card.source === 'server';
        const retriable = server || (!FINAL_ERRORS.has(card.error?.kod) && card.file);
        const retryLabel = server ? 'Yeniden oku' : 'Tekrar dene';
        add(
          cardTop(card, numberMark(), el('p', { className: 'inv-status', text: 'Okunamadı' })),
          alertBox('err', null, [card.error?.mesaj ?? 'Bilinmeyen bir hata oluştu.']),
          server ? el('p', { className: 'inv-card-note' }, icon(ICONS.info), el('span', { text: 'Okunamayan fatura varken masraf onaya gönderilemez. Yeniden okutun ya da kaldırın.' })) : null,
          // A file that failed here keeps its values for the retry; one saved on the form shows them.
          server ? fisBlock(card) : null,
          el(
            'div',
            { className: 'inv-actions' },
            retriable
              ? btn(retryLabel, {
                  icon: ICONS.refresh,
                  size: 'sm',
                  onClick: () => (server ? rereadSaved() : retryCard(card)),
                  attrs: { 'aria-label': `${retryLabel}: ${card.name}`, ...(server ? { 'data-reread': '' } : {}) },
                })
              : null,
            removeButton(card),
          ),
        );
      } else {
        const f = card.fatura ?? {};
        const problems = card.kalemler ? totalChecks({ fatura: f, kalemler: card.kalemler }).filter((c) => !c.ok) : [];
        const gone = missingFor(card);
        card.headerShown = gone.join(',');
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
          fisBlock(card),
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
      if (busy || locked) for (const b of li.querySelectorAll('.inv-actions button')) b.disabled = true;
      else if (rereading) for (const b of li.querySelectorAll('[data-reread]')) b.disabled = true;
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
      if (card.kind !== 'reading') return;
      const text = readingText(card);
      if (card.statusNode && card.statusNode.textContent !== text) card.statusNode.textContent = text;
      card.node?.querySelector('.sheet-glyph')?.classList.toggle('active', isReadingNow(card));
    }

    // ---------- Adding, reading and removing ----------

    function onFiles(files) {
      const list = files.filter(Boolean);
      if (list.length === 0 || !alive || locked) return;
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
      const added = accepted.map((file) => newCard({ kind: 'reading', file, name: file.name || 'Fatura', uploading: true }));
      for (const card of added) {
        cards.push(card);
        renderCard(card);
      }
      markDirty();
      tickClocks();
      say(added.length === 1 ? `${added[0].name} okumaya gönderiliyor.` : `${fmtCount(added.length)} fatura okumaya gönderiliyor.`);
      renderPanelState();
      upload(added);
    }

    /** One request per group, one after another, so the server lines the files up in the order they were added. */
    async function upload(list) {
      let at = 0;
      for (const group of api.splitForSending(list.map((c) => c.file))) {
        const part = list.slice(at, at + group.length);
        at += group.length;
        await sendBatch(part);
        if (!alive) return;
      }
    }

    /** The cards of a batch still being followed. */
    const activeIn = (batch) => batch.cards.filter((c) => c.batch === batch && c.kind === 'reading' && cards.includes(c));

    /**
     * POST /api/invoices/toplu for these cards. The answer comes at once: files read before come back
     * read, the others are in line (sirada) or being read (okunuyor), each with its dosyaOzeti and its
     * place. The live feed (same panel tag) says which model reads a file; the batch is asked again
     * every few seconds until every file is read or failed.
     */
    async function sendBatch(group) {
      const list = group.filter((c) => cards.includes(c) && c.kind === 'reading');
      if (list.length === 0) return;
      const batch = { tag: api.newTag(), id: null, cards: list, ctl: new AbortController(), timer: null, polling: false, ended: false, unwatch: null };
      batches.add(batch);
      list.forEach((c, i) => Object.assign(c, { batch, sira: i + 1, uploading: true, hash: null, queue: null, activity: null, finishing: false }));
      for (const c of list) updateReading(c);
      const files = list.map((c) => c.file);
      rememberSent(batch.tag, files); // the reading screen can show and retry them too
      batch.unwatch = watchTag(batch.tag, (a) => onActivity(batch, a));
      const r = await api.sendMany(files, { force: false, tag: batch.tag, signal: batch.ctl.signal });
      if (!alive || batch.ended) return;
      for (const c of list) c.uploading = false;
      if (!r.ok) {
        const failed = activeIn(batch);
        endBatch(batch);
        if (r.unauthorized || r.aborted) return;
        for (const c of failed) settle(c, { kind: 'error', error: r.error, queue: null });
        say(failed.length === 1 ? `${failed[0].name} gönderilemedi.` : `${fmtCount(failed.length)} dosya gönderilemedi.`);
        return;
      }
      batch.id = r.body?.id ?? null;
      applyBatch(batch, r.body);
      schedulePoll(batch);
    }

    /** One answer of the batch (Kuyruk.dosyalar[], matched by sira) applied to its cards. */
    function applyBatch(batch, body) {
      const files = Array.isArray(body?.dosyalar) ? body.dosyalar : [];
      let gotHash = false;
      for (const d of files) {
        const card = batch.cards[(d.sira ?? 0) - 1];
        if (!card || card.batch !== batch || card.kind !== 'reading' || card.finishing || !cards.includes(card)) continue;
        if (!card.hash && d.dosyaOzeti) {
          card.hash = d.dosyaOzeti;
          gotHash = true;
          if (dropTwin(card)) continue;
        }
        if (d.durum === 'bitti') finishCard(card, d);
        else if (d.durum === 'hata') failCard(card, d.hata);
        else {
          card.queue = { durum: d.durum, kuyrukSirasi: d.kuyrukSirasi ?? null, onundeki: d.onundeki ?? null };
          updateReading(card);
        }
      }
      // A file the server has can be saved with the draft now.
      if (gotHash) renderPanelState();
    }

    /** The live feed: the model that reads a file, and its place in line between two answers of the batch. */
    function onActivity(batch, a) {
      if (!alive || batch.ended) return;
      const card = batch.cards[(a.sira ?? 0) - 1];
      if (!card || card.batch !== batch || card.kind !== 'reading' || card.finishing || !cards.includes(card)) return;
      card.activity = a;
      if (a.durum === 'sirada' || a.durum === 'okunuyor') {
        card.queue = { durum: a.durum, kuyrukSirasi: a.kuyrukSirasi ?? null, onundeki: a.onundeki ?? null };
        updateReading(card);
      } else if (batch.id) {
        schedulePoll(batch, 0); // read or failed: the batch has the result now
      }
    }

    function schedulePoll(batch, ms = POLL_MS) {
      if (batch.ended) return;
      clearTimeout(batch.timer);
      batch.timer = null;
      const active = activeIn(batch);
      if (!alive || active.length === 0) {
        endBatch(batch);
        return;
      }
      if (!batch.id) {
        for (const c of active) settle(c, { kind: 'error', error: { kod: 'kuyruk_yok', mesaj: 'Okuma sırası alınamadı. Dosyayı yeniden gönderin.' }, queue: null });
        endBatch(batch);
        return;
      }
      if (batch.polling) return; // the answer under way schedules the next turn
      batch.timer = setTimeout(() => pollBatch(batch), ms);
    }

    async function pollBatch(batch) {
      batch.timer = null;
      if (!alive || batch.ended) return;
      batch.polling = true;
      const r = await api.getBatch(batch.id, { signal });
      batch.polling = false;
      if (!alive || batch.ended) return;
      if (!r.ok) {
        if (r.unauthorized || r.aborted) return;
        if (r.error.durum === 404) {
          // The server restarted and forgot the line; the files are still here, so they can go again.
          for (const c of activeIn(batch).filter((x) => !x.finishing)) {
            settle(c, { kind: 'error', error: { kod: 'kuyruk_yok', mesaj: 'Okuma sırası sunucuda bulunamadı; sunucu yeniden başlamış olabilir. Dosyayı yeniden gönderin.' }, queue: null });
          }
          endBatch(batch);
          return;
        }
        schedulePoll(batch, POLL_RETRY_MS);
        return;
      }
      applyBatch(batch, r.body);
      schedulePoll(batch);
    }

    function endBatch(batch) {
      if (batch.ended) return;
      batch.ended = true;
      clearTimeout(batch.timer);
      batch.timer = null;
      batch.unwatch?.();
      batch.unwatch = null;
      batches.delete(batch);
    }

    /** A file already on the list (same SHA-256, or the same record once read): the new card goes, the first one flashes. */
    function dropTwin(card) {
      const twin = cards.find((c) => c !== card && c.hash && c.hash === card.hash);
      if (!twin) return false;
      showTwin(card, twin);
      return true;
    }

    function showTwin(card, twin) {
      const n = cards.indexOf(twin) + 1;
      removeCard(card, { announce: false, focusTo: twin });
      toast(`Bu fatura zaten ekli (${fmtCount(n)}. fatura); “${card.name}” ikinci kez eklenmedi.`);
      if (twin.node) {
        replay(twin.node, 'flash');
        twin.node.scrollIntoView({ block: 'nearest' });
      }
    }

    /** A file read: its result (from the batch, or the record when the batch left it out) fills the card. */
    async function finishCard(card, d) {
      card.finishing = true;
      card.queue = { durum: 'bitti', kuyrukSirasi: null, onundeki: null };
      updateReading(card);
      const recordId = d.kayitId ?? null;
      let rec = d.sonuc && typeof d.sonuc === 'object' ? d.sonuc : null;
      if (recordId && !rec) {
        const r = await api.getRecord(recordId, { signal });
        if (!alive || !cards.includes(card)) return;
        if (r.ok) rec = r.body;
      }
      if (!recordId || !rec) {
        card.finishing = false;
        settle(card, { kind: 'error', error: { kod: 'kimlik_yok', mesaj: 'Fatura okundu ama sonucu alınamadı. Tekrar deneyin ya da Fatura okuma ekranından açın.' }, queue: null });
        return;
      }
      // The preview's type comes from the file's first bytes, never from its name (files.js).
      const type = await sniffType(card.file);
      if (!alive || !cards.includes(card) || card.kind !== 'reading') return;
      card.finishing = false;
      const twin = cards.find((c) => c !== card && c.id === recordId);
      if (twin) {
        showTwin(card, twin);
        return;
      }
      const { url, mime } = typedObjectUrl(card.file, type);
      objectUrls.add(url);
      settle(card, {
        kind: 'done',
        id: recordId,
        fatura: rec.fatura,
        kalemler: rec.kalemler,
        original: pickInvoice(rec.fatura, rec.kalemler),
        onbellek: Boolean(d.onbellek),
        preview: { url, mime, name: card.name },
        queue: null,
      });
      say(`${card.name} okundu.`);
    }

    function failCard(card, hata) {
      settle(card, { kind: 'error', error: hata ?? { kod: 'okunamadi', mesaj: 'Fatura okunamadı.' }, queue: null });
      say(`${card.name} okunamadı.`);
    }

    function settle(card, props) {
      Object.assign(card, props);
      renderCard(card);
      afterInvoicesChanged();
    }

    /** A file sent from here goes to the line again (the server answers from the record if it was read meanwhile). */
    function retryCard(card) {
      if (busy || locked || !card.file) return;
      Object.assign(card, { kind: 'reading', error: null, serverError: null, since: new Date().toISOString(), hash: null, queue: null, activity: null, uploading: true, batch: null, finishing: false });
      renderCard(card);
      tickClocks();
      renderPanelState();
      sendBatch([card]);
    }

    /** Editing: POST /api/masraflar/:id/yeniden-oku puts every saved file that could not be read back in line. */
    async function rereadSaved() {
      if (!editing || busy || locked || rereading) return;
      const n = cards.filter((c) => c.kind === 'error' && c.source === 'server').length;
      rereading = true;
      renderPanelState();
      const r = await api.expenseAction(id, 'yeniden-oku');
      rereading = false;
      if (!alive) return;
      if (!r.ok) {
        renderPanelState();
        if (!r.unauthorized && !r.aborted) toast(r.error.mesaj, 'err');
        return;
      }
      mergeFresh(r.body);
      toast(n > 1 ? 'Okunamayan faturalar yeniden okuma sırasına girdi.' : 'Fatura yeniden okuma sırasına girdi.', 'ok');
    }

    function revokePreview(card) {
      const url = card.preview?.url;
      if (url && objectUrls.has(url)) {
        URL.revokeObjectURL(url);
        objectUrls.delete(url);
      }
    }

    /**
     * Stops following the card: its ?fatura= fetch is aborted, and a batch with nothing left to follow
     * stops asking (and uploading). The server still reads a file it has taken; the record lands in
     * the user's invoices and the reading screen shows it.
     */
    function detach(card) {
      const ctl = card.abort;
      card.abort = null;
      ctl?.abort();
      const batch = card.batch;
      if (batch && !batch.ended && activeIn(batch).filter((c) => c !== card).length === 0) {
        batch.ctl.abort();
        endBatch(batch);
      }
    }

    /** userChange: false when the panel takes back a card itself (a ?fatura= that failed, a saved file that became an invoice). */
    function removeCard(card, { announce = true, focusTo = null, userChange = true } = {}) {
      const i = cards.indexOf(card);
      if (i < 0) return;
      const hadFocus = card.node?.contains(document.activeElement);
      cards.splice(i, 1);
      detach(card);
      card.node?.remove();
      revokePreview(card);
      if (fillSource === card) fillSource = null;
      if (userChange) {
        markDirty();
        if (card.source === 'server') droppedPending = true;
      }
      if (announce) say(`${card.name} kaldırıldı. ${cards.length === 0 ? 'Fatura kalmadı.' : `${fmtCount(cards.length)} fatura kaldı.`}`);
      afterInvoicesChanged();
      if (hadFocus) {
        const next = focusTo ?? cards[i] ?? cards[i - 1];
        const target = next?.node?.querySelector('.inv-actions > :last-child') ?? (cards.length > 0 ? addBtn : invDrop.querySelector('button'));
        target?.focus();
      }
    }

    // ---------- Editing: files the saved form holds as still being read ----------

    /** The card fields of an invoice on the saved form (MasrafDetay.faturalar[]). */
    function linkedProps(f) {
      return {
        kind: 'linked',
        source: null,
        id: f.id,
        // SHA-256 of the file it was read from (null only on old records): finds the same file added again.
        hash: f.dosyaOzeti ?? null,
        name: f.dosyaAdi || (f.faturaNo ? `Fatura ${f.faturaNo}` : 'Fatura'),
        fatura: f,
        kalemler: f.kalemler ?? [],
        original: f.duzeltildi && f.okunan ? pickInvoice(f.okunan.fatura, f.okunan.kalemler) : pickInvoice(f, f.kalemler),
        duzeltildi: Boolean(f.duzeltildi),
        eksik: Array.isArray(f.eksikAlanlar) ? f.eksikAlanlar : [],
        preview: f.dosyaVar ? { url: api.invoiceFileUrl(f.id), mime: f.mime, name: f.dosyaAdi } : null,
        eqText: f.yerelKarsilik !== null && f.yerelKarsilik !== undefined ? fmtAmountInput(f.yerelKarsilik) : '',
        error: null,
        queue: null,
      };
    }

    /** The card fields of a saved file still being read (MasrafDetay.bekleyenFaturalar[]). */
    function pendingProps(b) {
      const failed = b.durum === 'hata';
      return {
        kind: failed ? 'error' : 'reading',
        source: 'server',
        hash: b.dosyaOzeti,
        name: b.dosyaAdi || 'Fatura',
        since: b.eklenme ?? new Date().toISOString(),
        queue: { durum: b.durum, kuyrukSirasi: b.kuyrukSirasi ?? null, onundeki: b.onundeki ?? null },
        error: failed ? (b.hata ?? { kod: 'okunamadi', mesaj: 'Fatura okunamadı.' }) : null,
      };
    }

    function scheduleDetailPoll(ms = DETAIL_POLL_MS) {
      clearTimeout(detailTimer);
      detailTimer = null;
      if (!alive || !editing || locked) return;
      if (!cards.some((c) => c.source === 'server' && c.kind === 'reading')) return;
      detailTimer = setTimeout(pollDetail, ms);
    }

    async function pollDetail() {
      detailTimer = null;
      // While saving, the save's answer decides; a hidden tab waits for its turn.
      if (busy || document.hidden) {
        scheduleDetailPoll();
        return;
      }
      const r = await api.getExpense(id, { signal });
      if (!alive) return;
      if (!r.ok) {
        if (!r.unauthorized && !r.aborted) scheduleDetailPoll(POLL_RETRY_MS);
        return;
      }
      if (busy) {
        scheduleDetailPoll();
        return;
      }
      mergeFresh(r.body);
    }

    /**
     * A fresh copy of the saved form (asked every few seconds while its files are read, or the answer
     * of "Yeniden oku"). Files still being read update their place; a file that left the list became an
     * invoice (its card turns into one, in place) or was dropped because the same invoice is already on
     * the form. What the user typed stays as it is.
     */
    function mergeFresh(fresh) {
      if (!alive || locked) return;
      if (!fresh?.izinler?.duzenle) {
        lockForm(fresh);
        return;
      }
      const known = new Set((detail?.faturalar ?? []).map((f) => f.id));
      const shown = new Set(cards.map((c) => c.id).filter(Boolean));
      const added = (fresh.faturalar ?? []).filter((f) => !known.has(f.id) && !shown.has(f.id));
      const byHash = new Map((fresh.bekleyenFaturalar ?? []).map((b) => [b.dosyaOzeti, b]));
      let changed = false;
      const gone = [];
      for (const card of cards) {
        if (card.source !== 'server' || (card.kind !== 'reading' && card.kind !== 'error')) continue;
        const b = byHash.get(card.hash);
        if (!b) {
          gone.push(card);
          continue;
        }
        const next = pendingProps(b);
        if (next.kind !== card.kind || (next.kind === 'error' && next.error?.mesaj !== card.error?.mesaj)) {
          Object.assign(card, next);
          renderCard(card);
          if (next.kind === 'error') say(`${card.name} okunamadı.`);
          changed = true;
        } else {
          card.queue = next.queue;
          updateReading(card);
        }
      }
      for (const card of gone) {
        // The read invoice went to the end of the server's list; it keeps this card's place on screen.
        // Same file, same dosyaOzeti; the name is only a fallback for an invoice without one.
        let i = added.findIndex((f) => f.dosyaOzeti && f.dosyaOzeti === card.hash);
        if (i < 0) i = added.findIndex((f) => !f.dosyaOzeti && f.dosyaAdi && f.dosyaAdi === card.name);
        if (i >= 0) {
          const [f] = added.splice(i, 1);
          Object.assign(card, linkedProps(f));
          // The file's values went to the invoice on the server; what the user typed here meanwhile stays.
          adoptValues(card, f.alanlar);
          renderCard(card);
          say(`${card.name} okundu ve masrafa eklendi.`);
        } else {
          removeCard(card, { announce: false, userChange: false });
        }
        changed = true;
      }
      // Invoices the server added that this page never showed (another tab): shown, unless the user
      // took saved files off the list here (then the next save decides).
      if (!droppedPending) {
        for (const f of added) {
          if (cards.length >= MAX_INVOICES) break;
          const card = newCard(linkedProps(f));
          adoptValues(card, f.alanlar);
          cards.push(card);
          renderCard(card);
          changed = true;
        }
      }
      // An empty amount and vendor the server filled once the last file was read: the fields follow
      // unless the user typed into them, so the next save does not empty them again.
      const follow = (name, before, after, text, label) => {
        if (after === null || after === undefined || (before !== null && before !== undefined)) return;
        const c = controls[name];
        if (c.value.trim() !== '') return;
        c.value = text;
        setFieldError(c, null);
        replay(c, 'autofilled');
        autoFilled.set(name, label);
        changed = true;
      };
      follow('tutar', detail?.tutar, fresh.tutar, fmtAmountInput(fresh.tutar), 'tutar');
      follow('satici', detail?.satici, fresh.satici, fresh.satici, 'satıcı');
      if (!sendWhenReadTouched) sendWhenRead.checked = Boolean(fresh.okununcaGonder);
      detail = fresh;
      if (changed) afterInvoicesChanged();
      else renderPanelState();
      scheduleDetailPoll();
    }

    /** The form left the editable states elsewhere (most often: sent by itself once its files were read). */
    function lockForm(fresh) {
      locked = true;
      dirty = false;
      clearTimeout(detailTimer);
      detailTimer = null;
      for (const b of [...batches]) {
        b.ctl.abort();
        endBatch(b);
      }
      if (fresh) detail = fresh;
      const sent = fresh?.durum === 'onayda';
      summary.replaceChildren(
        el(
          'div',
          { className: 'locked-note', role: 'status' },
          alertBox('info', sent ? 'Masraf onaya gönderildi' : 'Masraf artık düzenlenemez', [
            sent ? 'Faturalar okununca masraf kendiliğinden onaya gönderildi. Bu sayfadaki değişiklikler kaydedilemez.' : 'Masrafın durumu değişti. Bu sayfadaki değişiklikler kaydedilemez.',
          ]),
          btn('Masrafa git', { kind: 'primary', icon: ICONS.chevronRight, href: expenseHref(id) }),
        ),
      );
      for (const c of cards) renderCard(c);
      renderPanelState();
      summary.scrollIntoView({ block: 'nearest' });
    }

    /** ?fatura=<id> from the reading screen: the record that was already read becomes the first card. */
    async function linkRecord(fid) {
      if (!api.ID_PATTERN.test(fid)) {
        invAlert.replaceChildren(alertBox('err', null, ['Fatura bağlantısı geçersiz; dosyayı yeniden yükleyin.']));
        return;
      }
      const card = newCard({ kind: 'loading', id: fid, name: 'Okunan fatura' });
      // "Vazgeç", "Kaldır" and leaving the view abort these requests (detach).
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
        const card = newCard(linkedProps(f));
        adoptValues(card, f.alanlar);
        cards.push(card);
      }
      // Files still being read come after the invoices: once read, each goes to the end of the list.
      for (const b of d.bekleyenFaturalar ?? []) {
        const card = newCard(pendingProps(b));
        adoptValues(card, b.alanlar);
        cards.push(card);
      }
      for (const card of cards) renderCard(card); // after the push: the preview opens only for a lone invoice
      // The saved invoices already filled the form once; a newly added one fills only empty fields.
      fillSource = readyCards()[0] ?? null;
      sendWhenRead.checked = Boolean(d.okununcaGonder);
      // A saved amount that equals the invoices' total keeps following them as invoices change.
      const total = invoiceTotal();
      if (total && d.tutar !== null && d.tutar !== undefined && toCents(total.value) === toCents(d.tutar)) {
        touched.delete('tutar');
        amountAuto = true;
      }
      afterInvoicesChanged();
      scheduleDetailPoll();
    }

    // ---------- Saving ----------

    function collect({ sendAfter = false } = {}) {
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

      // A draft may go without an amount (filled once its invoices are read); sending needs one, and a
      // rejected form keeps its amount (docs/onay-sistemi.md, field rules for tutar).
      const t = parseAmount(controls.tutar.value);
      if (t.error) errors.tutar = t.error;
      else if (t.value === null) {
        if (sendAfter) errors.tutar = 'Onaya göndermek için tutarı girin.';
        else if (!amountMayBeEmpty()) errors.tutar = 'Reddedilen masrafın tutarı boş bırakılamaz.';
      } else if (t.value <= 0) errors.tutar = "Tutar 0'dan büyük olmalı.";

      const paraBirimi = controls.paraBirimi.value;
      let kur = null;
      if (paraBirimi !== base) {
        const k = parseAmount(controls.kur.value, RATE);
        if (k.error) errors.kur = k.error;
        else if (!k.value || k.value <= 0) errors.kur = `${paraBirimi} için ${base} karşılığı kuru girin.`;
        else kur = k.value;
      }

      // An amount that only follows the invoices (never typed) is left empty while files are still being
      // read: the server writes the total of every invoice once the last one is read, and leaves a
      // filled amount alone (docs/onay-sistemi.md, "Boş alanların doldurulması").
      const leaveToServer = !sendAfter && amountAuto && cards.some(isAwaiting) && amountMayBeEmpty();

      const data = {
        baslik,
        kategoriId,
        masrafTarihi,
        tutar: leaveToServer || t.error ? null : t.value,
        paraBirimi,
        kur,
        satici: controls.satici.value.trim() || null,
        aciklama: controls.aciklama.value.trim() || null,
        faturaIdler: readyCards().map((c) => c.id),
        // Files on the server that are still being read (or failed there), by their SHA-256.
        bekleyenFaturalar: cards.filter(isAwaiting).map((c) => c.hash),
        // Never with gonder (400); offered only while something is still to be read. null: the box is
        // not on screen, so it says nothing (a hidden box must not turn the saved choice off).
        okununcaGonder: !sendAfter && !sendWhenReadBox.hidden ? sendWhenRead.checked : null,
      };
      // Equivalents only for the invoices that need one on this form; a typed value that is not an
      // amount stops saving, an empty one only sending.
      const eq = equivalents();
      for (const { card, error } of eq.invalid) errors[`yerelKarsiliklar.${card.id}`] = error;
      data.yerelKarsiliklar = eq.given;
      data.faturaDuzeltmeleri = corrections();
      // The cost centre; undefined while the field is inactive (the saved one is left as it is).
      data.masrafMerkeziId = mmActive() ? formState().masrafMerkeziId : undefined;
      // Each receipt's values, keyed by invoice id or, while it is read, the file's SHA-256.
      data.fis = [];
      if (fieldInfo && entry.length > 0) {
        for (const card of cards) {
          if (!isReady(card) && !isAwaiting(card)) continue;
          const key = receiptKey(card);
          if (!key) continue;
          const n = normalizeValues(entry, card.values);
          for (const [k, message] of Object.entries(n.errors)) errors[`fisAlanlari.${key}.${k}`] = message;
          data.fis.push({ card, key, values: n.values });
        }
      }
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

    /**
     * Field names to controls, the equivalent inputs (yerelKarsiliklar.<faturaId>) and the receipt
     * fields (fisAlanlari.<faturaId or dosyaOzeti>.<anahtar>) included.
     */
    function errorTargets() {
      const targets = { ...fieldTargets };
      for (const c of cards) if (c.eq && needsEq(c)) targets[`yerelKarsiliklar.${c.id}`] = c.eq.input;
      for (const c of cards) {
        if (!c.fis) continue;
        for (const [k, ctl] of Object.entries(c.fis.controls)) {
          if (c.id) targets[`fisAlanlari.${c.id}.${k}`] = ctl.input;
          if (c.hash) targets[`fisAlanlari.${c.hash}.${k}`] = ctl.input;
        }
      }
      return targets;
    }

    function createBody(data) {
      const b = { baslik: data.baslik, kategoriId: data.kategoriId, masrafTarihi: data.masrafTarihi, paraBirimi: data.paraBirimi };
      if (data.tutar !== null) b.tutar = data.tutar; // left out: the server fills it once the invoices are read
      if (data.kur !== null) b.kur = data.kur;
      if (data.satici) b.satici = data.satici;
      if (data.aciklama) b.aciklama = data.aciklama;
      if (data.faturaIdler.length > 0) b.faturaIdler = data.faturaIdler;
      if (data.bekleyenFaturalar.length > 0) b.bekleyenFaturalar = data.bekleyenFaturalar;
      if (data.okununcaGonder) b.okununcaGonder = true;
      if (Object.keys(data.yerelKarsiliklar).length > 0) b.yerelKarsiliklar = data.yerelKarsiliklar;
      if (Object.keys(data.faturaDuzeltmeleri).length > 0) b.faturaDuzeltmeleri = data.faturaDuzeltmeleri;
      // Left out, the server picks the user's only active cost centre (the select already shows it).
      if (data.masrafMerkeziId !== undefined && data.masrafMerkeziId !== null) b.masrafMerkeziId = data.masrafMerkeziId;
      const fis = {};
      for (const { key, values } of data.fis) if (Object.keys(values).length > 0) fis[key] = values;
      if (Object.keys(fis).length > 0) b.fisAlanlari = fis;
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
      if (!sameMoney(data.tutar, d.tutar)) p.tutar = data.tutar; // null empties a draft's amount
      if (data.paraBirimi !== d.paraBirimi) p.paraBirimi = data.paraBirimi;
      if ((data.kur ?? null) !== (d.kur ?? null)) p.kur = data.kur;
      if ((data.satici ?? null) !== (d.satici ?? null)) p.satici = data.satici;
      if ((data.aciklama ?? null) !== (d.aciklama ?? null)) p.aciklama = data.aciklama;
      const saved = d.faturaIdler ?? (d.faturalar ?? []).map((f) => f.id);
      const savedPending = (d.bekleyenFaturalar ?? []).map((b) => b.dosyaOzeti);
      // The two lists always go together (docs/onay-sistemi.md, bekleyenFaturalar rule 3): a file the
      // server read after this page last asked is added back by its SHA-256, rather than dropped for
      // missing from faturaIdler.
      if (!sameList(data.faturaIdler, saved) || !sameList(data.bekleyenFaturalar, savedPending)) {
        p.faturaIdler = data.faturaIdler;
        p.bekleyenFaturalar = data.bekleyenFaturalar;
      }
      // Sent, the map replaces every equivalent; so it goes in full, with a changed list too.
      if (p.faturaIdler || !sameAmounts(data.yerelKarsiliklar, savedEquivalents(d))) p.yerelKarsiliklar = data.yerelKarsiliklar;
      // Listed invoices change; the others keep their correction on the server.
      if (Object.keys(data.faturaDuzeltmeleri).length > 0) p.faturaDuzeltmeleri = data.faturaDuzeltmeleri;
      // Only a change the user made on the visible box: removing the last failed file of a form set to
      // "send when read" must leave the setting on, so the server sends it (docs section 3).
      if (data.okununcaGonder !== null && sendWhenReadTouched && data.okununcaGonder !== Boolean(d.okununcaGonder)) p.okununcaGonder = data.okununcaGonder;
      if (data.masrafMerkeziId !== undefined && data.masrafMerkeziId !== (d.masrafMerkezi?.id ?? null)) p.masrafMerkeziId = data.masrafMerkeziId;
      // A receipt sent replaces all its active values (docs: fisAlanlari), so only changed ones go, in full.
      const fis = {};
      for (const { card, key, values } of data.fis) {
        if (!sameValues(values, normalizeValues(entry, card.savedValues).values)) fis[key] = values;
      }
      if (Object.keys(fis).length > 0) p.fisAlanlari = fis;
      return p;
    }

    /**
     * alanlar["faturaIdler.<i>"] goes under the i-th invoice sent and alanlar["bekleyenFaturalar.<i>"]
     * under the i-th file still being read; alanlar.faturaIdler and a 409 without alanlar (two saves
     * racing) go over the list. alanlar["yerelKarsiliklar.<faturaId>"] (400, or 409 karsilik_eksik when
     * sending) goes under that invoice's equivalent input.
     */
    function showServerError(e, { unsaved = false } = {}) {
      const alanlar = e.alanlar ? { ...e.alanlar } : null;
      const listMessages = [];
      let firstCard = null;
      if (alanlar) {
        for (const [key, message] of Object.entries(alanlar)) {
          const m = /^(faturaIdler|bekleyenFaturalar)(?:\.(\d+))?$/.exec(key);
          if (!m) continue;
          delete alanlar[key];
          const sent = m[1] === 'faturaIdler' ? sentCards : sentPending;
          const card = m[2] !== undefined ? sent[Number(m[2])] : null;
          if (card && cards.includes(card)) {
            if (m[1] === 'bekleyenFaturalar' && card.source !== 'server' && card.kind === 'reading') {
              // The server no longer has the file (e.g. it restarted): send it again or remove it.
              settle(card, { kind: 'error', error: { kod: 'bulunamadi', mesaj: String(message) }, queue: null });
            } else {
              setCardError(card, String(message));
            }
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
        // alanlar["fisAlanlari.<fiş>.<alan>"] (400, 409 alan_eksik) goes under that receipt field
        // (applyFieldErrors below); a receipt or field not on screen goes on the card or the list.
        for (const [key, message] of Object.entries(alanlar)) {
          const m = /^fisAlanlari\.([^.]+)(?:\.(.+))?$/.exec(key);
          if (!m) continue;
          const card = cards.find((c) => c.id === m[1] || c.hash === m[1]);
          if (m[2] !== undefined && card?.fis?.controls[m[2]]) continue;
          delete alanlar[key];
          if (card) {
            setCardError(card, m[2] !== undefined ? `${labelFrom(fieldInfo?.list, m[2])}: ${message}` : String(message));
            firstCard ??= card;
          } else listMessages.push(String(message));
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
      } else if (e.kod === 'alan_eksik') {
        // 409 with alanlar.masrafMerkeziId and fisAlanlari.<faturaId>.<alan>: the fields are marked.
        summary.replaceChildren(
          alertBox('err', 'Onaya gönderilemedi', [e.mesaj, ...leftovers, 'İşaretli alanları doldurup yeniden gönderin ya da taslak olarak kaydedin.', unsaved ? 'Masraf kaydedilmedi.' : null].filter(Boolean)),
        );
      } else if (e.kod === 'karsilik_eksik') {
        const items = [...new Set(Object.values(alanlar).map(String))];
        summary.replaceChildren(alertBox('err', 'Onaya gönderilemedi', [...items, 'Karşılıkları girip yeniden gönderin ya da taslak olarak kaydedin.']));
      } else if (e.kod === 'tutar_eksik') {
        // 409 with alanlar.tutar: the message is under the amount too.
        summary.replaceChildren(alertBox('err', 'Onaya gönderilemedi', [e.mesaj, unsaved ? 'Masraf kaydedilmedi; tutarı girip yeniden gönderin ya da taslak olarak kaydedin.' : null].filter(Boolean)));
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
        const f = card.id ? (d.faturalar ?? []).find((x) => x.id === card.id) : null;
        if (!f) {
          const b = card.hash ? (d.bekleyenFaturalar ?? []).find((x) => x.dosyaOzeti === card.hash) : null;
          if (b) {
            // The values typed here are saved: what the server holds is the base for the next save.
            card.fisTouched = false;
            adoptValues(card, b.alanlar);
          }
          continue;
        }
        card.fisTouched = false;
        adoptValues(card, f.alanlar);
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

    /** The toast after a draft save: what happens to the files still being read. */
    function savedText(saved, data) {
      if (saved?.durum === 'onayda') return 'Masraf kaydedildi ve onaya gönderildi.';
      const waiting = Array.isArray(saved?.bekleyenFaturalar) ? saved.bekleyenFaturalar.length : data.bekleyenFaturalar.length;
      if (waiting > 0 && (saved?.okununcaGonder ?? data.okununcaGonder)) return 'Masraf kaydedildi. Faturalar okununca onaya gönderilecek; size bildirim gelecek.';
      if (waiting > 0) return 'Masraf taslak olarak kaydedildi. Faturalar okununca size bildirim gelecek.';
      return editing ? 'Değişiklikler kaydedildi.' : 'Masraf taslak olarak kaydedildi.';
    }

    async function submit(sendAfter) {
      if (busy || locked) return;
      const form = page.querySelector('form');
      if (!form) return;
      clearFieldErrors(form);
      summary.replaceChildren();
      invAlert.replaceChildren();
      clearCardErrors();
      const uploading = cards.filter(isUploading).length;
      const failed = cards.filter(isLocalError);
      if (uploading > 0) {
        summary.replaceChildren(alertBox('info', null, [uploadingText(uploading)]));
        return;
      }
      if (failed.length > 0) {
        summary.replaceChildren(alertBox('err', null, [failedText(failed.length)]));
        failed[0].node?.scrollIntoView({ block: 'nearest' });
        failed[0].node?.focus({ preventScroll: true });
        return;
      }
      // Files still being read go with a draft; sending waits for them (the button is off, this covers Enter).
      const awaiting = cards.filter(isAwaiting);
      if (sendAfter && awaiting.length > 0) {
        const reading = awaiting.filter((c) => c.kind === 'reading').length;
        summary.replaceChildren(alertBox('info', null, [reading > 0 ? readingNote(reading) : serverFailedText(awaiting.length)]));
        return;
      }
      const { errors, data, missing } = collect({ sendAfter });
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
      sentPending = awaiting;
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
          if (['karsilik_eksik', 'fatura_eksik', 'alan_eksik', 'fatura_mukerrer', 'tutar_eksik'].includes(s.error.kod)) {
            // The changes are saved; stay on the form so the missing equivalents can be entered. The
            // saved form may differ from what this page loaded (another tab), so compare the next save
            // with the server's copy; failing that, with the equivalents it reported missing removed.
            const fresh = await api.getExpense(id, { signal });
            if (!alive) return;
            const gone = new Set(Object.keys(s.error.alanlar ?? {}).map((k) => k.replace(/^yerelKarsiliklar\./, '')));
            detail = fresh.ok ? fresh.body : { ...saved, faturalar: (saved.faturalar ?? []).map((f) => (gone.has(f.id) ? { ...f, yerelKarsilik: null } : f)) };
            syncFromSaved(detail);
            // The box now follows the saved copy again until the user changes it.
            sendWhenReadTouched = false;
            sendWhenRead.checked = Boolean(detail.okununcaGonder);
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
        // The user may leave now: the server keeps reading and tells them when it is done.
        toast(savedText(saved, data), 'ok');
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
      // The field list and the user's cost centres (GET /api/ben) come with the rest; without them the
      // form still works, only the receipt fields and the cost centre are left out.
      const tasks = [api.listCategories(false, { signal }), session.loadBaseCurrency(), api.listFields(false, { signal }), session.refreshMe({ signal })];
      if (editing) tasks.push(api.getExpense(id, { signal }));
      const [cats, b, fl, me, d] = await Promise.all(tasks);
      if (!alive) return;
      base = b;
      if (fl.ok && Array.isArray(fl.body?.alanlar)) {
        fieldInfo = { list: fl.body.alanlar, rules: Array.isArray(fl.body.kurallar) ? fl.body.kurallar : [] };
        entry = entryFields(fieldInfo.list);
      } else {
        fieldInfo = null;
        entry = [];
      }
      const meUser = (me?.ok && me.body?.kullanici) || session.currentUser();
      myCentres = Array.isArray(meUser?.masrafMerkezleri) ? meUser.masrafMerkezleri : [];
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
      if (fieldInfo) fillCentres(detail?.masrafMerkezi ?? null);
      else {
        mmField.hidden = true;
        if (!fl.unauthorized) fieldsNote.replaceChildren(alertBox('info', null, ['Fiş alanları ve masraf merkezi yüklenemedi. Masrafı yine kaydedebilirsiniz; alanları doldurmak için sayfayı yenileyin.']));
      }
      if (detail) {
        fillFromDetail(detail);
        const target = focusInvoice ? cards.find((c) => c.id === focusInvoice) : null;
        // ?fatura= leads to what is missing on that invoice: its header in the editor, else its receipt fields.
        if (target && (missingFor(target).length > 0 || !showFisGaps(target))) openEditor(target);
      } else {
        controls.masrafTarihi.value = todayIso();
        renderPanelState();
        if (fromInvoice) linkRecord(fromInvoice);
      }
      refreshRequired();
      updateCurrencyUi();
      schedulePreview();
    }
    init();

    /**
     * The confirmation for leaving with unsaved changes; says what happens to reads under way. Files
     * the saved form already holds are not affected: the server keeps reading them.
     */
    function leaveMessage() {
      const parts = [editing ? 'Masraftaki değişiklikler kaydedilmedi. Devam ederseniz kaybolur.' : 'Masraf henüz kaydedilmedi. Devam ederseniz girdikleriniz kaybolur.'];
      const local = cards.filter((c) => c.kind === 'reading' && c.source !== 'server');
      const reading = local.filter((c) => c.hash).length;
      const uploading = local.length - reading;
      if (reading > 0) {
        const who = reading === 1 ? 'Okunmakta olan fatura' : `Okunmakta olan ${fmtCount(reading)} fatura`;
        parts.push(`${who} okunmaya devam eder ve Fatura okuma ekranında görünür, ama bu masrafa eklenmez. Eklemek için önce taslak olarak kaydedin.`);
      }
      if (uploading > 0) parts.push(uploading === 1 ? 'Henüz gönderilmemiş dosya gönderilmez.' : `Henüz gönderilmemiş ${fmtCount(uploading)} dosya gönderilmez.`);
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
        clearTimeout(detailTimer);
        detailTimer = null;
        // Stops asking and uploading; files the server has taken are still read.
        for (const b of [...batches]) {
          b.ctl.abort();
          endBatch(b);
        }
        for (const c of cards) {
          c.abort?.abort();
          c.abort = null;
        }
        schedulePreview.cancel();
        setFileTarget(null);
        window.removeEventListener('beforeunload', onBeforeUnload);
        for (const url of objectUrls) URL.revokeObjectURL(url);
        objectUrls.clear();
      },
    };
  },
};
