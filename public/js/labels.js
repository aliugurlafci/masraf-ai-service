// Turkish labels for the codes the API uses, and the small badges built from them.
// Status is never shown by colour alone: every badge carries an icon and its word.

import { el, icon, ICONS } from './dom.js';
import { fmtCurrency, fmtAmount } from './format.js';

export const EXPENSE_STATUS = {
  taslak: { label: 'Taslak', tone: 'muted', icon: ICONS.edit },
  onayda: { label: 'Onayda', tone: 'wait', icon: ICONS.clock },
  onaylandi: { label: 'Onaylandı', tone: 'ok', icon: ICONS.check },
  reddedildi: { label: 'Reddedildi', tone: 'err', icon: ICONS.close },
  odendi: { label: 'Ödendi', tone: 'paid', icon: ICONS.cash },
  iptal: { label: 'İptal', tone: 'off', icon: ICONS.ban },
};

export const STATUS_ORDER = ['taslak', 'onayda', 'onaylandi', 'reddedildi', 'odendi', 'iptal'];

export const STEP_STATUS = {
  sirada: { label: 'Sırada', tone: 'muted', icon: ICONS.clock },
  bekliyor: { label: 'Karar bekliyor', tone: 'wait', icon: ICONS.clock },
  onaylandi: { label: 'Onayladı', tone: 'ok', icon: ICONS.check },
  reddedildi: { label: 'Reddetti', tone: 'err', icon: ICONS.close },
  atlandi: { label: 'Atlandı', tone: 'off', icon: ICONS.chevronRight },
  iptal: { label: 'İptal edildi', tone: 'off', icon: ICONS.ban },
};

export const ROLES = {
  calisan: 'Çalışan',
  muhasebe: 'Muhasebe',
  yonetici: 'Yönetici',
};

export const ROLE_HINTS = {
  calisan: 'Fatura okutur, kendi masraflarını gönderir.',
  muhasebe: 'Tüm masrafları görür, CSV alır, ödendi işaretler.',
  yonetici: 'Muhasebe yetkilerine ek olarak kullanıcıları, kategorileri ve onay akışlarını yönetir.',
};

export const HISTORY_LABEL = {
  olusturuldu: 'Oluşturuldu',
  guncellendi: 'Güncellendi',
  gonderildi: 'Onaya gönderildi',
  onaylandi: 'Onaylandı',
  reddedildi: 'Reddedildi',
  atlandi: 'Adım atlandı (kendi masrafı)',
  tamamlandi: 'Onay tamamlandı',
  geri_cekildi: 'Geri çekildi',
  iptal_edildi: 'İptal edildi',
  odendi: 'Ödendi olarak işaretlendi',
  devredildi: 'Onay devredildi',
};

export const HISTORY_TONE = {
  onaylandi: 'ok',
  tamamlandi: 'ok',
  reddedildi: 'err',
  iptal_edildi: 'off',
  geri_cekildi: 'wait',
  odendi: 'paid',
  gonderildi: 'accent',
};

/** Category glyphs on the 20×20 grid. */
export const CATEGORY_ICONS = {
  yemek: 'M6 3v5.5a2 2 0 0 0 4 0V3M8 3v14M14.5 17V3c-1.6.8-2.5 2.8-2.5 5.2V11h2.5',
  ulasim: 'M4.5 14V8.5L6.3 5h7.4l1.8 3.5V14zM4.5 10.5h11M6.5 14v2M13.5 14v2M7 12.2h.1M13 12.2h.1',
  konaklama: 'M3 15.5V5.5M3 12h14v3.5M17 12v-1.5a2 2 0 0 0-2-2H9.5V12M6.2 10.3a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6z',
  akaryakit: 'M4.5 16.5V4.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v12M3.5 16.5h9M6.5 7h3M11.5 8.5h1.5a1 1 0 0 1 1 1v4a1 1 0 0 0 2 0V7.5L14 5.5',
  ofis: 'M3.5 7h13v9h-13zM7.5 7V5h5v2M3.5 11h13M9 11v1.5h2V11',
  temsil: 'M7 3.5h6l-.6 4a2.4 2.4 0 0 1-4.8 0zM10 10v6M7 16.5h6',
  egitim: 'M2.5 8 10 4.5 17.5 8 10 11.5zM5.5 9.5V13c1.4 1.3 2.9 2 4.5 2s3.1-.7 4.5-2V9.5M17.5 8v4',
  iletisim: 'M6.5 3h7v14h-7zM9 14.5h2',
  diger: 'M5 10h.1M10 10h.1M15 10h.1',
};

export const CATEGORY_ICON_LABEL = {
  yemek: 'Yemek',
  ulasim: 'Ulaşım',
  konaklama: 'Konaklama',
  akaryakit: 'Akaryakıt',
  ofis: 'Ofis',
  temsil: 'Temsil ve ağırlama',
  egitim: 'Eğitim',
  iletisim: 'İletişim',
  diger: 'Diğer',
};

export const CATEGORY_KEYS = Object.keys(CATEGORY_ICONS);

export function statusBadge(durum, { map = EXPENSE_STATUS, className = '' } = {}) {
  const s = map[durum] ?? { label: durum ?? 'Bilinmiyor', tone: 'muted', icon: ICONS.info };
  return el('span', { className: `status ${s.tone} ${className}`.trim(), 'data-status': durum }, icon(s.icon), el('span', { text: s.label }));
}

export function categoryIcon(simge, { label = null, className = '' } = {}) {
  const d = CATEGORY_ICONS[simge] ?? CATEGORY_ICONS.diger;
  return el(
    'span',
    { className: `cat-icon cat-${CATEGORY_ICONS[simge] ? simge : 'diger'} ${className}`.trim(), 'aria-hidden': label ? null : 'true', role: label ? 'img' : null, 'aria-label': label },
    icon(d),
  );
}

export const roleLabel = (rol) => ROLES[rol] ?? rol ?? '';

/** The approval strategies of a flow (`strateji`). */
export const STRATEGY_LABEL = { zincir: 'Zincirleme onay', tek: 'Tek onaycı' };

const limitMoney = (v, cur) => (cur ? fmtCurrency(v, cur) : fmtAmount(v));
const isOpen = (v) => v === null || v === undefined;

/**
 * The amounts (company currency, both ends inclusive) that reach an approval step:
 * "Her tutar", "₺5.000,00 ve altı", "₺5.000,01 ve üzeri" or "₺5.000,01 – ₺50.000,00".
 */
export function bandText(altLimit, ustLimit, cur) {
  const lo = altLimit ?? 0;
  if (lo <= 0 && isOpen(ustLimit)) return 'Her tutar';
  if (isOpen(ustLimit)) return `${limitMoney(lo, cur)} ve üzeri`;
  if (lo <= 0) return `${limitMoney(ustLimit, cur)} ve altı`;
  return `${limitMoney(lo, cur)} – ${limitMoney(ustLimit, cur)}`;
}

/** The same band as an adjective before "masraflar": "her tutardaki", "₺5.000,01 ve üzerindeki" … */
export function bandPhrase(altLimit, ustLimit, cur) {
  const lo = altLimit ?? 0;
  if (lo <= 0 && isOpen(ustLimit)) return 'her tutardaki';
  if (isOpen(ustLimit)) return `${limitMoney(lo, cur)} ve üzerindeki`;
  if (lo <= 0) return `${limitMoney(ustLimit, cur)} ve altındaki`;
  return `${limitMoney(lo, cur)} – ${limitMoney(ustLimit, cur)} arasındaki`;
}

/** An approver's approval limit: "limit ₺5.000,00", or "sınırsız" for the last approver. */
export const limitText = (limit, cur) => (isOpen(limit) ? 'sınırsız' : `limit ${limitMoney(limit, cur)}`);

/**
 * The amount line of an expense: the declared amount, and the local one when the currency differs.
 * Returns { main, local } texts.
 */
export function amountTexts(m, base) {
  const main = fmtCurrency(m.tutar, m.paraBirimi);
  const differs = m.paraBirimi && base && m.paraBirimi !== base && m.yerelTutar !== null && m.yerelTutar !== undefined;
  return { main, local: differs ? fmtCurrency(m.yerelTutar, base) : null };
}

/** The audit log's action codes (src/ audit calls); an unknown code is shown humanized. */
export const AUDIT_LABEL = {
  ilk_yonetici: 'İlk yönetici oluşturuldu',
  kullanici_olusturuldu: 'Kullanıcı oluşturuldu',
  kullanici_guncellendi: 'Kullanıcı güncellendi',
  sifre_sifirlandi: 'Şifre sıfırlandı',
  kategori_olusturuldu: 'Kategori oluşturuldu',
  kategori_guncellendi: 'Kategori güncellendi',
  onay_akisi_olusturuldu: 'Onay akışı oluşturuldu',
  onay_akisi_guncellendi: 'Onay akışı güncellendi',
  onay_akisi_silindi: 'Onay akışı silindi',
  varsayilan_akis_degisti: 'Varsayılan akış değişti',
};

export const auditLabel = (code) => AUDIT_LABEL[code] ?? humanize(code);

export function humanize(code) {
  const s = String(code ?? '').replace(/[_-]+/g, ' ').trim();
  return s ? s.charAt(0).toLocaleUpperCase('tr-TR') + s.slice(1) : '';
}
