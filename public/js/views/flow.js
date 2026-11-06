// Onay akışları (yonetici): several named flows, exactly one of them the default. A user's expenses
// go to the flow they are assigned to (Kullanıcılar), or to the default one when they have none.
//
// The page lists the flows and edits the selected one: its name and the ordered approver list with
// an amount range per approver. Addresses: #/onay-akisi (the default flow), #/onay-akisi?akis=<id>,
// #/onay-akisi?akis=yeni (a new flow that is not saved yet). Before saving, the panel draws the
// ranges on a 0–∞ axis and marks uncovered amounts in red; the final check is the server's
// (400 gecersiz_akis with `sorunlar`). "Tutar dene" asks POST /api/onay-akisi/onizle with the
// flow's akisId who an amount goes to under the saved flow; an unsaved flow is only drawn locally.

import * as api from '../api.js';
import { el, icon, ICONS } from '../dom.js';
import { fmtAmountInput, fmtCount, fmtCurrency, fmtDateTime, parseAmount, toCents } from '../format.js';
import { approverChain } from '../expense-ui.js';
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
const PROBE_IDLE = 'Bir tutar yazın; hangi onaycılara gideceği burada görünür.';

let keySeq = 0;
const newKey = () => `s${++keySeq}`;

const centsText = (c) => fmtAmountInput(c / 100);
const tickText = (c) => (c % 100 === 0 ? fmtCount(c / 100) : centsText(c));
const quoted = (name) => `“${name}”`;
const sameName = (a, b) => a.trim().toLocaleLowerCase('tr-TR') === b.trim().toLocaleLowerCase('tr-TR');
const blankStep = () => ({ key: newKey(), onayciId: '', alt: fmtAmountInput(0), ust: '', unlimited: true });

export const flowView = {
  mount(root, { route, signal }) {
    let base = session.knownBaseCurrency() ?? 'TRY';
    let users = []; // every user; the select offers the active ones
    let flows = []; // Akis[] as the server lists them (default first, then by name)
    let flow = null; // the selected saved Akis; null while a new flow is edited
    let isNew = false;
    let steps = []; // [{ key, onayciId, alt, ust, unlimited }] as typed
    let savedSig = ''; // name + steps as saved (or as a blank new flow)
    let savedStepsSig = '';
    let saving = false;
    let loaded = false;
    let lastRoute = route;
    let probeCents = null; // the "Tutar dene" amount
    let pendingNew = null; // { ad, steps } from the "Yeni akış" dialog; the route change applies it
    let leaveOk = false; // an explicit discard (the "Yeni akış" dialog) lets the next address through
    let lastSavedId = null; // where "Vazgeç" returns to from a new flow

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

    const tbody = el('tbody');
    const coverage = el('div', { className: 'cov-wrap' });
    const problemsBox = el('div', { className: 'cov-problems', 'aria-live': 'polite' });
    const dirtyNote = el('p', { className: 'dirty-note', role: 'status' });
    const saveBtn = btn('Kaydet', { icon: ICONS.check, kind: 'primary', onClick: save });
    const resetBtn = btn('Değişiklikleri geri al', { kind: 'ghost', onClick: () => (isNew ? discardNew() : reset()) });
    const addBtn = btn('Onaycı ekle', { icon: ICONS.plus, onClick: addStep });
    const probeInput = input({ inputmode: 'decimal', placeholder: 'Örn. 20.000', 'aria-label': 'Denenecek tutar', className: 'input num' });
    const probeLocal = el('div', { className: 'probe-local', 'aria-live': 'polite' });
    const probeServer = el('div', { className: 'probe-server', 'aria-live': 'polite' });

    const userById = (uid) => users.find((u) => String(u.id) === String(uid)) ?? null;
    const userName = (uid) => userById(uid)?.adSoyad ?? 'Bilinmeyen kullanıcı';
    const defaultFlow = () => flows.find((f) => f.varsayilan) ?? flows[0] ?? null;
    const flowHref = (id) => href(ROUTE, { akis: id });
    const setLabel = (button, text) => {
      const span = button.querySelector('span');
      if (span) span.textContent = text;
    };

    function stepsFromFlow(f) {
      return (f?.adimlar ?? [])
        .slice()
        .sort((a, b) => a.sira - b.sira)
        .map((a) => ({
          key: newKey(),
          onayciId: String(a.onayci?.id ?? ''),
          alt: fmtAmountInput(a.altLimit ?? 0),
          ust: a.ustLimit === null || a.ustLimit === undefined ? '' : fmtAmountInput(a.ustLimit),
          unlimited: a.ustLimit === null || a.ustLimit === undefined,
        }));
    }

    function toCentsOrText(text) {
      const p = parseAmount(text);
      return p.error || p.value === null ? `?${text}` : toCents(p.value);
    }
    const stepsSig = (list = steps) => JSON.stringify(list.map((s) => [s.onayciId, toCentsOrText(s.alt), s.unlimited ? null : toCentsOrText(s.ust)]));
    const signature = (name = nameInput.value, list = steps) => JSON.stringify([name.trim(), stepsSig(list)]);
    // A new flow counts as unsaved work once it differs from a blank one (a name or a copied step list).
    const isDirty = () => signature() !== savedSig;
    const stepsDirty = () => isNew || stepsSig() !== savedStepsSig;

    // ---------- Showing a flow ----------

    function reset() {
      nameInput.value = flow?.ad ?? '';
      setFieldError(nameInput, null);
      steps = stepsFromFlow(flow);
      savedSig = signature();
      savedStepsSig = stepsSig();
      alertSlot.replaceChildren();
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
      steps = [blankStep()];
      savedSig = signature(); // a blank new flow is not "unsaved work" yet
      savedStepsSig = '';
      if (seed) {
        nameInput.value = seed.ad ?? '';
        if (seed.steps?.length) steps = seed.steps.map((s) => ({ ...s, key: newKey() }));
      }
      setFieldError(nameInput, null);
      alertSlot.replaceChildren();
      renderRows();
      renderIdentity();
      renderSwitcher();
      refresh();
      setPageTitle('Yeni akış · Onay akışları');
      announcer.textContent = 'Yeni akış: adını ve onaycılarını girip kaydedin.';
      restartProbe();
      if (seed) {
        // Came from the dialog: continue where input is still missing.
        const open = steps.find((s) => !s.onayciId);
        const target = nameInput.value && open ? tbody.querySelector(`tr[data-key="${open.key}"] select`) : nameInput;
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
              { className: 'flow-tab', href: flowHref(f.id), 'aria-current': current ? 'page' : null },
              el('span', { className: 'flow-tab-name' }, el('span', { className: 'flow-tab-text', text: f.ad }), current ? dirtyMark : null),
              el(
                'span',
                { className: 'flow-tab-meta' },
                f.varsayilan ? el('span', { className: 'tag accent', text: 'Varsayılan' }) : null,
                el('span', { text: `${fmtCount(f.adimlar?.length ?? 0)} onaycı · ${fmtCount(n)} kullanıcı` }),
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

    // ---------- Analysis: problems, ranges, gaps (all in cents) ----------

    function analyze() {
      const problems = [];
      const ranges = steps.map((s, i) => {
        const n = i + 1;
        const lo = parseAmount(s.alt);
        const hi = s.unlimited ? { value: Infinity } : parseAmount(s.ust);
        let bad = false;
        if (lo.error || lo.value === null) {
          problems.push(`${n}. adımın alt limiti ${lo.error ? `geçersiz: ${lo.error}` : 'boş'}`);
          bad = true;
        }
        if (!s.unlimited && (hi.error || hi.value === null)) {
          problems.push(`${n}. adımın üst limiti ${hi.error ? `geçersiz: ${hi.error}` : 'boş; sınır yoksa "Sınırsız" kutusunu işaretleyin'}`);
          bad = true;
        }
        if (!bad && hi.value !== Infinity && toCents(lo.value) > toCents(hi.value)) {
          problems.push(`${n}. adımda alt limit üst limitten büyük.`);
          bad = true;
        }
        return bad ? null : { idx: i, lo: toCents(lo.value), hi: hi.value === Infinity ? Infinity : toCents(hi.value) };
      });
      const structural = problems.length > 0;
      steps.forEach((s, i) => {
        if (!s.onayciId) problems.push(`${i + 1}. adımda onaycı seçilmedi.`);
        else if (userById(s.onayciId) && !userById(s.onayciId).aktif) problems.push(`${userName(s.onayciId)} pasif; akışta yalnızca aktif kullanıcılar olabilir.`);
      });
      const counts = new Map();
      for (const s of steps) if (s.onayciId) counts.set(s.onayciId, (counts.get(s.onayciId) ?? 0) + 1);
      for (const [uid, c] of counts) if (c > 1) problems.push(`${userName(uid)} akışta ${fmtCount(c)} kez var; bir kullanıcı bir akışta bir kez yer alır.`);
      if (steps.length === 0) problems.push('Akışta en az bir onaycı olmalı.');

      const sorted = ranges.filter(Boolean).sort((a, b) => a.lo - b.lo);
      const gaps = [];
      let covered = 0; // the first amount (in cents) nobody covers yet
      for (const r of sorted) {
        if (r.lo > covered) gaps.push({ lo: covered, hi: r.lo - 1 });
        covered = Math.max(covered, r.hi === Infinity ? Infinity : r.hi + 1);
        if (covered === Infinity) break;
      }
      if (covered !== Infinity) gaps.push({ lo: covered, hi: Infinity });
      const missingApprover = steps.some((s) => !s.onayciId);
      return { problems, ranges, gaps, blocking: structural || missingApprover || steps.length === 0 };
    }

    const gapText = (g) => (g.hi === Infinity ? `${centsText(g.lo)} ${base} ve üzeri tutarlar için onaycı yok.` : `${centsText(g.lo)} – ${centsText(g.hi)} ${base} arası tutarlar için onaycı yok.`);

    // ---------- Coverage strip: the ranges on an ordinal 0–∞ axis ----------

    function drawCoverage({ ranges, gaps }) {
      const points = new Set([0]);
      for (const r of ranges) {
        if (!r) continue;
        points.add(r.lo);
        if (r.hi !== Infinity) points.add(r.hi + 1);
      }
      for (const g of gaps) points.add(g.lo);
      const P = [...points].sort((a, b) => a - b);
      const n = P.length; // segments [P0,P1) … [P(n-1), ∞), equal width each
      const pos = (c) => (c === Infinity ? 100 : (P.indexOf(c) / n) * 100);
      const span = (lo, hiExclusive) => `left:${pos(lo)}%;width:${pos(hiExclusive) - pos(lo)}%`;

      let probeX = null;
      if (probeCents !== null) {
        let j = P.length - 1;
        for (let i = 0; i < P.length - 1; i++) {
          if (probeCents < P[i + 1]) {
            j = i;
            break;
          }
        }
        const frac = j < P.length - 1 ? (probeCents - P[j]) / (P[j + 1] - P[j]) : 0.35;
        probeX = ((j + Math.min(1, Math.max(0, frac))) / n) * 100;
      }
      const hit = (r) => r && probeCents !== null && probeCents >= r.lo && probeCents <= r.hi;

      const names = el('div', { className: 'cov-names' }, el('span', { className: 'cov-name strong', text: 'Kapsama' }));
      const plot = el('div', { className: 'cov-plot' });
      const sum = el('div', { className: 'cov-track cov-sum' });
      // Covered parts first, then the gaps in red on top.
      sum.append(el('span', { className: 'cov-seg ok', style: 'left:0%;width:100%' }));
      for (const g of gaps) sum.append(el('span', { className: 'cov-seg gap', style: span(g.lo, g.hi === Infinity ? Infinity : g.hi + 1), title: gapText(g) }));
      plot.append(sum);

      steps.forEach((s, i) => {
        const r = ranges[i];
        const label = `${i + 1}. ${s.onayciId ? userName(s.onayciId) : 'Onaycı seçilmedi'}`;
        names.append(el('span', { className: `cov-name${hit(r) ? ' hit' : ''}`, title: label, text: label }));
        const track = el('div', { className: `cov-track${hit(r) ? ' hit' : ''}` });
        if (r) track.append(el('span', { className: 'cov-bar', style: span(r.lo, r.hi === Infinity ? Infinity : r.hi + 1) }));
        else track.append(el('span', { className: 'cov-invalid', text: 'geçersiz aralık' }));
        plot.append(track);
      });

      const axis = el('div', { className: 'cov-axis' });
      P.forEach((c, i) => axis.append(el('span', { className: 'cov-tick', style: `left:${(i / n) * 100}%`, title: `${centsText(c)} ${base}`, text: tickText(c) })));
      axis.append(el('span', { className: 'cov-tick end', style: 'left:100%', text: '∞' }));
      plot.append(axis);
      names.append(el('span', { className: 'cov-name axis', text: base }));
      if (probeX !== null) plot.append(el('span', { className: 'cov-probe', style: `left:${probeX}%` }));

      coverage.replaceChildren(
        el('div', { className: 'cov', 'aria-hidden': 'true' }, names, plot),
        el('p', { className: 'visually-hidden', text: 'Grafik, her onaycının tutar aralığını 0’dan sonsuza bir eksen üzerinde gösterir. Aynı bilgi aşağıdaki uyarılarda yazılıdır.' }),
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
      drawCoverage(a);
      const items = [...a.gaps.map(gapText), ...a.problems];
      problemsBox.replaceChildren(
        items.length === 0
          ? alertBox('ok', null, ['Her tutarın en az bir onaycısı var.'])
          : alertBox(a.gaps.length > 0 ? 'err' : 'warn', a.gaps.length > 0 ? 'Kapsanmayan tutarlar var; sunucu bu akışı kaydetmez.' : 'Kontrol edin', items),
      );
      updateDirty();
      updateProbeLocal(a);
      for (const [i, row] of [...tbody.children].entries()) {
        const del = row.querySelector('[data-act="del"]');
        if (del) del.disabled = steps.length <= 1;
        row.querySelector('[data-act="up"]').disabled = i === 0;
        row.querySelector('[data-act="down"]').disabled = i === steps.length - 1;
      }
      syncOptions();
    }

    nameInput.addEventListener('input', () => {
      setFieldError(nameInput, null);
      updateDirty();
      const tab = switcher.querySelector('[data-new-name]');
      if (tab) tab.textContent = nameInput.value.trim() || 'Yeni akış';
    });

    // ---------- Rows ----------

    function syncOptions() {
      const used = new Map(); // user id -> row key
      for (const s of steps) if (s.onayciId) used.set(s.onayciId, s.key);
      for (const row of tbody.children) {
        const key = row.dataset.key;
        for (const opt of row.querySelectorAll('select option')) {
          if (!opt.value) continue;
          const owner = used.get(opt.value);
          opt.disabled = Boolean(owner && owner !== key);
        }
      }
    }

    function row(s, i) {
      const n = i + 1;
      const sel = el('select', { className: 'input', 'aria-label': `${n}. adım onaycısı`, 'data-f': 'onayciId' }, el('option', { value: '', text: 'Onaycı seçin' }));
      const options = users.filter((u) => u.aktif || String(u.id) === s.onayciId);
      for (const u of options) sel.append(el('option', { value: u.id, text: `${u.adSoyad}${u.departman ? ` · ${u.departman}` : ''}${u.aktif ? '' : ' (pasif)'}` }));
      sel.value = s.onayciId;
      const alt = input({ inputmode: 'decimal', value: s.alt, className: 'input num', 'aria-label': `${n}. adım alt limit (${base})`, 'data-f': 'alt' });
      const ust = input({ inputmode: 'decimal', value: s.ust, className: 'input num', 'aria-label': `${n}. adım üst limit (${base})`, 'data-f': 'ust', disabled: s.unlimited, placeholder: s.unlimited ? 'sınırsız' : '' });
      const unl = el('input', { type: 'checkbox', className: 'check', checked: s.unlimited, 'data-f': 'unlimited', 'aria-label': `${n}. adım üst limit sınırsız` });
      return el(
        'tr',
        { 'data-key': s.key },
        el('td', { className: 't-order' }, el('span', { className: 'order-n', text: String(n) })),
        el('td', { className: 't-approver', 'data-label': 'Onaycı' }, sel),
        el('td', { className: 't-lo', 'data-label': `Alt limit (${base})` }, alt),
        el('td', { className: 't-hi', 'data-label': `Üst limit (${base})` }, el('div', { className: 'hi-wrap' }, ust, el('label', { className: 'check-label' }, unl, el('span', { text: 'Sınırsız' })))),
        el(
          'td',
          { className: 't-actions' },
          btn('Yukarı taşı', { icon: ICONS.arrowUp, size: 'sm', iconOnly: true, attrs: { 'data-act': 'up', 'aria-label': `${n}. adımı yukarı taşı` } }),
          btn('Aşağı taşı', { icon: ICONS.arrowDown, size: 'sm', iconOnly: true, attrs: { 'data-act': 'down', 'aria-label': `${n}. adımı aşağı taşı` } }),
          btn('Sil', { icon: ICONS.trash, size: 'sm', iconOnly: true, kind: 'danger-ghost', attrs: { 'data-act': 'del', 'aria-label': `${n}. adımı sil` } }),
        ),
      );
    }

    function renderRows(focus = null) {
      tbody.replaceChildren(...steps.map(row));
      if (focus) {
        const target = tbody.querySelector(`tr[data-key="${focus.key}"] [data-act="${focus.act}"]`);
        if (target && !target.disabled) target.focus();
        else tbody.querySelector(`tr[data-key="${focus.key}"] select`)?.focus();
      }
    }

    // Selects and checkboxes fire "input" too, so one listener covers every control in a row.
    tbody.addEventListener('input', (e) => {
      const tr = e.target.closest('tr[data-key]');
      const f = e.target.dataset.f;
      if (!tr || !f) return;
      const s = steps.find((x) => x.key === tr.dataset.key);
      if (!s) return;
      if (f === 'unlimited') {
        s.unlimited = e.target.checked;
        const ust = tr.querySelector('[data-f="ust"]');
        ust.disabled = s.unlimited;
        ust.placeholder = s.unlimited ? 'sınırsız' : '';
        if (!s.unlimited) ust.focus();
      } else {
        s[f] = e.target.value;
      }
      refresh();
    });
    tbody.addEventListener('focusout', (e) => {
      const f = e.target.dataset?.f;
      if (f !== 'alt' && f !== 'ust') return;
      const p = parseAmount(e.target.value);
      if (!p.error && p.value !== null) {
        e.target.value = fmtAmountInput(p.value);
        const s = steps.find((x) => x.key === e.target.closest('tr').dataset.key);
        if (s) s[f] = e.target.value;
      }
    });
    tbody.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      const key = b.closest('tr').dataset.key;
      const i = steps.findIndex((s) => s.key === key);
      if (b.dataset.act === 'up' && i > 0) {
        [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]];
        renderRows({ key, act: i - 1 === 0 ? 'down' : 'up' });
      } else if (b.dataset.act === 'down' && i < steps.length - 1) {
        [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]];
        renderRows({ key, act: i + 1 === steps.length - 1 ? 'up' : 'down' });
      } else if (b.dataset.act === 'del' && steps.length > 1) {
        steps.splice(i, 1);
        const next = steps[Math.min(i, steps.length - 1)];
        renderRows(next ? { key: next.key, act: 'del' } : null);
      }
      refresh();
    });

    function addStep() {
      const { gaps } = analyze();
      const start = gaps.length > 0 ? gaps[0].lo : 0;
      const s = { key: newKey(), onayciId: '', alt: fmtAmountInput(start / 100), ust: '', unlimited: true };
      steps.push(s);
      renderRows();
      refresh();
      tbody.querySelector(`tr[data-key="${s.key}"] select`)?.focus();
    }

    // ---------- "Tutar dene" ----------

    function updateProbeLocal(a) {
      if (probeCents === null || !stepsDirty()) {
        probeLocal.replaceChildren();
        return;
      }
      const matched = a.ranges
        .map((r, i) => (r && probeCents >= r.lo && probeCents <= r.hi ? { sira: i + 1, onayci: { adSoyad: steps[i].onayciId ? userName(steps[i].onayciId) : 'Onaycı seçilmedi' }, durum: 'sirada', yedek: false } : null))
        .filter(Boolean);
      probeLocal.replaceChildren(el('p', { className: 'probe-title', text: isNew ? 'Ekrandaki (kaydedilmemiş) adımlara göre' : 'Düzenlenen (kaydedilmemiş) akışa göre' }), approverChain({ adimlar: matched }));
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
        probeServer.replaceChildren(el('p', { className: 'muted small', text: 'Akış henüz kaydedilmediği için yalnızca ekrandaki adımlara göre gösterilir.' }));
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

    async function save() {
      if (saving) return;
      alertSlot.replaceChildren();
      const ad = nameInput.value.trim();
      const a = analyze();
      if (!ad) setFieldError(nameInput, 'Akışa bir ad verin.');
      if (a.blocking) alertSlot.replaceChildren(alertBox('err', 'Akış kaydedilemedi', a.problems));
      if (!ad || a.blocking) {
        (ad ? alertSlot : nameInput).focus();
        return;
      }
      const adimlar = steps.map((s) => ({
        onayciId: Number(s.onayciId),
        altLimit: parseAmount(s.alt).value,
        ustLimit: s.unlimited ? null : parseAmount(s.ust).value,
      }));
      const creating = isNew;
      const editing = flow;
      saving = true;
      setBusy(saveBtn, true);
      const r = creating ? await api.createFlow({ ad, adimlar }) : await api.updateFlow(editing.id, { ad, adimlar });
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
        // 400 gecersiz_akis brings `sorunlar`; 400 gecersiz_istek brings `alanlar` keyed by path (ad, adimlar.0.altLimit).
        const alanlar = { ...(r.error.alanlar ?? {}) };
        if (alanlar.ad) {
          setFieldError(nameInput, String(alanlar.ad));
          delete alanlar.ad;
        }
        const fieldIssues = Object.entries(alanlar).map(([k, v]) => {
          const m = /^adimlar\.(\d+)\./.exec(k);
          return m ? `${Number(m[1]) + 1}. adım: ${v}` : String(v);
        });
        const issues = r.error.sorunlar?.length ? r.error.sorunlar : fieldIssues;
        if (r.error.alanlar?.ad && issues.length === 0) {
          nameInput.focus();
          return;
        }
        alertSlot.replaceChildren(alertBox('err', issues.length ? 'Sunucu akışı kabul etmedi' : 'Akış kaydedilemedi', issues.length ? issues : [r.error.mesaj]));
        alertSlot.focus();
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
      const source = isNew ? 'Ekrandaki adımları kopyala' : `${quoted(flow.ad)} akışının adımlarını kopyala`;
      const copyHint = `${fmtCount(steps.length)} adım, aralıklarıyla birlikte${dirty && !isNew ? '; ekrandaki kaydedilmemiş hâliyle' : ''}.`;
      const option = (value, title, hint, checked) =>
        el(
          'label',
          { className: 'role-option' },
          el('input', { type: 'radio', name: 'baslangic', value, checked }),
          el('span', { className: 'role-text' }, el('span', { className: 'role-title', text: title }), el('span', { className: 'role-hint', text: hint })),
        );
      const options = el('div', { className: 'role-options' }, option('kopya', source, copyHint, true), option('bos', 'Boş başla', 'Tek satırla (0 – sınırsız) başlar; onaycıyı siz seçersiniz.', false));
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
          return { ad, steps: copy ? steps.map((s) => ({ ...s })) : null };
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
        ['Kullanıcıya göre akış', 'Her kullanıcının masrafı kendi akışına gider. Kullanıcıyı bir akışa Kullanıcılar sayfasından atarsınız.'],
        ['Varsayılan akış', 'Akış atanmamış kullanıcılar varsayılan akışı kullanır. Varsayılan akış silinemez; silinen bir akışın kullanıcıları varsayılana geçer.'],
        ['Boşluksuz kapsama', "Her akışta en az bir onaycı olur ve aralıklar 0'dan sonsuza her tutarı kapsar; boşluk varsa kayıt reddedilir."],
        ['Aralıklar dahil, kuruş hassas', 'Alt ve üst limit aralığa dahildir: 0,00 – 5.000,00 ve 5.000,01 – sınırsız boşluksuz birleşir. Üst limit yoksa "Sınırsız" seçin.'],
        ['Sıralı onay', 'Masraf, aralığı tutarı içeren bütün onaycılara sıra numarasına göre sırayla gider. Her tutar tek onaycıya gitsin istiyorsanız aralıkları çakıştırmayın.'],
        ['Onay tutarı', `Beyan edilen tutar ile bağlı faturanın genel toplamından büyük olanıdır; aralıklar ${base} cinsindendir.`],
        ['Kendi masrafı atlanır', 'Gönderen kendi akışındaysa adımı atlanır. Geriye adım kalmazsa masraf, gönderen dışındaki ilk aktif yöneticiye (yedek) gider.'],
        ['Süren masraflar etkilenmez', 'Akış gönderim anında masrafa kopyalanır; akış, varsayılan ya da atama sonradan değişse de gönderilmiş masraflar etkilenmez.'],
        ['Bir akışta bir kez', 'Bir kullanıcı bir akışta bir kez yer alır, başka akışlarda ayrı aralıklarla bulunabilir. Herhangi bir akışta onaycı olan kullanıcı pasifleştirilemez.'],
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
        el('caption', { className: 'visually-hidden', text: 'Onay adımları' }),
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', { scope: 'col', className: 't-order', text: 'Sıra' }),
            el('th', { scope: 'col', text: 'Onaycı' }),
            el('th', { scope: 'col', className: 'num', text: `Alt limit (${base})` }),
            el('th', { scope: 'col', className: 'num', text: `Üst limit (${base})` }),
            el('th', { scope: 'col' }, el('span', { className: 'visually-hidden', text: 'Sırala ve sil' })),
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
            el(
              'section',
              { className: 'card', 'aria-labelledby': 'steps-h' },
              el('div', { className: 'card-head' }, el('h2', { className: 'card-title', id: 'steps-h', text: 'Adımlar' }), addBtn),
              el('div', { className: 'table-scroll' }, table),
            ),
            el(
              'section',
              { className: 'card', 'aria-labelledby': 'cov-h' },
              el('h2', { className: 'card-title', id: 'cov-h', text: 'Kapsama önizlemesi' }),
              el('p', { className: 'muted small', text: 'Her satır bir onaycının aralığıdır; kırmızı bölgeler hiçbir onaycının kapsamadığı tutarlardır. "Tutar dene" kutusundaki tutar dikey çizgiyle gösterilir.' }),
              coverage,
              problemsBox,
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
              el('label', { className: 'probe-field' }, el('span', { className: 'visually-hidden', text: 'Tutar' }), probeInput, el('span', { className: 'probe-cur', text: base })),
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
