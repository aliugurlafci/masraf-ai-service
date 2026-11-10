// Editing an invoice's data on an expense form (docs/onay-sistemi.md, section 3, "Fatura bilgileri,
// düzeltme ve gönderim kontrolleri"). A correction is the invoice schema in full:
// { fatura: { 11 header fields }, kalemler: [...] } (src/invoice/schema.ts). The read record never
// changes; the correction lives on the form only and is sent as `faturaDuzeltmeleri`.
// This module holds the field lists, the helpers that compare read and valid values, and the dialog.

import { el, icon, ICONS } from './dom.js';
import { fmtAmountInput, fmtCurrency, fmtDate, fmtQty, fmtRateInput, parseAmount } from './format.js';
import { btn, field, input, openDialog, setFieldError } from './ui.js';

export const MAX_LINES = 200;
const MAX_TEXT = 500;

/**
 * The four header fields required before field management existed; the fallback when the field list
 * (GET /api/alanlar) could not be loaded. fields.js works out the required ones from the field list.
 */
export const REQUIRED = ['faturaNo', 'faturaTarihi', 'saticiUnvan', 'genelToplam'];

// kind: text | date | currency | amount
export const HEADER_FIELDS = [
  { key: 'faturaNo', label: 'Fatura no', kind: 'text' },
  { key: 'faturaTarihi', label: 'Fatura tarihi', kind: 'date' },
  { key: 'saticiUnvan', label: 'Satıcı unvanı', kind: 'text' },
  { key: 'saticiVergiNo', label: 'Satıcı vergi no', kind: 'text' },
  { key: 'aliciUnvan', label: 'Alıcı unvanı', kind: 'text' },
  { key: 'aliciVergiNo', label: 'Alıcı vergi no', kind: 'text' },
  { key: 'paraBirimi', label: 'Para birimi', kind: 'currency' },
  { key: 'araToplam', label: 'Ara toplam', kind: 'amount' },
  { key: 'kdvToplam', label: 'KDV toplamı', kind: 'amount' },
  { key: 'genelToplam', label: 'Genel toplam', kind: 'amount' },
];

export const LINE_FIELDS = [
  { key: 'aciklama', label: 'Açıklama', kind: 'text' },
  { key: 'miktar', label: 'Miktar', kind: 'amount' },
  { key: 'birim', label: 'Birim', kind: 'text' },
  { key: 'birimFiyat', label: 'Birim fiyat', kind: 'amount' },
  { key: 'kdvOrani', label: 'KDV oranı (%)', kind: 'amount' },
  { key: 'tutar', label: 'Tutar', kind: 'amount' },
];

const LABEL = Object.fromEntries([...HEADER_FIELDS, ...LINE_FIELDS].map((f) => [f.key, f.label]));

const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** The schema's shape from any object that carries its fields (an API invoice has extra ones). */
export function pickInvoice(source, lines) {
  const fatura = {};
  for (const f of HEADER_FIELDS) fatura[f.key] = blank(source?.[f.key]) ? null : source[f.key];
  const kalemler = (Array.isArray(lines) ? lines : []).map((l) => {
    const out = {};
    for (const f of LINE_FIELDS) out[f.key] = blank(l?.[f.key]) ? null : l[f.key];
    return out;
  });
  return { fatura, kalemler };
}

export const sameInvoice = (a, b) => JSON.stringify(pickInvoice(a?.fatura, a?.kalemler)) === JSON.stringify(pickInvoice(b?.fatura, b?.kalemler));

/** Required fields that are empty in this invoice data. */
export const missingOf = (fatura) => REQUIRED.filter((k) => blank(fatura?.[k]));

export const labelOf = (key) => LABEL[key] ?? key;

/** Server paths such as "fatura.faturaTarihi" or "kalemler.2.tutar" as a short Turkish label. */
export function pathLabel(path) {
  const parts = String(path).split('.');
  if (parts[0] === 'kalemler') {
    const n = Number(parts[1]);
    const what = parts[2] ? labelOf(parts[2]) : 'kalem';
    return Number.isInteger(n) ? `${n + 1}. kalem, ${what.toLocaleLowerCase('tr-TR')}` : 'kalemler';
  }
  return labelOf(parts[parts.length - 1]);
}

/** A field value as the user reads it; null when empty. */
export function showValue(key, value, currency) {
  if (blank(value)) return null;
  const def = HEADER_FIELDS.find((f) => f.key === key) ?? LINE_FIELDS.find((f) => f.key === key);
  if (def?.kind === 'date') return fmtDate(value);
  if (def?.kind === 'amount') {
    if (key === 'miktar' || key === 'kdvOrani') return fmtQty(value);
    return key === 'birimFiyat' ? fmtAmountInput(value) : fmtCurrency(value, currency);
  }
  return String(value);
}

/** Header fields whose read and valid values differ: [{ key, label, from, to }] (text; empty → "boş"). */
export function diffHeader(okunan, gecerli) {
  const out = [];
  const cur = gecerli?.paraBirimi ?? okunan?.paraBirimi ?? null;
  for (const f of HEADER_FIELDS) {
    const a = blank(okunan?.[f.key]) ? null : okunan[f.key];
    const b = blank(gecerli?.[f.key]) ? null : gecerli[f.key];
    if (a === b) continue;
    out.push({ key: f.key, label: f.label, from: showValue(f.key, a, cur) ?? 'boş', to: showValue(f.key, b, cur) ?? 'boş' });
  }
  return out;
}

export const linesChanged = (okunan, gecerli) => JSON.stringify(pickInvoice({}, okunan).kalemler) !== JSON.stringify(pickInvoice({}, gecerli).kalemler);

/** Side-by-side table of the fields that differ (read value | valid value), plus a note for the lines. */
export function compareView(okunan, gecerli) {
  const rows = diffHeader(okunan?.fatura, gecerli?.fatura);
  const lines = linesChanged(okunan?.kalemler, gecerli?.kalemler);
  const body = rows.map((r) =>
    el('tr', {}, el('th', { scope: 'row', text: r.label }), el('td', { className: 'was', text: r.from }), el('td', { className: 'now', text: r.to })),
  );
  if (lines) {
    const a = okunan?.kalemler?.length ?? 0;
    const b = gecerli?.kalemler?.length ?? 0;
    body.push(el('tr', {}, el('th', { scope: 'row', text: 'Kalemler' }), el('td', { className: 'was', text: `${a} kalem` }), el('td', { className: 'now', text: `${b} kalem (değiştirilmiş)` })));
  }
  if (body.length === 0) return null;
  return el(
    'div',
    { className: 'compare-wrap' },
    el(
      'table',
      { className: 'compare' },
      el('caption', { className: 'visually-hidden', text: 'Okunan ve düzeltilmiş değerler' }),
      el('thead', {}, el('tr', {}, el('th', { scope: 'col', text: 'Alan' }), el('th', { scope: 'col', text: 'Okunan' }), el('th', { scope: 'col', text: 'Geçerli' }))),
      el('tbody', {}, ...body),
    ),
  );
}

// ---------- The dialog ----------

const isRealDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

const AMOUNT = { decimals: 6 };

function textOf(v) {
  return blank(v) ? '' : String(v);
}

/** Number as typed back: lossless (up to 6 decimals), Turkish separators. */
function numberText(v) {
  if (blank(v)) return '';
  return fmtRateInput(v);
}

function makeControl(def, value) {
  const props = { name: def.key, autocomplete: 'off' };
  if (def.kind === 'date') return input({ ...props, type: 'date', value: textOf(value) });
  if (def.kind === 'amount') return input({ ...props, inputmode: 'decimal', className: 'input num', value: numberText(value) });
  if (def.kind === 'currency') return input({ ...props, maxlength: 3, className: 'input upper', value: textOf(value), placeholder: 'TRY' });
  return input({ ...props, maxlength: MAX_TEXT, value: textOf(value) });
}

/** Reads a control: { value } (null when empty) or { error }. */
function readControl(def, control) {
  const raw = control.value.trim();
  if (def.kind === 'amount') {
    const p = parseAmount(raw, AMOUNT);
    return p.error ? { error: p.error } : { value: p.value };
  }
  if (raw === '') return { value: null };
  if (def.kind === 'date') return isRealDate(raw) ? { value: raw } : { error: 'Geçerli bir tarih girin (gün.ay.yıl).' };
  if (def.kind === 'currency') {
    const code = raw.toLocaleUpperCase('en-US');
    return /^[A-Z]{3}$/.test(code) ? { value: code } : { error: 'Üç harfli para birimi kodu girin (TRY, USD, EUR).' };
  }
  return raw.length > MAX_TEXT ? { error: `En çok ${MAX_TEXT} karakter olabilir.` } : { value: raw };
}

/**
 * Opens the editor for one invoice. current: { fatura, kalemler } (the valid data now);
 * errors: server messages by path ("fatura.faturaTarihi", "kalemler.0.tutar"); canRevert: offer
 * "Okunan değere dön"; required: the header keys required on this receipt (asterisks). Resolves with
 * { fatura, kalemler } (apply), 'revert' or null (cancelled).
 */
export function editInvoiceDialog({ title, current, errors = {}, canRevert = false, required: requiredKeys = REQUIRED }) {
  const data = pickInvoice(current?.fatura, current?.kalemler);
  const headerControls = {};
  const headerFields = [];
  for (const def of HEADER_FIELDS) {
    const control = makeControl(def, data.fatura[def.key]);
    headerControls[def.key] = control;
    const required = requiredKeys.includes(def.key);
    headerFields.push(field({ label: required ? `${def.label} *` : def.label, input: control, className: `inv-edit-field${required ? ' required' : ''}` }));
    if (required) {
      const warn = () => setFieldError(control, control.value.trim() === '' ? 'Boş. Onaya göndermek için doldurun.' : null);
      control.addEventListener('input', warn);
    }
  }

  const lineRows = el('div', { className: 'line-rows' });
  const lineCount = el('span', { className: 'muted small' });
  const rows = []; // { node, controls }
  const addLineBtn = btn('Kalem ekle', {
    icon: ICONS.plus,
    size: 'sm',
    onClick: () => {
      addRow({});
      rows[rows.length - 1].controls.aciklama.focus();
    },
  });

  function refreshCount() {
    lineCount.textContent = rows.length === 0 ? 'Kalem yok' : `${rows.length} kalem`;
    addLineBtn.disabled = rows.length >= MAX_LINES;
    rows.forEach((r, i) => {
      r.title.textContent = `${i + 1}. kalem`;
    });
  }

  function addRow(line) {
    const controls = {};
    const fields = LINE_FIELDS.map((def) => {
      controls[def.key] = makeControl(def, line[def.key]);
      return field({ label: def.label, input: controls[def.key], className: `line-field line-${def.key}` });
    });
    const title = el('p', { className: 'line-title' });
    const row = { controls, title, node: null };
    const remove = btn('Sil', {
      icon: ICONS.trash,
      size: 'sm',
      kind: 'danger-ghost',
      onClick: () => {
        const i = rows.indexOf(row);
        rows.splice(i, 1);
        row.node.remove();
        refreshCount();
        (rows[i] ?? rows[i - 1])?.controls.aciklama.focus();
      },
      attrs: { 'aria-label': 'Kalemi sil' },
    });
    row.node = el('div', { className: 'line-row', role: 'group', 'aria-labelledby': (title.id = `lt-${Math.random().toString(36).slice(2, 8)}`) }, el('div', { className: 'line-head' }, title, remove), el('div', { className: 'line-grid' }, ...fields));
    rows.push(row);
    lineRows.append(row.node);
    refreshCount();
  }
  for (const l of data.kalemler) addRow(l);

  // Server messages by path, shown where they belong.
  function showErrors() {
    for (const [path, message] of Object.entries(errors)) {
      const m = /^fatura\.(\w+)$/.exec(path);
      if (m && headerControls[m[1]]) {
        setFieldError(headerControls[m[1]], String(message));
        continue;
      }
      const k = /^kalemler\.(\d+)\.(\w+)$/.exec(path);
      if (k && rows[Number(k[1])]?.controls[k[2]]) setFieldError(rows[Number(k[1])].controls[k[2]], String(message));
    }
  }
  for (const key of requiredKeys) if (headerControls[key]?.value.trim() === '') setFieldError(headerControls[key], 'Boş. Onaya göndermek için doldurun.');
  showErrors();

  function collect() {
    let ok = true;
    let first = null;
    const fatura = {};
    for (const def of HEADER_FIELDS) {
      const r = readControl(def, headerControls[def.key]);
      if (r.error) {
        ok = false;
        setFieldError(headerControls[def.key], r.error);
        first ??= headerControls[def.key];
      } else {
        fatura[def.key] = r.value;
        if (!requiredKeys.includes(def.key)) setFieldError(headerControls[def.key], null);
      }
    }
    const kalemler = [];
    for (const row of rows) {
      const line = {};
      for (const def of LINE_FIELDS) {
        const r = readControl(def, row.controls[def.key]);
        if (r.error) {
          ok = false;
          setFieldError(row.controls[def.key], r.error);
          first ??= row.controls[def.key];
        } else {
          line[def.key] = r.value;
          setFieldError(row.controls[def.key], null);
        }
      }
      // A line left completely empty is dropped.
      if (LINE_FIELDS.some((d) => line[d.key] !== null && line[d.key] !== undefined)) kalemler.push(line);
    }
    return ok ? { fatura, kalemler } : { first };
  }

  const ctl = openDialog({
    title,
    description: 'Okunan değerleri düzeltin. Düzeltme yalnızca bu masrafı etkiler; fatura kaydı değişmez. Kırmızı alanlar onaya göndermek için gereklidir.',
    size: 'inv',
    body: [
      canRevert
        ? el(
            'div',
            { className: 'inv-revert' },
            btn('Okunan değere dön', { icon: ICONS.undo, size: 'sm', onClick: () => ctl.close('revert') }),
            el('span', { className: 'muted small', text: 'Düzeltmeyi kaldırır; fatura okunan haline döner.' }),
          )
        : null,
      el('fieldset', { className: 'inv-edit-group' }, el('legend', { text: 'Fatura bilgileri' }), el('div', { className: 'inv-edit-grid' }, ...headerFields)),
      el('div', { className: 'inv-edit-group' }, el('div', { className: 'line-bar' }, el('h3', { className: 'line-h', text: 'Kalemler' }), lineCount, addLineBtn), lineRows),
    ],
    submitLabel: 'Uygula',
    submitIcon: ICONS.check,
    onSubmit: () => {
      const r = collect();
      if (r.first) {
        r.first.focus();
        ctl.setError('İşaretli alanları düzeltin.');
        return false;
      }
      return r;
    },
  });
  // The cursor goes to the first empty required field, so a missing value is one click away.
  const firstEmpty = requiredKeys.find((k) => headerControls[k]?.value.trim() === '');
  if (firstEmpty) headerControls[firstEmpty].focus();
  return ctl.done.then((r) => (r === true ? null : r));
}

/** An icon + text line for a card or alert. */
export const noteLine = (glyph, text, className = 'inv-card-note') => el('p', { className }, icon(glyph), el('span', { text }));
