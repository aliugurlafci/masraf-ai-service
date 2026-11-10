// Definition lists (docs/onay-sistemi.md, section 6, "Tanım listeleri"): organisations, cost centres,
// categories and the options of each 'liste' receipt field. Shared here: the "Aksiyonlar" menu
// (Excel export and import), the import preview, deleting with the "in use, make it inactive" way
// out, the status badge and filter, and the paged list screen the three server-paged lists use.

import * as api from './api.js';
import { el, icon, ICONS } from './dom.js';
import { downloadObjectUrl } from './files.js';
import { fmtCount, todayIso } from './format.js';
import { href } from './router.js';
import {
  actionDialog,
  alertBox,
  applyFieldErrors,
  btn,
  debounce,
  emptyState,
  field,
  input,
  loadFailed,
  menuButton,
  messageDialog,
  openDialog,
  pageHead,
  pager,
  setFieldError,
  showError,
  skeletonList,
  toast,
  uid,
} from './ui.js';

const XLSX_ACCEPT = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_IMPORT_BYTES = 5 * 1024 * 1024; // docs: "En çok 5 MB"
const PAGE_SIZE = 50;

export function downloadBlob(blob, name) {
  const a = el('a', { href: downloadObjectUrl(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** "Aktif" / "Pasif" with an icon (never colour alone). */
export function statusBadge(aktif) {
  return el('span', { className: `status ${aktif ? 'ok' : 'off'} sm` }, icon(aktif ? ICONS.check : ICONS.ban), el('span', { text: aktif ? 'Aktif' : 'Pasif' }));
}

/** Tümü / Aktif / Pasif. value: '' | '1' | '0'. */
export function activeFilter(value, onChange) {
  const seg = el(
    'div',
    { className: 'seg', role: 'group', 'aria-label': 'Duruma göre' },
    ...[
      ['', 'Tümü'],
      ['1', 'Aktif'],
      ['0', 'Pasif'],
    ].map(([v, l]) => el('button', { type: 'button', 'data-v': v, 'aria-pressed': String(value === v), text: l })),
  );
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    for (const x of seg.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    onChange(b.dataset.v);
  });
  return seg;
}

/** A menu button: [{ label, icon, onClick, hidden? }]. The focus returns to the button before an item runs. */
export function actionsMenu(items, { label = 'Aksiyonlar' } = {}) {
  const menuId = uid('menu');
  const button = el('button', { className: 'btn', type: 'button', 'aria-controls': menuId }, icon(ICONS.sheet), el('span', { text: label }), el('span', { className: 'btn-chev', 'aria-hidden': 'true' }, icon(ICONS.chevronDown)));
  const menu = el(
    'div',
    { className: 'menu', role: 'menu', id: menuId, hidden: true, 'aria-label': label },
    ...items
      .filter((it) => !it.hidden)
      .map((it) =>
        el(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            tabindex: '-1',
            onClick: () => {
              button.focus();
              it.onClick();
            },
          },
          icon(it.icon),
          el('span', { text: it.label }),
        ),
      ),
  );
  menuButton(button, menu);
  return el('div', { className: 'menu-anchor' }, button, menu);
}

/** The Excel menu items of a list. */
export function excelItems({ base, exportName, onImport }) {
  return [
    { label: "Excel'e aktar", icon: ICONS.download, onClick: () => exportList(base, exportName) },
    { label: "Excel'den içe aktar", icon: ICONS.upload, onClick: onImport },
  ];
}

export async function exportList(base, exportName) {
  const r = await api.exportDefinitions(typeof base === 'function' ? base() : base);
  const name = typeof exportName === 'function' ? exportName() : exportName;
  if (!r.ok) {
    showError(r);
    return;
  }
  downloadBlob(r.blob, r.filename ?? `${name}_${todayIso()}.xlsx`);
  toast('Excel dosyası indirildi.', 'ok');
}

// ---------- Excel import: choose a file, preview, import ----------

/** labels: { alan: 'Türkçe ad' } for the column mapping (sutunlar). onDone(result) after an import. */
export function importList({ base, title = "Excel'den içe aktar", labels = {}, keyLabel = 'kod', onDone }) {
  const picker = el('input', { type: 'file', accept: XLSX_ACCEPT, hidden: true });
  document.body.append(picker);
  picker.addEventListener('cancel', () => picker.remove());
  picker.addEventListener('change', () => {
    const file = picker.files?.[0] ?? null;
    picker.remove();
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      messageDialog({ title: 'Dosya çok büyük', message: 'Excel dosyası en çok 5 MB olabilir. Dosyayı bölüp parça parça içe aktarın.' });
      return;
    }
    importDialog({ base: typeof base === 'function' ? base() : base, file, title, labels, keyLabel, onDone });
  });
  picker.click();
}

function countTile(label, value, tone = '') {
  return el('div', { className: `imp-count ${tone}`.trim() }, el('span', { className: 'imp-num', text: fmtCount(value ?? 0) }), el('span', { className: 'imp-label', text: label }));
}

function resultText(r) {
  const parts = [`${fmtCount(r.eklenen ?? 0)} eklendi`, `${fmtCount(r.guncellenen ?? 0)} güncellendi`];
  if (r.pasiflestirilen) parts.push(`${fmtCount(r.pasiflestirilen)} pasifleştirildi`);
  let text = `İçe aktarıldı: ${parts.join(', ')}.`;
  if (r.hataSayisi) text += ` ${fmtCount(r.hataSayisi)} hatalı satır atlandı.`;
  return text;
}

function importDialog({ base, file, title, labels, keyLabel, onDone }) {
  const checkId = uid('imp');
  const deactivate = el('input', { type: 'checkbox', className: 'check', id: checkId, 'aria-describedby': `${checkId}-hint` });
  const box = el('div', { className: 'imp-body', 'aria-live': 'polite' });
  let token = 0;
  let ready = false;

  const ctl = openDialog({
    title,
    description: `${file.name} · önce ne değişeceği gösterilir; “İçe aktar” deyince kaydedilir.`,
    size: 'wide',
    body: [
      el(
        'div',
        { className: 'imp-option' },
        el('label', { className: 'check-label wrap', for: checkId }, deactivate, el('span', { text: 'Dosyada olmayan kayıtları pasifleştir' })),
        el('p', { className: 'hint', id: `${checkId}-hint`, text: `Anahtarı (${keyLabel}) dosyada geçmeyen aktif kayıtlar pasif olur; silinmez, eski kayıtlarda görünmeye devam eder.` }),
      ),
      box,
    ],
    submitLabel: 'İçe aktar',
    submitIcon: ICONS.upload,
    onSubmit: async (c) => {
      if (!ready) return false;
      const r = await api.importDefinitions(base, file, { eksikleriPasiflestir: deactivate.checked });
      if (r.ok) return r.body;
      if (r.unauthorized) return null;
      c.setError(r.error.mesaj);
      return false;
    },
  });
  const submit = ctl.submitButton;

  async function preview() {
    const mine = ++token;
    ready = false;
    submit.disabled = true;
    ctl.setError(null);
    box.replaceChildren(el('div', { className: 'form-skeleton small', role: 'status', 'aria-label': 'Dosya okunuyor' }, el('span'), el('span'), el('span')));
    const r = await api.importDefinitions(base, file, { onizleme: true, eksikleriPasiflestir: deactivate.checked });
    if (mine !== token || !ctl.dialog.isConnected) return;
    if (!r.ok) {
      if (r.unauthorized) return;
      box.replaceChildren();
      ctl.setError(r.error.mesaj);
      return;
    }
    box.replaceChildren(...previewNodes(r.body, labels));
    const changes = (r.body.eklenen ?? 0) + (r.body.guncellenen ?? 0) + (r.body.pasiflestirilen ?? 0);
    ready = changes > 0;
    submit.disabled = !ready;
  }

  deactivate.addEventListener('change', preview);
  preview();
  ctl.done.then((res) => {
    if (!res || res === true) return;
    toast(resultText(res), res.hataSayisi ? null : 'ok');
    onDone?.(res);
  });
}

function previewNodes(p, labels) {
  const nodes = [];
  nodes.push(
    el(
      'div',
      { className: 'imp-counts' },
      countTile('Satır', p.satirSayisi),
      countTile('Eklenecek', p.eklenen, p.eklenen ? 'ok' : ''),
      countTile('Güncellenecek', p.guncellenen, p.guncellenen ? 'accent' : ''),
      countTile('Değişmeyecek', p.degismeyen),
      countTile('Pasifleşecek', p.pasiflestirilen, p.pasiflestirilen ? 'wait' : ''),
      countTile('Hatalı', p.hataSayisi, p.hataSayisi ? 'err' : ''),
    ),
  );
  const changes = (p.eklenen ?? 0) + (p.guncellenen ?? 0) + (p.pasiflestirilen ?? 0);
  if (changes === 0) nodes.push(alertBox('info', null, ['Bu dosyayla değişecek kayıt yok.']));

  const cols = Object.entries(p.sutunlar ?? {});
  if (cols.length > 0) {
    nodes.push(
      el(
        'div',
        { className: 'imp-section' },
        el('h3', { className: 'imp-h', text: 'Okunan sütunlar' }),
        el(
          'ul',
          { className: 'imp-map' },
          ...cols.map(([alan, sutun]) => el('li', {}, el('span', { className: 'imp-file-col', text: String(sutun) }), icon(ICONS.chevronRight), el('strong', { text: labels[alan] ?? alan }))),
        ),
      ),
    );
  }
  const ignored = Array.isArray(p.yokSayilanSutunlar) ? p.yokSayilanSutunlar : [];
  if (ignored.length > 0) {
    nodes.push(el('p', { className: 'muted small imp-ignored', text: `Yok sayılan sütunlar: ${ignored.join(', ')}` }));
  }
  const errors = Array.isArray(p.hatalar) ? p.hatalar : [];
  if (errors.length > 0) {
    const more = (p.hataSayisi ?? errors.length) - errors.length;
    nodes.push(
      el(
        'div',
        { className: 'imp-section' },
        el('h3', { className: 'imp-h', text: 'Hatalı satırlar (atlanır)' }),
        el(
          'div',
          { className: 'imp-errors table-scroll' },
          el(
            'table',
            { className: 'data-table imp-table' },
            el('caption', { className: 'visually-hidden', text: 'Hatalı satırlar' }),
            el('thead', {}, el('tr', {}, el('th', { scope: 'col', className: 'num', text: 'Satır' }), el('th', { scope: 'col', text: 'Hata' }))),
            el('tbody', {}, ...errors.map((e) => el('tr', {}, el('td', { className: 'num', 'data-label': 'Satır', text: fmtCount(e.satir) }), el('td', { 'data-label': 'Hata', text: e.mesaj })))),
          ),
        ),
        more > 0 ? el('p', { className: 'muted small', text: `… ve ${fmtCount(more)} hatalı satır daha.` }) : null,
      ),
    );
  }
  return nodes;
}

// ---------- Delete: "in use" offers to make the record inactive ----------

/**
 * Asks, deletes, and on 409 kullaniliyor explains that the record should be made inactive instead,
 * offering that when it is active. onDone('silindi' | 'pasif', body?) after a change.
 */
export async function deleteRecord({ name, what = 'Kayıt', note = 'Koşulu bu kayıt olan zorunluluk kuralları da silinir.', active, run, makeInactive, onDone }) {
  let inUse = null;
  const r = await actionDialog({
    title: `${what} silinsin mi?`,
    message: `“${name}” kalıcı olarak silinir. ${note}`.trim(),
    confirmLabel: 'Sil',
    kind: 'danger',
    confirmIcon: ICONS.trash,
    run: async () => {
      const res = await run();
      if (!res.ok && (res.error?.kod === 'kullaniliyor' || res.error?.kod === 'alan_kullaniliyor')) {
        inUse = res.error;
        return { ok: true, body: null };
      }
      return res;
    },
  });
  if (inUse) {
    if (!active || !makeInactive) {
      messageDialog({ title: 'Silinemedi', message: `${inUse.mesaj} Kayıt zaten pasif: yeni seçimlerde görünmez, kayıtlı değerler korunur.` });
      return;
    }
    const r2 = await actionDialog({
      title: 'Kayıt kullanılıyor',
      message: `${inUse.mesaj} Silmek yerine pasifleştirin: yeni seçimlerde görünmez, kayıtlı değerler korunur ve gösterilir.`,
      confirmLabel: 'Pasifleştir',
      kind: 'primary',
      confirmIcon: ICONS.ban,
      run: makeInactive,
    });
    if (r2?.ok) {
      toast(`“${name}” pasifleştirildi.`, 'ok');
      onDone?.('pasif', r2.body);
    }
    return;
  }
  if (r?.ok) {
    toast(`“${name}” silindi.`, 'ok');
    onDone?.('silindi');
  }
}

// ---------- Record dialog (declared fields) ----------

/**
 * fields: [{ key, label, max, required?, upper?, pattern?, patternMessage?, hint?, placeholder?, multiline? }].
 * rec: the record (edit) or null (create). Returns { body, read() → { data } | { errors }, targets }.
 * Edit adds an "Aktif" box. Values are trimmed; an empty optional value is null.
 */
function recordForm(fields, rec) {
  const controls = {};
  const body = [];
  for (const f of fields) {
    const value = rec?.[f.key] ?? '';
    const control = input({ name: f.key, maxlength: f.max, autocomplete: 'off', spellcheck: 'false', value: String(value), placeholder: f.placeholder, className: f.upper ? 'input upper' : 'input' });
    control.addEventListener('input', () => setFieldError(control, null));
    controls[f.key] = control;
    body.push(field({ label: f.label, input: control, hint: f.hint, optional: !f.required }));
  }
  let activeBox = null;
  if (rec) {
    const id = uid('aktif');
    activeBox = el('input', { type: 'checkbox', className: 'check', id, checked: rec.aktif !== false });
    body.push(
      el(
        'div',
        { className: 'field' },
        el('label', { className: 'check-label wrap', for: id }, activeBox, el('span', { text: 'Aktif' })),
        el('p', { className: 'hint', text: 'Pasif kayıt yeni seçimlerde görünmez; kayıtlı değerler korunur ve gösterilir.' }),
      ),
    );
  }
  function read() {
    const data = {};
    const errors = {};
    for (const f of fields) {
      let v = controls[f.key].value.trim();
      if (f.upper) v = v.toLocaleUpperCase('en-US');
      if (!v) {
        if (f.required) errors[f.key] = `${f.label} boş olamaz.`;
        data[f.key] = null;
        continue;
      }
      if (f.max && v.length > f.max) errors[f.key] = `En çok ${f.max} karakter olabilir.`;
      else if (f.pattern && !f.pattern.test(v)) errors[f.key] = f.patternMessage ?? 'Geçersiz değer.';
      data[f.key] = v;
    }
    if (activeBox) data.aktif = activeBox.checked;
    return Object.keys(errors).length > 0 ? { errors } : { data };
  }
  return { body, read, targets: controls };
}

/** Only the changed fields (null and '' are the same empty value). */
function changes(data, rec) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    const before = rec[k] === '' || rec[k] === undefined ? null : rec[k];
    if (v !== before) out[k] = v;
  }
  return out;
}

/** Create body: empty optional values are left out. */
function createBody(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) if (v !== null && k !== 'aktif') out[k] = v;
  return out;
}

/** Opens the add / edit dialog of a record. Resolves with the saved record or null. */
export function recordDialog({ title, description, fields, rec, save }) {
  const form = recordForm(fields, rec);
  return openDialog({
    title,
    description,
    body: form.body,
    submitLabel: rec ? 'Kaydet' : 'Ekle',
    submitIcon: rec ? ICONS.check : ICONS.plus,
    onSubmit: async (ctl) => {
      const r0 = form.read();
      if (r0.errors) {
        applyFieldErrors(r0.errors, form.targets);
        return false;
      }
      const payload = rec ? changes(r0.data, rec) : createBody(r0.data);
      if (rec && Object.keys(payload).length === 0) return rec;
      const r = await save(payload);
      if (r.ok) return r.body ?? rec;
      if (r.unauthorized) return null;
      if (r.error.kod === 'kod_kullaniliyor' && form.targets.kod) {
        setFieldError(form.targets.kod, r.error.mesaj);
        form.targets.kod.focus();
        return false;
      }
      const left = r.error.alanlar ? applyFieldErrors(r.error.alanlar, form.targets) : [r.error.mesaj];
      if (left.length > 0) ctl.setError(left.join(' '));
      return false;
    },
  }).done.then((v) => (v && v !== true ? v : null));
}

// ---------- The paged list screen ----------

/**
 * A list screen over GET <base>?q=&aktif=&sayfa=&adet= with search, the active filter, "Yeni ekle",
 * the Excel menu, a table with edit / delete per row and the pager. The address keeps q, aktif and
 * sayfa (plus config.query()).
 *
 * config: { title, sub, path, base() , what ('Organizasyon'), icon, columns: [{ label, className?, num?, cell(rec) }],
 *   nameOf(rec), fields (recordDialog fields), importLabels, keyLabel, exportName, before?: node,
 *   query?: () => object, emptyText? }
 * Returns { reload(), reset() } (reset: back to page 1 with no search, for a new base).
 */
export function listScreen(root, { route, signal }, config) {
  const state = {
    q: route.query.get('q') ?? '',
    aktif: ['1', '0'].includes(route.query.get('aktif')) ? route.query.get('aktif') : '',
    sayfa: Math.max(1, Number.parseInt(route.query.get('sayfa') ?? '1', 10) || 1),
  };
  let seq = 0;
  let rows = [];

  const search = input({ type: 'search', placeholder: 'Arayın…', 'aria-label': `${config.title} içinde ara`, value: state.q });
  const filter = activeFilter(state.aktif, (v) => {
    state.aktif = v;
    state.sayfa = 1;
    load();
  });
  const addBtn = btn('Yeni ekle', { icon: ICONS.plus, kind: 'primary', onClick: () => edit(null) });
  const menu = actionsMenu(
    excelItems({
      base: () => config.base(),
      exportName: config.exportName,
      onImport: () => importList({ base: () => config.base(), labels: config.importLabels, keyLabel: config.keyLabel ?? 'kod', onDone: () => load() }),
    }),
  );
  const announcer = el('p', { className: 'visually-hidden', role: 'status' });
  const results = el('div', { className: 'results' }, skeletonList(6));
  const pagerSlot = el('div', { className: 'pager-slot' });

  root.append(
    el(
      'div',
      { className: 'page' },
      pageHead({ title: config.title, sub: config.sub }),
      config.before ?? null,
      el('div', { className: 'toolbar def-toolbar' }, el('label', { className: 'search' }, icon(ICONS.search), search), filter, el('div', { className: 'def-actions' }, menu, addBtn)),
      announcer,
      results,
      pagerSlot,
    ),
  );

  search.addEventListener(
    'input',
    debounce(() => {
      state.q = search.value.trim();
      state.sayfa = 1;
      load();
    }, 300),
  );

  function syncUrl() {
    const q = { ...(config.query?.() ?? {}), q: state.q, aktif: state.aktif, sayfa: state.sayfa > 1 ? state.sayfa : '' };
    history.replaceState(history.state, '', href(config.path, q));
  }

  async function load(focus = null) {
    const base = config.base();
    if (!base) return;
    syncUrl();
    const mine = ++seq;
    results.setAttribute('aria-busy', 'true');
    if (rows.length === 0) results.replaceChildren(skeletonList(6));
    const r = await api.listDefinitions(base, { q: state.q, aktif: state.aktif, sayfa: state.sayfa, adet: PAGE_SIZE }, { signal });
    if (signal.aborted || mine !== seq) return;
    results.removeAttribute('aria-busy');
    if (!r.ok) {
      if (!r.unauthorized) results.replaceChildren(loadFailed(r, () => load()));
      pagerSlot.replaceChildren();
      return;
    }
    const body = r.body ?? {};
    rows = Array.isArray(body.kayitlar) ? body.kayitlar : [];
    const toplam = typeof body.toplam === 'number' ? body.toplam : rows.length;
    // A page past the end (a filter or a delete emptied it): back to the last page.
    if (rows.length === 0 && toplam > 0 && state.sayfa > 1) {
      state.sayfa = Math.max(1, Math.ceil(toplam / PAGE_SIZE));
      load(focus);
      return;
    }
    announcer.textContent = `${fmtCount(toplam)} kayıt`;
    render(toplam);
    pagerSlot.replaceChildren(
      ...[
        pager({
          sayfa: state.sayfa,
          adet: body.adet ?? PAGE_SIZE,
          toplam,
          onPage: (n) => {
            state.sayfa = n;
            load();
            results.scrollIntoView({ block: 'start' });
          },
        }),
      ].filter(Boolean),
    );
    if (focus) (results.querySelector(`tr[data-id="${focus.id}"] [data-act="${focus.act}"]`) ?? search).focus();
  }

  function render(toplam) {
    if (rows.length === 0) {
      const filtered = state.q || state.aktif;
      results.replaceChildren(
        filtered
          ? emptyState({ icon: ICONS.search, title: 'Bu filtreye uyan kayıt yok', text: 'Aramayı ya da durum filtresini değiştirin.' })
          : emptyState({ icon: config.icon ?? ICONS.tag, title: 'Henüz kayıt yok', text: config.emptyText ?? 'Yeni kayıt ekleyin ya da Aksiyonlar menüsünden Excel ile içe aktarın.', action: btn('Yeni ekle', { icon: ICONS.plus, kind: 'primary', onClick: () => edit(null) }) }),
      );
      return;
    }
    const tbody = el('tbody', { className: 'stagger' });
    for (const rec of rows) {
      const name = config.nameOf(rec);
      tbody.append(
        el(
          'tr',
          { className: rec.aktif === false ? 'is-off' : '', 'data-id': rec.id },
          ...config.columns.map((c, i) => {
            const v = c.cell(rec);
            const cls = [c.className, c.num ? 'num' : null, i === 0 ? 't-main' : null].filter(Boolean).join(' ') || null;
            return typeof v === 'string' || v === null || v === undefined
              ? el('td', { className: cls, 'data-label': c.label, text: v === null || v === undefined || v === '' ? '—' : v })
              : el('td', { className: cls, 'data-label': c.label }, v);
          }),
          el('td', { 'data-label': 'Durum' }, statusBadge(rec.aktif !== false)),
          el(
            'td',
            { className: 't-actions' },
            btn('Düzenle', { icon: ICONS.edit, size: 'sm', iconOnly: true, onClick: () => edit(rec), attrs: { 'data-act': 'edit', 'aria-label': `${name}: düzenle` } }),
            btn('Sil', { icon: ICONS.trash, size: 'sm', iconOnly: true, kind: 'danger-ghost', onClick: () => remove(rec), attrs: { 'data-act': 'delete', 'aria-label': `${name}: sil` } }),
          ),
        ),
      );
    }
    results.replaceChildren(
      el(
        'div',
        { className: 'table-card' },
        el(
          'div',
          { className: 'table-scroll' },
          el(
            'table',
            { className: 'data-table def-table' },
            el('caption', { className: 'visually-hidden', text: `${config.title}: ${fmtCount(toplam)} kayıt` }),
            el(
              'thead',
              {},
              el(
                'tr',
                {},
                ...config.columns.map((c) => el('th', { scope: 'col', className: c.num ? 'num' : null, text: c.label })),
                el('th', { scope: 'col', text: 'Durum' }),
                el('th', { scope: 'col' }, el('span', { className: 'visually-hidden', text: 'İşlemler' })),
              ),
            ),
            tbody,
          ),
        ),
      ),
    );
  }

  async function edit(rec) {
    const base = config.base();
    const saved = await recordDialog({
      title: rec ? `${config.what} düzenle` : `${config.what} ekle`,
      description: rec ? config.nameOf(rec) : null,
      fields: config.fields,
      rec,
      save: (payload) => (rec ? api.updateDefinition(base, rec.id, payload) : api.createDefinition(base, payload)),
    });
    if (!saved || saved === rec) return; // cancelled, or nothing changed
    toast(rec ? 'Kayıt güncellendi.' : `“${config.nameOf(saved)}” eklendi.`, 'ok');
    await load(rec ? { id: rec.id, act: 'edit' } : { id: saved.id, act: 'edit' });
  }

  function remove(rec) {
    const base = config.base();
    deleteRecord({
      name: config.nameOf(rec),
      what: config.what,
      active: rec.aktif !== false,
      run: () => api.deleteDefinition(base, rec.id),
      makeInactive: () => api.updateDefinition(base, rec.id, { aktif: false }),
      onDone: (kind) => load(kind === 'pasif' ? { id: rec.id, act: 'delete' } : null),
    });
  }

  load();
  return {
    reload: () => load(),
    reset() {
      state.q = '';
      state.sayfa = 1;
      search.value = '';
      rows = [];
      load();
    },
  };
}
