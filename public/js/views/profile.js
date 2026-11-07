// Profil: the signed-in user's account (from GET /api/ben): the flow their expenses go to and the
// flows they approve in, and the password change form.
// #/profil?bolum=sifre opens with the focus on the password form (user menu "Şifre değiştir").

import * as api from '../api.js';
import { el, ICONS, reducedMotion } from '../dom.js';
import { fmtCurrency, fmtDateTime, fmtRelative } from '../format.js';
import { bandPhrase, ROLE_HINTS, roleLabel, STRATEGY_LABEL } from '../labels.js';
import * as session from '../session.js';
import { avatar, btn, pageHead, showError, toast } from '../ui.js';
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

/** One flow the user approves in: their place, the amounts that reach them and their limit. */
function approverLine(o, cur) {
  const strategy = STRATEGY_LABEL[o.akis.strateji];
  const where = `“${o.akis.ad}” akışında ${o.sira}. onaycısınız${strategy ? ` (${strategy.toLocaleLowerCase('tr-TR')})` : ''}.`;
  const reach = bandPhrase(o.altLimit, o.ustLimit, cur);
  const comes = `${reach.charAt(0).toLocaleUpperCase('tr-TR')}${reach.slice(1)} masraflar size gelir.`;
  let limit;
  if (o.limit === null || o.limit === undefined) limit = 'Son onaycısınız; limitiniz yok.';
  else if (o.akis.strateji === 'zincir') limit = `Onay limitiniz ${fmtCurrency(o.limit, cur)}; daha büyük tutarlar sizin onayınızdan sonra bir üst onaycıya geçer.`;
  else limit = `Onay limitiniz ${fmtCurrency(o.limit, cur)}.`;
  return `${where} ${comes} ${limit}`;
}

/** The flows the user approves in. */
function approverIn(u, cur) {
  const list = u.onaycilik ?? [];
  if (list.length === 0) return 'Hiçbir onay akışında onaycı değilsiniz.';
  return el('ul', { className: 'kv-list' }, ...list.map((o) => el('li', { text: approverLine(o, cur) })));
}

export const profileView = {
  mount(root, { route, signal }) {
    const info = el('div');
    const pf = passwordForm({ onDone: () => toast('Şifreniz değiştirildi. Diğer cihazlardaki oturumlarınız kapatıldı.', 'ok') });
    const pwCard = el(
      'section',
      { className: 'card', id: 'sifre', 'aria-labelledby': 'pw-h' },
      el('h2', { className: 'card-title', id: 'pw-h', text: 'Şifre değiştir' }),
      el('p', { className: 'card-sub', text: 'Şifreniz değişince bu cihaz dışındaki oturumlarınız kapanır.' }),
      pf.form,
    );

    // E-mail copies of notifications: the only notification preference (in-app ones always arrive).
    const mailSwitch = el(
      'button',
      { className: 'switch', type: 'button', role: 'switch', id: 'mail-switch', 'aria-checked': 'false', 'aria-labelledby': 'mail-switch-l', 'aria-describedby': 'mail-switch-d' },
      el('span', { className: 'switch-knob', 'aria-hidden': 'true' }),
    );
    const mailMsg = el('p', { className: 'form-msg', role: 'status' });
    const prefCard = el(
      'section',
      { className: 'card', 'aria-labelledby': 'pref-h' },
      el('h2', { className: 'card-title', id: 'pref-h', text: 'Bildirimler' }),
      el(
        'div',
        { className: 'pref-row' },
        el('div', {}, el('p', { className: 'pref-label', id: 'mail-switch-l', text: 'Bildirimleri e-posta ile de al' }), el('p', { className: 'muted small', id: 'mail-switch-d', text: 'Uygulama içi bildirimler her zaman gelir; bu ayar yalnızca e-posta kopyasını açar ya da kapatır.' })),
        mailSwitch,
      ),
      mailMsg,
    );
    mailSwitch.addEventListener('click', async () => {
      const next = mailSwitch.getAttribute('aria-checked') !== 'true';
      mailSwitch.setAttribute('aria-busy', 'true');
      mailSwitch.disabled = true;
      mailMsg.textContent = '';
      const r = await api.updatePreferences({ mailBildirim: next });
      mailSwitch.removeAttribute('aria-busy');
      mailSwitch.disabled = false;
      if (!r.ok) {
        showError(r);
        if (!r.unauthorized && !r.aborted) mailMsg.textContent = r.error.mesaj;
        return;
      }
      session.setSession(r.body);
      toast(next ? 'Bildirimler e-posta ile de gelecek.' : 'E-posta bildirimleri kapatıldı.', 'ok');
    });

    root.append(el('div', { className: 'page narrow' }, pageHead({ title: 'Profil', sub: 'Hesap bilgileriniz, bildirim tercihiniz ve şifreniz.' }), el('div', { className: 'profile-grid' }, info, el('div', { className: 'profile-side' }, prefCard, pwCard))));

    function renderInfo() {
      const u = session.currentUser();
      if (!u) return;
      if (!mailSwitch.hasAttribute('aria-busy')) mailSwitch.setAttribute('aria-checked', String(u.mailBildirim !== false));
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
