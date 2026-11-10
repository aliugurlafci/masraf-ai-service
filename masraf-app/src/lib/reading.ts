import type { MasrafDetay, OkumaOzeti } from '@/api/types';

/** How the server starts the history line of a failed "okununca gönder" attempt; the reason follows. */
const AUTO_SEND_FAILED = 'Okununca gönder: masraf onaya gönderilemedi.';

/**
 * Why "okununca gönder" could not send the form right after the owner's own save or edit. No notification
 * is written for the owner's own action (contract section 3); the reason is in the form's latest history
 * line. Points to the history when that line is not the failure.
 */
export function autoSendFailure(detail: MasrafDetay): string {
  const note = detail.gecmis[detail.gecmis.length - 1]?.aciklama ?? null;
  return note !== null && note.startsWith(AUTO_SEND_FAILED) ? note : 'Masraf onaya gönderilemedi; nedenini masrafın geçmişinde bulabilirsiniz.';
}

/**
 * A queued file's place in the shared reading queue: "Sırada 3. · önünde 4 fatura var", or just "Sırada"
 * while the server does not know its place yet (both values null).
 */
export function queueText(kuyrukSirasi: number | null, onundeki: number | null): string {
  if (kuyrukSirasi === null) return 'Sırada';
  if (onundeki === null) return `Sırada ${kuyrukSirasi}.`;
  if (onundeki === 0) return `Sırada ${kuyrukSirasi}. · birazdan okunacak`;
  return `Sırada ${kuyrukSirasi}. · önünde ${onundeki} fatura var`;
}

/** A list row's reading badge: "2 fatura okunuyor · 1 fatura okunamadı"; null when nothing is pending. */
export function readingBadge(okuma: OkumaOzeti | null): { readonly text: string; readonly failed: boolean } | null {
  if (okuma === null || okuma.bekleyen + okuma.hatali === 0) return null;
  const parts = [okuma.bekleyen > 0 ? `${okuma.bekleyen} fatura okunuyor` : null, okuma.hatali > 0 ? `${okuma.hatali} fatura okunamadı` : null];
  return { text: parts.filter((p) => p !== null).join(' · '), failed: okuma.hatali > 0 };
}
