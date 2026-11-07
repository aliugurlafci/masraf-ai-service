// E-posta (yonetici): a test mail and the outbox (GET /api/eposta, newest first). The default list
// is the failed mails, each with "Yeniden dene" (POST /api/eposta/:id/yeniden). Mail bodies and
// attachments never come back from the API.

import * as api from '../api.js';
import { el, ICONS } from '../dom.js';
import { fmtCount, fmtDateTime, fmtRelative } from '../format.js';
import { MAIL_STATUS, statusBadge } from '../labels.js';
import { btn, emptyState, field, input, loadFailed, pageHead, select, setBusy, setFieldError, showError, skeletonList, toast } from '../ui.js';

const FILTERS = [
  { value: 'hata', label: 'Hatalı' },
  { value: 'bekliyor', label: 'Bekleyen' },
  { value: 'atlandi', label: 'Atlanan' },
  { value: 'gonderildi', label: 'Gönderilen' },
  { value: '', label: 'Tümü' },
];
const LIMIT = 50;

export const emailView = {
  mount(root, { signal }) {
    let status = 'hata';
    let token = 0;
    let alive = true;

    const to = input({ name: 'alici', type: 'email', autocomplete: 'off', placeholder: 'Boşsa kendi adresiniz' });
    const testBtn = btn('Test maili gönder', { icon: ICONS.send, type: 'submit', kind: 'primary' });
    const testForm = el('form', { className: 'mail-test', novalidate: true }, field({ label: 'Alıcı', input: to, hint: 'Sunucunun mail ayarlarının çalıştığını denemek için.', optional: true }), el('div', { className: 'form-buttons' }, testBtn));
    const testResult = el('div', { 'aria-live': 'polite' });
    const filter = select(FILTERS.map((f) => ({ value: f.value, label: f.label })), { name: 'durum', 'aria-label': 'Duruma göre süz' });
    filter.value = status;
    const refreshBtn = btn('Yenile', { icon: ICONS.refresh, size: 'sm', onClick: () => load() });
    const list = el('div', { className: 'mail-list' });

    root.append(
      el(
        'div',
        { className: 'page' },
        pageHead({ title: 'E-posta', sub: 'Bildirim postalarının giden kutusu.' }),
        el('div', { className: 'mail-grid' },
          el('section', { className: 'card', 'aria-labelledby': 'mail-test-h' }, el('h2', { className: 'card-title', id: 'mail-test-h', text: 'Test maili' }), testForm, testResult),
          el('section', { className: 'card', 'aria-labelledby': 'mail-list-h' },
            el('div', { className: 'card-head' }, el('h2', { className: 'card-title', id: 'mail-list-h', text: 'Giden kutusu' }), el('div', { className: 'mail-tools' }, el('label', { className: 'visually-hidden', for: 'mail-filter', text: 'Durum' }), filter, refreshBtn)),
            list,
          ),
        ),
      ),
    );
    filter.id = 'mail-filter';

    testForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      setFieldError(to, null);
      testResult.replaceChildren();
      const alici = to.value.trim();
      if (alici && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(alici)) {
        setFieldError(to, 'Geçerli bir e-posta adresi girin.');
        to.focus();
        return;
      }
      setBusy(testBtn, true);
      const r = await api.sendTestMail(alici);
      setBusy(testBtn, false);
      if (!alive) return;
      if (!r.ok) {
        if (r.unauthorized) return;
        if (r.error.alanlar?.alici) setFieldError(to, r.error.alanlar.alici);
        // 409 mail_kapali: MAIL_GONDERIM=kapali, nothing is sent.
        else testResult.replaceChildren(el('p', { className: 'form-msg err', role: 'alert' }, r.error.mesaj));
        return;
      }
      toast('Test maili kuyruğa alındı.', 'ok');
      testResult.replaceChildren(el('p', { className: 'form-msg ok', text: 'Test maili kuyruğa alındı. Birkaç saniye içinde giden kutusunda görünür.' }));
      if (status === '') load();
    });
    filter.addEventListener('change', () => {
      status = filter.value;
      load();
    });

    async function load() {
      const my = ++token;
      if (!list.firstChild) list.append(skeletonList(3));
      const r = await api.listMails({ durum: status || undefined, adet: LIMIT }, { signal });
      if (!alive || my !== token) return;
      if (!r.ok) {
        if (!r.unauthorized && !r.aborted) list.replaceChildren(loadFailed(r, load));
        return;
      }
      render(Array.isArray(r.body) ? r.body : []);
    }

    function render(rows) {
      if (rows.length === 0) {
        list.replaceChildren(
          emptyState({
            icon: ICONS.mail,
            title: status === 'hata' ? 'Hatalı mail yok' : 'Mail yok',
            text: status === 'hata' ? 'Gönderilemeyen bir posta bulunmuyor.' : 'Bu durumda bir posta bulunmuyor.',
          }),
        );
        return;
      }
      const head = el('tr', {}, ...['Alıcı', 'Konu', 'Durum', 'Deneme', 'Zaman', 'İşlem'].map((h) => el('th', { scope: 'col', className: h === 'Deneme' ? 'num' : null, text: h })));
      const body = rows.map((m) => {
        const retry = m.durum === 'hata' ? btn('Yeniden dene', { icon: ICONS.refresh, size: 'sm', onClick: (e) => retry_(m, e.currentTarget), attrs: { 'aria-label': `Yeniden dene: ${m.konu}` } }) : null;
        return el(
          'tr',
          {},
          el('td', { 'data-label': 'Alıcı', text: m.alici }),
          el('td', { 'data-label': 'Konu' }, el('span', { text: m.konu }), m.sonHata ? el('span', { className: 'mail-err', text: m.sonHata }) : null),
          el('td', { 'data-label': 'Durum' }, statusBadge(m.durum, { map: MAIL_STATUS, className: 'sm' })),
          el('td', { className: 'num', 'data-label': 'Deneme', text: fmtCount(m.deneme ?? 0) }),
          el('td', { 'data-label': 'Zaman' }, el('time', { datetime: m.gonderim ?? m.olusturma, title: fmtDateTime(m.gonderim ?? m.olusturma), text: fmtRelative(m.gonderim ?? m.olusturma) ?? '' })),
          el('td', { className: 'act' }, retry),
        );
      });
      list.replaceChildren(
        el('div', { className: 'table-scroll' }, el('table', { className: 'data-table mail-table' }, el('caption', { className: 'visually-hidden', text: 'Giden kutusu' }), el('thead', {}, head), el('tbody', {}, ...body))),
        rows.length >= LIMIT ? el('p', { className: 'muted small mail-note', text: `En yeni ${LIMIT} posta gösteriliyor.` }) : null,
      );
    }

    async function retry_(m, button) {
      setBusy(button, true);
      const r = await api.retryMail(m.id);
      if (!alive) return;
      if (!r.ok) {
        setBusy(button, false);
        showError(r);
        if (r.error?.durum === 409 || r.error?.durum === 404) load();
        return;
      }
      toast('Posta yeniden denenmek üzere kuyruğa alındı.', 'ok');
      load();
    }

    load();
    return {
      unmount() {
        alive = false;
      },
    };
  },
};
