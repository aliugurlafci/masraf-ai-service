// Kategoriler (yonetici): add, rename in place, pick an icon, turn on/off and reorder.
// GET /api/kategoriler?tumu=1 lists inactive ones too.

import * as api from '../api.js';
import { el, icon, ICONS } from '../dom.js';
import { fmtCount } from '../format.js';
import { CATEGORY_ICON_LABEL, CATEGORY_ICONS, CATEGORY_KEYS, categoryIcon } from '../labels.js';
import { btn, emptyState, field, fieldset, input, loadFailed, openDialog, pageHead, setBusy, setFieldError, skeletonList, toast, uid } from '../ui.js';

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

export const categoriesView = {
  mount(root, { signal }) {
    let cats = [];
    let busy = false;
    const list = el('div', { className: 'results' }, skeletonList(4));
    const announcer = el('p', { className: 'visually-hidden', role: 'status' });

    root.append(
      el(
        'div',
        { className: 'page narrow' },
        pageHead({
          title: 'Kategoriler',
          sub: 'Masraf formunda seçilen kategoriler. Pasif kategoriler yeni masraflarda görünmez; eski masraflarda kalır.',
          actions: [btn('Kategori ekle', { icon: ICONS.plus, kind: 'primary', onClick: addCategory })],
        }),
        announcer,
        list,
      ),
    );

    const sorted = () => cats.slice().sort((a, b) => (a.sira ?? 0) - (b.sira ?? 0) || a.ad.localeCompare(b.ad, 'tr'));

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
      const rows = sorted();
      announcer.textContent = `${fmtCount(rows.length)} kategori`;
      if (rows.length === 0) {
        list.replaceChildren(emptyState({ icon: ICONS.tag, title: 'Henüz kategori yok', text: 'Masraf formunda seçilecek ilk kategoriyi ekleyin.', action: btn('Kategori ekle', { icon: ICONS.plus, kind: 'primary', onClick: addCategory }) }));
        return;
      }
      const ul = el('ul', { className: 'cat-list card-list stagger' });
      rows.forEach((c, i) => ul.append(rowFor(c, i, rows.length)));
      list.replaceChildren(ul);
      if (focus) list.querySelector(`[data-id="${focus.id}"] [data-act="${focus.act}"]`)?.focus();
    }

    function rowFor(c, i, total) {
      const nameCell = el(
        'div',
        { className: 'cat-name-cell' },
        el('span', { className: 'cat-title', text: c.ad }),
        el('span', { className: 'cell-sub', text: `${fmtCount(i + 1)}. sırada · ${CATEGORY_ICON_LABEL[c.simge] ?? c.simge ?? 'Diğer'} simgesi` }),
      );
      const sw = el(
        'button',
        { className: 'switch', type: 'button', role: 'switch', 'aria-checked': String(Boolean(c.aktif)), 'data-act': 'toggle', 'aria-label': `${c.ad} kategorisi aktif` },
        el('span', { className: 'switch-knob', 'aria-hidden': 'true' }),
      );
      const li = el(
        'li',
        { className: `cat-row${c.aktif ? '' : ' is-off'}`, 'data-id': c.id },
        el('button', { className: 'cat-icon-btn', type: 'button', 'data-act': 'icon', 'aria-label': `${c.ad}: simgeyi değiştir` }, categoryIcon(c.simge)),
        nameCell,
        el('div', { className: 'cat-switch' }, sw, el('span', { className: 'switch-text', 'aria-hidden': 'true', text: c.aktif ? 'Aktif' : 'Pasif' })),
        el(
          'div',
          { className: 'row-actions' },
          btn('Yeniden adlandır', { icon: ICONS.edit, size: 'sm', iconOnly: true, attrs: { 'data-act': 'rename', 'aria-label': `${c.ad}: yeniden adlandır` } }),
          btn('Yukarı taşı', { icon: ICONS.arrowUp, size: 'sm', iconOnly: true, disabled: i === 0, attrs: { 'data-act': 'up', 'aria-label': `${c.ad}: yukarı taşı` } }),
          btn('Aşağı taşı', { icon: ICONS.arrowDown, size: 'sm', iconOnly: true, disabled: i === total - 1, attrs: { 'data-act': 'down', 'aria-label': `${c.ad}: aşağı taşı` } }),
        ),
      );
      li.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (!act || busy) return;
        if (act === 'toggle') toggle(c, sw);
        else if (act === 'icon') pickIcon(c);
        else if (act === 'rename') rename(c, li, nameCell);
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

    function rename(c, li, nameCell) {
      const box = input({ value: c.ad, maxlength: 60, 'aria-label': `${c.ad} için yeni ad`, className: 'input input-sm' });
      const save = btn('Kaydet', { size: 'sm', kind: 'primary', type: 'submit' });
      const cancel = btn('Vazgeç', { size: 'sm', kind: 'ghost' });
      const form = el('form', { className: 'rename-form', novalidate: true }, field({ label: 'Kategori adı', input: box, className: 'inline' }), el('div', { className: 'rename-buttons' }, save, cancel));
      nameCell.replaceWith(form);
      li.classList.add('editing');
      box.focus();
      box.select();
      const close = (focusAct = 'rename') => render({ id: c.id, act: focusAct });
      cancel.addEventListener('click', () => close());
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
        }
      });
      box.addEventListener('input', () => setFieldError(box, null));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const ad = box.value.trim();
        if (!ad) {
          setFieldError(box, 'Ad boş olamaz.');
          return;
        }
        if (ad === c.ad) {
          close();
          return;
        }
        setBusy(save, true);
        const r = await api.updateCategory(c.id, { ad });
        setBusy(save, false);
        if (!r.ok) {
          if (r.unauthorized) return;
          setFieldError(box, r.error.alanlar?.ad ?? r.error.mesaj);
          box.focus();
          return;
        }
        replaceCat(r.body);
        close();
        toast('Kategori adı değişti.', 'ok');
      });
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
      if (!list.contains(document.activeElement)) list.querySelector(`[data-id="${c.id}"] [data-act="rename"]`)?.focus();
    }

    function addCategory() {
      const name = input({ name: 'ad', maxlength: 60, autocomplete: 'off', required: true, placeholder: 'Örn. Kırtasiye' });
      const picker = iconPicker('diger');
      name.addEventListener('input', () => setFieldError(name, null));
      openDialog({
        title: 'Kategori ekle',
        body: [field({ label: 'Ad', input: name }), picker.set],
        submitLabel: 'Ekle',
        submitIcon: ICONS.plus,
        onSubmit: async (ctl) => {
          const ad = name.value.trim();
          if (!ad) {
            setFieldError(name, 'Kategori adını girin.');
            name.focus();
            return false;
          }
          const r = await api.createCategory({ ad, simge: picker.value() });
          if (r.ok) return r.body;
          if (r.unauthorized) return null;
          if (r.error.kod === 'kategori_var' || r.error.alanlar?.ad) {
            setFieldError(name, r.error.alanlar?.ad ?? r.error.mesaj);
            name.focus();
          } else {
            ctl.setError(r.error.mesaj);
          }
          return false;
        },
      }).done.then((created) => {
        if (!created || created === true) return;
        replaceCat(created);
        render({ id: created.id, act: 'rename' });
        toast(`${created.ad} eklendi.`, 'ok');
      });
    }

    load();
  },
};
