// Tanım listeleri (yonetici): Organizasyonlar (#/organizasyonlar), Masraf merkezleri
// (#/masraf-merkezleri) and Fiş listeleri (#/fis-listeleri?alan=<anahtar>), the options of each
// 'liste' receipt field. All three are the paged list screen of deflist.js; the categories have
// their own screen (views/categories.js) for the icons and the order.

import * as api from '../api.js';
import { el, icon, ICONS } from '../dom.js';
import { fmtCount } from '../format.js';
import { listScreen } from '../deflist.js';
import { href } from '../router.js';
import { emptyState, loadFailed, pageHead, select, skeletonList } from '../ui.js';

/** Gösterim: kod, plus " – ad" when ad is set and differs from kod (docs section 6). */
export function shown(kod, ad) {
  return ad && ad !== kod ? `${kod} – ${ad}` : (kod ?? '');
}

const CURRENCY = /^[A-Z]{3}$/;

export const organizationsView = {
  mount(root, ctx) {
    listScreen(root, ctx, {
      title: 'Organizasyonlar',
      sub: 'Kullanıcılara atanan şirketler. Bir masrafın organizasyonu, sahibinin organizasyonudur.',
      path: '/organizasyonlar',
      base: () => api.ORGANIZATIONS,
      what: 'Organizasyon',
      icon: ICONS.building,
      columns: [
        { label: 'Kod', className: 't-code', cell: (o) => o.kod },
        { label: 'Ad', cell: (o) => o.ad },
        { label: 'Para birimi', cell: (o) => o.paraBirimi },
        { label: 'Kullanıcı', num: true, cell: (o) => fmtCount(o.kullaniciSayisi ?? 0) },
      ],
      nameOf: (o) => shown(o.kod, o.ad),
      fields: [
        { key: 'kod', label: 'Kod', max: 50, required: true, placeholder: 'Örn. 1000' },
        { key: 'ad', label: 'Ad', max: 200, required: true },
        { key: 'paraBirimi', label: 'Para birimi', max: 3, upper: true, pattern: CURRENCY, patternMessage: 'Üç harfli para birimi kodu girin (TRY, USD, EUR).', hint: 'ISO 4217 kodu (TRY, USD, EUR).', placeholder: 'TRY' },
      ],
      importLabels: { kod: 'Kod', ad: 'Ad', paraBirimi: 'Para birimi', aktif: 'Aktif' },
      keyLabel: 'kod',
      exportName: 'organizasyonlar',
    });
  },
};

export const costCentresView = {
  mount(root, ctx) {
    listScreen(root, ctx, {
      title: 'Masraf merkezleri',
      sub: 'Kullanıcılara tanımlanan masraf merkezleri. Gönderen, masraf formunda kendisine tanımlı aktif merkezlerden birini seçer.',
      path: '/masraf-merkezleri',
      base: () => api.COST_CENTRES,
      what: 'Masraf merkezi',
      icon: ICONS.target,
      columns: [
        { label: 'Kod', className: 't-code', cell: (m) => m.kod },
        { label: 'Açıklama', cell: (m) => m.aciklama },
        { label: 'Kullanıcı', num: true, cell: (m) => fmtCount(m.kullaniciSayisi ?? 0) },
      ],
      nameOf: (m) => m.gosterim ?? shown(m.kod, m.aciklama),
      fields: [
        { key: 'kod', label: 'Kod', max: 50, required: true, placeholder: 'Örn. 11033106' },
        { key: 'aciklama', label: 'Açıklama', max: 200 },
      ],
      importLabels: { kod: 'Kod', aciklama: 'Açıklama', aktif: 'Aktif' },
      keyLabel: 'kod',
      exportName: 'masraf-merkezleri',
    });
  },
};

/** Fiş listeleri: one 'liste' field at a time, chosen above the list. */
export const optionListsView = {
  mount(root, ctx) {
    const { route, signal } = ctx;
    const holder = el('div', { className: 'page' }, pageHead({ title: 'Fiş listeleri', sub: 'Liste türündeki fiş alanlarının seçenekleri.' }), skeletonList(4));
    root.append(holder);

    async function start() {
      const r = await api.listFields(true, { signal });
      if (signal.aborted) return;
      if (!r.ok) {
        if (!r.unauthorized) holder.replaceChildren(pageHead({ title: 'Fiş listeleri' }), loadFailed(r, start));
        return;
      }
      const lists = (r.body?.alanlar ?? []).filter((f) => f.tur === 'liste').sort((a, b) => (a.sira ?? 0) - (b.sira ?? 0) || a.id - b.id);
      if (lists.length === 0) {
        holder.replaceChildren(
          pageHead({ title: 'Fiş listeleri' }),
          emptyState({
            icon: ICONS.tag,
            title: 'Liste türünde fiş alanı yok',
            text: 'Alan yönetiminde “Liste” türünde bir fiş alanı ekleyin; seçenekleri burada yönetilir.',
            action: el('a', { className: 'btn btn-primary', href: '#/alanlar' }, icon(ICONS.chevronRight), el('span', { text: 'Alan yönetimine git' })),
          }),
        );
        return;
      }
      const asked = route.query.get('alan');
      let current = lists.find((f) => f.anahtar === asked) ?? lists[0];
      const picker = select(
        lists.map((f) => ({ value: f.anahtar, label: f.aktif ? f.ad : `${f.ad} (pasif alan)` })),
        { value: current.anahtar, id: 'fis-listesi', className: 'input list-picker' },
      );
      const info = el('p', { className: 'muted small list-info' });
      const showInfo = () => {
        const parts = [`${fmtCount(current.secenekSayisi ?? 0)} aktif seçenek`];
        if (!current.aktif) parts.push('alan pasif: formlarda görünmez');
        if (current.zorunlu) parts.push('zorunlu alan');
        info.replaceChildren(el('span', { text: parts.join(' · ') }), el('a', { className: 'card-link', href: '#/alanlar', text: 'Alan yönetimi' }));
      };
      showInfo();
      const bar = el(
        'div',
        { className: 'list-switch' },
        el('label', { className: 'list-switch-label', for: picker.id, text: 'Liste' }),
        picker,
        info,
      );
      holder.remove();
      const screen = listScreen(root, ctx, {
        title: 'Fiş listeleri',
        sub: 'Gönderenlerin her fiş için seçtiği listeler (Etiket, Proje Kodu, Ödeme Yöntemi …). Pasif seçenek yeni seçimlerde görünmez; kayıtlı fişlerde kalır.',
        path: '/fis-listeleri',
        base: () => api.optionsBase(current.anahtar),
        query: () => ({ alan: current.anahtar }),
        what: 'Seçenek',
        icon: ICONS.list,
        before: bar,
        columns: [
          { label: 'Kod', className: 't-code', cell: (s) => s.kod },
          { label: 'Açıklama', cell: (s) => s.ad },
        ],
        nameOf: (s) => s.gosterim ?? shown(s.kod, s.ad),
        fields: [
          { key: 'kod', label: 'Kod', max: 50, required: true },
          { key: 'ad', label: 'Açıklama', max: 200 },
        ],
        importLabels: { kod: 'Kod', ad: 'Açıklama', aktif: 'Aktif' },
        keyLabel: 'kod',
        exportName: () => current.anahtar,
      });
      picker.addEventListener('change', () => {
        current = lists.find((f) => f.anahtar === picker.value) ?? current;
        showInfo();
        history.replaceState(history.state, '', href('/fis-listeleri', { alan: current.anahtar }));
        screen.reset();
      });
    }
    start();
  },
};
