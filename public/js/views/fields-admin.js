// Alan yönetimi (#/alanlar, yonetici): the form fields (Kategori, Masraf merkezi), the invoice
// header fields that must be filled, the receipt fields a sender fills in for each receipt, and the
// conditional rules ("Kategori = ARAÇ BAKIM ONARIM → Etiket, Proje Kodu zorunlu"). Contract:
// docs/onay-sistemi.md, section 3 ("Fiş alanları, masraf merkezi ve zorunluluk kuralları") and
// section 6 ("Fiş alanları"). What a field may change comes from the contract's table; the server
// refuses anything else with 400.

import * as api from '../api.js';
import { listSearch, searchSelect } from '../combo.js';
import { deleteRecord } from '../deflist.js';
import { el, icon, ICONS } from '../dom.js';
import { ENTRY_TYPES, isEntryField, isInvoiceField, TYPE_LABEL } from '../fields.js';
import { fmtCount } from '../format.js';
import { href } from '../router.js';
import {
  actionDialog,
  applyFieldErrors,
  btn,
  field,
  fieldset,
  input,
  loadFailed,
  openDialog,
  pageHead,
  select,
  setFieldError,
  skeletonList,
  textarea,
  toast,
  uid,
} from '../ui.js';

const MAX_ENTRY_FIELDS = 40;
const FORM_KEYS = ['kategori', 'masrafMerkezi'];

const bySira = (a, b) => (a.sira ?? 0) - (b.sira ?? 0) || a.id - b.id;

export const fieldsAdminView = {
  mount(root, { signal }) {
    let fields = [];
    let rules = [];
    let categories = null; // loaded for the rule dialog's value search
    let busy = false;

    const body = el('div', { className: 'fa-body' }, skeletonList(6));
    const announcer = el('p', { className: 'visually-hidden', role: 'status' });
    root.append(
      el(
        'div',
        { className: 'page' },
        pageHead({
          title: 'Alan yönetimi',
          sub: 'Masraf formundaki ve her fişteki alanlar, hangilerinin zorunlu olduğu ve seçilen değere göre zorunlu olan alanlar.',
        }),
        announcer,
        body,
      ),
    );

    const fieldOf = (key) => fields.find((f) => f.anahtar === key) ?? null;
    const labelOf = (key) => fieldOf(key)?.ad ?? key;
    const entryFields = () => fields.filter(isEntryField).sort(bySira);
    const invoiceFields = () => fields.filter(isInvoiceField).sort(bySira);

    async function load(focus = null) {
      const r = await api.listFields(true, { signal });
      if (signal.aborted) return;
      if (!r.ok) {
        if (!r.unauthorized) body.replaceChildren(loadFailed(r, () => load()));
        return;
      }
      fields = Array.isArray(r.body?.alanlar) ? r.body.alanlar : [];
      rules = Array.isArray(r.body?.kurallar) ? r.body.kurallar : [];
      render(focus);
    }

    function render(focus = null) {
      body.replaceChildren(formCard(), invoiceCard(), entryCard(), rulesCard());
      if (focus) body.querySelector(`[data-key="${focus.key}"] [data-act="${focus.act}"]`)?.focus();
    }

    function replaceField(updated) {
      const i = fields.findIndex((f) => f.id === updated.id);
      if (i >= 0) fields[i] = { ...fields[i], ...updated };
      else fields.push(updated);
    }

    // ---------- Pieces ----------

    function switchFor(f, prop, label) {
      const on = Boolean(f[prop]);
      const sw = el(
        'button',
        { className: 'switch', type: 'button', role: 'switch', 'aria-checked': String(on), 'aria-label': `${f.ad}: ${label}`, 'data-act': prop },
        el('span', { className: 'switch-knob', 'aria-hidden': 'true' }),
      );
      sw.addEventListener('click', () => toggle(f, prop, sw));
      return el('span', { className: 'fa-switch' }, sw, el('span', { className: 'switch-text', 'aria-hidden': 'true', text: prop === 'aktif' ? (on ? 'Aktif' : 'Pasif') : on ? 'Zorunlu' : 'İsteğe bağlı' }));
    }

    function aboutCell(f) {
      return f.aciklama ? el('span', { className: 'fa-about', text: f.aciklama }) : el('span', { className: 'muted', text: '—' });
    }

    function editButton(f) {
      return btn('Düzenle', { icon: ICONS.edit, size: 'sm', iconOnly: true, onClick: () => editField(f), attrs: { 'data-act': 'edit', 'aria-label': `${f.ad}: düzenle` } });
    }

    function table(caption, heads, rows, className = '') {
      return el(
        'div',
        { className: 'table-scroll' },
        el(
          'table',
          { className: `data-table fa-table ${className}`.trim() },
          el('caption', { className: 'visually-hidden', text: caption }),
          el('thead', {}, el('tr', {}, ...heads.map((h) => (h ? el('th', { scope: 'col', className: h.className ?? null, text: h.label }) : el('th', { scope: 'col' }, el('span', { className: 'visually-hidden', text: 'İşlemler' })))))),
          el('tbody', {}, ...rows),
        ),
      );
    }

    function card(id, title, sub, content, action = null) {
      return el(
        'section',
        { className: 'card fa-card', 'aria-labelledby': id },
        el('div', { className: 'card-head' }, el('div', { className: 'card-head-text' }, el('h2', { className: 'card-title', id, text: title }), sub ? el('p', { className: 'card-sub', text: sub }) : null), action),
        content,
      );
    }

    // ---------- Form fields ----------

    function formCard() {
      const rows = FORM_KEYS.map(fieldOf)
        .filter(Boolean)
        .map((f) =>
          el(
            'tr',
            { 'data-key': f.anahtar, className: f.aktif === false ? 'is-off' : '' },
            el('td', { className: 't-main', 'data-label': 'Alan' }, el('span', { className: 'cell-title', text: f.ad })),
            el('td', { 'data-label': 'Zorunlu' }, f.anahtar === 'kategori' ? el('span', { className: 'tag accent', text: 'Her zaman zorunlu' }) : switchFor(f, 'zorunlu', 'zorunlu')),
            el('td', { 'data-label': 'Durum' }, f.anahtar === 'kategori' ? el('span', { className: 'muted', text: 'Her zaman aktif' }) : switchFor(f, 'aktif', 'aktif')),
            el('td', { className: 't-detail', 'data-label': 'Açıklama' }, aboutCell(f)),
            el('td', { className: 't-actions' }, editButton(f)),
          ),
        );
      const mm = fieldOf('masrafMerkezi');
      return card(
        'fa-form',
        'Form alanları',
        mm?.aktif === false
          ? 'Masraf merkezi pasif: formda gösterilmez ve masraflar masraf merkezisiz gönderilir.'
          : 'Bir masrafta bir kez seçilir. Masraf merkezini gönderen, kendisine tanımlı merkezlerden seçer.',
        table('Form alanları', [{ label: 'Alan' }, { label: 'Zorunlu' }, { label: 'Durum' }, { label: 'Açıklama' }, null], rows),
      );
    }

    // ---------- Invoice header ----------

    function invoiceCard() {
      const rows = invoiceFields().map((f) =>
        el(
          'tr',
          { 'data-key': f.anahtar },
          el('td', { className: 't-main', 'data-label': 'Alan' }, el('span', { className: 'cell-title', text: f.ad })),
          el('td', { 'data-label': 'Zorunlu' }, switchFor(f, 'zorunlu', 'zorunlu')),
          el('td', { className: 't-detail', 'data-label': 'Açıklama' }, aboutCell(f)),
          el('td', { className: 't-actions' }, editButton(f)),
        ),
      );
      return card(
        'fa-invoice',
        'Fatura bilgileri',
        'Okunan faturanın bilgileri. Zorunlu olanlar boşsa masraf onaya gönderilemez; gönderen düzeltip doldurur. Okuma kalitesi kontrolü bu ayardan etkilenmez.',
        table('Fatura bilgileri', [{ label: 'Alan' }, { label: 'Zorunlu' }, { label: 'Açıklama' }, null], rows),
      );
    }

    // ---------- Receipt fields ----------

    function entryCard() {
      const list = entryFields();
      const full = list.length >= MAX_ENTRY_FIELDS;
      const add = btn('Alan ekle', { icon: ICONS.plus, kind: 'primary', size: 'sm', disabled: full, onClick: addField, attrs: full ? { title: `En çok ${MAX_ENTRY_FIELDS} fiş alanı tanımlanabilir.` } : {} });
      const rows = list.map((f, i) => {
        const used = (f.kullanim ?? 0) > 0;
        const hintId = uid('fa-del');
        const optionsCell =
          f.tur === 'liste'
            ? el('a', { className: 'card-link', href: href('/fis-listeleri', { alan: f.anahtar }), 'aria-label': `${f.ad}: ${fmtCount(f.secenekSayisi ?? 0)} aktif seçenek, listeyi aç`, text: `${fmtCount(f.secenekSayisi ?? 0)} seçenek` })
            : el('span', { className: 'muted', text: '—' });
        return el(
          'tr',
          { 'data-key': f.anahtar, className: f.aktif === false ? 'is-off' : '' },
          el(
            'td',
            { className: 't-order' },
            el(
              'span',
              { className: 'fa-move' },
              btn('Yukarı taşı', { icon: ICONS.arrowUp, size: 'sm', iconOnly: true, disabled: i === 0, onClick: () => move(f, -1), attrs: { 'data-act': 'up', 'aria-label': `${f.ad}: yukarı taşı` } }),
              btn('Aşağı taşı', { icon: ICONS.arrowDown, size: 'sm', iconOnly: true, disabled: i === list.length - 1, onClick: () => move(f, 1), attrs: { 'data-act': 'down', 'aria-label': `${f.ad}: aşağı taşı` } }),
            ),
          ),
          el(
            'td',
            { className: 't-main', 'data-label': 'Alan' },
            el('div', { className: 'cell-text' }, el('span', { className: 'cell-title', text: f.ad }), el('span', { className: 'cell-sub' }, el('span', { className: 'mono', text: f.anahtar }), f.aciklama ? el('span', { text: ` · ${f.aciklama}` }) : null)),
          ),
          el('td', { 'data-label': 'Tür', text: TYPE_LABEL[f.tur] ?? f.tur }),
          el('td', { 'data-label': 'Zorunlu' }, switchFor(f, 'zorunlu', 'zorunlu')),
          el('td', { 'data-label': 'Durum' }, switchFor(f, 'aktif', 'aktif')),
          el('td', { 'data-label': 'Seçenekler' }, optionsCell),
          el('td', { className: 'num', 'data-label': 'Kullanım', title: 'Bu alana değer girilmiş fiş sayısı', text: fmtCount(f.kullanim ?? 0) }),
          el(
            'td',
            { className: 't-actions' },
            editButton(f),
            btn('Sil', {
              icon: ICONS.trash,
              size: 'sm',
              iconOnly: true,
              kind: 'danger-ghost',
              disabled: used,
              onClick: () => removeField(f),
              attrs: {
                'data-act': 'delete',
                'aria-label': `${f.ad}: sil`,
                title: used ? 'Değer girilmiş alan silinemez; pasifleştirin.' : 'Sil',
                'aria-describedby': used ? hintId : null,
              },
            }),
            used ? el('span', { className: 'visually-hidden', id: hintId, text: 'Değer girilmiş alan silinemez; pasifleştirin.' }) : null,
          ),
        );
      });
      return card(
        'fa-entry',
        'Fiş alanları',
        `Gönderenin her fiş için ayrı doldurduğu alanlar; fiş okunurken de doldurulabilir. ${fmtCount(list.length)} / ${MAX_ENTRY_FIELDS} alan.`,
        list.length > 0 ? table('Fiş alanları', [{ label: 'Sıra' }, { label: 'Alan' }, { label: 'Tür' }, { label: 'Zorunlu' }, { label: 'Durum' }, { label: 'Seçenekler' }, { label: 'Kullanım', className: 'num' }, null], rows, 'fa-entry-table') : el('p', { className: 'muted', text: 'Henüz fiş alanı yok. “Alan ekle” ile ekleyin.' }),
        add,
      );
    }

    // ---------- Changes ----------

    async function toggle(f, prop, sw) {
      if (busy) return;
      busy = true;
      sw.setAttribute('aria-busy', 'true');
      const r = await api.updateField(f.id, { [prop]: !f[prop] });
      busy = false;
      sw.removeAttribute('aria-busy');
      if (!r.ok) {
        if (!r.unauthorized) toast(Object.values(r.error.alanlar ?? {})[0] ?? r.error.mesaj, 'err');
        return;
      }
      replaceField(r.body);
      render({ key: f.anahtar, act: prop });
      const n = r.body;
      announcer.textContent = prop === 'aktif' ? `${n.ad} ${n.aktif ? 'aktif' : 'pasif'}.` : `${n.ad} ${n.zorunlu ? 'zorunlu' : 'isteğe bağlı'}.`;
      if (prop === 'aktif') toast(n.aktif ? `${n.ad} aktif.` : `${n.ad} pasif; formlarda görünmez, kayıtlı değerler korunur.`, 'ok');
    }

    async function move(f, dir) {
      if (busy) return;
      const list = entryFields();
      const i = list.findIndex((x) => x.id === f.id);
      const other = list[i + dir];
      if (!other) return;
      busy = true;
      let failed = null;
      if ((f.sira ?? 0) === (other.sira ?? 0)) {
        // Same number: one step past the neighbour is enough.
        const r = await api.updateField(f.id, { sira: (other.sira ?? 0) + dir });
        if (!r.ok) failed = r;
      } else {
        const r1 = await api.updateField(f.id, { sira: other.sira });
        const r2 = r1.ok ? await api.updateField(other.id, { sira: f.sira }) : null;
        failed = !r1.ok ? r1 : r2 && !r2.ok ? r2 : null;
      }
      busy = false;
      if (failed?.unauthorized) return;
      if (failed) toast(failed.error.mesaj, 'err');
      await load({ key: f.anahtar, act: dir < 0 ? 'up' : 'down' });
      if (!body.contains(document.activeElement)) body.querySelector(`[data-key="${f.anahtar}"] [data-act="edit"]`)?.focus();
    }

    /** Name (receipt fields only) and help text; the system fields keep their names. */
    function editField(f) {
      const own = !f.sistem;
      const name = own ? input({ name: 'ad', maxlength: 60, autocomplete: 'off', value: f.ad }) : null;
      const about = textarea({ name: 'aciklama', maxlength: 200, rows: 2, value: f.aciklama ?? '' });
      about.value = f.aciklama ?? '';
      for (const c of [name, about].filter(Boolean)) c.addEventListener('input', () => setFieldError(c, null));
      openDialog({
        title: `${f.ad}: düzenle`,
        description: own ? `Anahtar: ${f.anahtar} · ${TYPE_LABEL[f.tur] ?? f.tur} (tür sonradan değişmez)` : 'Sistem alanının adı değişmez; yanında gösterilen açıklamayı yazabilirsiniz.',
        body: [name ? field({ label: 'Ad', input: name, hint: 'En çok 60 karakter; başka bir alanla aynı olamaz.' }) : null, field({ label: 'Açıklama', input: about, optional: true, hint: 'Formda alanın yanında yardım metni olarak görünür. En çok 200 karakter.' })],
        submitLabel: 'Kaydet',
        onSubmit: async (ctl) => {
          const patch = {};
          if (name) {
            const ad = name.value.trim();
            if (!ad) {
              setFieldError(name, 'Ad boş olamaz.');
              name.focus();
              return false;
            }
            if (ad !== f.ad) patch.ad = ad;
          }
          const aciklama = about.value.trim() || null;
          if (aciklama !== (f.aciklama ?? null)) patch.aciklama = aciklama;
          if (Object.keys(patch).length === 0) return f;
          const r = await api.updateField(f.id, patch);
          if (r.ok) return r.body;
          if (r.unauthorized) return null;
          if (r.error.kod === 'alan_adi_kullaniliyor' && name) {
            setFieldError(name, r.error.mesaj);
            name.focus();
            return false;
          }
          const left = r.error.alanlar ? applyFieldErrors(r.error.alanlar, { ad: name, aciklama: about }) : [r.error.mesaj];
          if (left.length > 0) ctl.setError(left.join(' '));
          return false;
        },
      }).done.then((saved) => {
        if (!saved || saved === true || saved === f) return;
        replaceField(saved);
        render({ key: f.anahtar, act: 'edit' });
        toast('Alan güncellendi.', 'ok');
      });
    }

    function addField() {
      const name = input({ name: 'ad', maxlength: 60, autocomplete: 'off', placeholder: 'Örn. Araç Plakası' });
      const type = select(Object.entries(ENTRY_TYPES).map(([value, label]) => ({ value, label })), { name: 'tur', value: 'liste' });
      const requiredId = uid('zorunlu');
      const required = el('input', { type: 'checkbox', className: 'check', id: requiredId });
      const about = textarea({ name: 'aciklama', maxlength: 200, rows: 2 });
      const typeHint = el('span');
      const hints = {
        liste: 'Seçenekler Fiş listeleri ekranında eklenir ya da Excel ile içe aktarılır.',
        metin: 'En çok 200 karakter.',
        uzun_metin: 'En çok 1000 karakter; formda çok satırlı kutu.',
        sayi: 'Sayı.',
        tarih: 'Tarih (gün.ay.yıl).',
      };
      const showHint = () => (typeHint.textContent = `${hints[type.value] ?? ''} Tür sonradan değişmez.`);
      showHint();
      type.addEventListener('change', showHint);
      name.addEventListener('input', () => setFieldError(name, null));
      openDialog({
        title: 'Fiş alanı ekle',
        description: 'Gönderen bu alanı her fiş için ayrı doldurur. Anahtar addan üretilir ve sonradan değişmez.',
        body: [
          field({ label: 'Ad', input: name }),
          field({ label: 'Tür', input: type, hint: typeHint }),
          el('div', { className: 'field' }, el('label', { className: 'check-label wrap', for: requiredId }, required, el('span', { text: 'Zorunlu' })), el('p', { className: 'hint', text: 'İşaretlenirse her fişte doldurulmadan masraf onaya gönderilemez.' })),
          field({ label: 'Açıklama', input: about, optional: true, hint: 'Formda alanın yanında yardım metni olarak görünür.' }),
        ],
        submitLabel: 'Ekle',
        submitIcon: ICONS.plus,
        onSubmit: async (ctl) => {
          const ad = name.value.trim();
          if (!ad) {
            setFieldError(name, 'Alanın adını girin.');
            name.focus();
            return false;
          }
          const data = { ad, tur: type.value, zorunlu: required.checked };
          const aciklama = about.value.trim();
          if (aciklama) data.aciklama = aciklama;
          const r = await api.createField(data);
          if (r.ok) return r.body;
          if (r.unauthorized) return null;
          if (r.error.kod === 'alan_adi_kullaniliyor') {
            setFieldError(name, r.error.mesaj);
            name.focus();
            return false;
          }
          const left = r.error.alanlar ? applyFieldErrors(r.error.alanlar, { ad: name, tur: type, aciklama: about }) : [r.error.mesaj];
          if (left.length > 0) ctl.setError(left.join(' '));
          return false;
        },
      }).done.then(async (created) => {
        if (!created || created === true) return;
        toast(created.tur === 'liste' ? `${created.ad} eklendi. Seçeneklerini Fiş listeleri ekranında ekleyin.` : `${created.ad} eklendi.`, 'ok');
        await load({ key: created.anahtar, act: 'edit' });
      });
    }

    function removeField(f) {
      deleteRecord({
        name: f.ad,
        what: 'Alan',
        note: 'Seçenekleri, onu koşul olarak kullanan kurallar ve kurallardaki hedefliği de silinir.',
        active: f.aktif !== false,
        run: () => api.deleteField(f.id),
        makeInactive: () => api.updateField(f.id, { aktif: false }),
        onDone: (kind) => load(kind === 'pasif' ? { key: f.anahtar, act: 'aktif' } : null),
      });
    }

    // ---------- Rules ----------

    function conditionChoices() {
      const lists = fields.filter((f) => f.tur === 'liste').sort(bySira);
      return [fieldOf('kategori'), fieldOf('masrafMerkezi'), ...lists].filter(Boolean);
    }

    function ruleText(rule) {
      const cond = fieldOf(rule.kosulAlan);
      return {
        cond: cond?.ad ?? rule.kosulAlan,
        value: rule.kosulDeger?.gosterim ?? `#${rule.kosulDeger?.id ?? '?'}`,
        targets: (rule.hedefler ?? []).map(labelOf),
      };
    }

    function rulesCard() {
      const list = rules.slice().sort((a, b) => {
        const ta = ruleText(a);
        const tb = ruleText(b);
        return ta.cond.localeCompare(tb.cond, 'tr') || ta.value.localeCompare(tb.value, 'tr');
      });
      const add = btn('Kural ekle', { icon: ICONS.plus, kind: 'primary', size: 'sm', onClick: () => editRule(null) });
      const items = list.map((rule) => {
        const t = ruleText(rule);
        const cond = fieldOf(rule.kosulAlan);
        const off = cond?.aktif === false;
        return el(
          'li',
          { className: `fa-rule${off ? ' is-off' : ''}`, 'data-key': `kural-${rule.id}` },
          el(
            'p',
            { className: 'fa-rule-text' },
            el('span', { className: 'fa-rule-cond' }, el('span', { className: 'muted', text: `${t.cond} = ` }), el('strong', { text: t.value })),
            rule.kosulDeger?.aktif === false ? el('span', { className: 'tag', text: 'Değer pasif' }) : null,
            el('span', { className: 'fa-rule-arrow', 'aria-hidden': 'true' }, icon(ICONS.chevronRight)),
            el('span', { className: 'visually-hidden', text: ' ise ' }),
            el('span', { className: 'fa-rule-targets' }, ...t.targets.map((x) => el('span', { className: 'tag accent', text: x }))),
            el('span', { className: 'muted', text: ' zorunlu' }),
          ),
          off ? el('p', { className: 'muted small', text: `Uygulanmıyor: ${t.cond} alanı pasif.` }) : null,
          el(
            'div',
            { className: 'row-actions' },
            btn('Düzenle', { icon: ICONS.edit, size: 'sm', iconOnly: true, onClick: () => editRule(rule), attrs: { 'data-act': 'edit', 'aria-label': `Kuralı düzenle: ${t.cond} = ${t.value}` } }),
            btn('Sil', { icon: ICONS.trash, size: 'sm', iconOnly: true, kind: 'danger-ghost', onClick: () => removeRule(rule), attrs: { 'data-act': 'delete', 'aria-label': `Kuralı sil: ${t.cond} = ${t.value}` } }),
          ),
        );
      });
      return card(
        'fa-rules',
        'Koşullu zorunluluk kuralları',
        'Seçilen değere göre zorunlu olan alanlar. Koşul kategori ya da masraf merkeziyse her fişe, bir fiş alanıysa yalnızca o fişe uygulanır.',
        items.length > 0 ? el('ul', { className: 'fa-rules', role: 'list' }, ...items) : el('p', { className: 'muted', text: 'Henüz kural yok.' }),
        add,
      );
    }

    async function categorySearch(q) {
      if (!categories) {
        const r = await api.listCategories(true, { signal });
        if (!r.ok) return null;
        categories = Array.isArray(r.body) ? r.body : [];
      }
      const needle = q.toLocaleLowerCase('tr-TR');
      const items = categories
        .filter((c) => !needle || [c.ad, c.kod].some((s) => (s ?? '').toLocaleLowerCase('tr-TR').includes(needle)))
        .sort((a, b) => (a.sira ?? 0) - (b.sira ?? 0) || a.ad.localeCompare(b.ad, 'tr'))
        .map((c) => ({ id: c.id, label: c.ad, sub: c.kod ?? null, inactive: c.aktif === false }));
      return { items: items.slice(0, 50), total: items.length };
    }

    function searchFor(key) {
      if (key === 'kategori') return categorySearch;
      if (key === 'masrafMerkezi') return listSearch(api.listCostCentres, (m) => ({ id: m.id, label: m.gosterim ?? m.kod, inactive: m.aktif === false }), { activeOnly: false });
      return listSearch((p, o) => api.listOptions(key, p, o), (s) => ({ id: s.id, label: s.gosterim ?? s.kod, inactive: s.aktif === false }), { activeOnly: false });
    }

    /** The fields a rule on this condition may make required (contract: kural doğrulaması). */
    function targetGroups(condKey) {
      const cond = fieldOf(condKey);
      const formCond = cond?.duzey === 'form';
      const groups = [];
      if (formCond && condKey !== 'masrafMerkezi' && fieldOf('masrafMerkezi')) groups.push({ title: 'Form', items: [fieldOf('masrafMerkezi')] });
      groups.push({ title: 'Fatura bilgileri', items: invoiceFields() });
      groups.push({ title: 'Fiş alanları', items: entryFields().filter((f) => f.anahtar !== condKey) });
      return groups.filter((g) => g.items.length > 0);
    }

    function editRule(rule) {
      const choices = conditionChoices();
      const condSel = select(
        choices.map((f) => ({ value: f.anahtar, label: f.aktif === false ? `${f.ad} (pasif)` : f.ad })),
        { name: 'kosulAlan', value: rule?.kosulAlan ?? 'kategori' },
      );
      let condKey = condSel.value;
      let value = rule ? { id: rule.kosulDeger.id, label: rule.kosulDeger.gosterim, inactive: rule.kosulDeger.aktif === false } : null;
      const checked = new Set(rule?.hedefler ?? []);
      let combo = null;
      const valueSlot = el('div');
      const targetsBox = el('div', { className: 'fa-targets' });
      const targetsSet = fieldset({ legend: 'Zorunlu olacak alanlar', content: targetsBox, hint: 'En az bir alan seçin.' });

      function buildValue() {
        combo = searchSelect({
          value,
          placeholder: 'Arayın ve seçin…',
          search: searchFor(condKey),
          onChange: (v) => {
            value = v;
            setFieldError(combo.input, null);
          },
        });
        valueSlot.replaceChildren(field({ label: 'Değer', input: combo.input, control: combo.node, hint: 'Pasif bir kayıt da seçilebilir; kural kayıtlı değerlerde uygulanır.' }));
      }

      function buildTargets() {
        const groups = targetGroups(condKey);
        const allowed = new Set(groups.flatMap((g) => g.items.map((f) => f.anahtar)));
        for (const k of [...checked]) if (!allowed.has(k)) checked.delete(k);
        targetsBox.replaceChildren(
          ...groups.map((g) =>
            el(
              'div',
              { className: 'fa-target-group', role: 'group', 'aria-label': g.title },
              el('p', { className: 'fa-target-title', text: g.title }),
              el(
                'div',
                { className: 'fa-target-list' },
                ...g.items.map((f) => {
                  const id = uid('hedef');
                  const box = el('input', { type: 'checkbox', className: 'check', id, value: f.anahtar, checked: checked.has(f.anahtar) });
                  box.addEventListener('change', () => {
                    if (box.checked) checked.add(f.anahtar);
                    else checked.delete(f.anahtar);
                    setFieldError(targetsSet, null);
                  });
                  return el('label', { className: 'check-label wrap fa-target', for: id }, box, el('span', { text: f.ad }), f.aktif === false ? el('span', { className: 'tag', text: 'Pasif' }) : null);
                }),
              ),
            ),
          ),
        );
      }

      condSel.addEventListener('change', () => {
        condKey = condSel.value;
        value = null;
        setFieldError(condSel, null);
        buildValue();
        buildTargets();
      });
      buildValue();
      buildTargets();

      openDialog({
        title: rule ? 'Kuralı düzenle' : 'Kural ekle',
        description: '“Koşul alanı bu değerdeyse şu alanlar zorunludur.” Bir değer için tek kural olur.',
        size: 'wide',
        body: [field({ label: 'Koşul alanı', input: condSel, hint: 'Kategori, masraf merkezi ya da liste türünde bir fiş alanı.' }), valueSlot, targetsSet],
        submitLabel: rule ? 'Kaydet' : 'Ekle',
        submitIcon: rule ? ICONS.check : ICONS.plus,
        onSubmit: async (ctl) => {
          let bad = false;
          if (!value) {
            setFieldError(combo.input, 'Bir değer seçin.');
            bad = true;
          }
          const hedefler = targetGroups(condKey)
            .flatMap((g) => g.items.map((f) => f.anahtar))
            .filter((k) => checked.has(k));
          if (hedefler.length === 0) {
            setFieldError(targetsSet, 'En az bir alan seçin.');
            bad = true;
          }
          if (bad) {
            ctl.form.querySelector('[aria-invalid="true"]')?.focus();
            return false;
          }
          const data = { kosulAlan: condKey, kosulDegerId: value.id, hedefler };
          const r = rule ? await api.updateFieldRule(rule.id, data) : await api.createFieldRule(data);
          if (r.ok) return r.body;
          if (r.unauthorized) return null;
          if (r.error.kod === 'kural_var') {
            setFieldError(combo.input, r.error.mesaj);
            combo.input.focus();
            return false;
          }
          const alanlar = { ...(r.error.alanlar ?? {}) };
          // hedefler.<i>: the i-th target sent; the message goes over the list with the field's name.
          const targetMsgs = [];
          for (const [k, msg] of Object.entries(alanlar)) {
            const m = /^hedefler(?:\.(\d+))?$/.exec(k);
            if (!m) continue;
            delete alanlar[k];
            targetMsgs.push(m[1] !== undefined && hedefler[Number(m[1])] ? `${labelOf(hedefler[Number(m[1])])}: ${msg}` : String(msg));
          }
          if (targetMsgs.length > 0) setFieldError(targetsSet, targetMsgs.join(' '));
          const left = Object.keys(alanlar).length > 0 ? applyFieldErrors(alanlar, { kosulAlan: condSel, kosulDegerId: combo.input }) : targetMsgs.length > 0 ? [] : [r.error.mesaj];
          if (left.length > 0) ctl.setError(left.join(' '));
          return false;
        },
      }).done.then(async (saved) => {
        if (!saved || saved === true) return;
        toast(rule ? 'Kural güncellendi.' : 'Kural eklendi.', 'ok');
        await load({ key: `kural-${saved.id}`, act: 'edit' });
      });
    }

    async function removeRule(rule) {
      const t = ruleText(rule);
      const r = await actionDialog({
        title: 'Kural silinsin mi?',
        message: `“${t.cond} = ${t.value}” kuralı silinir; ${t.targets.join(', ')} bu değerde artık zorunlu olmaz (kendi ayarları geçerli kalır).`,
        confirmLabel: 'Sil',
        kind: 'danger',
        confirmIcon: ICONS.trash,
        run: () => api.deleteFieldRule(rule.id),
      });
      if (!r?.ok) return;
      toast('Kural silindi.', 'ok');
      rules = rules.filter((x) => x.id !== rule.id);
      render();
      body.querySelector('#fa-rules')?.closest('section')?.querySelector('.card-head .btn')?.focus();
    }

    load();
  },
};
