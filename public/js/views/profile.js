// Profil: the signed-in user's account (from GET /api/ben): the flow their expenses go to and the
// flows they approve in, and the password change form.
// #/profil?bolum=sifre opens with the focus on the password form (user menu "Şifre değiştir").

import { el, ICONS, reducedMotion } from '../dom.js';
import { fmtDateTime, fmtRelative } from '../format.js';
import { rangeText, ROLE_HINTS, roleLabel } from '../labels.js';
import * as session from '../session.js';
import { avatar, btn, pageHead, toast } from '../ui.js';
import { passwordForm } from './login.js';

function kv(label, value, className = null) {
  if (value === null || value === undefined || value === '') return null;
  return el('div', { className }, el('dt', { text: label }), typeof value === 'string' ? el('dd', { text: value }) : el('dd', {}, value));
}

/** The flow the user's own expenses go to; "varsayılan" when no flow is assigned to them. */
function ownFlow(u) {
  if (!u.onayAkisi) return null;
  return el(
    'span',
    {},
    el('span', { text: u.onayAkisi.ad }),
    u.onayAkisiId === null ? el('span', { className: 'muted small block', text: 'Size bir akış atanmadığı için varsayılan akış kullanılır.' }) : null,
  );
}

/** The flows the user approves in, each with the order and the amount range. */
function approverIn(u, cur) {
  const list = u.onaycilik ?? [];
  if (list.length === 0) return 'Hiçbir onay akışında onaycı değilsiniz.';
  return el(
    'ul',
    { className: 'kv-list' },
    ...list.map((o) => el('li', { text: `“${o.akis.ad}” akışında ${o.sira}. sıradasınız; ${rangeText(o.altLimit, o.ustLimit, cur)} tutarındaki masraflar size gelir.` })),
  );
}

export const profileView = {
  mount(root, { route, signal }) {
    const info = el('div');
    const pf = passwordForm({ onDone: () => toast('Şifreniz değiştirildi. Diğer cihazlardaki oturumlarınız kapatıldı.', 'ok') });
    const pwCard = el(
      'section',
      { className: 'card', id: 'sifre', 'aria-labelledby': 'pw-h' },
      el('h2', { className: 'card-title', id: 'pw-h', text: 'Şifre değiştir' }),
      el('p', { className: 'muted small', text: 'Şifreniz değişince bu cihaz dışındaki oturumlarınız kapanır.' }),
      pf.form,
    );

    root.append(el('div', { className: 'page narrow' }, pageHead({ title: 'Profil', sub: 'Hesap bilgileriniz ve şifreniz.' }), el('div', { className: 'profile-grid' }, info, pwCard)));

    function renderInfo() {
      const u = session.currentUser();
      if (!u) return;
      info.replaceChildren(
        el(
          'section',
          { className: 'card profile-card', 'aria-labelledby': 'me-h' },
          el(
            'div',
            { className: 'profile-head' },
            avatar(u.adSoyad, 'large'),
            el('div', {}, el('h2', { className: 'card-title', id: 'me-h', text: u.adSoyad }), el('p', { className: 'muted', text: u.eposta })),
          ),
          el(
            'dl',
            { className: 'kv' },
            kv('Rol', el('span', {}, el('span', { className: `role-badge ${u.rol}`, text: roleLabel(u.rol) }), el('span', { className: 'muted small block', text: ROLE_HINTS[u.rol] ?? '' }))),
            kv('Departman', u.departman || '—'),
            kv('Masraflarınızın onay akışı', ownFlow(u)),
            kv('Onaycı olduğunuz akışlar', approverIn(u, session.knownBaseCurrency() ?? ''), 'kv-wide'),
            kv('Son giriş', u.sonGiris ? `${fmtDateTime(u.sonGiris)} (${fmtRelative(u.sonGiris)})` : null),
            kv('Hesap açılışı', fmtDateTime(u.olusturma)),
          ),
          u.onaycilik?.length ? el('div', { className: 'card-foot' }, btn('Onaylarım', { href: '#/onaylar', icon: ICONS.inbox, size: 'sm' })) : null,
        ),
      );
    }

    renderInfo();
    const off = session.onSessionChange(renderInfo);
    session.loadBaseCurrency().then(renderInfo);
    // The flows (assignment, approver places) may have changed since sign-in: ask once more.
    session.refreshMe({ signal });

    function applyQuery(r) {
      if (r.query.get('bolum') === 'sifre') {
        requestAnimationFrame(() => {
          pwCard.scrollIntoView({ block: 'start', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
          pf.focus();
        });
      }
    }
    applyQuery(route);

    return {
      update(next) {
        applyQuery(next);
        return true;
      },
      unmount() {
        off();
      },
    };
  },
};
