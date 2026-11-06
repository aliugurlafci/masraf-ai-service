// Onay akışları (yonetici): several named flows, exactly one of them the default. A user's expenses
// go to the flow they are assigned to (Kullanıcılar), or to the default one when they have none.
//
// A flow is a strategy and an ordered approver list (docs/onay-sistemi.md, section 2). Every approver
// but the last has an approval limit: the largest amount (base currency, inclusive) they give the last
// approval for. Limits rise down the list and the last approver has none, so every amount has exactly
// one deciding approver. "zincir": everyone from the first approver up to the deciding one approves,
// in order. "tek": the deciding approver alone.
//
// Addresses: #/onay-akisi (the default flow), #/onay-akisi?akis=<id>, #/onay-akisi?akis=yeni (a new
// flow that is not saved yet). The editor checks the rules of validateFlow (src/approval/flow.ts) as
// the admin types and shows who approves which amounts ("Kim onaylar?"); the server has the final
// word (400 gecersiz_akis with `sorunlar`, 400 gecersiz_istek with `alanlar`). "Tutar dene" asks
// POST /api/onay-akisi/onizle with the saved flow's akisId; unsaved changes are computed on screen.

import * as api from '../api.js';
import { el, icon, ICONS } from '../dom.js';
import { fmtAmountInput, fmtCount, fmtCurrency, fmtDateTime, parseAmount, toCents } from '../format.js';
import { approverChain } from '../expense-ui.js';
import { STRATEGY_LABEL } from '../labels.js';
import { href, navigate } from '../router.js';
import * as session from '../session.js';
import {
  actionDialog,
  alertBox,
  btn,
  confirmDialog,
  debounce,
  field,
  fieldset,
  input,
  loadFailed,
  openDialog,
  pageHead,
  setBusy,
  setFieldError,
  setPageTitle,
  toast,
} from '../ui.js';

const ROUTE = '/onay-akisi';
const NEW = 'yeni';
const NAME_MAX = 80;
const MAX_CENTS = 90_000_000_000_000 * 100; // MAX_AMOUNT in src/approval/flow.ts
const PROBE_IDLE = 'Bir tutar yazın; kimlerin onaylayacağı burada görünür.';

/** The two strategies, as the server names them (`strateji`). */
const STRATEGY = {
  zincir: {
    title: STRATEGY_LABEL.zincir,
    short: 'Zincirleme',
    text: 'Masraf ilk onaycıdan başlar; limiti tutara yeten onaycıya kadar sıradaki herkes sırayla onaylar.',
  },
  tek: {
    title: STRATEGY_LABEL.tek,
    short: 'Tek onaycı',
    text: 'Masrafı yalnızca limiti tutara yeten onaycı onaylar; her tutar aralığının kendi onaycısı vardır.',
  },
};
const strategyOf = (value) => (value === 'tek' ? 'tek' : 'zincir');

let keySeq = 0;
const newKey = () => `s${++keySeq}`;

const quoted = (name) => `“${name}”`;
const sameName = (a, b) => a.trim().toLocaleLowerCase('tr-TR') === b.trim().toLocaleLowerCase('tr-TR');
const blankStep = () => ({ key: newKey(), onayciId: '', limit: '' });

/** A round example amount in the second approver's range: about four times the first limit. */
function exampleCents(firstCents, secondCents) {
  const units = (firstCents * 4) / 100;
  const step = 10 ** Math.max(0, Math.floor(Math.log10(units)) - 1);
  let cents = Math.round(units / step) * step * 100;
  if (cents <= firstCents) cents = firstCents + 100;
  if (secondCents !== null && cents > secondCents) cents = secondCents;
  return cents;
}

export const flowView = {
  mount(root, { route, signal }) {
    let base = session.knownBaseCurrency() ?? 'TRY';
    let users = []; // every user; the select offers the active ones
    let flows = []; // Akis[] as the server lists them (default first, then by name)
    let flow = null; // the selected saved Akis; null while a new flow is edited
    let isNew = false;
    let strategy = 'zincir';
    let steps = []; // [{ key, onayciId, limit }] as typed; the last step's limit is not used
    let savedSig = ''; // name + strategy + steps as saved (or as a blank new flow)
    let savedRuleSig = '';
    let saving = false;
    let loaded = false;
    let lastRoute = route;
    let probeCents = null; // the "Tutar dene" amount
    let pendingNew = null; // { ad, strateji, steps } from the "Yeni akış" dialog; the route change applies it
    let leaveOk = false; // an explicit discard (the "Yeni akış" dialog) lets the next address through
    let lastSavedId = null; // where "Vazgeç" returns to from a new flow
    let attempted = false; // a save was tried: every problem is shown, not only the touched ones
    const touched = new Set(); // "<key>:limit" / "<key>:approver" the admin has left at least once
    const serverErr = new Map(); // "<key>:limit" / "<key>:approver" → the server's message
    const rowRefs = new Map(); // key → the row's controls

    const money = (cents) => fmtCurrency(cents / 100, base);
    const userById = (uid) => users.find((u) => String(u.id) === String(uid)) ?? null;
    const userName = (uid) => userById(uid)?.adSoyad ?? 'Bilinmeyen kullanıcı';
    const defaultFlow = () => flows.find((f) => f.varsayilan) ?? flows[0] ?? null;
    const flowHref = (id) => href(ROUTE, { akis: id });
    const setLabel = (button, text) => {
      const span = button.querySelector('span');
      if (span) span.textContent = text;
    };

    const announcer = el('p', { className: 'visually-hidden', role: 'status' });
    const switcher = el('nav', { className: 'flow-switch', 'aria-label': 'Onay akışları' });
    const alertSlot = el('div', { className: 'form-alert', tabindex: '-1' });
    const content = el('div', { className: 'form-skeleton', role: 'status', 'aria-label': 'Yükleniyor' }, el('span'), el('span'), el('span'));
    const newBtn = btn('Yeni akış', { icon: ICONS.plus, disabled: true, onClick: openNewDialog });
    root.append(
      el(
        'div',
        { className: 'page wide' },
        pageHead({
          title: 'Onay akışları',
          sub: 'Her kullanıcının masrafı kendi akışındaki onaycılara gider. Akış atanmamış kullanıcılar varsayılan akışı kullanır.',
          actions: [newBtn],
        }),
        switcher,
        announcer,
        alertSlot,
        content,
      ),
    );

    const nameInput = input({ name: 'ad', maxlength: NAME_MAX, autocomplete: 'off', spellcheck: 'false', required: true, placeholder: 'Örn. Satış ekibi' });
    const facts = el('ul', { className: 'flow-facts' });
    const defaultBtn = btn('Varsayılan yap', { icon: ICONS.checkCircle, size: 'sm', onClick: makeDefault });
    const deleteBtn = btn('Sil', { icon: ICONS.trash, size: 'sm', kind: 'danger-ghost', onClick: removeFlow });
    const deleteNote = el('p', { className: 'flow-note', id: 'flow-del-note', text: 'Varsayılan akış silinemez. Silmek için önce başka bir akışı varsayılan yapın.' });
    const dirtyMark = el('span', { className: 'flow-tab-dirty', title: 'Kaydedilmemiş değişiklik var' }, el('span', { className: 'visually-hidden', text: ', kaydedilmemiş değişiklik var' }));

    // Strategy: two option cards; each shows a live example from the approvers on screen.
    const strategyInputs = {};
    const strategyExamples = {};
    const strategyCards = Object.entries(STRATEGY).map(([value, s]) => {
      strategyInputs[value] = el('input', { type: 'radio', name: 'strateji', value, 'aria-describedby': `strat-${value}-text strat-${value}-ex` });
      strategyExamples[value] = el('span', { className: 'strategy-example', id: `strat-${value}-ex` });
      return el(
        'label',
        { className: 'role-option strategy-option' },
        strategyInputs[value],
        el('span', { className: 'role-text' }, el('span', { className: 'role-title', text: s.title }), el('span', { className: 'role-hint', id: `strat-${value}-text`, text: s.text }), strategyExamples[value]),
      );
    });
    const strategyBox = fieldset({ legend: 'Onay stratejisi', content: el('div', { className: 'strategy-options' }, ...strategyCards), className: 'strategy-field' });

    const tbody = el('tbody');
    const tierBody = el('div', { className: 'tier-body' });
    const dirtyNote = el('p', { className: 'dirty-note', role: 'status' });
    const saveBtn = btn('Kaydet', { icon: ICONS.check, kind: 'primary', onClick: save });
    const resetBtn = btn('Değişiklikleri geri al', { kind: 'ghost', onClick: () => (isNew ? discardNew() : reset()) });
    const addBtn = btn('Onaycı ekle', { icon: ICONS.plus, onClick: addStep });
    const probeInput = input({ inputmode: 'decimal', placeholder: 'Örn. 20.000', 'aria-label': `Denenecek tutar (${base})`, className: 'input num' });
    const probeLocal = el('div', { className: 'probe-local', 'aria-live': 'polite' });
    const probeServer = el('div', { className: 'probe-server', 'aria-live': 'polite' });

    function stepsFromFlow(f) {
      return (f?.adimlar ?? [])
        .slice()
        .sort((a, b) => a.sira - b.sira)
        .map((a) => ({ key: newKey(), onayciId: String(a.onayci?.id ?? ''), limit: a.limit === null || a.limit === undefined ? '' : fmtAmountInput(a.limit) }));
    }

    function centsOrText(text) {
      const p = parseAmount(text);
      return p.error || p.value === null ? `?${text.trim()}` : toCents(p.value);
    }
    // The last approver's limit is not part of the flow (it is always unlimited).
    const ruleSig = () => JSON.stringify([strategy, steps.map((s, i) => [s.onayciId, i === steps.length - 1 ? null : centsOrText(s.limit)])]);
    const signature = () => JSON.stringify([nameInput.value.trim(), ruleSig()]);
    // A new flow counts as unsaved work once it differs from a blank one (a name or a copied step list).
    const isDirty = () => signature() !== savedSig;
    const rulesDirty = () => isNew || ruleSig() !== savedRuleSig;

    // ---------- Showing a flow ----------

    function clearChecks() {
      attempted = false;
      touched.clear();
      serverErr.clear();
      setFieldError(nameInput, null);
      setFieldError(strategyBox, null);
      alertSlot.replaceChildren();
    }

    function setStrategy(value) {
      strategy = strategyOf(value);
      strategyInputs[strategy].checked = true;
    }

    function reset() {
      nameInput.value = flow?.ad ?? '';
      setStrategy(flow?.strateji);
      steps = stepsFromFlow(flow);
      if (steps.length === 0) steps = [blankStep()];
      clearChecks();
      savedSig = signature();
      savedRuleSig = ruleSig();
      renderRows();
      refresh();
    }

    function showFlow(f) {
      flow = f;
      isNew = false;
      lastSavedId = f.id;
      reset();
      renderIdentity();
      renderSwitcher();
      setPageTitle(`${f.ad} · Onay akışları`);
      announcer.textContent = `${quoted(f.ad)} akışı gösteriliyor.`;
      restartProbe();
    }

    function startNew(seed) {
      flow = null;
      isNew = true;
      nameInput.value = '';
      setStrategy('zincir');
      steps = [blankStep()];
      clearChecks();
      savedSig = signature(); // a blank new flow is not "unsaved work" yet
      savedRuleSig = '';
      if (seed) {
        nameInput.value = seed.ad ?? '';
        setStrategy(seed.strateji);
        if (seed.steps?.length) steps = seed.steps.map((s) => ({ ...s, key: newKey() }));
      }
      renderRows();
      renderIdentity();
      renderSwitcher();
      refresh();
      setPageTitle('Yeni akış · Onay akışları');
      announcer.textContent = 'Yeni akış: adını, stratejisini ve onaycılarını girip kaydedin.';
      restartProbe();
      if (seed) {
        // Came from the dialog: continue where input is still missing.
        const open = steps.find((s) => !s.onayciId);
        const target = nameInput.value && open ? rowRefs.get(open.key)?.sel : nameInput;
        (target ?? nameInput).focus();
      }
    }

    /** #/onay-akisi[?akis=<id>|yeni] → the flow to show. */
    function applyRoute(r) {
      leaveOk = false;
      const want = r.query.get('akis');
      if (want === NEW) {
        const seed = pendingNew;
        pendingNew = null;
        if (!isNew || seed) startNew(seed);
        return;
      }
      pendingNew = null;
      const id = want && /^\d+$/.test(want) ? Number(want) : null;
      const target = id === null ? defaultFlow() : flows.find((f) => f.id === id);
      if (!target) {
        const fallback = defaultFlow();
        if (!fallback) {
          startNew(null);
          return;
        }
        toast('Bu onay akışı bulunamadı; varsayılan akış gösteriliyor.', 'err');
        showFlow(fallback);
        // After the router has taken this address, put the default one in its place.
        queueMicrotask(() => navigate(ROUTE, { query: { akis: fallback.id }, replace: true }));
        return;
      }
      if (!isNew && flow?.id === target.id) return;
      showFlow(target);
    }

    /** Whether an address shows what is on screen now (no reason to ask about unsaved changes). */
    function sameTarget(r) {
      const want = r.query.get('akis');
      if (want === NEW) return isNew;
      if (isNew || !flow) return false;
      return want ? String(flow.id) === want : flow.id === defaultFlow()?.id;
    }

    // ---------- Flow list (switcher) and the flow's own card ----------

    function renderSwitcher() {
      const hadFocus = switcher.contains(document.activeElement);
      const list = el('ul', { className: 'flow-tabs' });
      for (const f of flows) {
        const current = !isNew && flow?.id === f.id;
        const n = f.kullaniciSayisi ?? 0;
        list.append(
          el(
            'li',
            {},
            el(
              'a',
              { className: 'flow-tab', href: flowHref(f.id), title: f.ad, 'aria-current': current ? 'page' : null },
              el('span', { className: 'flow-tab-name' }, el('span', { className: 'flow-tab-text', text: f.ad }), current ? dirtyMark : null),
              el(
                'span',
                { className: 'flow-tab-meta' },
                f.varsayilan ? el('span', { className: 'tag accent', text: 'Varsayılan' }) : null,
                el('span', { text: `${STRATEGY[strategyOf(f.strateji)].short} · ${fmtCount(f.adimlar?.length ?? 0)} onaycı · ${fmtCount(n)} kullanıcı` }),
              ),
            ),
          ),
        );
      }
      if (isNew) {
        list.append(
          el(
            'li',
            {},
            el(
              'a',
              { className: 'flow-tab is-new', href: flowHref(NEW), 'aria-current': 'page' },
              el('span', { className: 'flow-tab-name' }, el('span', { className: 'flow-tab-text', 'data-new-name': '', text: nameInput.value.trim() || 'Yeni akış' })),
              el('span', { className: 'flow-tab-meta' }, el('span', { className: 'tag warn', text: 'Kaydedilmedi' })),
            ),
          ),
        );
      }
      switcher.replaceChildren(list);
      updateDirty();
      if (hadFocus) list.querySelector('[aria-current="page"]')?.focus();
    }

    function fact(glyph, ...children) {
      return el('li', {}, glyph ? icon(glyph) : null, ...children);
    }

    function renderIdentity() {
      defaultBtn.hidden = isNew || !flow || flow.varsayilan;
      deleteBtn.hidden = isNew;
      deleteBtn.disabled = !flow || flow.varsayilan;
      deleteNote.hidden = isNew || !flow?.varsayilan;
      if (deleteNote.hidden) deleteBtn.removeAttribute('aria-describedby');
      else deleteBtn.setAttribute('aria-describedby', deleteNote.id);
      setLabel(saveBtn, isNew ? 'Akışı oluştur' : 'Kaydet');
      setLabel(resetBtn, isNew ? 'Vazgeç' : 'Değişiklikleri geri al');
      if (isNew) {
        facts.replaceChildren(
          fact(null, el('span', { className: 'tag warn', text: 'Kaydedilmedi' }), el('span', { text: 'Kaydettikten sonra kullanıcıları Kullanıcılar sayfasından bu akışa atayabilirsiniz.' })),
        );
        return;
      }
      const n = flow.kullaniciSayisi ?? 0;
      // Native replaceChildren would print "null": keep only real nodes.
      facts.replaceChildren(
        ...[
          flow.varsayilan ? fact(null, el('span', { className: 'tag accent', text: 'Varsayılan akış' }), el('span', { text: 'Akış atanmamış kullanıcılar bu akışı kullanır.' })) : null,
          fact(
            ICONS.users,
            el('span', { text: n > 0 ? `${fmtCount(n)} aktif kullanıcının masrafı bu akışa gidiyor.` : 'Masrafı bu akışa giden aktif kullanıcı yok.' }),
            n > 0 ? el('a', { href: href('/kullanicilar', { akis: flow.id }), text: 'Kullanıcıları gör' }) : el('a', { href: '#/kullanicilar', text: 'Kullanıcı ata' }),
          ),
          flow.guncelleme ? fact(ICONS.clock, el('span', { text: `Son değişiklik ${fmtDateTime(flow.guncelleme)}${flow.guncelleyen?.adSoyad ? `, ${flow.guncelleyen.adSoyad}` : ''}.` })) : null,
        ].filter(Boolean),
      );
    }

    // ---------- Checks (validateFlow on screen) and the amount tiers, all in cents ----------

    function analyze() {
      const n = steps.length;
      const rows = steps.map(() => ({ approver: null, limit: null, hint: null, cents: null }));
      const problems = []; // [{ text, key, field }]
      const counts = new Map();
      for (const s of steps) if (s.onayciId) counts.set(s.onayciId, (counts.get(s.onayciId) ?? 0) + 1);
      let prev = null; // the closest valid limit above: { n, cents }
      steps.forEach((s, i) => {
        const r = rows[i];
        const no = i + 1;
        const u = s.onayciId ? userById(s.onayciId) : null;
        if (!s.onayciId) r.approver = 'Onaycı seçin.';
        else if (counts.get(s.onayciId) > 1) r.approver = 'Bu kişi akışta birden fazla kez var; bir kişi bir akışta bir kez yer alır.';
        else if (u && !u.aktif) r.approver = 'Pasif kullanıcı; akışta yalnızca aktif kullanıcılar olabilir.';
        if (r.approver) problems.push({ text: `${no}. onaycı: ${r.approver}`, key: s.key, field: 'approver' });
        if (i === n - 1) return; // the last approver's limit is always unlimited
        const min = prev === null ? 1 : prev.cents + 1;
        r.hint = prev === null ? '0’dan büyük bir tutar girin.' : `En az ${money(min)} olmalı.`;
        const p = parseAmount(s.limit);
        if (p.error) r.limit = p.error;
        else if (p.value === null) r.limit = prev === null ? 'Onay limitini girin.' : `Onay limitini girin; en az ${money(min)} olmalı.`;
        else {
          const c = toCents(p.value);
          if (c <= 0) r.limit = 'Onay limiti 0’dan büyük olmalı.';
          else if (c > MAX_CENTS) r.limit = 'Onay limiti çok büyük.';
          else {
            r.cents = c;
            if (prev !== null && c <= prev.cents) r.limit = `En az ${money(min)} olmalı; ${prev.n}. onaycının limitinden büyük olmalı.`;
            prev = { n: no, cents: c };
          }
        }
        if (r.limit) problems.push({ text: `${no}. onaycının limiti: ${r.limit}`, key: s.key, field: 'limit' });
      });
      if (n === 0) problems.push({ text: 'Akışta en az bir onaycı olmalı.' });
      // The tiers stop at the first limit that is not usable yet.
      const tiers = [];
      let lo = 0;
      for (let i = 0; i < n; i++) {
        const last = i === n - 1;
        if (!last && (rows[i].cents === null || rows[i].limit)) break;
        tiers.push({ i, lo, hi: last ? null : rows[i].cents });
        if (!last) lo = rows[i].cents + 1;
      }
      return { rows, problems, tiers, complete: tiers.length === n && n > 0 };
    }

    const tierRangeText = (t, count) => {
      if (count === 1 && t.hi === null) return 'Her tutar';
      if (t.hi === null) return `${money(t.lo - 1)} üzeri`;
      if (t.lo === 0) return `${money(t.hi)} ve altı`;
      return `${money(t.lo)} – ${money(t.hi)}`;
    };
    /** Who approves an amount in tier t: the indexes of the steps, in order. */
    const chainOf = (t) => (strategy === 'zincir' ? steps.slice(0, t.i + 1).map((_, j) => j) : [t.i]);
    const tierOf = (a, cents) => a.tiers.find((t) => cents >= t.lo && (t.hi === null || cents <= t.hi)) ?? null;
    const nameOf = (i) => (steps[i]?.onayciId ? userName(steps[i].onayciId) : null);

    // ---------- Rows ----------

    function syncOptions() {
      const used = new Map(); // user id -> row key
      for (const s of steps) if (s.onayciId) used.set(s.onayciId, s.key);
      for (const [key, r] of rowRefs) {
        for (const opt of r.sel.options) {
          if (!opt.value) continue;
          const owner = used.get(opt.value);
          opt.disabled = Boolean(owner && owner !== key);
        }
      }
    }

    function approverSub(uid) {
      const u = uid ? userById(uid) : null;
      if (!u) return '';
      return [u.departman, u.eposta].filter(Boolean).join(' · ');
    }

    function row(s, i) {
      const n = i + 1;
      const last = i === steps.length - 1;
      const id = `st-${s.key}`;
      const sel = el(
        'select',
        { className: 'input', id: `${id}-o`, 'data-f': 'onayciId', 'aria-label': `${n}. onaycı`, 'aria-describedby': `${id}-sub ${id}-oerr` },
        el('option', { value: '', text: 'Onaycı seçin' }),
      );
      // Names only, so the closed select never cuts a name; the department is written under it.
      for (const u of users.filter((x) => x.aktif || String(x.id) === s.onayciId)) sel.append(el('option', { value: String(u.id), text: u.aktif ? u.adSoyad : `${u.adSoyad} (pasif)` }));
      sel.value = s.onayciId;
      const refs = {
        sel,
        sub: el('p', { className: 'approver-sub', id: `${id}-sub`, text: approverSub(s.onayciId) }),
        apprErr: el('p', { className: 'field-error', id: `${id}-oerr`, hidden: true }),
        lim: null,
        limHint: null,
        limErr: null,
      };
      let limitCell;
      if (last) {
        limitCell = el(
          'div',
          { className: 'limit-free' },
          el('span', { className: 'tag accent', text: 'Sınırsız' }),
          el('span', { className: 'limit-free-note', text: steps.length === 1 ? 'Tek onaycı her tutarı onaylar.' : 'Son onaycı her tutarı onaylayabilir.' }),
        );
      } else {
        refs.lim = input({
          inputmode: 'decimal',
          autocomplete: 'off',
          value: s.limit,
          className: 'input num',
          id: `${id}-l`,
          'data-f': 'limit',
          placeholder: 'Limit girin',
          'aria-label': `${n}. onaycının onay limiti (${base}, dahil)`,
          'aria-describedby': `${id}-lh ${id}-lerr`,
        });
        refs.limHint = el('p', { className: 'hint', id: `${id}-lh` });
        refs.limErr = el('p', { className: 'field-error', id: `${id}-lerr`, hidden: true });
        limitCell = el('div', { className: 'limit-cell' }, el('div', { className: 'limit-input' }, refs.lim, el('span', { className: 'limit-cur', 'aria-hidden': 'true', text: base })), refs.limHint, refs.limErr);
      }
      rowRefs.set(s.key, refs);
      return el(
        'tr',
        { 'data-key': s.key, className: last ? 'is-last' : null },
        el('td', { className: 't-order' }, el('span', { className: 'order-n', 'aria-hidden': 'true', text: String(n) })),
        el('td', { className: 't-approver', 'data-label': 'Onaycı' }, sel, refs.sub, refs.apprErr),
        el('td', { className: 't-limit', 'data-label': 'Onay limiti' }, limitCell),
        el(
          'td',
          { className: 't-actions' },
          btn('Yukarı taşı', { icon: ICONS.arrowUp, size: 'sm', iconOnly: true, attrs: { 'data-act': 'up', 'aria-label': `${n}. onaycıyı yukarı taşı` } }),
          btn('Aşağı taşı', { icon: ICONS.arrowDown, size: 'sm', iconOnly: true, attrs: { 'data-act': 'down', 'aria-label': `${n}. onaycıyı aşağı taşı` } }),
          btn('Sil', { icon: ICONS.trash, size: 'sm', iconOnly: true, kind: 'danger-ghost', attrs: { 'data-act': 'del', 'aria-label': `${n}. onaycıyı akıştan çıkar` } }),
        ),
      );
    }

    function renderRows(focus = null) {
      rowRefs.clear();
      tbody.replaceChildren(...steps.map(row));
      if (focus) {
        const tr = tbody.querySelector(`tr[data-key="${focus.key}"]`);
        const target = focus.act ? tr?.querySelector(`[data-act="${focus.act}"]`) : null;
        if (target && !target.disabled) target.focus();
        else rowRefs.get(focus.key)?.sel.focus();
      }
    }

    /** An inline message under a control (null clears it). */
    function showError(control, slot, message) {
      if (!control || !slot) return;
      if (message) {
        control.setAttribute('aria-invalid', 'true');
        slot.replaceChildren(icon(ICONS.alert), el('span', { text: message }));
        slot.hidden = false;
      } else {
        control.removeAttribute('aria-invalid');
        slot.replaceChildren();
        slot.hidden = true;
      }
    }

    function updateRows(a) {
      steps.forEach((s, i) => {
        const r = rowRefs.get(s.key);
        const check = a.rows[i];
        if (!r || !check) return;
        const apprMsg = serverErr.get(`${s.key}:approver`) ?? (attempted || touched.has(`${s.key}:approver`) ? check.approver : null);
        showError(r.sel, r.apprErr, apprMsg);
        if (r.lim) {
          const limMsg = serverErr.get(`${s.key}:limit`) ?? (attempted || touched.has(`${s.key}:limit`) ? check.limit : null);
          showError(r.lim, r.limErr, limMsg);
          r.limHint.textContent = check.hint ?? '';
          r.limHint.hidden = Boolean(limMsg) || !check.hint;
        }
      });
      for (const [i, tr] of [...tbody.children].entries()) {
        tr.querySelector('[data-act="del"]').disabled = steps.length <= 1;
        tr.querySelector('[data-act="up"]').disabled = i === 0;
        tr.querySelector('[data-act="down"]').disabled = i === steps.length - 1;
      }
      syncOptions();
    }

    // ---------- Strategy examples and "Kim onaylar?" ----------

    function exampleLine(kind, a) {
      // Live when the first two approvers and the first limit are known; otherwise by position.
      const second = a.tiers[1];
      const named = second && nameOf(0) && nameOf(1);
      const amount = second ? money(exampleCents(a.tiers[0].hi, second.hi)) : null;
      const names = named ? [nameOf(0), nameOf(1)] : ['1. onaycı', '2. onaycı'];
      const chain = kind === 'zincir' ? names : [names[1]];
      // The arrows are drawn; a screen reader hears "…: Burak, Mehmet".
      return [
        el('span', { className: 'ex-label', text: 'Örnek:' }),
        el('span', { className: 'ex-amount', text: amount ?? '2. onaycının aralığındaki bir tutar' }),
        el('span', { className: 'visually-hidden', text: kind === 'zincir' ? ', sırayla onaylayanlar: ' : ', onaylayan: ' }),
        ...chain.map((name, k) =>
          el('span', { className: 'ex-step' }, el('span', { className: 'ex-arrow', 'aria-hidden': 'true', text: '→' }), k > 0 ? el('span', { className: 'visually-hidden', text: ', ' }) : null, el('span', { text: name })),
        ),
      ];
    }

    function renderStrategy(a) {
      for (const kind of Object.keys(STRATEGY)) strategyExamples[kind].replaceChildren(...exampleLine(kind, a));
    }

    function renderTiers(a) {
      const count = steps.length;
      const probeTier = probeCents === null ? null : tierOf(a, probeCents);
      const rowsOut = a.tiers.map((t) => {
        const hit = probeTier === t;
        const chain = chainOf(t);
        return el(
          'tr',
          { className: hit ? 'is-probe' : null },
          el('th', { scope: 'row' }, el('span', { text: tierRangeText(t, count) }), hit ? el('span', { className: 'tag accent probe-tag', text: 'Denenen tutar' }) : null),
          el(
            'td',
            {},
            el(
              'ol',
              { className: 'tier-chain', 'aria-label': strategy === 'zincir' ? 'Sırayla onaylayanlar' : 'Onaylayan' },
              ...chain.map((j) => {
                const name = nameOf(j);
                return el('li', { className: `${j === t.i ? 'is-decider' : ''}${name ? '' : ' unset'}`.trim() || null, text: name ?? `${j + 1}. onaycı seçilmedi` });
              }),
            ),
          ),
        );
      });
      const missing = a.tiers.length < count && count > 0;
      if (missing) {
        const stop = a.tiers.length + 1;
        rowsOut.push(el('tr', { className: 'tier-gap' }, el('td', { colspan: '2', text: `Daha büyük tutarlar, ${stop}. onaycının limiti girilince burada görünür.` })));
      }
      tierBody.replaceChildren(
        el(
          'table',
          { className: 'tier-table' },
          el('caption', { className: 'visually-hidden', text: `Tutara göre onaylayanlar (${STRATEGY[strategy].title})` }),
          el('thead', {}, el('tr', {}, el('th', { scope: 'col', text: `Onay tutarı (${base})` }), el('th', { scope: 'col', text: strategy === 'zincir' ? 'Onaylayanlar, sırayla' : 'Onaylayan' }))),
          el('tbody', {}, ...rowsOut),
        ),
        el(
          'p',
          { className: 'tier-note' },
          icon(ICONS.info),
          el('span', { text: 'Onaycının kendi masrafı bir üst onaycıya gider; en üstteki onaycının kendi masrafı yedek yöneticiye gider.' }),
        ),
      );
    }

    /** The parts that depend only on "is anything unsaved": the note, the buttons, the tab mark. */
    function updateDirty() {
      const dirty = isDirty();
      dirtyNote.textContent = isNew ? 'Yeni akış henüz kaydedilmedi.' : dirty ? 'Kaydedilmemiş değişiklikler var.' : 'Kayıtlı akış gösteriliyor.';
      dirtyNote.classList.toggle('is-dirty', isNew || dirty);
      resetBtn.hidden = !isNew && !dirty;
      saveBtn.disabled = saving || (!isNew && !dirty);
      dirtyMark.hidden = isNew || !dirty;
    }

    function refresh() {
      const a = analyze();
      updateRows(a);
      renderStrategy(a);
      renderTiers(a);
      updateDirty();
      updateProbeLocal(a);
      return a;
    }

    nameInput.addEventListener('input', () => {
      setFieldError(nameInput, null);
      updateDirty();
      const tab = switcher.querySelector('[data-new-name]');
      if (tab) tab.textContent = nameInput.value.trim() || 'Yeni akış';
    });

    strategyBox.addEventListener('change', (e) => {
      if (e.target.name !== 'strateji') return;
      setStrategy(e.target.value);
      setFieldError(strategyBox, null);
      refresh();
    });

    // Selects fire "input" too, so one listener covers every control in a row.
    tbody.addEventListener('input', (e) => {
      const tr = e.target.closest('tr[data-key]');
      const f = e.target.dataset.f;
      if (!tr || !f) return;
      const s = steps.find((x) => x.key === tr.dataset.key);
      if (!s) return;
      if (f === 'onayciId') {
        s.onayciId = e.target.value;
        touched.add(`${s.key}:approver`);
        serverErr.delete(`${s.key}:approver`);
        const r = rowRefs.get(s.key);
        if (r) r.sub.textContent = approverSub(s.onayciId);
      } else if (f === 'limit') {
        s.limit = e.target.value;
        serverErr.delete(`${s.key}:limit`);
      }
      refresh();
    });
    // A limit's problems show once the admin leaves the box (an empty approver only on save).
    tbody.addEventListener('focusout', (e) => {
      const tr = e.target.closest?.('tr[data-key]');
      if (!tr || e.target.dataset?.f !== 'limit') return;
      const s = steps.find((x) => x.key === tr.dataset.key);
      if (!s) return;
      const p = parseAmount(e.target.value);
      if (!p.error && p.value !== null) {
        e.target.value = fmtAmountInput(p.value);
        s.limit = e.target.value;
      }
      touched.add(`${s.key}:limit`);
      refresh();
    });
    tbody.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      const key = b.closest('tr').dataset.key;
      const i = steps.findIndex((s) => s.key === key);
      const lastBefore = steps[steps.length - 1];
      let message = '';
      if (b.dataset.act === 'up' && i > 0) {
        [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]];
        renderRows({ key, act: i - 1 === 0 ? 'down' : 'up' });
        message = `${nameOf(i - 1) ?? 'Onaycı'} ${i}. sıraya taşındı.`;
      } else if (b.dataset.act === 'down' && i < steps.length - 1) {
        [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]];
        renderRows({ key, act: i + 1 === steps.length - 1 ? 'up' : 'down' });
        message = `${nameOf(i + 1) ?? 'Onaycı'} ${i + 2}. sıraya taşındı.`;
      } else if (b.dataset.act === 'del' && steps.length > 1) {
        const name = nameOf(i);
        steps.splice(i, 1);
        touched.delete(`${key}:limit`);
        touched.delete(`${key}:approver`);
        const next = steps[Math.min(i, steps.length - 1)];
        renderRows(next ? { key: next.key, act: 'del' } : null);
        message = `${name ?? `${i + 1}. onaycı`} akıştan çıkarıldı.`;
      } else {
        return;
      }
      const lastNow = steps[steps.length - 1];
      if (lastNow !== lastBefore) message += ` Son onaycı artık ${nameOf(steps.length - 1) ?? `${steps.length}. sıradaki`}; limiti sınırsız.`;
      announcer.textContent = message;
      refresh();
    });

    function addStep() {
      const prevLast = steps[steps.length - 1];
      const s = blankStep();
      steps.push(s);
      renderRows();
      refresh();
      rowRefs.get(s.key)?.sel.focus();
      const n = steps.length;
      announcer.textContent = prevLast && !parseAmount(prevLast.limit).value
        ? `${n}. onaycı eklendi ve son onaycı oldu. ${n - 1}. onaycının onay limitini girin.`
        : `${n}. onaycı eklendi ve son onaycı oldu.`;
    }

    // ---------- "Tutar dene" ----------

    function updateProbeLocal(a) {
      if (probeCents === null || !rulesDirty()) {
        probeLocal.replaceChildren();
        return;
      }
      const t = tierOf(a, probeCents);
      const title = el('p', { className: 'probe-title', text: isNew ? 'Ekrandaki (kaydedilmemiş) akışa göre' : 'Düzenlenen (kaydedilmemiş) akışa göre' });
      if (!t) {
        probeLocal.replaceChildren(title, el('p', { className: 'muted small', text: 'Bu tutar için onay limitleri henüz tamamlanmadı.' }));
        return;
      }
      const adimlar = chainOf(t).map((j, k) => ({ sira: k + 1, onayci: { adSoyad: nameOf(j) ?? `${j + 1}. onaycı seçilmedi` }, durum: 'sirada', yedek: false }));
      probeLocal.replaceChildren(title, approverChain({ adimlar }), el('p', { className: 'muted small', text: 'Gönderen akışta değilmiş gibi hesaplanır.' }));
    }

    const runProbe = debounce(async () => {
      const p = parseAmount(probeInput.value);
      if (p.error || p.value === null || p.value <= 0) {
        probeCents = null;
        probeServer.replaceChildren(el('p', { className: 'muted', text: p.error ?? PROBE_IDLE }));
        refresh();
        return;
      }
      probeCents = toCents(p.value);
      refresh();
      if (isNew || !flow) {
        probeServer.replaceChildren(el('p', { className: 'muted small', text: 'Akış henüz kaydedilmediği için yalnızca ekrandaki onaycılara göre gösterilir.' }));
        return;
      }
      const asked = probeCents;
      const askedFlow = flow.id;
      const r = await api.previewFlow({ tutar: p.value, akisId: askedFlow }, { signal });
      if (signal.aborted || asked !== probeCents || isNew || flow?.id !== askedFlow) return;
      if (!r.ok) {
        if (!r.unauthorized && !r.aborted) probeServer.replaceChildren(el('p', { className: 'muted', text: r.error.mesaj }));
        return;
      }
      const name = r.body.akis?.ad ?? flow.ad;
      probeServer.replaceChildren(
        el('p', { className: 'probe-title', text: `Kayıtlı ${quoted(name)} akışına göre (${fmtCurrency(r.body.onayTutari ?? p.value, r.body.paraBirimi ?? base)})` }),
        approverChain(r.body),
        el('p', { className: 'muted small', text: 'Siz göndermişsiniz gibi hesaplanır: akışta sizin adımınız varsa atlanır.' }),
      );
    }, 400);
    probeInput.addEventListener('input', runProbe);

    /** Another flow is on screen: the server's answer for the previous one no longer applies. */
    function restartProbe() {
      if (!probeInput.value.trim()) {
        probeServer.replaceChildren(el('p', { className: 'muted', text: PROBE_IDLE }));
        return;
      }
      probeServer.replaceChildren(el('p', { className: 'muted', text: 'Onaycılar hesaplanıyor…' }));
      runProbe();
    }

    // ---------- Save ----------

    function replaceInList(saved) {
      const i = flows.findIndex((f) => f.id === saved.id);
      if (i >= 0) flows[i] = saved;
      else flows.push(saved);
    }

    function focusProblem(p) {
      if (!p?.key) return false;
      const r = rowRefs.get(p.key);
      const target = p.field === 'limit' ? r?.lim : r?.sel;
      if (!target) return false;
      target.focus();
      return true;
    }

    /** The server's messages: `alanlar` under their controls, `sorunlar` in the summary box. */
    function showServerProblems(error) {
      const alanlar = { ...(error.alanlar ?? {}) };
      const leftovers = [];
      let first = null;
      for (const [k, v] of Object.entries(alanlar)) {
        const m = /^adimlar\.(\d+)\.(limit|onayciId)$/.exec(k);
        const s = m ? steps[Number(m[1])] : null;
        if (k === 'ad') {
          setFieldError(nameInput, String(v));
          first ??= nameInput;
        } else if (k === 'strateji') {
          setFieldError(strategyBox, String(v));
          first ??= strategyInputs[strategy];
        } else if (s) {
          const fieldName = m[2] === 'limit' ? 'limit' : 'approver';
          serverErr.set(`${s.key}:${fieldName}`, String(v));
          leftovers.push(`${Number(m[1]) + 1}. onaycı: ${v}`);
          first ??= fieldName === 'limit' ? rowRefs.get(s.key)?.lim : rowRefs.get(s.key)?.sel;
        } else {
          leftovers.push(String(v));
        }
      }
      // gecersiz_akis: "2. onaycının limiti, …" → mark that row too.
      for (const text of error.sorunlar ?? []) {
        const m = /^(\d+)\. onaycı/.exec(text);
        const s = m ? steps[Number(m[1]) - 1] : null;
        if (s) {
          const fieldName = /limit/i.test(text) && s !== steps[steps.length - 1] ? 'limit' : 'approver';
          // "2. onaycının limiti, 1. onaycınınkinden … büyük olmalıdır." → "Limit, 1. onaycınınkinden …"
          const own = text.replace(/^\d+\. onaycının limiti/, 'Limit').replace(/^\d+\. onaycı:\s*/, '');
          serverErr.set(`${s.key}:${fieldName}`, own.charAt(0).toLocaleUpperCase('tr-TR') + own.slice(1));
        }
      }
      refresh();
      const items = error.sorunlar?.length ? error.sorunlar : leftovers;
      if (items.length) alertSlot.replaceChildren(alertBox('err', 'Sunucu akışı kabul etmedi', items));
      else if (!first) alertSlot.replaceChildren(alertBox('err', 'Akış kaydedilemedi', [error.mesaj]));
      if (first) first.focus();
      else alertSlot.focus();
    }

    async function save() {
      if (saving) return;
      alertSlot.replaceChildren();
      attempted = true;
      const ad = nameInput.value.trim();
      const a = refresh();
      if (!ad) setFieldError(nameInput, 'Akışa bir ad verin.');
      if (!ad || a.problems.length > 0) {
        if (a.problems.length > 0) alertSlot.replaceChildren(alertBox('err', 'Akış kaydedilemedi', a.problems.map((p) => p.text)));
        if (!ad) nameInput.focus();
        else if (!focusProblem(a.problems[0])) alertSlot.focus();
        return;
      }
      const adimlar = steps.map((s, i) => ({ onayciId: Number(s.onayciId), limit: i === steps.length - 1 ? null : parseAmount(s.limit).value }));
      const body = { ad, strateji: strategy, adimlar };
      const creating = isNew;
      const editing = flow;
      saving = true;
      setBusy(saveBtn, true);
      const r = creating ? await api.createFlow(body) : await api.updateFlow(editing.id, body);
      saving = false;
      setBusy(saveBtn, false);
      if (signal.aborted) return;
      if (!r.ok) {
        updateDirty();
        if (r.unauthorized) return;
        if (r.error.kod === 'akis_adi_kullaniliyor') {
          setFieldError(nameInput, r.error.mesaj);
          nameInput.focus();
          return;
        }
        showServerProblems(r.error);
        // The flow may have been deleted elsewhere: the list shows what is left.
        if (r.error.durum === 404) refreshList();
        return;
      }
      const saved = r.body;
      base = saved.paraBirimi ?? base;
      session.setBaseCurrency(base);
      replaceInList(saved);
      showFlow(saved);
      toast(
        creating
          ? `${quoted(saved.ad)} akışı oluşturuldu. Kullanıcıları Kullanıcılar sayfasından bu akışa atayabilirsiniz.`
          : `${quoted(saved.ad)} akışı kaydedildi. Yeni gönderilen masraflar bu akışla yönlenir.`,
        'ok',
      );
      if (creating) navigate(ROUTE, { query: { akis: saved.id }, replace: true });
      refreshList();
    }

    /** The list again (user counts, order by name, the default mark); the editor keeps its contents. */
    async function refreshList() {
      const r = await api.listFlows({ signal });
      if (signal.aborted || !r.ok || !Array.isArray(r.body)) return;
      flows = r.body;
      if (flow) flow = flows.find((f) => f.id === flow.id) ?? flow;
      renderSwitcher();
      renderIdentity();
    }

    // ---------- New, default, delete ----------

    function openNewDialog() {
      if (!loaded) return;
      const dirty = isDirty();
      const name = input({ name: 'ad', maxlength: NAME_MAX, autocomplete: 'off', spellcheck: 'false', required: true, placeholder: 'Örn. Satış ekibi' });
      name.addEventListener('input', () => setFieldError(name, null));
      const source = isNew ? 'Ekrandaki akışı kopyala' : `${quoted(flow.ad)} akışını kopyala`;
      const copyHint = `${STRATEGY[strategy].title}, ${fmtCount(steps.length)} onaycı ve limitleri${dirty && !isNew ? '; ekrandaki kaydedilmemiş hâliyle' : ''}.`;
      const option = (value, title, hint, checked) =>
        el(
          'label',
          { className: 'role-option' },
          el('input', { type: 'radio', name: 'baslangic', value, checked }),
          el('span', { className: 'role-text' }, el('span', { className: 'role-title', text: title }), el('span', { className: 'role-hint', text: hint })),
        );
      const options = el(
        'div',
        { className: 'role-options' },
        option('kopya', source, copyHint, true),
        option('bos', 'Boş başla', 'Zincirleme onay ve tek onaycıyla (sınırsız) başlar; onaycıyı siz seçersiniz.', false),
      );
      const warning = dirty
        ? alertBox('warn', null, [
            isNew
              ? 'Düzenlediğiniz yeni akış kaydedilmedi. Boş başlarsanız girdikleriniz kaybolur.'
              : `${quoted(flow.ad)} akışındaki kaydedilmemiş değişiklikler o akışa kaydedilmez.`,
          ])
        : null;
      openDialog({
        title: 'Yeni akış',
        description: 'Akış kaydedilene kadar hiçbir kullanıcıyı etkilemez.',
        body: [field({ label: 'Akış adı', input: name, hint: 'En çok 80 karakter; her akışın adı farklı olmalı.' }), fieldset({ legend: 'Başlangıç', content: options }), warning],
        submitLabel: 'Başla',
        submitIcon: ICONS.plus,
        onSubmit: (ctl) => {
          const ad = name.value.trim();
          let problem = null;
          if (!ad) problem = 'Akışa bir ad verin.';
          else if (flows.some((f) => sameName(f.ad, ad))) problem = 'Bu adda bir akış zaten var.';
          if (problem) {
            setFieldError(name, problem);
            name.focus();
            return false;
          }
          const copy = ctl.form.querySelector('input[name="baslangic"]:checked')?.value === 'kopya';
          return copy ? { ad, strateji: strategy, steps: steps.map((s) => ({ ...s })) } : { ad, strateji: 'zincir', steps: null };
        },
      }).done.then((seed) => {
        if (!seed || seed === true || signal.aborted) return;
        pendingNew = seed;
        leaveOk = true; // the dialog already said what happens to unsaved changes
        navigate(ROUTE, { query: { akis: NEW } });
      });
    }

    function discardNew() {
      const back = flows.find((f) => f.id === lastSavedId) ?? defaultFlow();
      if (!back) return;
      showFlow(back);
      navigate(ROUTE, { query: { akis: back.id }, replace: true });
    }

    async function makeDefault() {
      if (!flow || flow.varsayilan) return;
      const target = flow;
      const previous = defaultFlow();
      const r = await actionDialog({
        title: 'Varsayılan akış yap',
        message: `${quoted(target.ad)} varsayılan akış olacak. Akış atanmamış kullanıcıların masrafları bundan sonra bu akışa gider.`,
        details: [
          previous ? el('p', { className: 'dlg-text', text: `${quoted(previous.ad)} sıradan bir akışa döner; ona açıkça atanmış kullanıcılar orada kalır.` }) : null,
          el('p', { className: 'dlg-text', text: 'Onayda olan masraflar etkilenmez.' }),
          isDirty() ? alertBox('warn', null, ['Ekrandaki kaydedilmemiş değişiklikler bu işleme dahil değildir; onları ayrıca kaydedin.']) : null,
        ],
        confirmLabel: 'Varsayılan yap',
        confirmIcon: ICONS.checkCircle,
        run: () => api.setDefaultFlow(target.id),
      });
      if (!r?.body || signal.aborted) return;
      for (const f of flows) f.varsayilan = false;
      replaceInList(r.body);
      if (flow?.id === r.body.id) flow = r.body;
      renderIdentity();
      renderSwitcher();
      toast(`${quoted(r.body.ad)} artık varsayılan akış.`, 'ok');
      refreshList();
    }

    async function removeFlow() {
      if (!flow || flow.varsayilan) return;
      const target = flow;
      const fallback = defaultFlow();
      const n = target.kullaniciSayisi ?? 0;
      const r = await actionDialog({
        title: 'Akışı sil',
        message: `${quoted(target.ad)} akışı silinecek. Bu işlem geri alınamaz.`,
        details: [
          el('p', {
            className: 'dlg-text',
            text: `Bu akışa atanmış kullanıcılar varsayılan akışa${fallback ? ` (${quoted(fallback.ad)})` : ''} geçer.${n > 0 ? ` Şu an masrafı bu akışa giden ${fmtCount(n)} aktif kullanıcı var.` : ''}`,
          }),
          el('p', { className: 'dlg-text', text: 'Onayda olan masraflar etkilenmez.' }),
        ],
        confirmLabel: 'Akışı sil',
        confirmIcon: ICONS.trash,
        kind: 'danger',
        run: () => api.deleteFlow(target.id),
      });
      if (!r?.ok || signal.aborted) return;
      flows = flows.filter((f) => f.id !== target.id);
      toast(`${quoted(target.ad)} akışı silindi; kullanıcıları varsayılan akışa geçti.`, 'ok');
      const next = defaultFlow();
      if (next) {
        showFlow(next);
        navigate(ROUTE, { query: { akis: next.id }, replace: true });
      }
      refreshList();
    }

    // ---------- Layout ----------

    function rules() {
      const items = [
        ['Strateji', 'Zincirleme onayda masraf ilk onaycıdan, limiti tutara yeten onaycıya kadar sırayla ilerler. Tek onaycıda yalnızca o onaycı onaylar.'],
        ['Onay limiti dahildir', `Limitler ${base} cinsindendir. Limiti 5.000,00 olan onaycı tam 5.000,00 tutarındaki masrafı da onaylar; 5.000,01 bir sonrakine geçer. Son onaycının limiti yoktur.`],
        ['Kendi masrafı bir üste gider', 'Kimse kendi masrafını onaylamaz. Karar veren onaycının kendi masrafı bir üst onaycıya, en üstteki onaycınınki yedek yöneticiye gider.'],
        ['Varsayılan akış', 'Akış atanmamış kullanıcılar varsayılan akışı kullanır. Varsayılan akış silinemez.'],
        ['Süren masraflar etkilenmez', 'Değişiklikler yalnızca bundan sonra gönderilen masraflara uygulanır.'],
      ];
      return el(
        'section',
        { className: 'card rules', 'aria-labelledby': 'rules-h' },
        el('h2', { className: 'card-title', id: 'rules-h', text: 'Kurallar' }),
        el('dl', { className: 'rule-list' }, ...items.map(([t, d]) => el('div', {}, el('dt', { text: t }), el('dd', { text: d })))),
      );
    }

    function build() {
      const table = el(
        'table',
        { className: 'data-table flow-table' },
        el('caption', { className: 'visually-hidden', text: 'Onaycılar, onay sırasına göre' }),
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', { scope: 'col', className: 't-order', text: 'Sıra' }),
            el('th', { scope: 'col', text: 'Onaycı' }),
            el('th', { scope: 'col', className: 't-limit' }, el('span', { text: 'Onay limiti' }), el('span', { className: 'th-sub', text: `${base}, dahil` })),
            el('th', { scope: 'col' }, el('span', { className: 'visually-hidden', text: 'Sırala ve çıkar' })),
          ),
        ),
        tbody,
      );
      content.replaceWith(
        el(
          'div',
          { className: 'flow-grid' },
          el(
            'div',
            { className: 'flow-main' },
            el(
              'section',
              { className: 'card flow-id', 'aria-label': 'Akış bilgileri' },
              el('div', { className: 'flow-id-row' }, field({ label: 'Akış adı', input: nameInput, className: 'flow-name-field' }), el('div', { className: 'flow-id-actions' }, defaultBtn, deleteBtn)),
              facts,
              deleteNote,
            ),
            el('section', { className: 'card', 'aria-label': 'Onay stratejisi' }, strategyBox),
            el(
              'section',
              { className: 'card', 'aria-labelledby': 'steps-h' },
              el(
                'div',
                { className: 'card-head' },
                el('div', { className: 'card-head-text' }, el('h2', { className: 'card-title', id: 'steps-h', text: 'Onaycılar' }), el('p', { className: 'card-sub', text: 'Küçük limitten büyüğe, onay sırasıyla. Her onaycı limitine kadar olan masrafların son onayını verir.' })),
                addBtn,
              ),
              el('div', { className: 'table-scroll' }, table),
            ),
            el(
              'section',
              { className: 'card', 'aria-labelledby': 'who-h' },
              el('h2', { className: 'card-title', id: 'who-h', text: 'Kim onaylar?' }),
              el('p', { className: 'card-sub', text: 'Ekrandaki akışa göre, siz yazdıkça güncellenir.' }),
              tierBody,
            ),
            el('div', { className: 'form-actions sticky' }, dirtyNote, el('div', { className: 'form-buttons' }, resetBtn, saveBtn)),
          ),
          el(
            'aside',
            { className: 'flow-side' },
            el(
              'section',
              { className: 'card', 'aria-labelledby': 'probe-h' },
              el('h2', { className: 'card-title', id: 'probe-h', text: 'Tutar dene' }),
              el('label', { className: 'probe-field' }, el('span', { className: 'visually-hidden', text: 'Tutar' }), probeInput, el('span', { className: 'probe-cur', 'aria-hidden': 'true', text: base })),
              probeServer,
              probeLocal,
            ),
            rules(),
          ),
        ),
      );
    }

    const onBeforeUnload = (e) => {
      if (loaded && isDirty() && !saving) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    async function load() {
      const [f, u] = await Promise.all([api.listFlows({ signal }), api.listUsers({}, { signal })]);
      if (signal.aborted) return;
      const failed = !f.ok ? f : !u.ok ? u : null;
      if (failed) {
        if (!failed.unauthorized) content.replaceChildren(loadFailed(failed, load));
        return;
      }
      flows = Array.isArray(f.body) ? f.body : [];
      users = (Array.isArray(u.body) ? u.body : []).slice().sort((a, b) => a.adSoyad.localeCompare(b.adSoyad, 'tr'));
      base = flows[0]?.paraBirimi ?? base;
      session.setBaseCurrency(base);
      probeInput.setAttribute('aria-label', `Denenecek tutar (${base})`);
      build();
      loaded = true;
      newBtn.disabled = false;
      applyRoute(lastRoute);
    }
    load();

    return {
      update(next) {
        lastRoute = next;
        if (loaded) applyRoute(next);
        return true;
      },
      canLeave(next) {
        if (leaveOk) {
          leaveOk = false;
          return true;
        }
        if (!loaded || saving || !isDirty()) return true;
        if (next.def.view === flowView && sameTarget(next)) return true;
        return confirmDialog({
          title: 'Kaydedilmemiş değişiklikler',
          message: isNew
            ? 'Yeni akış henüz kaydedilmedi. Devam ederseniz girdikleriniz kaybolur.'
            : `${quoted(flow?.ad ?? '')} akışındaki değişiklikler kaydedilmedi. Devam ederseniz kaybolur.`,
          confirmLabel: 'Değişiklikleri at',
          kind: 'danger',
        });
      },
      unmount() {
        runProbe.cancel();
        window.removeEventListener('beforeunload', onBeforeUnload);
      },
    };
  },
};
