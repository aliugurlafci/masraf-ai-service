// Kategoriler (yonetici): add, edit (name, code, VAT rates, account code), pick an icon, turn on/off,
// reorder, delete, and Excel export / import (docs section 6, "Kategoriler" and "Tanım listeleri").
// GET /api/kategoriler?tumu=1 lists inactive ones too; the list is not paged, so search and the
// status filter work on the page.

import * as api from '../api.js';
import { el, icon, ICONS } from '../dom.js';
import { fmtCount } from '../format.js';
import { activeFilter, actionsMenu, deleteRecord, excelItems, importList } from '../deflist.js';
import { CATEGORY_ICON_LABEL, CATEGORY_ICONS, CATEGORY_KEYS, categoryIcon } from '../labels.js';
import { applyFieldErrors, btn, debounce, emptyState, field, fieldset, input, loadFailed, openDialog, pageHead, setFieldError, skeletonList, toast, uid } from '../ui.js';

const TEXT_MAX = 50; // kod, kdvOranlari, hesapKodu

function iconPicker(selected) {
  const name = uid('simge');
  const grid = el('div', { className: 'icon-grid' });
  for (const key of CATEGORY_KEYS) {
    grid.append(
      el(
        'label',
        { className: 'icon-option' },
        el('input', { type: 'radio', name, value: key, checked: key === selected }),
        el('span', { className: `cat-icon cat-${key}`, 'aria-hidden': 'true' }, icon(CATEGORY_ICONS[key])),
        el('span', { className: 'icon-name', text: CATEGORY_ICON_LABEL[key] }),
      ),
    );
  }
  const set = fieldset({ legend: 'Simge', content: grid });
  return { set, value: () => grid.querySelector('input:checked')?.value ?? 'diger' };
}

const blankToNull = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

export const categoriesView = {
  mount(root, { signal }) {
    let cats = [];
    let busy = false;
    const filters = { q: '', aktif: '' };
    const list = el('div', { className: 'results' }, skeletonList(4));
    const announcer = el('p', { className: 'visually-hidden', role: 'status' });
    const search = input({ type: 'search', placeholder: 'Ad, kod ya da hesap kodu ara', 'aria-label': 'Kategori ara' });
    const filter = activeFilter('', (v) => {
      filters.aktif = v;
      render();
    });
    const menu = actionsMenu(
      excelItems({
        base: api.CATEGORIES,
        exportName: 'kategoriler',
        onImport: () =>
          importList({
            base: api.CATEGORIES,
            keyLabel: 'kategori adı',
            labels: { ad: 'Ad', kod: 'Kod', kdvOranlari: 'KDV oranları', hesapKodu: 'Hesap kodu', simge: 'Simge', aktif: 'Aktif' },
            onDone: () => load(),
          }),
      }),
    );

    root.append(
      el(
        'div',
        { className: 'page narrow' },
        pageHead({
          title: 'Kategoriler',
          sub: 'Masraf formunda seçilen kategoriler. Pasif kategoriler yeni masraflarda görünmez; eski masraflarda kalır.',
        }),
        el('div', { className: 'toolbar def-toolbar' }, el('label', { className: 'search' }, icon(ICONS.search), search), filter, el('div', { className: 'def-actions' }, menu, btn('Yeni ekle', { icon: ICONS.plus, kind: 'primary', onClick: () => editCategory(null) }))),
        announcer,
        list,
      ),
    );

    search.addEventListener(
      'input',
      debounce(() => {
        filters.q = search.value.trim();
        render();
      }, 200),
    );

    const sorted = () => cats.slice().sort((a, b) => (a.sira ?? 0) - (b.sira ?? 0) || a.ad.localeCompare(b.ad, 'tr'));
    const filtering = () => Boolean(filters.q || filters.aktif);

    function visible() {
      const q = filters.q.toLocaleLowerCase('tr-TR');
      return sorted().filter((c) => {
        if (filters.aktif === '1' && !c.aktif) return false;
        if (filters.aktif === '0' && c.aktif) return false;
        if (!q) return true;
        return [c.ad, c.kod, c.hesapKodu].some((s) => (s ?? '').toLocaleLowerCase('tr-TR').includes(q));
      });
    }

    async function load(focus = null) {
      const r = await api.listCategories(true, { signal });
      if (signal.aborted) return;
      if (!r.ok) {
        if (!r.unauthorized) list.replaceChildren(loadFailed(r, () => load()));
        return;
      }
      cats = Array.isArray(r.body) ? r.body : [];
      render(focus);
    }

    function render(focus = null) {
      const rows = visible();
      announcer.textContent = `${fmtCount(rows.length)} kategori`;
      if (rows.length === 0) {
        list.replaceChildren(
          cats.length === 0
            ? emptyState({ icon: ICONS.tag, title: 'Henüz kategori yok', text: 'Masraf formunda seçilecek ilk kategoriyi ekleyin ya da Excel ile içe aktarın.', action: btn('Yeni ekle', { icon: ICONS.plus, kind: 'primary', onClick: () => editCategory(null) }) })
            : emptyState({ icon: ICONS.search, title: 'Bu filtreye uyan kategori yok', text: 'Aramayı ya da durum filtresini değiştirin.' }),
        );
        return;
      }
      const all = sorted();
      const ul = el('ul', { className: 'cat-list card-list stagger' });
      for (const c of rows) ul.append(rowFor(c, all.indexOf(c), all.length));
      list.replaceChildren(
        ...[filtering() ? el('p', { className: 'muted small cat-order-note', text: 'Sırayı değiştirmek için aramayı ve filtreyi temizleyin.' }) : null, ul].filter(Boolean),
      );
      if (focus) list.querySelector(`[data-id="${focus.id}"] [data-act="${focus.act}"]`)?.focus();
    }

    function meta(c) {
      const parts = [
        c.kod ? ['Kod', c.kod] : null,
        c.kdvOranlari ? ['KDV', c.kdvOranlari] : null,
        c.hesapKodu ? ['Hesap', c.hesapKodu] : null,
      ].filter(Boolean);
      if (parts.length === 0) return null;
      return el('span', { className: 'cat-meta' }, ...parts.map(([k, v]) => el('span', { className: 'cat-meta-item' }, el('span', { className: 'cat-meta-key', text: `${k} ` }), el('span', { className: 'mono', text: v }))));
    }

    function rowFor(c, i, total) {
      const nameCell = el(
        'div',
        { className: 'cat-name-cell' },
        el('span', { className: 'cat-title', text: c.ad }),
        meta(c),
        el('span', { className: 'cell-sub', text: `${fmtCount(i + 1)}. sırada · ${CATEGORY_ICON_LABEL[c.simge] ?? c.simge ?? 'Diğer'} simgesi` }),
      );
      const sw = el(
        'button',
        { className: 'switch', type: 'button', role: 'switch', 'aria-checked': String(Boolean(c.aktif)), 'data-act': 'toggle', 'aria-label': `${c.ad} kategorisi aktif` },
        el('span', { className: 'switch-knob', 'aria-hidden': 'true' }),
      );
      const moving = !filtering();
      const li = el(
        'li',
        { className: `cat-row${c.aktif ? '' : ' is-off'}`, 'data-id': c.id },
        el('button', { className: 'cat-icon-btn', type: 'button', 'data-act': 'icon', 'aria-label': `${c.ad}: simgeyi değiştir` }, categoryIcon(c.simge)),
        nameCell,
        el('div', { className: 'cat-switch' }, sw, el('span', { className: 'switch-text', 'aria-hidden': 'true', text: c.aktif ? 'Aktif' : 'Pasif' })),
        el(
          'div',
          { className: 'row-actions' },
          btn('Düzenle', { icon: ICONS.edit, size: 'sm', iconOnly: true, attrs: { 'data-act': 'edit', 'aria-label': `${c.ad}: düzenle` } }),
          moving ? btn('Yukarı taşı', { icon: ICONS.arrowUp, size: 'sm', iconOnly: true, disabled: i === 0, attrs: { 'data-act': 'up', 'aria-label': `${c.ad}: yukarı taşı` } }) : null,
          moving ? btn('Aşağı taşı', { icon: ICONS.arrowDown, size: 'sm', iconOnly: true, disabled: i === total - 1, attrs: { 'data-act': 'down', 'aria-label': `${c.ad}: aşağı taşı` } }) : null,
          btn('Sil', { icon: ICONS.trash, size: 'sm', iconOnly: true, kind: 'danger-ghost', attrs: { 'data-act': 'delete', 'aria-label': `${c.ad}: sil` } }),
        ),
      );
      li.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (!act || busy) return;
        if (act === 'toggle') toggle(c, sw);
        else if (act === 'icon') pickIcon(c);
        else if (act === 'edit') editCategory(c);
        else if (act === 'delete') remove(c);
        else if (act === 'up' || act === 'down') move(c, act === 'up' ? -1 : 1, act);
      });
      return li;
    }

    function replaceCat(updated) {
      const i = cats.findIndex((x) => x.id === updated.id);
      if (i >= 0) cats[i] = updated;
      else cats.push(updated);
    }

    async function toggle(c, sw) {
      busy = true;
      sw.setAttribute('aria-busy', 'true');
      const r = await api.updateCategory(c.id, { aktif: !c.aktif });
      busy = false;
      sw.removeAttribute('aria-busy');
      if (!r.ok) {
        if (!r.unauthorized) toast(r.error.mesaj, 'err');
        return;
      }
      replaceCat(r.body);
      render({ id: c.id, act: 'toggle' });
      toast(r.body.aktif ? `${r.body.ad} aktif.` : `${r.body.ad} pasif; yeni masraflarda görünmez.`, 'ok');
    }

    function pickIcon(c) {
      const picker = iconPicker(c.simge);
      openDialog({
        title: 'Simge seç',
        description: `${c.ad} kategorisinin simgesi listelerde ve formda görünür.`,
        body: [picker.set],
        submitLabel: 'Kaydet',
        onSubmit: async (ctl) => {
          const simge = picker.value();
          if (simge === c.simge) return true;
          const r = await api.updateCategory(c.id, { simge });
          if (r.ok) return r.body;
          if (r.unauthorized) return null;
          ctl.setError(r.error.mesaj);
          return false;
        },
      }).done.then((updated) => {
        if (!updated || updated === true) return;
        replaceCat(updated);
        render({ id: c.id, act: 'icon' });
        toast('Simge değişti.', 'ok');
      });
    }

    async function move(c, dir, act) {
      const rows = sorted();
      const i = rows.findIndex((x) => x.id === c.id);
      const other = rows[i + dir];
      if (!other) return;
      // Swap the two order numbers; equal numbers fall back to the positions on screen.
      let mine = c.sira;
      let theirs = other.sira;
      if (mine === theirs || mine === undefined || theirs === undefined) {
        mine = i + 1;
        theirs = i + dir + 1;
      }
      busy = true;
      const r1 = await api.updateCategory(c.id, { sira: theirs });
      const r2 = r1.ok ? await api.updateCategory(other.id, { sira: mine }) : null;
      busy = false;
      const failed = !r1.ok ? r1 : r2 && !r2.ok ? r2 : null;
      if (failed && !failed.unauthorized) toast(failed.error.mesaj, 'err');
      if (failed?.unauthorized) return;
      await load({ id: c.id, act });
      if (!list.contains(document.activeElement)) list.querySelector(`[data-id="${c.id}"] [data-act="edit"]`)?.focus();
    }

    /** Add (c null) or edit a category: name, the three codes, and the icon when adding. */
    function editCategory(c) {
      const controls = {
        ad: input({ name: 'ad', maxlength: 60, autocomplete: 'off', value: c?.ad ?? '', placeholder: 'Örn. Kırtasiye' }),
        kod: input({ name: 'kod', maxlength: TEXT_MAX, autocomplete: 'off', spellcheck: 'false', value: c?.kod ?? '' }),
        kdvOranlari: input({ name: 'kdvOranlari', maxlength: TEXT_MAX, autocomplete: 'off', value: c?.kdvOranlari ?? '', placeholder: 'Örn. 0, 1, 10, 20' }),
        hesapKodu: input({ name: 'hesapKodu', maxlength: TEXT_MAX, autocomplete: 'off', spellcheck: 'false', value: c?.hesapKodu ?? '', placeholder: 'Örn. 7609901001' }),
      };
      for (const ctl of Object.values(controls)) ctl.addEventListener('input', () => setFieldError(ctl, null));
      const picker = c ? null : iconPicker('diger');
      openDialog({
        title: c ? 'Kategoriyi düzenle' : 'Kategori ekle',
        description: c ? c.ad : null,
        body: [
          field({ label: 'Ad', input: controls.ad }),
          el(
            'div',
            { className: 'field-row' },
            field({ label: 'Kod', input: controls.kod, optional: true }),
            field({ label: 'Hesap kodu', input: controls.hesapKodu, optional: true }),
          ),
          field({ label: 'KDV oranları', input: controls.kdvOranlari, optional: true, hint: 'Bu kategoride geçerli oranlar, virgülle ayrılmış.' }),
          picker?.set,
        ],
        submitLabel: c ? 'Kaydet' : 'Ekle',
        submitIcon: c ? ICONS.check : ICONS.plus,
        onSubmit: async (ctl) => {
          const ad = controls.ad.value.trim();
          if (!ad) {
            setFieldError(controls.ad, 'Kategori adını girin.');
            controls.ad.focus();
            return false;
          }
          const data = { ad, kod: blankToNull(controls.kod.value), kdvOranlari: blankToNull(controls.kdvOranlari.value), hesapKodu: blankToNull(controls.hesapKodu.value) };
          let r;
          if (c) {
            const patch = {};
            for (const [k, v] of Object.entries(data)) if (v !== (k === 'ad' ? c.ad : blankToNull(c[k]))) patch[k] = v;
            if (Object.keys(patch).length === 0) return c;
            r = await api.updateCategory(c.id, patch);
          } else {
            const body = { ad, simge: picker.value() };
            for (const k of ['kod', 'kdvOranlari', 'hesapKodu']) if (data[k] !== null) body[k] = data[k];
            r = await api.createCategory(body);
          }
          if (r.ok) return r.body;
          if (r.unauthorized) return null;
          if (r.error.kod === 'kategori_var') {
            setFieldError(controls.ad, r.error.mesaj);
            controls.ad.focus();
            return false;
          }
          const left = r.error.alanlar ? applyFieldErrors(r.error.alanlar, controls) : [r.error.mesaj];
          if (left.length > 0) ctl.setError(left.join(' '));
          return false;
        },
      }).done.then((saved) => {
        if (!saved || saved === true || saved === c) return;
        replaceCat(saved);
        render({ id: saved.id, act: 'edit' });
        toast(c ? 'Kategori güncellendi.' : `${saved.ad} eklendi.`, 'ok');
      });
    }

    function remove(c) {
      deleteRecord({
        name: c.ad,
        what: 'Kategori',
        note: 'Koşulu bu kategori olan zorunluluk kuralları da silinir.',
        active: Boolean(c.aktif),
        run: () => api.deleteCategory(c.id),
        makeInactive: () => api.updateCategory(c.id, { aktif: false }),
        onDone: (kind, body) => {
          if (kind === 'pasif' && body) replaceCat(body);
          else cats = cats.filter((x) => x.id !== c.id);
          render(kind === 'pasif' ? { id: c.id, act: 'delete' } : null);
          if (kind !== 'pasif') search.focus();
        },
      });
    }

    load();
  },
};
