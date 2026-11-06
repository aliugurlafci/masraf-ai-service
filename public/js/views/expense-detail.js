// Masraf detayı (GET /api/masraflar/:id): fields, the invoices and their files, the approval steps
// of the latest round, the history, and the actions this user may take. Buttons come only from the
// server's `izinler`; the panel never works out the rules itself.

import * as api from '../api.js';
import { el, icon, ICONS } from '../dom.js';
import { fmtCurrency, fmtDateLong, fmtDateTime, fmtRateInput, fmtRelative } from '../format.js';
import { invoicesTotal } from '../equivalents.js';
import { approveDialog, approverChain, chainLead, invoicePreview, rejectDialog } from '../expense-ui.js';
import { bandText, categoryIcon, HISTORY_LABEL, HISTORY_TONE, humanize, STEP_STATUS, statusBadge } from '../labels.js';
import * as session from '../session.js';
import { actionDialog, alertBox, btn, field, loadFailed, openDialog, pageHead, select, setPageTitle, setFieldError, toast } from '../ui.js';

const UNDECIDED = new Set(['sirada', 'bekliyor']);

function backFor(d) {
  const me = session.currentUser();
  if (d && me && d.olusturan?.id === me.id) return { href: '#/masraflar', label: 'Masraflarım' };
  if (session.isFinance()) return { href: '#/tum-masraflar', label: 'Tüm masraflar' };
  return { href: '#/onaylar', label: 'Onaylarım' };
}

/** `odeme` and `sonuclanma` are described only as nullable; show a time, or a {tarih, kullanici} pair. */
function eventText(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return fmtDateTime(v) ?? v;
  if (typeof v === 'object') {
    const when = v.tarih ? fmtDateTime(v.tarih) : null;
    const who = v.kullanici?.adSoyad ?? null;
    return [when, who].filter(Boolean).join(' · ') || null;
  }
  return String(v);
}

function kv(label, value, { wide = false } = {}) {
  if (value === null || value === undefined || value === '') return null;
  return el('div', { className: wide ? 'kv-wide' : null }, el('dt', { text: label }), typeof value === 'string' ? el('dd', { text: value }) : el('dd', {}, value));
}

const invoicesOf = (d) => (Array.isArray(d?.faturalar) ? d.faturalar : []);

const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Invoices in a third currency whose base-currency equivalent was not entered (sending is refused). */
const missingEquivalents = (d) => invoicesOf(d).filter((f) => f.karsilikGerekli && !positive(f.yerelKarsilik));

/** The entered equivalents ({ faturaId: amount }); the server keeps only those the form needs. */
function equivalentsOf(d) {
  const out = {};
  for (const f of invoicesOf(d)) if (positive(f.yerelKarsilik)) out[f.id] = f.yerelKarsilik;
  return out;
}

/** Who the saved form would go to if sent now (POST /api/onay-akisi/onizle). */
function previewBody(d) {
  const body = { tutar: d.tutar, paraBirimi: d.paraBirimi };
  if (d.kur !== null && d.kur !== undefined) body.kur = d.kur;
  const ids = Array.isArray(d.faturaIdler) ? d.faturaIdler : invoicesOf(d).map((f) => f.id);
  if (ids.length > 0) body.faturaIdler = ids;
  const eq = equivalentsOf(d);
  if (Object.keys(eq).length > 0) body.yerelKarsiliklar = eq;
  return body;
}

/** The invoices' total in the form's currency (equivalents.js), as tutarFarki.fatura counts it. */
const invoiceTotalOf = (d, base) =>
  invoicesTotal(
    invoicesOf(d).map((f) => ({ fatura: f, equivalent: f.karsilikGerekli ? f.yerelKarsilik : null })),
    d.paraBirimi ?? base,
    base,
    d.kur,
  );

/**
 * Under an invoice: its entered base-currency equivalent, or why it does not add to the amount, or
 * that it adds converted (a base-currency receipt on a foreign-currency form).
 */
function invoiceNote(f, d, base) {
  const cur = d.paraBirimi ?? base;
  const note = (glyph, text) => el('p', { className: 'inv-card-note' }, icon(glyph), el('span', { text }));
  if (f.karsilikGerekli) {
    if (positive(f.yerelKarsilik)) return el('p', { className: 'inv-eq-line' }, el('span', { text: `${base} karşılığı: ` }), el('strong', { text: fmtCurrency(f.yerelKarsilik, base) }));
    return note(
      ICONS.warn,
      d.izinler?.duzenle
        ? `Fatura ${f.paraBirimi} cinsinden ve ${base} karşılığı girilmedi. Onaya göndermeden önce masrafı düzenleyip girin.`
        : `Fatura ${f.paraBirimi} cinsinden ve ${base} karşılığı girilmedi; onay tutarına katılmaz.`,
    );
  }
  if (!positive(f.genelToplam)) return note(ICONS.info, 'Genel toplam okunamadı; onay tutarına katılmaz.');
  if (f.paraBirimi === base && cur !== base) return note(ICONS.info, `Fatura ${base} cinsinden; toplama kurla ${cur} karşılığı olarak katılır.`);
  return null;
}

export const expenseDetailView = {
  mount(root, { route, signal }) {
    const id = route.params.id;
    const page = el('div', { className: 'page' });
    root.append(page);
    let base = session.knownBaseCurrency() ?? 'TRY';
    let detail = null;

    page.append(pageHead({ title: `Masraf #${id}`, back: backFor(null) }), el('div', { className: 'skeleton-detail', role: 'status', 'aria-label': 'Yükleniyor' }, el('span'), el('span'), el('span')));

    async function load() {
      const [r, b] = await Promise.all([api.getExpense(id, { signal }), session.loadBaseCurrency()]);
      if (signal.aborted) return;
      base = b;
      if (!r.ok) {
        if (r.unauthorized) return;
        const hadFocus = page.contains(document.activeElement);
        page.replaceChildren(pageHead({ title: `Masraf #${id}`, back: backFor(null) }), loadFailed(r, r.error.durum === 404 || r.error.durum === 403 ? null : load));
        if (hadFocus) page.querySelector('h1')?.focus();
        return;
      }
      render(r.body);
    }

    // ---------- Actions ----------

    function after(r, message) {
      if (!r) return;
      if (r.body) render(r.body);
      toast(message, 'ok');
      session.refreshMe();
    }

    async function doSend(d) {
      const chainSlot = el('div', { className: 'chain-slot', 'aria-live': 'polite' }, el('p', { className: 'muted', text: 'Onaycılar hesaplanıyor…' }));
      api.previewFlow(previewBody(d)).then((p) => {
        if (!chainSlot.isConnected) return;
        if (p.ok) chainSlot.replaceChildren(el('p', { className: 'dlg-text', text: chainLead(p.body, 'masraf şu onaycılara sırayla gidecek:') }), approverChain(p.body));
        else if (!p.unauthorized) chainSlot.replaceChildren(el('p', { className: 'muted', text: p.error.mesaj }));
      });
      const missing = missingEquivalents(d).length;
      const r = await actionDialog({
        title: 'Onaya gönder',
        message: d.tur >= 1 && d.durum === 'reddedildi' ? 'Masraf yeni bir turla yeniden onaya gönderilecek.' : 'Gönderdikten sonra masrafı düzenleyemezsiniz; gerekirse geri çekebilirsiniz.',
        details: [missing > 0 ? alertBox('warn', null, [missingLead(missing)]) : null, chainSlot],
        confirmLabel: 'Onaya gönder',
        confirmIcon: ICONS.send,
        run: async () => {
          const res = await api.expenseAction(d.id, 'gonder');
          // 409 karsilik_eksik names every invoice without its equivalent in alanlar.
          if (!res.ok && res.error?.kod === 'karsilik_eksik') {
            const items = res.error.alanlar ? [...new Set(Object.values(res.error.alanlar).map(String))] : [res.error.mesaj];
            return { ...res, error: { ...res.error, mesaj: `Onaya gönderilemedi. Masrafı düzenleyip ${base} karşılığını girin.`, sorunlar: items } };
          }
          return res;
        },
      });
      after(r, 'Masraf onaya gönderildi.');
    }

    function missingLead(n) {
      return `${n === 1 ? 'Bir faturanın' : `${n} faturanın`} ${base} karşılığı girilmedi. Göndermeden önce düzenleyip ${base} karşılığını girin.`;
    }

    async function doSimple(d, action) {
      const defs = {
        'geri-cek': {
          title: 'Masrafı geri çek',
          message: 'Onay süreci durur ve masraf taslağa döner. Düzenleyip yeniden gönderebilirsiniz.',
          confirmLabel: 'Geri çek',
          confirmIcon: ICONS.undo,
          kind: 'primary',
          done: 'Masraf geri çekildi; şimdi taslak.',
        },
        iptal: {
          title: 'Masrafı iptal et',
          message: [
            'İptal edilen masraf geri alınamaz.',
            invoicesOf(d).length > 1 ? 'Bağlı faturalar başka bir masrafta kullanılabilir hale gelir.' : invoicesOf(d).length === 1 ? 'Bağlı fatura başka bir masrafta kullanılabilir hale gelir.' : null,
          ]
            .filter(Boolean)
            .join(' '),
          confirmLabel: 'İptal et',
          confirmIcon: ICONS.ban,
          kind: 'danger',
          done: 'Masraf iptal edildi.',
        },
        odendi: {
          title: 'Ödendi olarak işaretle',
          message: `${fmtCurrency(d.yerelTutar ?? d.tutar, d.yerelTutar !== null && d.yerelTutar !== undefined ? base : d.paraBirimi)} tutarındaki masraf ödendi olarak işaretlenecek.`,
          confirmLabel: 'Ödendi işaretle',
          confirmIcon: ICONS.cash,
          kind: 'primary',
          done: 'Masraf ödendi olarak işaretlendi.',
        },
      };
      const def = defs[action];
      const r = await actionDialog({ ...def, run: () => api.expenseAction(d.id, action) });
      if (r) after(r, def.done);
      else load(); // the state may have moved on (409); show the current one
    }

    async function doDecision(d, kind) {
      const result = kind === 'onayla' ? await approveDialog(d, base) : await rejectDialog(d, base);
      if (result && typeof result === 'object') {
        render(result);
        toast(kind === 'onayla' ? 'Masraf onaylandı.' : 'Masraf reddedildi.', 'ok');
        session.refreshMe();
      } else {
        load();
      }
    }

    async function doTransfer(d) {
      const steps = (d.onaylar ?? []).filter((s) => UNDECIDED.has(s.durum));
      if (steps.length === 0) {
        toast('Devredilecek, karar verilmemiş bir adım yok.', 'err');
        return;
      }
      const stepSelect = select(
        steps.map((s) => ({ value: s.id, label: `${s.sira}. adım · ${s.onayci?.adSoyad ?? 'Onaycı'}${s.durum === 'bekliyor' ? ' (karar bekliyor)' : ''}` })),
        { name: 'onayId' },
      );
      const userSelect = select([{ value: '', label: 'Kullanıcılar yükleniyor…' }], { name: 'yeniOnayciId', disabled: true });
      const users = await api.listUsers();
      if (!users.ok) {
        if (!users.unauthorized) toast(users.error.mesaj, 'err');
        return;
      }
      const active = users.body.filter((u) => u.aktif);
      const fill = () => {
        const step = steps.find((s) => String(s.id) === stepSelect.value);
        userSelect.replaceChildren(el('option', { value: '', text: 'Yeni onaycıyı seçin' }));
        for (const u of active) {
          if (u.id === step?.onayci?.id) continue;
          userSelect.append(el('option', { value: u.id, text: `${u.adSoyad}${u.departman ? ` · ${u.departman}` : ''}` }));
        }
        userSelect.disabled = false;
      };
      fill();
      stepSelect.addEventListener('change', fill);
      userSelect.addEventListener('change', () => setFieldError(userSelect, null));
      const result = await openDialog({
        title: 'Onayı devret',
        description: 'Karar verilmemiş bir adımın onaycısı değişir. Yeni onaycı masrafı Onaylarım listesinde görür.',
        body: [field({ label: 'Adım', input: stepSelect }), field({ label: 'Yeni onaycı', input: userSelect })],
        submitLabel: 'Devret',
        submitIcon: ICONS.transfer,
        onSubmit: async (ctl) => {
          if (!userSelect.value) {
            setFieldError(userSelect, 'Yeni onaycıyı seçin.');
            userSelect.focus();
            return false;
          }
          const r = await api.expenseAction(d.id, 'devret', { onayId: Number(stepSelect.value), yeniOnayciId: Number(userSelect.value) });
          if (r.ok) return r;
          if (r.unauthorized) return null;
          if (r.error.alanlar?.yeniOnayciId) setFieldError(userSelect, r.error.alanlar.yeniOnayciId);
          else ctl.setError(r.error.mesaj);
          return false;
        },
      }).done;
      if (result && result !== true) after(result, 'Onay devredildi.');
    }

    function actionBar(d) {
      const iz = d.izinler ?? {};
      const buttons = [
        iz.onayla ? btn('Onayla', { icon: ICONS.check, kind: 'ok', onClick: () => doDecision(d, 'onayla') }) : null,
        iz.reddet ? btn('Reddet', { icon: ICONS.close, kind: 'danger', onClick: () => doDecision(d, 'reddet') }) : null,
        iz.gonder ? btn('Onaya gönder', { icon: ICONS.send, kind: 'primary', onClick: () => doSend(d) }) : null,
        iz.odendi ? btn('Ödendi işaretle', { icon: ICONS.cash, kind: 'primary', onClick: () => doSimple(d, 'odendi') }) : null,
        iz.duzenle ? btn('Düzenle', { icon: ICONS.edit, href: `#/masraflar/${d.id}/duzenle` }) : null,
        iz.geriCek ? btn('Geri çek', { icon: ICONS.undo, onClick: () => doSimple(d, 'geri-cek') }) : null,
        iz.devret ? btn('Devret', { icon: ICONS.transfer, onClick: () => doTransfer(d) }) : null,
        iz.iptal ? btn('İptal et', { icon: ICONS.ban, kind: 'danger-ghost', onClick: () => doSimple(d, 'iptal') }) : null,
      ].filter(Boolean);
      if (buttons.length === 0) return null;
      let lead = null;
      const missing = iz.gonder ? missingEquivalents(d).length : 0;
      if (iz.onayla || iz.reddet) lead = 'Sıra sizde: bu masrafı inceleyip onaylayın ya da reddedin.';
      else if (iz.odendi) lead = 'Masraf onaylandı; ödeme yapıldığında işaretleyin.';
      else if (missing > 0) lead = d.durum === 'reddedildi' ? `Masraf reddedildi. ${missingLead(missing)}` : missingLead(missing);
      else if (iz.gonder && d.durum === 'reddedildi') lead = 'Masraf reddedildi. Düzenleyip yeniden gönderebilirsiniz.';
      else if (iz.gonder) lead = 'Masraf taslak. Hazır olduğunda onaya gönderin.';
      else if (iz.geriCek) {
        const waiting = (d.onaylar ?? []).find((s) => s.durum === 'bekliyor');
        lead = waiting?.onayci?.adSoyad
          ? `${waiting.onayci.adSoyad} kararını bekliyor. Geri çekerseniz masraf taslağa döner.`
          : 'Masraf onayda. Geri çekerseniz taslağa döner.';
      } else if (iz.devret) lead = 'Onaycı karar veremiyorsa onayı başka birine devredebilirsiniz.';
      return el('div', { className: `action-bar${iz.onayla ? ' is-turn' : ''}`, role: 'group', 'aria-label': 'İşlemler' }, lead ? el('p', { className: 'action-lead', text: lead }) : null, el('div', { className: 'action-buttons' }, ...buttons));
    }

    // ---------- Sections ----------

    function infoCard(d) {
      const foreign = d.paraBirimi && d.paraBirimi !== base;
      const onay = d.onayTutari !== null && d.onayTutari !== undefined && d.onayTutari !== d.yerelTutar ? fmtCurrency(d.onayTutari, base) : null;
      return el(
        'section',
        { className: 'card', 'aria-labelledby': 'info-title' },
        el('h2', { className: 'card-title', id: 'info-title', text: 'Bilgiler' }),
        el(
          'dl',
          { className: 'kv' },
          kv('Kategori', d.kategori ? el('span', { className: 'with-icon' }, categoryIcon(d.kategori.simge), el('span', { text: d.kategori.ad })) : 'Kategorisiz'),
          kv('Masraf tarihi', fmtDateLong(d.masrafTarihi)),
          kv('Tutar', fmtCurrency(d.tutar, d.paraBirimi)),
          foreign && d.kur !== null && d.kur !== undefined ? kv('Kur', `1 ${d.paraBirimi} = ${fmtRateInput(d.kur)} ${base}`) : null,
          foreign ? kv('Yerel tutar', fmtCurrency(d.yerelTutar, base)) : null,
          onay ? kv('Onay tutarı', onay) : null,
          kv('Satıcı', d.satici),
          kv('Oluşturan', d.olusturan?.adSoyad),
          kv('Oluşturma', fmtDateTime(d.olusturma)),
          kv('Gönderim', fmtDateTime(d.gonderim)),
          kv('Sonuçlanma', eventText(d.sonuclanma)),
          kv('Ödeme', eventText(d.odeme)),
          d.tur > 1 ? kv('Onay turu', `${d.tur}. tur`) : null,
          kv('Açıklama', d.aciklama, { wide: true }),
        ),
      );
    }

    function invoiceFacts(f, compact) {
      return el(
        'dl',
        { className: compact ? 'kv compact' : 'kv' },
        kv('Fatura no', f.faturaNo ?? 'Okunamadı'),
        kv('Fatura tarihi', fmtDateLong(f.faturaTarihi)),
        kv('Satıcı', f.saticiUnvan),
        kv('Genel toplam', fmtCurrency(f.genelToplam, f.paraBirimi)),
      );
    }

    const filePreview = (f) => invoicePreview({ url: api.invoiceFileUrl(f.id), mime: f.mime, name: f.dosyaAdi });

    /** In a list the file loads only when its preview is opened. */
    function lazyPreview(f, name) {
      const slot = el('div', { className: 'inv-preview-body' });
      const details = el('details', { className: 'inv-preview' }, el('summary', {}, icon(ICONS.chevronDown), el('span', { text: 'Önizleme' }), el('span', { className: 'visually-hidden', text: `: ${name}` })), slot);
      details.addEventListener('toggle', () => {
        if (details.open && !slot.firstChild) slot.append(filePreview(f));
      });
      return details;
    }

    /** The invoices' total in the form's currency: equivalents and base-currency invoices converted by the rate. */
    function invoiceSum(d, list) {
      const total = invoiceTotalOf(d, base);
      const left = list.length - total.count;
      return el(
        'div',
        { className: 'inv-sum' },
        el(
          'p',
          { className: 'inv-sum-line' },
          el('span', { text: total.count > 0 ? `Faturaların toplamı · ${total.count} fatura` : 'Toplanacak fatura yok' }),
          el('strong', { text: total.count > 0 ? fmtCurrency(total.value, d.paraBirimi) : '—' }),
        ),
        left > 0 ? el('p', { className: 'inv-sum-note', text: `${left} fatura onay tutarına katılmıyor; nedeni altında yazıyor.` }) : null,
      );
    }

    function invoiceCard(d) {
      const list = invoicesOf(d);
      const title = el('h2', { className: 'card-title', id: 'inv-title', text: list.length > 1 ? 'Faturalar' : 'Fatura' });
      if (list.length === 0) {
        return el(
          'section',
          { className: 'card', 'aria-labelledby': 'inv-title' },
          title,
          el('p', { className: 'muted', text: 'Bu masrafa fatura eklenmemiş.' }),
          d.izinler?.duzenle ? btn('Fatura ekle', { icon: ICONS.upload, href: `#/masraflar/${d.id}/duzenle` }) : null,
        );
      }
      if (list.length === 1) {
        const f = list[0];
        return el(
          'section',
          { className: 'card', 'aria-labelledby': 'inv-title' },
          el('div', { className: 'card-head' }, title, el('a', { className: 'card-link', href: `#/okuma/${encodeURIComponent(f.id)}`, text: 'Okunan faturayı aç' })),
          invoiceFacts(f, false),
          invoiceNote(f, d, base),
          f.dosyaVar ? filePreview(f) : el('p', { className: 'muted', text: 'Bu faturanın orijinal dosyası saklanmamış.' }),
        );
      }
      const items = list.map((f, i) => {
        const name = f.dosyaAdi || (f.faturaNo ? `Fatura ${f.faturaNo}` : `${i + 1}. fatura`);
        return el(
          'li',
          { className: 'inv-item' },
          el(
            'div',
            { className: 'inv-item-head' },
            el('span', { className: 'inv-n', 'aria-hidden': 'true' }),
            el('p', { className: 'inv-item-title', text: name }),
            el('a', { className: 'card-link', href: `#/okuma/${encodeURIComponent(f.id)}`, text: 'Okunan faturayı aç', 'aria-label': `Okunan faturayı aç: ${name}` }),
          ),
          invoiceFacts(f, true),
          invoiceNote(f, d, base),
          f.dosyaVar ? lazyPreview(f, name) : el('p', { className: 'muted small', text: 'Bu faturanın orijinal dosyası saklanmamış.' }),
        );
      });
      return el(
        'section',
        { className: 'card', 'aria-labelledby': 'inv-title' },
        el('div', { className: 'card-head' }, title, el('span', { className: 'tag', text: `${list.length} fatura` })),
        el('ol', { className: 'inv-items', role: 'list' }, ...items),
        invoiceSum(d, list),
      );
    }

    function stepsCard(d) {
      const steps = d.onaylar ?? [];
      const card = el(
        'section',
        { className: 'card', 'aria-labelledby': 'steps-title' },
        el('div', { className: 'card-head' }, el('h2', { className: 'card-title', id: 'steps-title', text: 'Onay adımları' }), d.tur > 1 ? el('span', { className: 'tag', text: `${d.tur}. tur` }) : null),
      );
      if (steps.length === 0) {
        if (d.izinler?.gonder) {
          const slot = el('div', { className: 'chain-slot', 'aria-live': 'polite' }, el('p', { className: 'muted', text: 'Onaycılar hesaplanıyor…' }));
          card.append(slot);
          api.previewFlow(previewBody(d), { signal }).then((p) => {
            if (!slot.isConnected || !p.ok) {
              if (slot.isConnected) slot.replaceChildren(el('p', { className: 'muted', text: 'Henüz onaya gönderilmedi.' }));
              return;
            }
            slot.replaceChildren(el('p', { className: 'muted', text: chainLead(p.body, 'gönderildiğinde şu onaycılara sırayla gidecek:') }), approverChain(p.body));
          });
        } else {
          card.append(el('p', { className: 'muted', text: 'Henüz onaya gönderilmedi.' }));
        }
        return card;
      }
      const list = el('ol', { className: 'timeline' });
      for (const s of steps) {
        const st = STEP_STATUS[s.durum] ?? { label: humanize(s.durum), tone: 'muted', icon: ICONS.info };
        list.append(
          el(
            'li',
            { className: `tl-item ${st.tone}`, 'data-state': s.durum },
            el('span', { className: 'tl-dot', 'aria-hidden': 'true' }, icon(st.icon)),
            el(
              'div',
              { className: 'tl-body' },
              el(
                'p',
                { className: 'tl-title' },
                el('strong', { text: s.onayci?.adSoyad ?? 'Onaycı' }),
                s.yedek ? el('span', { className: 'tag', text: 'Yedek yönetici' }) : null,
                statusBadge(s.durum, { map: STEP_STATUS, className: 'sm' }),
              ),
              el('p', { className: 'tl-meta', text: [`${s.sira}. adım`, s.yedek ? null : `Aralık: ${bandText(s.altLimit, s.ustLimit, base).toLocaleLowerCase('tr-TR')}`, s.kararTarihi ? fmtDateTime(s.kararTarihi) : null].filter(Boolean).join(' · ') }),
              s.aciklama ? el('blockquote', { className: 'tl-note', text: s.aciklama }) : null,
            ),
          ),
        );
      }
      card.append(list);
      return card;
    }

    function historyCard(d) {
      const items = d.gecmis ?? [];
      if (items.length === 0) return null;
      const list = el('ol', { className: 'history-list' });
      for (const h of items) {
        list.append(
          el(
            'li',
            { className: HISTORY_TONE[h.islem] ?? '' },
            el('span', { className: 'hl-dot', 'aria-hidden': 'true' }),
            el(
              'div',
              {},
              el('p', { className: 'hl-title' }, el('strong', { text: HISTORY_LABEL[h.islem] ?? humanize(h.islem) }), h.kullanici ? el('span', { text: ` · ${h.kullanici.adSoyad}` }) : null),
              el('p', { className: 'hl-time' }, el('time', { datetime: h.tarih, title: fmtDateTime(h.tarih), text: fmtRelative(h.tarih) ?? '' })),
              h.aciklama ? el('p', { className: 'hl-note', text: h.aciklama }) : null,
            ),
          ),
        );
      }
      return el('section', { className: 'card', 'aria-labelledby': 'hist-title' }, el('h2', { className: 'card-title', id: 'hist-title', text: 'Geçmiş' }), list);
    }

    function render(d) {
      detail = d;
      const hadFocus = page.contains(document.activeElement) && document.activeElement.tagName === 'H1';
      setPageTitle(d.baslik);
      const foreign = d.paraBirimi && d.paraBirimi !== base && d.yerelTutar !== null && d.yerelTutar !== undefined;

      let rejection = null;
      if (d.durum === 'reddedildi') {
        const step = (d.onaylar ?? []).find((s) => s.durum === 'reddedildi');
        if (step) rejection = alertBox('err', `${step.onayci?.adSoyad ?? 'Onaycı'} masrafı reddetti`, [step.aciklama ? `Neden: ${step.aciklama}` : null]);
      }
      const many = invoicesOf(d).length > 1;
      let diff = null;
      if (d.tutarFarki) {
        // Both figures are in the form's own currency (contract: tutarFarki). `fatura` is the total of
        // the invoices that count, base-currency amounts and equivalents converted with the form's rate.
        const cur = d.paraBirimi ?? base;
        const money = (v) => fmtCurrency(v, cur);
        const larger = money(Math.max(d.tutarFarki.fatura, d.tutarFarki.beyan));
        const converted = cur !== base && invoicesOf(d).some((f) => f.karsilikGerekli || f.paraBirimi === base);
        diff = alertBox('warn', many ? 'Beyan edilen tutar faturalardan farklı' : 'Beyan edilen tutar faturadan farklı', [
          `${many ? 'Faturaların toplamı' : 'Faturanın tutarı'} ${money(d.tutarFarki.fatura)}, beyan edilen tutar ${money(d.tutarFarki.beyan)}.${converted ? ` ${base} tutarlar masrafın kuruyla ${cur} karşılığına çevrildi.` : ''}`,
          d.onayTutari !== null && d.onayTutari !== undefined
            ? `Onay tutarı ikisinden büyük olan ${larger} üzerinden belirlendi.`
            : `Onaya gönderildiğinde ikisinden büyük olan ${larger} esas alınır.`,
        ]);
      }

      page.replaceChildren(...[
        pageHead({
          back: backFor(d),
          eyebrow: `#${d.id}${d.kategori ? ` · ${d.kategori.ad}` : ''}`,
          title: d.baslik,
          sub: el('p', { className: 'page-sub with-badge' }, statusBadge(d.durum), el('span', { text: [d.olusturan?.adSoyad, fmtDateLong(d.masrafTarihi)].filter(Boolean).join(' · ') })),
          actions: [
            el(
              'div',
              { className: 'head-amount' },
              el('span', { className: 'amount-main', text: fmtCurrency(d.tutar, d.paraBirimi) ?? '—' }),
              foreign ? el('span', { className: 'amount-local', text: `≈ ${fmtCurrency(d.yerelTutar, base)}` }) : null,
            ),
          ],
        }),
        actionBar(d),
        rejection,
        diff,
        el('div', { className: 'detail-grid' }, el('div', { className: 'detail-col' }, infoCard(d), invoiceCard(d)), el('div', { className: 'detail-col' }, stepsCard(d), historyCard(d))),
      ].filter(Boolean)); // native replaceChildren would print "null" for the missing parts
      if (hadFocus) page.querySelector('h1')?.focus();
    }

    load();
    return {
      unmount() {
        detail = null;
      },
    };
  },
};
