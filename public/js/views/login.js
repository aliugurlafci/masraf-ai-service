// Sign-in (POST /api/oturum with istemci: "panel"; the server sets the HttpOnly cookie) and the
// password change form, used both for the forced change after a reset and on the profile page.

import * as api from '../api.js';
import { el, icon, ICONS, reducedMotion, replay } from '../dom.js';
import { alertBox, applyFieldErrors, clearFieldErrors, field, input, setBusy, setFieldError } from '../ui.js';

function brand() {
  return el(
    'div',
    { className: 'auth-brand' },
    el('span', { className: 'brand-mark', 'aria-hidden': 'true' }, el('span', { className: 'brand-scan' })),
    el('span', { className: 'brand-name', text: 'Masraf' }),
  );
}

/** A password box with a show/hide toggle; returns { field, input }. */
export function passwordField(label, props = {}, hint = null) {
  const box = input({ type: 'password', spellcheck: 'false', autocapitalize: 'off', ...props });
  const f = field({ label, input: box, hint });
  const toggle = el('button', { className: 'pw-toggle', type: 'button', 'aria-label': 'Şifreyi göster', 'aria-pressed': 'false' }, icon(ICONS.eye));
  toggle.addEventListener('click', () => {
    const show = box.type === 'password';
    box.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(show));
    toggle.setAttribute('aria-label', show ? 'Şifreyi gizle' : 'Şifreyi göster');
    toggle.replaceChildren(icon(show ? ICONS.eyeOff : ICONS.eye));
  });
  const wrap = el('div', { className: 'pw-wrap' });
  box.replaceWith(wrap);
  wrap.append(box, toggle);
  box.addEventListener('input', () => setFieldError(box, null));
  return { field: f, input: box };
}

function steps() {
  const step = (d, title, text) =>
    el('li', {}, el('span', { className: 'auth-step-icon', 'aria-hidden': 'true' }, icon(d)), el('div', {}, el('p', { className: 'auth-step-title', text: title }), el('p', { text })));
  return el(
    'ol',
    { className: 'auth-steps' },
    step(ICONS.scan, 'Faturayı okutun', 'PDF ya da fotoğraf; tutar, tarih ve satıcı kendiliğinden dolar.'),
    step(ICONS.send, 'Onaya gönderin', 'Masraf, tutarına göre doğru onaycılara sırayla gider.'),
    step(ICONS.checkCircle, 'Süreci izleyin', 'Kim onayladı, ne zaman ödendi; hepsi tek ekranda.'),
  );
}

/** notice: { kind: 'info'|'ok', text } shown above the form (session ended, signed out). */
export function renderLogin(container, { notice = null, onSuccess }) {
  const email = input({ type: 'email', name: 'eposta', autocomplete: 'username', inputmode: 'email', spellcheck: 'false', autocapitalize: 'off', required: true });
  const pw = passwordField('Şifre', { name: 'sifre', autocomplete: 'current-password', required: true });
  const errorSlot = el('div', { className: 'form-alert' });
  const submit = el('button', { className: 'btn btn-primary btn-block btn-lg', type: 'submit' }, el('span', { text: 'Giriş yap' }));
  email.addEventListener('input', () => setFieldError(email, null));

  const card = el(
    'div',
    { className: 'auth-card' },
    brand(),
    el('h1', { tabindex: '-1', text: 'Giriş yapın' }),
    el('p', { className: 'auth-sub', text: 'Masraflarınızı göndermek ve onaylarınızı yönetmek için şirket hesabınızla giriş yapın.' }),
    notice ? alertBox(notice.kind === 'ok' ? 'ok' : 'info', null, [notice.text]) : null,
    errorSlot,
  );
  const form = el('form', { className: 'auth-form', novalidate: true }, field({ label: 'E-posta', input: email }), pw.field, submit);
  card.append(form);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFieldErrors(form);
    errorSlot.replaceChildren();
    const eposta = email.value.trim();
    const sifre = pw.input.value;
    let invalid = false;
    if (!eposta || !eposta.includes('@')) {
      setFieldError(email, 'Geçerli bir e-posta adresi girin.');
      invalid = true;
    }
    if (!sifre) {
      setFieldError(pw.input, 'Şifrenizi girin.');
      invalid = true;
    }
    if (invalid) {
      (email.getAttribute('aria-invalid') ? email : pw.input).focus();
      return;
    }
    setBusy(submit, true);
    const r = await api.login(eposta, sifre);
    setBusy(submit, false);
    if (r.ok && r.body?.kullanici) {
      onSuccess(r.body.kullanici);
      return;
    }
    if (r.ok) {
      errorSlot.replaceChildren(alertBox('err', null, ['Sunucunun yanıtı anlaşılamadı.']));
      return;
    }
    const leftovers = r.error.alanlar ? applyFieldErrors(r.error.alanlar, { eposta: email, sifre: pw.input }) : [r.error.mesaj];
    if (leftovers.length > 0) errorSlot.replaceChildren(alertBox('err', null, leftovers));
    if (!reducedMotion.matches) replay(card, 'shake');
    if (r.error.kod === 'hatali_giris') {
      pw.input.select();
      pw.input.focus();
    }
  });

  container.replaceChildren(el('div', { className: 'auth-split' }, el('div', { className: 'auth-center' }, card), el('aside', { className: 'auth-side', 'aria-label': 'Masraf paneli' }, el('div', { className: 'auth-side-inner' }, el('p', { className: 'auth-side-title', text: 'Faturadan onaya, tek akış.' }), steps()))));
  (email.value ? pw.input : email).focus();
}

/**
 * The password change form (PUT /api/ben/sifre). onDone runs after a 204. `forced` words it for
 * the first sign-in after an administrator set the password.
 */
export function passwordForm({ onDone, forced = false, submitLabel = 'Şifreyi değiştir', extraActions = [] }) {
  const current = passwordField(forced ? 'Geçici şifre' : 'Mevcut şifre', { name: 'mevcutSifre', autocomplete: 'current-password', required: true });
  const next = passwordField('Yeni şifre', { name: 'yeniSifre', autocomplete: 'new-password', required: true });
  const again = passwordField('Yeni şifre (tekrar)', { name: 'yeniSifreTekrar', autocomplete: 'new-password', required: true });
  const errorSlot = el('div', { className: 'form-alert' });
  const submit = el('button', { className: 'btn btn-primary', type: 'submit' }, el('span', { text: submitLabel }));
  const form = el('form', { className: 'pw-form', novalidate: true }, errorSlot, current.field, next.field, again.field, el('div', { className: 'form-buttons' }, submit, ...extraActions));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFieldErrors(form);
    errorSlot.replaceChildren();
    const mevcut = current.input.value;
    const yeni = next.input.value;
    let first = null;
    const fail = (target, message) => {
      setFieldError(target, message);
      first ??= target;
    };
    if (!mevcut) fail(current.input, forced ? 'Size verilen geçici şifreyi girin.' : 'Mevcut şifrenizi girin.');
    if (!yeni) fail(next.input, 'Yeni şifreyi girin.');
    else if (yeni === mevcut) fail(next.input, 'Yeni şifre mevcut şifreyle aynı olamaz.');
    if (yeni && again.input.value !== yeni) fail(again.input, 'Şifreler birbirini tutmuyor.');
    if (first) {
      first.focus();
      return;
    }
    setBusy(submit, true);
    const r = await api.changeMyPassword(mevcut, yeni);
    setBusy(submit, false);
    if (r.ok) {
      form.reset();
      onDone();
      return;
    }
    if (r.unauthorized) return;
    if (r.error.kod === 'hatali_sifre') {
      setFieldError(current.input, r.error.mesaj);
      current.input.focus();
      return;
    }
    const leftovers = r.error.alanlar ? applyFieldErrors(r.error.alanlar, { mevcutSifre: current.input, yeniSifre: next.input }) : [r.error.mesaj];
    if (leftovers.length > 0) errorSlot.replaceChildren(alertBox('err', null, leftovers));
  });
  return { form, focus: () => current.input.focus() };
}

/** The forced change after an administrator created the account or reset its password. */
export function renderPasswordChange(container, { user, onDone, onLogout }) {
  const logoutBtn = el('button', { className: 'btn btn-ghost', type: 'button', text: 'Çıkış yap', onClick: onLogout });
  const pf = passwordForm({ onDone, forced: true, submitLabel: 'Şifremi belirle', extraActions: [logoutBtn] });
  const card = el(
    'div',
    { className: 'auth-card' },
    brand(),
    el('h1', { tabindex: '-1', text: 'Yeni şifrenizi belirleyin' }),
    el('p', {
      className: 'auth-sub',
      text: `${user?.adSoyad ? `${user.adSoyad}, h` : 'H'}esabınız için geçici bir şifre tanımlandı. Devam etmeden önce yalnızca sizin bildiğiniz bir şifre belirleyin. Şifre değişince diğer cihazlardaki oturumlarınız kapanır.`,
    }),
    pf.form,
  );
  container.replaceChildren(el('div', { className: 'auth-center solo' }, card));
  pf.focus();
}
