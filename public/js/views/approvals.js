// Onaylarım: expenses waiting for this user's decision (GET /api/onaylar?durum=bekleyen, oldest
// first) and the ones they decided on (?durum=karar, newest first). Approve or reject in place.

import * as api from '../api.js';
import { el, icon, ICONS, reducedMotion } from '../dom.js';
import { fmtCount, fmtDateShort, fmtDateTime, fmtRelative } from '../format.js';
import { amountBlock, approveDialog, expenseHref, rejectDialog } from '../expense-ui.js';
import { categoryIcon, statusBadge } from '../labels.js';
import { navigate } from '../router.js';
import * as session from '../session.js';
import { btn, emptyState, loadFailed, pageHead, skeletonList, toast } from '../ui.js';

const TABS = [
  { key: 'bekleyen', label: 'Bekleyenler' },
  { key: 'karar', label: 'Karar verdiklerim' },
];

export const approvalsView = {
  mount(root, { route, signal }) {
    let tab = route.query.get('sekme') === 'karar' ? 'karar' : 'bekleyen';
    let token = 0;
    let base = session.knownBaseCurrency();
    let items = [];

    const tabButtons = TABS.map((t) =>
      el(
        'button',
        { className: 'tab', type: 'button', role: 'tab', id: `appr-tab-${t.key}`, 'aria-controls': 'appr-panel', 'data-tab': t.key },
        el('span', { text: t.label }),
        t.key === 'bekleyen' ? el('span', { className: 'tab-count', 'aria-hidden': 'true' }) : null,
      ),
    );
    const tablist = el('div', { className: 'tabs page-tabs', role: 'tablist', 'aria-label': 'Onaylar' }, ...tabButtons);
    const panel = el('div', { className: 'appr-panel', id: 'appr-panel', role: 'tabpanel', tabindex: '-1' });

    root.append(el('div', { className: 'page narrow' }, pageHead({ title: 'Onaylarım', sub: 'Onay akışında sırası size gelen masraflar.' }), tablist, panel));

    function syncTabs() {
      for (const b of tabButtons) {
        const on = b.dataset.tab === tab;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
      }
      panel.setAttribute('aria-labelledby', `appr-tab-${tab}`);
    }

    function setCount(n) {
      const badge = tablist.querySelector('.tab-count');
      badge.textContent = n > 0 ? fmtCount(n) : '';
      badge.hidden = n <= 0;
      tabButtons[0].setAttribute('aria-label', n > 0 ? `Bekleyenler, ${fmtCount(n)}` : 'Bekleyenler');
    }
    setCount(session.pendingCount());

    function select(key, focus = false) {
      if (key === tab) return;
      navigate('/onaylar', { query: { sekme: key === 'karar' ? 'karar' : '' }, replace: true });
      if (focus) tablist.querySelector(`[data-tab="${key}"]`)?.focus();
    }

    tablist.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) select(b.dataset.tab);
    });
    tablist.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const i = TABS.findIndex((t) => t.key === tab);
      let next = i;
      if (e.key === 'ArrowRight') next = (i + 1) % TABS.length;
      else if (e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
      else if (e.key === 'Home') next = 0;
      else next = TABS.length - 1;
      select(TABS[next].key, true);
    });

    // ---------- Lists ----------

    function pendingCard(m) {
      const li = el('li', { className: 'appr-card', 'data-id': m.id });
      const approve = btn('Onayla', { icon: ICONS.check, kind: 'ok', size: 'sm', attrs: { 'aria-label': `${m.baslik} masrafını onayla` } });
      const reject = btn('Reddet', { icon: ICONS.close, kind: 'danger-ghost', size: 'sm', attrs: { 'aria-label': `${m.baslik} masrafını reddet` } });
      approve.addEventListener('click', async () => decide(m, li, 'onayla'));
      reject.addEventListener('click', async () => decide(m, li, 'reddet'));
      li.append(
        el(
          'a',
          { className: 'appr-main', href: expenseHref(m.id) },
          categoryIcon(m.kategori?.simge),
          el(
            'span',
            { className: 'appr-text' },
            el('span', { className: 'appr-title', text: m.baslik }),
            el('span', { className: 'appr-sub', text: [m.olusturan?.adSoyad, m.kategori?.ad, fmtDateShort(m.masrafTarihi)].filter(Boolean).join(' · ') }),
            m.satici ? el('span', { className: 'appr-sub', text: m.satici }) : null,
          ),
          amountBlock(m, base, 'appr-amount'),
        ),
        el(
          'div',
          { className: 'appr-foot' },
          el('span', { className: 'appr-when' }, icon(ICONS.clock), el('time', { datetime: m.gonderim ?? '', title: fmtDateTime(m.gonderim) ?? '', text: m.gonderim ? `${fmtRelative(m.gonderim)} gönderildi` : '' })),
          el('div', { className: 'appr-actions' }, reject, approve),
        ),
      );
      return li;
    }

    function decidedRow(m) {
      return el(
        'li',
        {},
        el(
          'a',
          { className: 'mini-row', href: expenseHref(m.id) },
          categoryIcon(m.kategori?.simge),
          el('span', { className: 'mini-main' }, el('span', { className: 'mini-title', text: m.baslik }), el('span', { className: 'mini-sub', text: [m.olusturan?.adSoyad, fmtDateShort(m.masrafTarihi)].filter(Boolean).join(' · ') })),
          el('span', { className: 'mini-end' }, amountBlock(m, base, 'mini-amount-block'), statusBadge(m.durum, { className: 'sm' })),
        ),
      );
    }

    async function decide(m, li, kind) {
      const result = kind === 'onayla' ? await approveDialog(m, base) : await rejectDialog(m, base);
      if (!result) return;
      if (typeof result !== 'object') {
        // The server refused (e.g. someone else decided first): show the current list.
        load();
        return;
      }
      toast(kind === 'onayla' ? `Onaylandı: ${m.baslik}` : `Reddedildi: ${m.baslik}`, 'ok');
      items = items.filter((x) => x.id !== m.id);
      const next = li.nextElementSibling ?? li.previousElementSibling;
      const remove = () => {
        li.remove();
        if (items.length === 0) panel.replaceChildren(emptyPending());
        else (next?.querySelector('.appr-main') ?? panel).focus();
      };
      if (reducedMotion.matches) remove();
      else {
        li.classList.add('leaving');
        setTimeout(remove, 280);
      }
      setCount(items.length);
      session.refreshMe();
    }

    function emptyPending() {
      return emptyState({ icon: ICONS.checkCircle, title: 'Bekleyen onayınız yok', text: 'Sırası size gelen masraflar burada görünür.' });
    }

    async function load() {
      const my = ++token;
      panel.replaceChildren(skeletonList(4));
      const [r, b] = await Promise.all([api.listApprovals(tab, { signal }), session.loadBaseCurrency()]);
      if (my !== token || signal.aborted) return;
      base = b;
      if (!r.ok) {
        if (!r.unauthorized) panel.replaceChildren(loadFailed(r, load));
        return;
      }
      items = Array.isArray(r.body) ? r.body : [];
      if (tab === 'bekleyen') {
        setCount(items.length);
        session.setPending(items.length);
        panel.replaceChildren(items.length === 0 ? emptyPending() : el('ul', { className: 'appr-list stagger' }, ...items.map(pendingCard)));
      } else {
        panel.replaceChildren(
          items.length === 0
            ? emptyState({ icon: ICONS.inbox, title: 'Henüz karar vermediniz', text: 'Onayladığınız ya da reddettiğiniz masraflar burada listelenir.' })
            : el('ul', { className: 'mini-list card-list stagger' }, ...items.map(decidedRow)),
        );
      }
    }

    syncTabs();
    load();

    return {
      update(next) {
        const t = next.query.get('sekme') === 'karar' ? 'karar' : 'bekleyen';
        if (t !== tab) {
          tab = t;
          syncTabs();
          load();
        }
        return true;
      },
    };
  },
};
