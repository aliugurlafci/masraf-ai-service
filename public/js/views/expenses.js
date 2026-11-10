// Masraflarım (kapsam=benim) and Tüm masraflar (kapsam=tumu, accounting and managers): status
// chips, search, paging; the filters live in the address (#/masraflar?durum=onayda&q=&sayfa=2).
// The company list also exports CSV and marks approved expenses as paid in bulk.

import * as api from '../api.js';
import { el, icon, ICONS } from '../dom.js';
import { downloadObjectUrl } from '../files.js';
import { fmtCount, fmtCurrency, fmtDateShort, todayIso } from '../format.js';
import { expenseHref } from '../expense-ui.js';
import { amountTexts, categoryIcon, EXPENSE_STATUS, readingTags, STATUS_ORDER, statusBadge } from '../labels.js';
import { navigate } from '../router.js';
import * as session from '../session.js';
import {
  actionDialog,
  btn,
  debounce,
  emptyState,
  field,
  input,
  loadFailed,
  openDialog,
  pageHead,
  pager,
  select,
  setFieldError,
  skeletonList,
  toast,
} from '../ui.js';

const PAGE_SIZE = 20;

function parseQuery(q) {
  const durum = (q.get('durum') ?? '')
    .split(',')
    .filter((d) => STATUS_ORDER.includes(d));
  const sayfa = Math.max(1, Number.parseInt(q.get('sayfa') ?? '1', 10) || 1);
  return { durum: [...new Set(durum)], q: q.get('q') ?? '', sayfa };
}

function downloadBlob(blob, name) {
  const a = el('a', { href: downloadObjectUrl(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function createListView(kapsam) {
  const all = kapsam === 'tumu';
  const path = all ? '/tum-masraflar' : '/masraflar';

  return {
    mount(root, { route, signal }) {
      let params = parseQuery(route.query);
      let token = 0;
      let base = session.knownBaseCurrency();
      const selected = new Map(); // id -> MasrafOzet (company list: approved ones to mark paid)
      let pageRows = [];

      // ---------- Controls ----------

      const chips = el('div', { className: 'chips', role: 'group', 'aria-label': 'Duruma göre süz' });
      const chipAll = el('button', { className: 'chip', type: 'button', 'data-durum': '', text: 'Tümü' });
      chips.append(chipAll);
      for (const key of STATUS_ORDER) {
        const s = EXPENSE_STATUS[key];
        chips.append(el('button', { className: `chip tone-${s.tone}`, type: 'button', 'data-durum': key }, el('span', { className: 'chip-dot', 'aria-hidden': 'true' }), el('span', { text: all && key === 'onaylandi' ? 'Onaylandı (ödeme bekliyor)' : s.label })));
      }

      const search = input({ type: 'search', placeholder: all ? 'Başlık, satıcı ya da kişi ara' : 'Başlık ya da satıcı ara', 'aria-label': 'Masraf ara', value: params.q, enterkeyhint: 'search' });
      const toolbar = el('div', { className: 'toolbar' }, chips, el('label', { className: 'search' }, icon(ICONS.search), search));
      const announcer = el('p', { className: 'visually-hidden', role: 'status' });
      const results = el('div', { className: 'results' });
      const pagerSlot = el('div', { className: 'pager-slot' });
      const bulkBar = all ? el('div', { className: 'bulk-bar', hidden: true, role: 'region', 'aria-label': 'Seçili masraflar' }) : null;

      root.append(
        el(
          'div',
          { className: 'page' },
          pageHead({
            title: all ? 'Tüm masraflar' : 'Masraflarım',
            sub: all ? 'Şirketteki bütün masraf formları.' : 'Oluşturduğunuz masraf formları ve durumları.',
            actions: all
              ? [btn('CSV dışa aktar', { icon: ICONS.download, onClick: openExport })]
              : [btn('Yeni masraf', { icon: ICONS.plus, kind: 'primary', href: '#/masraflar/yeni' })],
          }),
          toolbar,
          bulkBar,
          announcer,
          results,
          pagerSlot,
        ),
      );

      function syncControls() {
        for (const chip of chips.querySelectorAll('.chip')) {
          const key = chip.dataset.durum;
          const on = key === '' ? params.durum.length === 0 : params.durum.includes(key);
          chip.setAttribute('aria-pressed', String(on));
        }
        if (search.value !== params.q && document.activeElement !== search) search.value = params.q;
      }

      function go(next, replace = false) {
        navigate(path, { query: { durum: next.durum.join(','), q: next.q.trim(), sayfa: next.sayfa > 1 ? next.sayfa : '' }, replace });
      }

      chips.addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        const key = chip.dataset.durum;
        let durum;
        if (key === '') durum = [];
        else if (params.durum.includes(key)) durum = params.durum.filter((d) => d !== key);
        else durum = [...params.durum, key];
        go({ ...params, durum, sayfa: 1 });
      });

      const onSearch = debounce(() => go({ ...params, q: search.value, sayfa: 1 }, true), 350);
      search.addEventListener('input', onSearch);
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          onSearch.cancel();
          go({ ...params, q: search.value, sayfa: 1 }, true);
        }
      });

      // ---------- Results ----------

      async function load() {
        const my = ++token;
        if (!results.firstChild || results.querySelector('.notice')) results.replaceChildren(skeletonList(6));
        results.classList.add('is-loading');
        results.setAttribute('aria-busy', 'true');
        const [r, b] = await Promise.all([
          api.listExpenses({ kapsam, durum: params.durum.join(','), q: params.q.trim(), sayfa: params.sayfa, adet: PAGE_SIZE }, { signal }),
          session.loadBaseCurrency(),
        ]);
        if (my !== token || signal.aborted) return;
        base = b;
        results.classList.remove('is-loading');
        results.removeAttribute('aria-busy');
        if (!r.ok) {
          if (!r.unauthorized) results.replaceChildren(loadFailed(r, load));
          pagerSlot.replaceChildren();
          return;
        }
        const { kayitlar = [], toplam = 0, sayfa = params.sayfa, adet = PAGE_SIZE } = r.body;
        const pages = Math.max(1, Math.ceil(toplam / adet));
        if (toplam > 0 && kayitlar.length === 0 && params.sayfa > pages) {
          go({ ...params, sayfa: pages }, true);
          return;
        }
        pageRows = kayitlar;
        selected.clear();
        renderBulk();
        announcer.textContent = toplam === 0 ? 'Masraf bulunamadı.' : `${fmtCount(toplam)} masraf bulundu.`;
        results.replaceChildren(kayitlar.length === 0 ? emptyView() : table(kayitlar));
        pagerSlot.replaceChildren(pager({ sayfa, adet, toplam, onPage: (n) => go({ ...params, sayfa: n }) }) ?? '');
      }

      function emptyView() {
        const filtered = params.durum.length > 0 || params.q.trim() !== '';
        if (filtered) {
          return emptyState({
            icon: ICONS.search,
            title: 'Bu filtreye uyan masraf yok',
            text: 'Durum seçimini ya da aramayı değiştirin.',
            action: btn('Filtreleri temizle', { onClick: () => go({ durum: [], q: '', sayfa: 1 }) }),
          });
        }
        return all
          ? emptyState({ icon: ICONS.layers, title: 'Henüz masraf yok', text: 'Çalışanlar masraf gönderdikçe burada görünür.' })
          : emptyState({
              icon: ICONS.receipt,
              title: 'Henüz masrafınız yok',
              text: 'Faturanızı yükleyin; tutar, tarih ve satıcı kendiliğinden dolsun.',
              action: btn('Yeni masraf', { href: '#/masraflar/yeni', kind: 'primary', icon: ICONS.plus }),
            });
      }

      function table(rows) {
        const payable = rows.filter((m) => m.durum === 'onaylandi');
        const selectable = all && payable.length > 0;
        const head = el(
          'tr',
          {},
          selectable
            ? el('th', { className: 'sel', scope: 'col' }, el('input', { type: 'checkbox', className: 'check', 'aria-label': 'Bu sayfadaki onaylanmış masrafların hepsini seç', 'data-select-all': '' }))
            : all
              ? el('th', { className: 'sel', scope: 'col' }, el('span', { className: 'visually-hidden', text: 'Seç' }))
              : null,
          el('th', { scope: 'col', text: 'Masraf' }),
          all ? el('th', { scope: 'col', className: 't-owner', text: 'Oluşturan' }) : null,
          el('th', { scope: 'col', text: 'Tarih' }),
          el('th', { scope: 'col', className: 'num', text: 'Tutar' }),
          el('th', { scope: 'col', text: 'Durum' }),
          el('th', { scope: 'col', text: 'Sıradaki onaycı' }),
        );
        const tbody = el('tbody', { className: 'stagger' });
        for (const m of rows) {
          const { main, local, empty } = amountTexts(m, base);
          tbody.append(
            el(
              'tr',
              { 'data-href': expenseHref(m.id) },
              all
                ? el(
                    'td',
                    { className: 'sel' },
                    m.durum === 'onaylandi' ? el('input', { type: 'checkbox', className: 'check', 'data-id': m.id, 'aria-label': `${m.baslik} masrafını seç` }) : null,
                  )
                : null,
              el(
                'td',
                { className: 't-main' },
                el(
                  'div',
                  { className: 'cell-main' },
                  categoryIcon(m.kategori?.simge),
                  el(
                    'div',
                    { className: 'cell-text' },
                    el('a', { className: 'row-link', href: expenseHref(m.id), text: m.baslik }),
                    el('span', { className: 'cell-sub', title: m.satici || null, text: [m.kategori?.ad, m.satici].filter(Boolean).join(' · ') || '—' }),
                    // Shown instead of the "Oluşturan" column when the table is narrow (CSS container query).
                    all && m.olusturan ? el('span', { className: 'cell-owner' }, el('span', { className: 'visually-hidden', text: 'Oluşturan: ' }), el('span', { text: m.olusturan.adSoyad })) : null,
                  ),
                ),
              ),
              all ? el('td', { className: 't-owner', 'data-label': 'Oluşturan', text: m.olusturan?.adSoyad ?? '—' }) : null,
              el('td', { className: 't-date', 'data-label': 'Tarih', text: fmtDateShort(m.masrafTarihi) ?? '—' }),
              el('td', { className: 'num t-amount', 'data-label': 'Tutar' }, el('span', { className: `amount${empty ? ' is-empty' : ''}`, text: main ?? '—' }), local ? el('span', { className: 'cell-sub', text: `≈ ${local}` }) : null),
              el('td', { className: 't-status', 'data-label': 'Durum' }, statusBadge(m.durum), readingTags(m.okuma)),
              el('td', { className: `t-next${m.siradakiOnayci ? '' : ' is-empty'}`, 'data-label': 'Sıradaki onaycı', text: m.siradakiOnayci?.adSoyad ?? '—' }),
            ),
          );
        }
        tbody.addEventListener('click', (e) => {
          if (e.target.closest('a, button, input, label')) return;
          const tr = e.target.closest('tr[data-href]');
          if (tr && !window.getSelection()?.toString()) location.hash = tr.dataset.href;
        });
        const tableEl = el('table', { className: `data-table exp-table${all ? ' with-sel with-owner' : ''}` }, el('caption', { className: 'visually-hidden', text: all ? 'Tüm masraflar' : 'Masraflarım' }), el('thead', {}, head), tbody);
        tableEl.addEventListener('change', (e) => {
          const box = e.target.closest('input.check');
          if (!box) return;
          if (box.hasAttribute('data-select-all')) {
            for (const m of payable) {
              if (box.checked) selected.set(m.id, m);
              else selected.delete(m.id);
            }
            for (const b of tableEl.querySelectorAll('input.check[data-id]')) b.checked = box.checked;
          } else {
            const m = pageRows.find((x) => String(x.id) === box.dataset.id);
            if (!m) return;
            if (box.checked) selected.set(m.id, m);
            else selected.delete(m.id);
            const head = tableEl.querySelector('[data-select-all]');
            if (head) {
              head.checked = selected.size === payable.length;
              head.indeterminate = selected.size > 0 && selected.size < payable.length;
            }
          }
          renderBulk();
        });
        return el('div', { className: 'table-card' }, tableEl);
      }

      // ---------- Bulk "paid" (company list) ----------

      function renderBulk() {
        if (!bulkBar) return;
        if (selected.size === 0) {
          bulkBar.hidden = true;
          bulkBar.replaceChildren();
          return;
        }
        const sum = [...selected.values()].reduce((n, m) => n + (m.yerelTutar ?? 0), 0);
        bulkBar.hidden = false;
        bulkBar.replaceChildren(
          el('p', {}, el('strong', { text: `${fmtCount(selected.size)} masraf seçildi` }), el('span', { text: ` · toplam ${fmtCurrency(sum, base)}` })),
          el(
            'div',
            { className: 'bulk-actions' },
            btn('Seçimi temizle', {
              kind: 'ghost',
              onClick: () => {
                selected.clear();
                for (const b of results.querySelectorAll('input.check')) {
                  b.checked = false;
                  b.indeterminate = false;
                }
                renderBulk();
              },
            }),
            btn('Ödendi işaretle', { icon: ICONS.cash, kind: 'primary', onClick: markPaid }),
          ),
        );
      }

      async function markPaid() {
        const items = [...selected.values()];
        const sum = items.reduce((n, m) => n + (m.yerelTutar ?? 0), 0);
        const results2 = { ok: 0, failed: [] };
        const done = await actionDialog({
          title: 'Ödendi olarak işaretle',
          message: `${fmtCount(items.length)} masraf (toplam ${fmtCurrency(sum, base)}) ödendi olarak işaretlenecek. Bu işlem masraf geçmişine yazılır.`,
          confirmLabel: 'Ödendi işaretle',
          confirmIcon: ICONS.cash,
          run: async () => {
            for (const m of items) {
              const r = await api.expenseAction(m.id, 'odendi');
              if (r.unauthorized) return r;
              if (r.ok) results2.ok++;
              else results2.failed.push(`${m.baslik}: ${r.error.mesaj}`);
            }
            return { ok: true };
          },
        });
        if (!done) return;
        if (results2.ok > 0) toast(`${fmtCount(results2.ok)} masraf ödendi olarak işaretlendi.`, 'ok');
        if (results2.failed.length > 0) toast(`${fmtCount(results2.failed.length)} masraf işaretlenemedi. ${results2.failed[0]}`, 'err');
        load();
      }

      // ---------- CSV export ----------

      function openExport() {
        const status = select([{ value: '', label: 'Tüm durumlar' }, ...STATUS_ORDER.map((k) => ({ value: k, label: EXPENSE_STATUS[k].label }))], { name: 'durum' });
        if (params.durum.length === 1) status.value = params.durum[0];
        const from = input({ type: 'date', name: 'baslangic', max: todayIso() });
        const to = input({ type: 'date', name: 'bitis', max: todayIso() });
        const clearErr = () => {
          setFieldError(from, null);
          setFieldError(to, null);
        };
        from.addEventListener('input', clearErr);
        to.addEventListener('input', clearErr);
        openDialog({
          title: 'CSV dışa aktar',
          description: 'Excel ile açılabilen, noktalı virgülle ayrılmış bir dosya indirilir. Tarih aralığını boş bırakırsanız tümü gelir.',
          body: [field({ label: 'Durum', input: status }), el('div', { className: 'field-row' }, field({ label: 'Başlangıç', input: from, optional: true }), field({ label: 'Bitiş', input: to, optional: true }))],
          submitLabel: 'İndir',
          submitIcon: ICONS.download,
          onSubmit: async (ctl) => {
            if (from.value && to.value && from.value > to.value) {
              setFieldError(to, 'Bitiş tarihi başlangıçtan önce olamaz.');
              to.focus();
              return false;
            }
            const r = await api.exportExpenses({ durum: status.value, baslangic: from.value, bitis: to.value });
            if (!r.ok) {
              if (r.unauthorized) return null;
              ctl.setError(r.error.mesaj);
              return false;
            }
            downloadBlob(r.blob, r.filename ?? `masraflar-${todayIso()}.csv`);
            toast('CSV dosyası indirildi.', 'ok');
            return true;
          },
        });
      }

      syncControls();
      load();

      return {
        update(next) {
          params = parseQuery(next.query);
          syncControls();
          load();
          return true;
        },
      };
    },
  };
}

export const myExpensesView = createListView('benim');
export const allExpensesView = createListView('tumu');
