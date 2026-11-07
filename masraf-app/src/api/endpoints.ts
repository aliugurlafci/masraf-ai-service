import { config } from '@/config';

import { apiUrl, request, upload } from './client';
import type {
  BenYaniti,
  BildirimListesi,
  Kullanici,
  Kategori,
  Kuyruk,
  MasrafDetay,
  MasrafGuncelleIstegi,
  MasrafListeSorgusu,
  MasrafListesi,
  MasrafOlusturIstegi,
  MasrafOzet,
  OnayListeDurumu,
  Onizleme,
  OnizlemeIstegi,
  OturumYaniti,
  Ozet,
  SifreDegistirIstegi,
  TercihIstegi,
} from './types';

type Signal = { readonly signal?: AbortSignal };

// --- Session and profile ---

export const login = (eposta: string, sifre: string): Promise<OturumYaniti> =>
  request<OturumYaniti>('/api/oturum', { method: 'POST', body: { eposta, sifre, istemci: 'mobil' } });

export const logout = (): Promise<void> => request<void>('/api/oturum', { method: 'DELETE' });

export const getBen = (opts: Signal = {}): Promise<BenYaniti> => request<BenYaniti>('/api/ben', opts);

export const changePassword = (body: SifreDegistirIstegi): Promise<void> =>
  request<void>('/api/ben/sifre', { method: 'PUT', body });

export const updatePreferences = (body: TercihIstegi): Promise<Kullanici> =>
  request<Kullanici>('/api/ben/tercihler', { method: 'PUT', body });

export const getOzet = (opts: Signal = {}): Promise<Ozet> => request<Ozet>('/api/ozet', opts);

// --- Categories and approval flow ---

export const getKategoriler = (opts: Signal = {}): Promise<Kategori[]> => request<Kategori[]>('/api/kategoriler', opts);

export const previewFlow = (body: OnizlemeIstegi, opts: Signal = {}): Promise<Onizleme> =>
  request<Onizleme>('/api/onay-akisi/onizle', { method: 'POST', body, ...opts });

// --- Expense forms ---

export const getMasraflar = (query: MasrafListeSorgusu, opts: Signal = {}): Promise<MasrafListesi> =>
  request<MasrafListesi>('/api/masraflar', {
    query: { kapsam: query.kapsam, durum: query.durum, q: query.q, sayfa: query.sayfa, adet: query.adet },
    ...opts,
  });

export const getMasraf = (id: number, opts: Signal = {}): Promise<MasrafDetay> =>
  request<MasrafDetay>(`/api/masraflar/${id}`, opts);

export const createMasraf = (body: MasrafOlusturIstegi): Promise<MasrafDetay> =>
  request<MasrafDetay>('/api/masraflar', { method: 'POST', body });

export const updateMasraf = (id: number, body: MasrafGuncelleIstegi): Promise<MasrafDetay> =>
  request<MasrafDetay>(`/api/masraflar/${id}`, { method: 'PATCH', body });

/** Actions without a body. */
export type MasrafIslemi = 'gonder' | 'geri-cek' | 'iptal' | 'odendi';

export const runMasrafAction = (id: number, action: MasrafIslemi): Promise<MasrafDetay> =>
  request<MasrafDetay>(`/api/masraflar/${id}/${action}`, { method: 'POST' });

export const approveMasraf = (id: number, aciklama?: string): Promise<MasrafDetay> =>
  request<MasrafDetay>(`/api/masraflar/${id}/onayla`, {
    method: 'POST',
    body: aciklama === undefined || aciklama.trim() === '' ? {} : { aciklama: aciklama.trim() },
  });

export const rejectMasraf = (id: number, aciklama: string): Promise<MasrafDetay> =>
  request<MasrafDetay>(`/api/masraflar/${id}/reddet`, { method: 'POST', body: { aciklama: aciklama.trim() } });

export const getOnaylar = (durum: OnayListeDurumu, opts: Signal = {}): Promise<MasrafOzet[]> =>
  request<MasrafOzet[]>('/api/onaylar', { query: { durum }, ...opts });

// --- Notifications ---

export const getBildirimler = (sayfa: number, adet: number, opts: Signal = {}): Promise<BildirimListesi> =>
  request<BildirimListesi>('/api/bildirimler', { query: { sayfa, adet }, ...opts });

export const markNotificationRead = (id: number): Promise<void> => request<void>(`/api/bildirimler/${id}/okundu`, { method: 'POST' });

export const markAllNotificationsRead = (): Promise<void> => request<void>('/api/bildirimler/hepsi-okundu', { method: 'POST' });

// --- Invoice reading ---

export interface PickedFile {
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
}

/**
 * Sends one file to the multi-file reader (field "files"). The server answers 202 once the file is queued
 * (200 when it was read before); the result then comes from getQueue.
 */
export function uploadInvoice(file: PickedFile): Promise<Kuyruk> {
  const form = new FormData();
  // React Native's FormData takes a {uri, name, type} descriptor for a local file.
  form.append('files', { uri: file.uri, name: file.name, type: file.mimeType } as unknown as Blob);
  return upload<Kuyruk>('/api/invoices/toplu', form, config.uploadTimeoutMs);
}

export const getQueue = (id: string, opts: Signal = {}): Promise<Kuyruk> =>
  request<Kuyruk>(`/api/invoices/toplu/${encodeURIComponent(id)}`, opts);

/** Original invoice file; needs the Authorization header (see authHeaders). */
export const invoiceFileUrl = (faturaId: string): string => apiUrl(`/api/invoices/${encodeURIComponent(faturaId)}/dosya`);
