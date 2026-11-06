// Denetim kaydı (yonetici): GET /api/denetim?adet=N, newest first. Administrative actions on
// users, the approval flow and categories.

import * as api from '../api.js';
import { el, icon, ICONS } from '../dom.js';
import { fmtCount, fmtDateTime, fmtRelative } from '../format.js';
import { humanize } from '../labels.js';
import { btn, debounce, emptyState, input, loadFailed, pageHead, setBusy, skeletonList } from '../ui.js';

const STEPS = [50, 100, 200, 500];

/** `ayrinti` is free-form: text as is, an object as "key: value" pairs. */
function detailNode(v) {
  if (v === null || v === undefined || v === '') return el('span', { className: 'muted', text: '—' });
  if (typeof v !== 'object') return el('span', { text: String(v) });
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i + 1), x]) : Object.entries(v);
  if (entries.length === 0) return el('span', { className: 'muted', text: '—' });
  return el(
    'dl',
    { className: 'audit-kv' },
    ...entries.map(([k, x]) => el('div', {}, el('dt', { text: humanize(k) }), el('dd', { text: typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x) }))),
  );
}

const textOf = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export const auditView = {
  mount(root, { signal }) {
    let step = 0;
    let entries = [];
    let q = '';

    const search = input({ type: 'search', placeholder: 'İşlem, kişi ya da ayrıntı ara', 'aria-label': 'Kayıtlarda ara' });
    const more = btn('Daha eski kayıtları göster', { icon: ICONS.chevronDown, onClick: () => load(step + 1) });
    const announcer = el('p', { className: 'visually-hidden', role: 'status' });
    const list = el('div', { className: 'results' }, skeletonList(6));
    const foot = el('div', { className: 'list-foot' });

    root.append(
      el(
        'div',
        { className: 'page' },
        pageHead({ title: 'Denetim kaydı', sub: 'Kullanıcı, kategori ve onay akışı üzerindeki yönetici işlemleri, en yeni başta.' }),
        el('div', { className: 'toolbar' }, el('label', { className: 'search' }, icon(ICONS.search), search)),
        announcer,
        list,
        foot,
      ),
    );

    search.addEventListener(
      'input',
      debounce(() => {
        q = search.value.trim().toLocaleLowerCase('tr-TR');
        render();
      }, 200),
    );

    async function load(nextStep = 0) {
      setBusy(more, true);
      const r = await api.listAudit(STEPS[nextStep], { signal });
      setBusy(more, false);
      if (signal.aborted) return;
      if (!r.ok) {
        if (!r.unauthorized) list.replaceChildren(loadFailed(r, () => load(nextStep)));
        return;
      }
      step = nextStep;
      entries = Array.isArray(r.body) ? r.body : [];
      render();
    }

    function render() {
      const rows = q
        ? entries.filter((e) => [humanize(e.islem), e.islem, e.kullanici?.adSoyad, textOf(e.ayrinti)].some((s) => (s ?? '').toLocaleLowerCase('tr-TR').includes(q)))
        : entries;
      announcer.textContent = `${fmtCount(rows.length)} kayıt`;
      const canMore = entries.length >= STEPS[step] && step < STEPS.length - 1;
      foot.replaceChildren(canMore ? more : entries.length > 0 ? el('p', { className: 'muted small', text: `Son ${fmtCount(entries.length)} kayıt gösteriliyor.` }) : '');
      if (rows.length === 0) {
        list.replaceChildren(entries.length === 0 ? emptyState({ icon: ICONS.log, title: 'Henüz kayıt yok', text: 'Yönetici işlemleri yapıldıkça burada listelenir.' }) : emptyState({ icon: ICONS.search, title: 'Aramaya uyan kayıt yok' }));
        return;
      }
      list.replaceChildren(
        el(
          'div',
          { className: 'table-card' },
          el(
            'table',
            { className: 'data-table audit-table' },
            el('caption', { className: 'visually-hidden', text: 'Denetim kaydı' }),
            el('thead', {}, el('tr', {}, el('th', { scope: 'col', text: 'Zaman' }), el('th', { scope: 'col', text: 'Kişi' }), el('th', { scope: 'col', text: 'İşlem' }), el('th', { scope: 'col', text: 'Ayrıntı' }))),
            el(
              'tbody',
              {},
              ...rows.map((e) =>
                el(
                  'tr',
                  {},
                  el('td', { className: 't-date', 'data-label': 'Zaman' }, el('time', { datetime: e.tarih, title: fmtDateTime(e.tarih) ?? '', text: fmtDateTime(e.tarih) ?? '' }), el('span', { className: 'cell-sub', text: fmtRelative(e.tarih) ?? '' })),
                  el('td', { 'data-label': 'Kişi', text: e.kullanici?.adSoyad ?? 'Sistem' }),
                  el('td', { 'data-label': 'İşlem' }, el('span', { className: 'audit-op', title: e.islem, text: humanize(e.islem) })),
                  el('td', { className: 't-detail', 'data-label': 'Ayrıntı' }, detailNode(e.ayrinti)),
                ),
              ),
            ),
          ),
        ),
      );
    }

    load();
  },
};
