// Search selects: a text box that searches as you type and offers the matches in a list below it
// (ARIA combobox with a listbox), and a multi-select built on it that keeps the choices as removable
// chips. The search itself is the caller's (usually a server list with ?q=); answers that arrive
// after a newer search are dropped.

import { el, icon, ICONS } from './dom.js';
import { fmtCount } from './format.js';
import { debounce, uid } from './ui.js';

/**
 * searchSelect({ value, placeholder, search, onChange, clearable, disabled, label, ariaLabel })
 *  value: { id, label, inactive? } | null
 *  search(q, signal) → Promise<{ items: [{ id, label, sub?, inactive?, disabled? }], total? } | null>
 *    (null: the search failed; the list says so)
 *  onChange(item | null) after the user picks or clears.
 *  label names the list of matches; ariaLabel names the text box when no <label> points at it.
 * Returns { node, input, value(), setValue(item), setDisabled(on), focus() }.
 */
export function searchSelect({ value = null, placeholder = 'Arayın ve seçin…', search, onChange, clearable = true, disabled = false, label = null, ariaLabel = null, keepOpenOnPick = false, exclude = null }) {
  const listId = uid('lb');
  let current = value;
  let items = [];
  let active = -1;
  let open = false;
  let ctl = null;
  let seq = 0;
  let editing = false;

  const inputEl = el('input', {
    type: 'text',
    className: 'input combo-input',
    role: 'combobox',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    'aria-controls': listId,
    placeholder,
    'aria-label': ariaLabel,
    disabled,
  });
  const list = el('ul', { className: 'combo-list', id: listId, role: 'listbox', hidden: true, 'aria-label': label ?? 'Seçenekler' });
  const status = el('p', { className: 'visually-hidden', role: 'status' });
  const clearBtn = el('button', { className: 'combo-clear', type: 'button', 'aria-label': 'Seçimi temizle', title: 'Temizle', hidden: true }, icon(ICONS.close));
  const caret = el('span', { className: 'combo-caret', 'aria-hidden': 'true' }, icon(ICONS.chevronDown));
  const box = el('div', { className: 'combo-box' }, el('span', { className: 'combo-search', 'aria-hidden': 'true' }, icon(ICONS.search)), inputEl, clearBtn, caret);
  const node = el('div', { className: 'combo' }, box, list, status);

  function showValue() {
    inputEl.value = current?.label ?? '';
    clearBtn.hidden = !clearable || !current || inputEl.disabled;
    node.classList.toggle('has-inactive', Boolean(current?.inactive));
    inputEl.title = current?.inactive ? `${current.label} (pasif)` : '';
  }

  function close() {
    if (!open) return;
    open = false;
    list.hidden = true;
    inputEl.setAttribute('aria-expanded', 'false');
    inputEl.removeAttribute('aria-activedescendant');
    ctl?.abort();
  }

  function setActive(i) {
    const options = [...list.querySelectorAll('[role="option"]')];
    active = options.length === 0 ? -1 : Math.max(0, Math.min(i, options.length - 1));
    options.forEach((o, n) => o.classList.toggle('is-active', n === active));
    const node = options[active];
    if (node) {
      inputEl.setAttribute('aria-activedescendant', node.id);
      node.scrollIntoView({ block: 'nearest' });
    } else inputEl.removeAttribute('aria-activedescendant');
  }

  function renderList(state, total = null) {
    list.replaceChildren();
    if (state === 'loading') {
      list.append(el('li', { className: 'combo-note', role: 'presentation', text: 'Aranıyor…' }));
      return;
    }
    if (state === 'error') {
      list.append(el('li', { className: 'combo-note err', role: 'presentation', text: 'Liste yüklenemedi. Yeniden yazmayı deneyin.' }));
      status.textContent = 'Liste yüklenemedi.';
      return;
    }
    const shown = items.filter((it) => !exclude?.(it));
    if (shown.length === 0) {
      list.append(el('li', { className: 'combo-note', role: 'presentation', text: 'Sonuç yok' }));
      status.textContent = 'Sonuç yok.';
      return;
    }
    shown.forEach((it, i) => {
      const selected = current && String(current.id) === String(it.id);
      const li = el(
        'li',
        { className: 'combo-option', role: 'option', id: `${listId}-${i}`, 'aria-selected': String(Boolean(selected)), 'aria-disabled': it.disabled ? 'true' : null },
        el('span', { className: 'combo-label', text: it.label }),
        it.sub ? el('span', { className: 'combo-sub', text: it.sub }) : null,
        it.inactive ? el('span', { className: 'tag', text: 'Pasif' }) : null,
        selected ? icon(ICONS.check) : null,
      );
      // mousedown keeps the focus in the text box, so the list does not close before the click.
      li.addEventListener('mousedown', (e) => e.preventDefault());
      li.addEventListener('click', () => pick(it));
      list.append(li);
    });
    if (total !== null && total > shown.length) list.append(el('li', { className: 'combo-note', role: 'presentation', text: `${fmtCount(total)} kayıttan ilk ${fmtCount(shown.length)} tanesi. Aramayı daraltın.` }));
    status.textContent = `${fmtCount(total ?? shown.length)} sonuç.`;
    setActive(Math.max(0, shown.findIndex((it) => current && String(current.id) === String(it.id))));
  }

  async function run(q) {
    ctl?.abort();
    ctl = new AbortController();
    const mine = ++seq;
    renderList('loading');
    let r = null;
    try {
      r = await search(q, ctl.signal);
    } catch {
      r = null;
    }
    if (mine !== seq || !open) return;
    if (!r) {
      items = [];
      renderList('error');
      return;
    }
    items = r.items ?? [];
    renderList('ok', r.total ?? null);
  }

  const runSoon = debounce((q) => run(q), 250);

  function openList() {
    if (inputEl.disabled) return;
    if (!open) {
      open = true;
      list.hidden = false;
      inputEl.setAttribute('aria-expanded', 'true');
    }
    run(editing ? inputEl.value.trim() : '');
  }

  function pick(it) {
    if (!it || it.disabled) return;
    current = { id: it.id, label: it.label, inactive: Boolean(it.inactive) };
    editing = false;
    runSoon.cancel();
    if (keepOpenOnPick) {
      // A multi-select: the box empties for the next pick.
      const picked = current;
      current = null;
      showValue();
      onChange?.(picked);
      renderList('ok');
      inputEl.focus();
      return;
    }
    showValue();
    close();
    onChange?.(current);
  }

  function clear() {
    const had = current !== null;
    current = null;
    editing = false;
    showValue();
    close();
    if (had) onChange?.(null);
  }

  // A press anywhere on the list (an option, a note, its scroll bar) keeps the focus in the text box.
  list.addEventListener('mousedown', (e) => e.preventDefault());
  inputEl.addEventListener('focus', () => {
    if (current && !keepOpenOnPick) inputEl.select();
  });
  inputEl.addEventListener('click', () => {
    if (!open) openList();
  });
  inputEl.addEventListener('input', () => {
    editing = true;
    if (!open) {
      open = true;
      list.hidden = false;
      inputEl.setAttribute('aria-expanded', 'true');
    }
    renderList('loading');
    runSoon(inputEl.value.trim());
  });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        openList();
        return;
      }
      setActive(active + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter') {
      if (!open) return;
      e.preventDefault(); // never submits the form while choosing
      const shown = items.filter((it) => !exclude?.(it));
      if (active >= 0 && shown[active]) pick(shown[active]);
    } else if (e.key === 'Escape') {
      if (!open) return;
      e.preventDefault();
      e.stopPropagation(); // a dialog stays open
      editing = false;
      showValue();
      close();
    } else if (e.key === 'Home' || e.key === 'End') {
      if (!open) return;
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : Number.MAX_SAFE_INTEGER);
    }
  });
  inputEl.addEventListener('blur', () => {
    runSoon.cancel();
    // An emptied box clears the choice; other text that was not picked goes back to the choice.
    if (editing && inputEl.value.trim() === '' && clearable && !keepOpenOnPick) {
      clear();
      return;
    }
    editing = false;
    showValue();
    close();
  });
  clearBtn.addEventListener('click', () => {
    clear();
    inputEl.focus();
  });
  caret.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (open) close();
    else {
      inputEl.focus();
      openList();
    }
  });

  showValue();
  return {
    node,
    input: inputEl,
    value: () => current,
    setValue(v) {
      current = v;
      editing = false;
      showValue();
    },
    setDisabled(on) {
      inputEl.disabled = on;
      if (on) close();
      showValue();
    },
    focus: () => inputEl.focus(),
  };
}

/**
 * multiSelect({ values, search, onChange, label, placeholder }): the choices as chips (each with a
 * remove button) above a search select that empties after every pick.
 * Returns { node, input, values(), setValues(list) }.
 */
export function multiSelect({ values = [], search, onChange, label = null, placeholder = 'Arayın ve ekleyin…', max = Infinity }) {
  let chosen = values.slice();
  const chips = el('ul', { className: 'combo-chips', 'aria-label': label ? `Seçilenler: ${label}` : 'Seçilenler' });
  const announcer = el('p', { className: 'visually-hidden', role: 'status' });
  const combo = searchSelect({
    placeholder,
    search,
    label,
    clearable: false,
    keepOpenOnPick: true,
    exclude: (it) => chosen.some((c) => String(c.id) === String(it.id)),
    onChange: (it) => {
      if (!it || chosen.some((c) => String(c.id) === String(it.id))) return;
      if (chosen.length >= max) {
        announcer.textContent = `En çok ${fmtCount(max)} seçim yapılabilir.`;
        return;
      }
      chosen.push(it);
      renderChips();
      announcer.textContent = `${it.label} eklendi.`;
      onChange?.(chosen.slice());
    },
  });

  function renderChips() {
    chips.hidden = chosen.length === 0;
    chips.replaceChildren(
      ...chosen.map((c) =>
        el(
          'li',
          { className: `combo-chip${c.inactive ? ' is-off' : ''}` },
          el('span', { text: c.label }),
          c.inactive ? el('span', { className: 'tag', text: 'Pasif' }) : null,
          el(
            'button',
            {
              type: 'button',
              className: 'combo-chip-x',
              'aria-label': `Kaldır: ${c.label}`,
              title: 'Kaldır',
              onClick: () => {
                chosen = chosen.filter((x) => x !== c);
                renderChips();
                announcer.textContent = `${c.label} kaldırıldı.`;
                onChange?.(chosen.slice());
                combo.input.focus();
              },
            },
            icon(ICONS.close),
          ),
        ),
      ),
    );
  }
  renderChips();
  return {
    node: el('div', { className: 'combo-multi' }, chips, combo.node, announcer),
    input: combo.input,
    values: () => chosen.slice(),
    setValues(list) {
      chosen = list.slice();
      renderChips();
    },
  };
}

/** A search function over a paged definition list (GET <list>?q=&aktif=1&adet=20). */
export function listSearch(fetchPage, toItem, { activeOnly = true, adet = 20 } = {}) {
  return async (q, signal) => {
    const params = { q, adet };
    if (activeOnly) params.aktif = 1;
    const r = await fetchPage(params, { signal });
    if (!r.ok) return null;
    const rows = Array.isArray(r.body?.kayitlar) ? r.body.kayitlar : [];
    return { items: rows.map(toItem), total: typeof r.body?.toplam === 'number' ? r.body.toplam : rows.length };
  };
}
