import type { AdimDurum, GecmisIslem, MasrafDurum, Rol, Strateji } from '@/api/types';

export const STATUS_LABELS: Readonly<Record<MasrafDurum, string>> = {
  taslak: 'Taslak',
  onayda: 'Onayda',
  onaylandi: 'Onaylandı',
  reddedildi: 'Reddedildi',
  odendi: 'Ödendi',
  iptal: 'İptal',
};

/** Order of the filter chips on the expense list. */
export const STATUS_ORDER: readonly MasrafDurum[] = ['taslak', 'onayda', 'onaylandi', 'reddedildi', 'odendi', 'iptal'];

export const STEP_LABELS: Readonly<Record<AdimDurum, string>> = {
  sirada: 'Sırada',
  bekliyor: 'Karar bekliyor',
  onaylandi: 'Onayladı',
  reddedildi: 'Reddetti',
  atlandi: 'Atlandı',
  iptal: 'İptal',
};

export const HISTORY_LABELS: Readonly<Record<GecmisIslem, string>> = {
  olusturuldu: 'Oluşturuldu',
  guncellendi: 'Güncellendi',
  gonderildi: 'Onaya gönderildi',
  onaylandi: 'Onaylandı',
  reddedildi: 'Reddedildi',
  atlandi: 'Adım atlandı',
  tamamlandi: 'Onay tamamlandı',
  geri_cekildi: 'Geri çekildi',
  iptal_edildi: 'İptal edildi',
  odendi: 'Ödendi olarak işaretlendi',
  devredildi: 'Onay devredildi',
};

export const STRATEGY_LABELS: Readonly<Record<Strateji, string>> = {
  zincir: 'Zincirleme onay',
  tek: 'Tek onaycı',
};

export const ROLE_LABELS: Readonly<Record<Rol, string>> = {
  calisan: 'Çalışan',
  muhasebe: 'Muhasebe',
  yonetici: 'Yönetici',
};

/** Roles that can see every form (kapsam=tumu) and the company summary. */
export const canSeeAll = (rol: Rol | undefined): boolean => rol === 'muhasebe' || rol === 'yonetici';
