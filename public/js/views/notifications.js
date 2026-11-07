// Bildirimler (#/bildirimler): the signed-in user's notifications (GET /api/bildirimler), newest
// first, unread ones highlighted. Opening one marks it read and goes to its expense. In-app
// notifications always arrive; only the e-mail copy is a preference (Profil).

import * as api from '../api.js';
import { el, icon, ICONS } from '../dom.js';
import { fmtCount, fmtDateTime, fmtRelative } from '../format.js';
import { expenseHref } from '../expense-ui.js';
import { NOTIFICATION_TYPES } from '../labels.js';
import { navigate } from '../router.js';
import * as session from '../session.js';
import { btn, emptyState, loadFailed, pager, pageHead, showError, skeletonList, toast } from '../ui.js';

const PAGE_SIZE = 20;

export const notificationsView = {
  mount(root, { route, signal }) {
    let unreadOnly = route.query.get('okunmamis') === '1';
    let pageNo = Math.max(1, Number(route.query.get('sayfa')) || 1);
    let token = 0;
    let alive = true;

    const body = el('div', { className: 'notif-body', 'aria-live': 'polite' });
    const allBtn = btn('Hepsini okundu yap', { icon: ICONS.check, onClick: markAll });
    const tabs = [
      { key: false, label: 'Tümü' },
      { key: true, label: 'Okunmamış' },
    ].map((t) => el('button', { className: 'tab', type: 'button', role: 'tab', 'data-unread': String(t.key), onClick: () => setFilter(t.key) }, el('span', { text: t.label })));
    const tablist = el('div', { className: 'tabs page-tabs', role: 'tablist', 'aria-label': 'Bildirim süzgeci' }, ...tabs);
    root.append(el('div', { className: 'page narrow' }, pageHead({ title: 'Bildirimler', sub: 'Onay süreciyle ilgili haberler.', actions: [allBtn] }), tablist, body));

    function syncTabs() {
      for (const b of tabs) {
        const on = (b.dataset.unread === 'true') === unreadOnly;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
      }
    }
    tablist.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      setFilter(!unreadOnly);
      tablist.querySelector('[aria-selected="true"]')?.focus();
    });

    function go() {
      navigate('/bildirimler', { query: { okunmamis: unreadOnly ? '1' : '', sayfa: pageNo > 1 ? pageNo : '' }, replace: true });
    }

    function setFilter(on) {
      if (on === unreadOnly) return;
      unreadOnly = on;
      pageNo = 1;
      go();
    }

    async function load() {
      const my = ++token;
      syncTabs();
      if (!body.firstChild) body.append(skeletonList(4));
      const r = await api.listNotifications({ okunmamis: unreadOnly ? 1 : undefined, sayfa: pageNo, adet: PAGE_SIZE }, { signal });
      if (!alive || my !== token) return;
      if (!r.ok) {
        if (!r.unauthorized && !r.aborted) body.replaceChildren(loadFailed(r, load));
        return;
      }
      session.setUnread(r.body.okunmamis);
      allBtn.disabled = !(r.body.okunmamis > 0);
      render(r.body);
    }

    function render(data) {
      const list = data.kayitlar ?? [];
      const pages = Math.max(1, Math.ceil(data.toplam / data.adet));
      if (list.length === 0 && data.toplam > 0 && pageNo > pages) {
        pageNo = pages;
        go();
        return;
      }
      if (list.length === 0) {
        body.replaceChildren(
          emptyState({
            icon: ICONS.bell,
            title: unreadOnly ? 'Okunmamış bildirim yok' : 'Henüz bildirim yok',
            text: unreadOnly ? 'Her şeyi okudunuz.' : 'Masraflarınızla ilgili gelişmeler burada görünür.',
          }),
        );
        return;
      }
      body.replaceChildren(
        el('ul', { className: 'notif-list' }, ...list.map(item)),
        pager({ sayfa: data.sayfa, adet: data.adet, toplam: data.toplam, onPage: (n) => {
          pageNo = n;
          go();
          window.scrollTo({ top: 0 });
        } }),
      );
    }

    function item(n) {
      const t = NOTIFICATION_TYPES[n.tur] ?? { label: 'Bildirim', tone: 'muted', icon: ICONS.bell };
      const content = [
        el('span', { className: `notif-glyph ${t.tone}`, 'aria-hidden': 'true' }, icon(t.icon)),
        el(
          'span',
          { className: 'notif-text' },
          el('span', { className: 'notif-title' }, n.okundu ? null : el('span', { className: 'visually-hidden', text: 'Okunmadı: ' }), el('strong', { text: n.baslik }), el('span', { className: 'tag', text: t.label })),
          el('span', { className: 'notif-msg', text: n.mesaj }),
          el('span', { className: 'notif-time' }, el('time', { datetime: n.olusturma, title: fmtDateTime(n.olusturma), text: fmtRelative(n.olusturma) ?? '' }), n.form ? el('span', { text: ` · #${n.form.id} ${n.form.baslik}` }) : null),
        ),
      ];
      const li = el('li', { className: `notif${n.okundu ? '' : ' unread'}` });
      if (n.form) {
        // A real link (middle-click, copy address); the read mark goes out as the page opens.
        li.append(el('a', { className: 'notif-main', href: expenseHref(n.form.id), onClick: () => markRead(n, li) }, ...content));
      } else {
        li.append(el('div', { className: 'notif-main' }, ...content));
      }
      if (!n.okundu) li.append(el('button', { className: 'btn btn-sm notif-mark', type: 'button', text: 'Okundu yap', 'aria-label': `Okundu yap: ${n.baslik}`, onClick: () => markRead(n, li) }));
      return li;
    }

    async function markRead(n, li) {
      if (n.okundu) return;
      n.okundu = true;
      li.classList.remove('unread');
      li.querySelector('.notif-mark')?.remove();
      li.querySelector('.visually-hidden')?.remove();
      const r = await api.markNotificationRead(n.id);
      if (!r.ok) {
        // Not marked on the server: put it back so the count stays honest.
        n.okundu = false;
        showError(r);
      }
      session.refreshMe();
    }

    async function markAll() {
      allBtn.disabled = true;
      const r = await api.markAllNotificationsRead();
      if (!r.ok) {
        allBtn.disabled = false;
        showError(r);
        return;
      }
      toast('Bütün bildirimler okundu olarak işaretlendi.', 'ok');
      session.setUnread(0);
      load();
    }

    load();
    return {
      update(next) {
        unreadOnly = next.query.get('okunmamis') === '1';
        pageNo = Math.max(1, Number(next.query.get('sayfa')) || 1);
        load();
        return true;
      },
      unmount() {
        alive = false;
      },
    };
  },
};
