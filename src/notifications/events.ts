// Which event notifies whom, with which type and text (docs/onay-sistemi.md, section 7). Pure; no database.
import { formatMoney } from '../approval/flow.ts';
import type { FormDurum } from '../expenses/rules.ts';

export const NOTIFICATION_TYPES = [
  'onay_bekliyor',
  'hatirlatma',
  'devredildi',
  'onaylandi',
  'reddedildi',
  'odendi',
  'odeme_bekliyor',
  'okuma_bitti',
  'okuma_hatasi',
  'onaya_gonderildi',
  'onaya_gonderilemedi',
] as const;
export type BildirimTuru = (typeof NOTIFICATION_TYPES)[number];

/** What a notification and its mail say about the form. */
export interface FormRef {
  readonly id: number;
  readonly baslik: string;
  readonly sahip: { readonly id: number; readonly adSoyad: string };
  /** Null only on a draft whose amount waits for its invoices. */
  readonly tutar: number | null;
  readonly paraBirimi: string;
  /** The form's state after the action. */
  readonly durum: FormDurum;
}

export type NotificationEvent =
  /** A step started waiting: after sending (`sonraki: false`) or after the previous approval. */
  | { readonly kind: 'onay_bekliyor'; readonly form: FormRef; readonly onayciId: number; readonly sonraki: boolean }
  /** An administrator handed a step to `onayciId`; `bekliyor` when the step waits for a decision now. */
  | { readonly kind: 'devredildi'; readonly form: FormRef; readonly onayciId: number; readonly sira: number; readonly bekliyor: boolean }
  /** The last approval: the owner and every active accountant. */
  | { readonly kind: 'onaylandi'; readonly form: FormRef; readonly muhasebeIds: readonly number[] }
  | { readonly kind: 'reddedildi'; readonly form: FormRef; readonly reddeden: string; readonly gerekce: string }
  | { readonly kind: 'odendi'; readonly form: FormRef }
  /** A step has waited longer than the reminder threshold. */
  | { readonly kind: 'hatirlatma'; readonly form: FormRef; readonly onayciId: number; readonly saat: number }
  // Reading in the background (docs/onay-sistemi.md, section 3): the form's last waiting file is settled.
  /** Every file was read. */
  | { readonly kind: 'okuma_bitti'; readonly form: FormRef }
  /** `hatali` files could not be read. */
  | { readonly kind: 'okuma_hatasi'; readonly form: FormRef; readonly hatali: number }
  /** "Okununca gönder" sent the form for approval. */
  | { readonly kind: 'onaya_gonderildi'; readonly form: FormRef }
  /** "Okununca gönder" could not send the form; `neden` is the refusal's message. */
  | { readonly kind: 'onaya_gonderilemedi'; readonly form: FormRef; readonly neden: string };

export interface PlannedNotification {
  readonly kullaniciId: number;
  readonly tur: BildirimTuru;
  readonly baslik: string;
  readonly mesaj: string;
  /** Attachment of the mail, if one goes out. */
  readonly ek: 'masraf_pdf' | null;
}

const amountOf = (f: FormRef): string => (f.tutar === null ? 'tutarı girilmedi' : formatMoney(f.tutar, f.paraBirimi));
const quoted = (f: FormRef): string => `"${f.baslik}"`;

/**
 * The notifications an event causes, one per recipient. `actorId` is who did the action (null for the
 * reminder job): nobody is notified of their own action. A recipient listed twice is notified once.
 */
export function planNotifications(event: NotificationEvent, actorId: number | null): PlannedNotification[] {
  const f = event.form;
  const out: PlannedNotification[] = [];
  const add = (kullaniciId: number, tur: BildirimTuru, baslik: string, mesaj: string, ek: PlannedNotification['ek'] = null): void => {
    if (kullaniciId === actorId || out.some((n) => n.kullaniciId === kullaniciId)) return;
    out.push({ kullaniciId, tur, baslik, mesaj, ek });
  };
  switch (event.kind) {
    case 'onay_bekliyor':
      add(
        event.onayciId,
        'onay_bekliyor',
        'Onayınızı bekleyen masraf',
        event.sonraki
          ? `${f.sahip.adSoyad} adlı kişinin ${quoted(f)} masrafı (${amountOf(f)}) önceki onaydan geçti ve onayınızı bekliyor.`
          : `${f.sahip.adSoyad}, ${quoted(f)} masrafını (${amountOf(f)}) onayınıza gönderdi.`,
      );
      break;
    case 'devredildi':
      if (event.bekliyor) {
        add(event.onayciId, 'onay_bekliyor', 'Onayınızı bekleyen masraf', `${f.sahip.adSoyad} adlı kişinin ${quoted(f)} masrafının (${amountOf(f)}) onayı size devredildi ve kararınızı bekliyor.`);
      } else {
        add(
          event.onayciId,
          'devredildi',
          'Size devredilen onay',
          `${f.sahip.adSoyad} adlı kişinin ${quoted(f)} masrafının (${amountOf(f)}) ${event.sira}. onay adımı size devredildi. Sıra size geldiğinde onayınız istenecek.`,
        );
      }
      break;
    case 'onaylandi':
      add(f.sahip.id, 'onaylandi', 'Masrafınız onaylandı', `${quoted(f)} masrafınız (${amountOf(f)}) onaylandı. Onay belgesi ektedir.`, 'masraf_pdf');
      for (const id of event.muhasebeIds) {
        add(id, 'odeme_bekliyor', 'Ödeme bekleyen masraf', `${f.sahip.adSoyad} adlı kişinin ${quoted(f)} masrafı (${amountOf(f)}) onaylandı ve ödeme bekliyor.`);
      }
      break;
    case 'reddedildi':
      add(f.sahip.id, 'reddedildi', 'Masrafınız reddedildi', `${quoted(f)} masrafınız (${amountOf(f)}) ${event.reddeden} tarafından reddedildi. Gerekçe: ${event.gerekce}`);
      break;
    case 'odendi':
      add(f.sahip.id, 'odendi', 'Masrafınız ödendi', `${quoted(f)} masrafınız (${amountOf(f)}) ödendi olarak işaretlendi.`);
      break;
    case 'hatirlatma':
      add(
        event.onayciId,
        'hatirlatma',
        'Onay hatırlatması',
        `${f.sahip.adSoyad} adlı kişinin ${quoted(f)} masrafı (${amountOf(f)}) ${event.saat} saatten uzun süredir onayınızı bekliyor.`,
      );
      break;
    case 'okuma_bitti':
      add(f.sahip.id, 'okuma_bitti', 'Faturalarınız okundu', `${quoted(f)} masrafınızın faturaları okundu. Kontrol edip onaya gönderebilirsiniz.`);
      break;
    case 'okuma_hatasi':
      add(
        f.sahip.id,
        'okuma_hatasi',
        'Okunamayan fatura var',
        `${quoted(f)} masrafınızın ${event.hatali === 1 ? 'bir faturası' : `${event.hatali} faturası`} okunamadı. Masrafı açıp yeniden okutun ya da faturayı kaldırın.`,
      );
      break;
    case 'onaya_gonderildi':
      add(f.sahip.id, 'onaya_gonderildi', 'Masrafınız onaya gönderildi', `${quoted(f)} masrafınızın faturaları okundu ve masrafınız (${amountOf(f)}) onaya gönderildi.`);
      break;
    case 'onaya_gonderilemedi':
      add(
        f.sahip.id,
        'onaya_gonderilemedi',
        'Masrafınız onaya gönderilemedi',
        `${quoted(f)} masrafınızın faturaları okundu ama masraf onaya gönderilemedi: ${event.neden} Masrafı açıp tamamlayın ve gönderin.`,
      );
      break;
  }
  return out;
}

/** Whether a mail goes to this recipient: only active users who want mail. In-app notifications always do. */
export const wantsMail = (recipient: { readonly aktif: boolean; readonly mailBildirim: boolean }): boolean => recipient.aktif && recipient.mailBildirim;
