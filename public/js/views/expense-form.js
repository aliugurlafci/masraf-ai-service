// Yeni masraf (#/masraflar/yeni, optionally ?fatura=<record id>) and Masrafı düzenle
// (#/masraflar/:id/duzenle). A dropped or chosen invoice is read through the usual reading flow
// (POST /api/invoices; X-Fatura-Id is the record id) and fills the form. While the amount changes,
// POST /api/onay-akisi/onizle shows who the expense would go to.

import * as api from '../api.js';
import { el, icon, ICONS, replay } from '../dom.js';
import { fmtAmountInput, fmtCurrency, fmtDateLong, fmtRateInput, modelName, parseAmount, toCents, todayIso } from '../format.js';
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

function readingText(a) {
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
    let readToken = 0;
    let previewToken = 0;
    const objectUrls = [];
    const touched = new Set();
    const st = { faturaId: null, inv: { kind: 'empty' } };

    const page = el('div', { className: 'page wide' });
    const content = el('div', { className: 'form-skeleton', role: 'status', 'aria-label': 'Yükleniyor' }, el('span'), el('span'), el('span'));
    page.append(
      pageHead({
        title: editing ? 'Masrafı düzenle' : 'Yeni masraf',
        sub: editing ? 'Taslak ve reddedilmiş masraflar düzenlenebilir.' : 'Faturayı yükleyin; tutar, tarih ve satıcı kendiliğinden dolsun. Faturasız masraf da girebilirsiniz.',
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
    const readingHint = el('p', { className: 'form-hint', hidden: true }, icon(ICONS.clock), el('span', { text: 'Fatura okunuyor; okuma bitince kaydedebilirsiniz.' }));
    const saveBtn = btn(editing ? 'Kaydet' : 'Taslak kaydet', { icon: ICONS.check, type: 'submit' });
    let sendBtn = null;

    const fileInput = el('input', { type: 'file', accept: ACCEPT, hidden: true });
    const invBody = el('div', { className: 'inv-body' });
    const invNote = el('div', { className: 'inv-note', 'aria-live': 'polite' });

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
          el(
            'section',
            { className: 'card inv-panel', 'aria-labelledby': 'inv-h' },
            el('div', { className: 'card-head' }, el('h2', { className: 'card-title', id: 'inv-h', text: 'Fatura' }), el('span', { className: 'muted small', text: 'İsteğe bağlı' })),
            invBody,
            invNote,
            fileInput,
          ),
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
          if (name === 'tutar' || name === 'kur' || name === 'paraBirimi') {
            if (name === 'paraBirimi') updateCurrencyUi();
            else updateLocalHint();
            schedulePreview();
          }
        });
      }
      controls.tutar.addEventListener('blur', () => {
        const p = parseAmount(controls.tutar.value);
        if (!p.error && p.value !== null) controls.tutar.value = fmtAmountInput(p.value);
      });
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
        const f = fileInput.files?.[0];
        fileInput.value = '';
        if (f) readFile(f);
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
      // Native replaceChildren would print "null": keep only real nodes.
      approversBody.replaceChildren(
        ...[
          o.adimlar?.length ? el('p', { className: 'approvers-lead', text: chainLead(o, 'bu masraf şu onaycılara sırayla gidecek:') }) : null,
          approverChain(o),
          !o.adimlar?.length && o.akis?.ad ? el('p', { className: 'muted small', text: `Onay akışınız: “${o.akis.ad}”.` }) : null,
          differs ? el('p', { className: 'muted small', text: `Onay tutarı ${fmtCurrency(o.onayTutari, o.paraBirimi ?? base)}: fatura toplamı beyan edilen tutardan büyük olduğu için o esas alınır.` }) : null,
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
      if (st.faturaId) body.faturaId = st.faturaId;
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

    function setInv(next) {
      st.inv = next;
      renderInv();
    }

    function renderInv() {
      const s = st.inv;
      readingHint.hidden = s.kind !== 'reading';
      setBusy(saveBtn, busy);
      if (sendBtn) setBusy(sendBtn, busy);
      if (s.kind === 'reading') {
        saveBtn.disabled = true;
        if (sendBtn) sendBtn.disabled = true;
      }
      if (s.kind === 'empty') invBody.replaceChildren(dropZone());
      else if (s.kind === 'loading') invBody.replaceChildren(el('div', { className: 'form-skeleton small', role: 'status', 'aria-label': 'Fatura yükleniyor' }, el('span'), el('span')));
      else if (s.kind === 'reading') invBody.replaceChildren(readingBox(s));
      else if (s.kind === 'error') invBody.replaceChildren(errorBox(s));
      else invBody.replaceChildren(invoiceBox(s));
    }

    function dropZone() {
      return el(
        'div',
        { className: 'inv-drop' },
        el('span', { className: 'sheet-glyph large', 'aria-hidden': 'true' }, el('span', { className: 'scan' })),
        el('p', { className: 'inv-drop-title', text: 'Faturayı sürükleyip bırakın' }),
        el('p', { className: 'inv-drop-text', text: 'PDF ya da fotoğraf (PNG, JPEG, WEBP, GIF). Ekran görüntüsünü Ctrl+V ile yapıştırabilirsiniz.' }),
        btn('Dosya seç', { icon: ICONS.upload, kind: 'primary', onClick: () => fileInput.click() }),
        el('p', { className: 'inv-drop-foot', text: 'Faturasız masraf için yalnızca formu doldurun.' }),
      );
    }

    function readingBox(s) {
      s.statusNode = el('p', { className: 'inv-status', role: 'status', text: readingText(s.activity) });
      return el(
        'div',
        { className: 'inv-reading' },
        el(
          'div',
          { className: 'inv-reading-top' },
          el('span', { className: 'sheet-glyph large active', 'aria-hidden': 'true' }, el('span', { className: 'scan' })),
          el('div', { className: 'inv-reading-text' }, el('p', { className: 'inv-file', text: s.file.name || 'Fatura' }), s.statusNode),
          el('span', { className: 'inv-clock', 'data-since': s.since, 'data-fmt': 'clock', text: '0:00' }),
        ),
        el('p', { className: 'muted small', text: 'Okuma bir dakika kadar sürebilir. Bu sırada kategori ve açıklamayı girebilirsiniz.' }),
        btn('Vazgeç', { kind: 'ghost', size: 'sm', onClick: () => restore(s.prev) }),
      );
    }

    function errorBox(s) {
      const retriable = !FINAL_ERRORS.has(s.error?.kod);
      return el(
        'div',
        { className: 'inv-error' },
        alertBox('err', 'Fatura okunamadı', [s.error?.mesaj ?? 'Bilinmeyen bir hata oluştu.']),
        el(
          'div',
          { className: 'inv-actions' },
          retriable && s.file ? btn('Tekrar dene', { icon: ICONS.refresh, size: 'sm', onClick: () => readFile(s.file) }) : null,
          btn('Başka dosya seç', { icon: ICONS.upload, size: 'sm', onClick: () => fileInput.click() }),
          btn('Faturasız devam et', { kind: 'ghost', size: 'sm', onClick: () => restore(s.prev) }),
        ),
      );
    }

    function invoiceBox(s) {
      const f = s.fatura ?? {};
      const problems = s.kalemler ? totalChecks({ fatura: f, kalemler: s.kalemler }).filter((c) => !c.ok) : [];
      let lead = 'Bağlı fatura';
      if (s.kind === 'done') lead = s.fromRecord ? 'Okunan fatura bağlandı.' : s.onbellek ? 'Bu dosya daha önce okunmuş; sonuç kayıttan alındı.' : 'Fatura okundu.';
      return el(
        'div',
        { className: 'inv-done' },
        el('p', { className: 'inv-ok' }, icon(ICONS.checkCircle), el('span', { text: lead })),
        el(
          'dl',
          { className: 'kv compact' },
          kv('Fatura no', f.faturaNo ?? 'Okunamadı'),
          kv('Tarih', fmtDateLong(f.faturaTarihi)),
          kv('Satıcı', f.saticiUnvan),
          kv('Genel toplam', fmtCurrency(f.genelToplam, f.paraBirimi)),
        ),
        problems.length > 0 ? alertBox('warn', 'Okunan rakamları kontrol edin', problems.map((c) => c.text)) : null,
        s.preview ? invoicePreview(s.preview) : s.previewLoading ? el('div', { className: 'form-skeleton small', role: 'status', 'aria-label': 'Önizleme yükleniyor' }, el('span')) : null,
        el(
          'div',
          { className: 'inv-actions' },
          st.faturaId ? btn('Okunan faturayı aç', { icon: ICONS.external, size: 'sm', href: `#/okuma/${encodeURIComponent(st.faturaId)}`, attrs: { target: '_blank', rel: 'noopener' } }) : null,
          btn('Değiştir', { icon: ICONS.upload, size: 'sm', onClick: () => fileInput.click() }),
          btn('Kaldır', { icon: ICONS.trash, size: 'sm', kind: 'danger-ghost', onClick: removeInvoice }),
        ),
      );
    }

    /** Back to the invoice the form had before a new file was chosen (or to none). */
    function restore(prev) {
      readToken++;
      invNote.replaceChildren();
      if (prev) {
        st.faturaId = prev.faturaId;
        setInv(prev.inv);
      } else {
        st.faturaId = null;
        setInv({ kind: 'empty' });
      }
      schedulePreview();
    }

    function removeInvoice() {
      readToken++;
      st.faturaId = null;
      markDirty();
      invNote.replaceChildren();
      setInv({ kind: 'empty' });
      schedulePreview();
      invBody.querySelector('button')?.focus();
    }

    function onFiles(files) {
      const list = files.filter(Boolean);
      if (list.length === 0) return;
      if (list.length > 1) toast('Bir masrafa tek fatura eklenir; ilk dosya kullanıldı.');
      readFile(list[0]);
    }

    async function readFile(file) {
      const current = st.inv;
      const prev = current.kind === 'done' || current.kind === 'linked' ? { inv: current, faturaId: st.faturaId } : (current.prev ?? null);
      const tag = api.newTag();
      rememberSent(tag, [file]);
      const token = ++readToken;
      const s = { kind: 'reading', file, tag, since: new Date().toISOString(), activity: null, statusNode: null, prev };
      st.faturaId = null;
      invNote.replaceChildren();
      setInv(s);
      tickClocks();
      markDirty();
      const unwatch = watchTag(tag, (a) => {
        if (token !== readToken || st.inv !== s) return;
        s.activity = a;
        if (s.statusNode) s.statusNode.textContent = readingText(a);
      });
      const r = await api.sendOne(file, { force: false, tag });
      unwatch();
      if (!alive || token !== readToken) return;
      if (!r.ok) {
        if (r.unauthorized) return;
        setInv({ kind: 'error', file, error: r.error, prev });
        return;
      }
      if (!r.id) {
        setInv({ kind: 'error', file, prev, error: { kod: 'kimlik_yok', mesaj: 'Fatura okundu ama kayıt kimliği alınamadı. Fatura okuma ekranından deneyin.' } });
        return;
      }
      st.faturaId = r.id;
      const url = URL.createObjectURL(file);
      objectUrls.push(url);
      setInv({
        kind: 'done',
        fatura: r.body.fatura,
        kalemler: r.body.kalemler,
        onbellek: r.body.olcum?.kaynak === 'kayit' || r.res?.headers.get('X-Fatura-Onbellek') === '1',
        preview: { url, mime: file.type, name: file.name || 'fatura' },
      });
      fillFromInvoice(r.body.fatura);
      schedulePreview();
    }

    /** ?fatura=<id> from the reading screen: link a record that was already read. */
    async function linkRecord(fid) {
      if (!api.ID_PATTERN.test(fid)) {
        invNote.replaceChildren(alertBox('err', null, ['Fatura bağlantısı geçersiz; dosyayı yeniden yükleyin.']));
        return;
      }
      setInv({ kind: 'loading' });
      const r = await api.getRecord(fid, { signal });
      if (!alive) return;
      if (!r.ok) {
        if (r.unauthorized || r.aborted) return;
        setInv({ kind: 'empty' });
        invNote.replaceChildren(alertBox('err', 'Fatura açılamadı', [r.error.mesaj]));
        return;
      }
      st.faturaId = fid;
      const s = { kind: 'done', fromRecord: true, fatura: r.body.fatura, kalemler: r.body.kalemler, preview: null, previewLoading: true };
      setInv(s);
      fillFromInvoice(r.body.fatura);
      markDirty();
      schedulePreview();
      const file = await api.getInvoiceFile(fid, { signal });
      if (!alive || st.inv !== s) return;
      s.previewLoading = false;
      if (file.ok) {
        const url = URL.createObjectURL(file.blob);
        objectUrls.push(url);
        s.preview = { url, mime: (file.type ?? '').split(';')[0].trim(), name: r.body.fatura?.faturaNo ? `${r.body.fatura.faturaNo}` : `fatura-${fid}` };
      }
      renderInv();
    }

    /** Fills the fields the user has not typed into; says which ones and flags an amount mismatch. */
    function fillFromInvoice(f) {
      if (!f) return;
      const filled = [];
      const fill = (name, value, label) => {
        if (value === null || value === undefined || value === '') return;
        const c = controls[name];
        if (touched.has(name) && c.value.trim() !== '') return;
        if (name === 'paraBirimi') ensureCurrencyOption(value);
        c.value = value;
        replay(c, 'autofilled');
        filled.push(label);
      };
      if (typeof f.genelToplam === 'number' && f.genelToplam > 0) fill('tutar', fmtAmountInput(Math.round(f.genelToplam * 100) / 100), 'tutar');
      if (typeof f.paraBirimi === 'string' && /^[A-Z]{3}$/.test(f.paraBirimi)) fill('paraBirimi', f.paraBirimi, 'para birimi');
      if (f.faturaTarihi && f.faturaTarihi <= todayIso()) fill('masrafTarihi', f.faturaTarihi, 'tarih');
      if (f.saticiUnvan) fill('satici', f.saticiUnvan, 'satıcı');
      if (f.saticiUnvan) fill('baslik', f.saticiUnvan.slice(0, 120), 'başlık');
      updateCurrencyUi();

      const notes = [];
      if (filled.length > 0) notes.push(alertBox('ok', null, [`Faturadan dolduruldu: ${filled.join(', ')}. Göndermeden önce kontrol edin.`]));
      const typed = parseAmount(controls.tutar.value);
      if (typeof f.genelToplam === 'number' && !typed.error && typed.value !== null && controls.paraBirimi.value === f.paraBirimi && toCents(typed.value) !== toCents(f.genelToplam)) {
        notes.push(
          alertBox('warn', null, [
            `Formdaki tutar faturanın genel toplamından (${fmtCurrency(f.genelToplam, f.paraBirimi)}) farklı. Onay, ikisinden büyük olan tutar üzerinden yapılır ve onaycılar farkı görür.`,
          ]),
        );
      }
      invNote.replaceChildren(...notes);
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
      st.faturaId = d.faturaId ?? null;
      if (d.fatura) {
        setInv({
          kind: 'linked',
          fatura: d.fatura,
          preview: d.fatura.dosyaVar ? { url: api.invoiceFileUrl(d.fatura.id), mime: d.fatura.mime, name: d.fatura.dosyaAdi } : null,
        });
      } else {
        setInv({ kind: 'empty' });
      }
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
        faturaId: st.faturaId ?? null,
      };
      return { errors, data };
    }

    function createBody(data) {
      const b = { baslik: data.baslik, kategoriId: data.kategoriId, masrafTarihi: data.masrafTarihi, tutar: data.tutar, paraBirimi: data.paraBirimi };
      if (data.kur !== null) b.kur = data.kur;
      if (data.satici) b.satici = data.satici;
      if (data.aciklama) b.aciklama = data.aciklama;
      if (data.faturaId) b.faturaId = data.faturaId;
      return b;
    }

    /** Only the fields that changed; a cleared optional field is sent as null. */
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
      if ((data.faturaId ?? null) !== (d.faturaId ?? null)) p.faturaId = data.faturaId;
      return p;
    }

    function showServerError(e) {
      const alanlar = e.alanlar ? { ...e.alanlar } : null;
      if (alanlar?.faturaId) {
        invNote.replaceChildren(alertBox('err', null, [String(alanlar.faturaId)]));
        delete alanlar.faturaId;
      } else if (e.kod === 'fatura_kullaniliyor') {
        invNote.replaceChildren(alertBox('err', null, [e.mesaj]));
      }
      const leftovers = alanlar ? applyFieldErrors(alanlar, fieldTargets) : [];
      const messages = alanlar ? leftovers : [e.mesaj];
      if (messages.length > 0 || alanlar) {
        summary.replaceChildren(alertBox('err', alanlar ? 'Formu kontrol edin' : null, messages.length > 0 ? messages : ['İşaretli alanları düzeltin.']));
      }
      if (!alanlar || Object.keys(alanlar).length === 0) {
        summary.scrollIntoView({ block: 'nearest' });
        summary.focus({ preventScroll: true });
      }
    }

    function setSaving(on) {
      busy = on;
      setBusy(saveBtn, on);
      if (sendBtn) setBusy(sendBtn, on);
    }

    async function submit(sendAfter) {
      if (busy) return;
      const form = page.querySelector('form');
      if (!form) return;
      clearFieldErrors(form);
      summary.replaceChildren();
      if (st.inv.kind === 'reading') {
        summary.replaceChildren(alertBox('info', null, ['Fatura okunuyor; okuma bitince kaydedebilirsiniz.']));
        return;
      }
      const { errors, data } = collect();
      if (Object.keys(errors).length > 0) {
        applyFieldErrors(errors, fieldTargets);
        summary.replaceChildren(alertBox('err', 'Formu kontrol edin', ['İşaretli alanları düzeltin.']));
        return;
      }
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
        setInv({ kind: 'empty' });
        if (fromInvoice) linkRecord(fromInvoice);
      }
      updateCurrencyUi();
      schedulePreview();
      setFileTarget({ label: 'Bırakın, fatura okunsun', onFiles });
    }
    init();

    return {
      update() {
        return false; // another expense or invoice: start over
      },
      unmount() {
        alive = false;
        readToken++;
        schedulePreview.cancel();
        setFileTarget(null);
        window.removeEventListener('beforeunload', onBeforeUnload);
        for (const url of objectUrls) URL.revokeObjectURL(url);
      },
    };
  },
};
