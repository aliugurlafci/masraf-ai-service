// Gösterge (GET /api/ozet): the user's own figures, approvals waiting for them, their latest
// expenses and, for accounting and managers, the company-wide picture.

import * as api from '../api.js';
import { el, icon, ICONS } from '../dom.js';
import { fmtCount, fmtCurrency, fmtToday } from '../format.js';
import { expenseMiniRow } from '../expense-ui.js';
import { EXPENSE_STATUS } from '../labels.js';
import * as session from '../session.js';
import { animatedValue, btn, emptyState, loadFailed, pageHead } from '../ui.js';

const DIST = ['taslak', 'onayda', 'onaylandi', 'reddedildi', 'odendi'];

function tile({ label, value, format, hint, href, tone = '' }) {
  const inner = [
    el('span', { className: 'kpi-label', text: label }),
    el('span', { className: 'kpi-value' }, animatedValue(value, format)),
    hint ? el('span', { className: 'kpi-hint', text: hint }) : null,
  ];
  return href
    ? el('a', { className: `kpi ${tone}`.trim(), href }, ...inner, el('span', { className: 'kpi-go', 'aria-hidden': 'true' }, icon(ICONS.chevronRight)))
    : el('div', { className: `kpi ${tone}`.trim() }, ...inner);
}

const count = (v) => fmtCount(Math.round(v));

/** Status counts as one segmented bar with a legend that links to the filtered list. */
function distribution(benim) {
  const total = DIST.reduce((n, k) => n + (benim[k] ?? 0), 0);
  const bar = el('div', { className: 'dist-bar', 'aria-hidden': 'true' });
  const legend = el('ul', { className: 'dist-legend' });
  for (const key of DIST) {
    const n = benim[key] ?? 0;
    const s = EXPENSE_STATUS[key];
    if (n > 0) bar.append(el('span', { className: `dist-seg ${s.tone}`, style: `flex-grow:${n}`, title: `${s.label}: ${fmtCount(n)}` }));
    legend.append(
      el(
        'li',
        {},
        el(
          'a',
          { href: `#/masraflar?durum=${key}`, className: 'dist-item' },
          el('span', { className: `dist-swatch ${s.tone}`, 'aria-hidden': 'true' }, icon(s.icon)),
          el('span', { className: 'dist-name', text: s.label }),
          el('span', { className: 'dist-count', text: fmtCount(n) }),
        ),
      ),
    );
  }
  if (total === 0) bar.append(el('span', { className: 'dist-seg is-empty', style: 'flex-grow:1' }));
  return el('section', { className: 'card', 'aria-labelledby': 'dist-title' }, el('h2', { className: 'card-title', id: 'dist-title', text: 'Masraflarımın durumu' }), bar, legend);
}

function render(o) {
  const base = o.paraBirimi ?? 'TRY';
  const b = o.benim ?? {};
  const money = (v) => fmtCurrency(v, base);
  const nodes = [];

  if (o.bekleyenOnay > 0) {
    nodes.push(
      el(
        'a',
        { className: 'callout', href: '#/onaylar' },
        el('span', { className: 'callout-icon', 'aria-hidden': 'true' }, icon(ICONS.inbox)),
        el(
          'span',
          { className: 'callout-text' },
          el('strong', { text: o.bekleyenOnay === 1 ? 'Bir masraf onayınızı bekliyor' : `${fmtCount(o.bekleyenOnay)} masraf onayınızı bekliyor` }),
          el('span', { text: 'Sırası size gelen masrafları inceleyip onaylayın ya da reddedin.' }),
        ),
        el('span', { className: 'callout-go' }, el('span', { text: 'Onaylarım' }), icon(ICONS.chevronRight)),
      ),
    );
  }

  nodes.push(
    el(
      'section',
      { className: 'dash-section', 'aria-labelledby': 'mine-title' },
      el('h2', { className: 'sec-title', id: 'mine-title', text: 'Benim masraflarım' }),
      el(
        'div',
        { className: 'kpis' },
        tile({ label: 'Bu ay gönderilen', value: b.buAyToplam ?? 0, format: money, hint: 'İptal edilenler hariç' }),
        tile({ label: 'Onay bekleyen tutar', value: b.bekleyenTutar ?? 0, format: money, hint: `${fmtCount(b.onayda ?? 0)} masraf onayda`, href: '#/masraflar?durum=onayda', tone: 'wait' }),
        tile({ label: 'Taslaklar', value: b.taslak ?? 0, format: count, hint: 'Henüz gönderilmedi', href: '#/masraflar?durum=taslak' }),
        tile({ label: 'Onayınızı bekleyen', value: o.bekleyenOnay ?? 0, format: count, hint: 'Size gelen onaylar', href: '#/onaylar', tone: o.bekleyenOnay > 0 ? 'accent' : '' }),
      ),
    ),
  );

  const recent = o.sonMasraflar ?? [];
  const recentCard = el(
    'section',
    { className: 'card', 'aria-labelledby': 'recent-title' },
    el('div', { className: 'card-head' }, el('h2', { className: 'card-title', id: 'recent-title', text: 'Son masraflar' }), recent.length > 0 ? el('a', { className: 'card-link', href: '#/masraflar', text: 'Tümünü gör' }) : null),
    recent.length > 0
      ? el('ul', { className: 'mini-list stagger' }, ...recent.map((m) => expenseMiniRow(m, base)))
      : emptyState({
          icon: ICONS.receipt,
          title: 'Henüz masrafınız yok',
          text: 'Faturanızı yükleyin; tutar, tarih ve satıcı kendiliğinden dolsun.',
          action: btn('İlk masrafı oluştur', { href: '#/masraflar/yeni', kind: 'primary', icon: ICONS.plus }),
        }),
  );
  nodes.push(el('div', { className: 'dash-cols' }, recentCard, distribution(b)));

  if (o.genel) {
    const g = o.genel;
    nodes.push(
      el(
        'section',
        { className: 'dash-section', 'aria-labelledby': 'company-title' },
        el('h2', { className: 'sec-title', id: 'company-title', text: 'Şirket geneli' }),
        el(
          'div',
          { className: 'kpis' },
          tile({ label: 'Onayda', value: g.onayda ?? 0, format: count, hint: 'Karar bekleyen masraflar', href: '#/tum-masraflar?durum=onayda', tone: 'wait' }),
          tile({ label: 'Ödeme bekleyen', value: g.odemeBekleyen ?? 0, format: count, hint: `Toplam ${money(g.odemeBekleyenTutar ?? 0)}`, href: '#/tum-masraflar?durum=onaylandi', tone: 'ok' }),
          tile({ label: 'Bu ay onaylanan', value: g.buAyOnaylanan ?? 0, format: money, hint: 'Yerel para birimiyle' }),
        ),
      ),
    );
  }
  return nodes;
}

export const dashboardView = {
  mount(root, { signal }) {
    const user = session.currentUser();
    const first = (user?.adSoyad ?? '').trim().split(/\s+/)[0];
    const content = el('div', { className: 'dash' }, el('div', { className: 'skeleton-tiles', role: 'status', 'aria-label': 'Yükleniyor' }, el('span'), el('span'), el('span'), el('span')));
    root.append(
      el(
        'div',
        { className: 'page' },
        pageHead({
          title: first ? `Merhaba, ${first}` : 'Gösterge',
          sub: fmtToday(),
          actions: [btn('Fatura okut', { href: '#/okuma', icon: ICONS.scan }), btn('Yeni masraf', { href: '#/masraflar/yeni', kind: 'primary', icon: ICONS.plus })],
        }),
        content,
      ),
    );

    async function load() {
      const r = await api.summary({ signal });
      if (signal.aborted) return;
      if (!r.ok) {
        if (!r.unauthorized) content.replaceChildren(loadFailed(r, load));
        return;
      }
      session.setBaseCurrency(r.body.paraBirimi);
      if (typeof r.body.bekleyenOnay === 'number') session.setPending(r.body.bekleyenOnay);
      content.replaceChildren(...render(r.body));
    }
    load();
  },
};
