// Who an event notifies, with which type and text, and the mails (docs/onay-sistemi.md, section 7). No database.
import { describe, expect, it } from 'vitest';
import { planNotifications, wantsMail, type FormRef } from '../../src/notifications/events.ts';
import { escapeHtml, formLink, renderNotificationMail, renderTestMail, subjectLine } from '../../src/notifications/mail-templates.ts';
import { cleanError, retryDelayMs } from '../../src/notifications/outbox.ts';
import { localDay, reminderDue } from '../../src/notifications/reminders.ts';

const form: FormRef = { id: 1001, baslik: 'Müşteri yemeği', sahip: { id: 3, adSoyad: 'Ayşe Kaya' }, tutar: 1800, paraBirimi: 'TRY', durum: 'onayda' };

describe('planNotifications', () => {
  it('tells the approver a form waits, in the words of the contract', () => {
    expect(planNotifications({ kind: 'onay_bekliyor', form, onayciId: 2, sonraki: false }, 3)).toEqual([
      { kullaniciId: 2, tur: 'onay_bekliyor', baslik: 'Onayınızı bekleyen masraf', mesaj: 'Ayşe Kaya, "Müşteri yemeği" masrafını (1.800,00 TRY) onayınıza gönderdi.', ek: null },
    ]);
    expect(planNotifications({ kind: 'onay_bekliyor', form, onayciId: 2, sonraki: true }, 5)[0]?.mesaj).toContain('önceki onaydan geçti');
  });

  it('tells a new approver of a handed step: waiting now, or later as information', () => {
    expect(planNotifications({ kind: 'devredildi', form, onayciId: 7, sira: 1, bekliyor: true }, 1).map((n) => n.tur)).toEqual(['onay_bekliyor']);
    const later = planNotifications({ kind: 'devredildi', form, onayciId: 7, sira: 2, bekliyor: false }, 1);
    expect(later).toMatchObject([{ kullaniciId: 7, tur: 'devredildi' }]);
    expect(later[0]?.mesaj).toContain('2. onay adımı size devredildi');
  });

  it('tells the owner with the document and every accountant once at the last approval', () => {
    const planned = planNotifications({ kind: 'onaylandi', form: { ...form, durum: 'onaylandi' }, muhasebeIds: [8, 9, 8] }, 2);
    expect(planned.map((n) => [n.kullaniciId, n.tur, n.ek])).toEqual([
      [3, 'onaylandi', 'masraf_pdf'],
      [8, 'odeme_bekliyor', null],
      [9, 'odeme_bekliyor', null],
    ]);
  });

  it('gives the reason of a rejection and tells the owner of the payment', () => {
    const rejected = planNotifications({ kind: 'reddedildi', form, reddeden: 'Mehmet Demir', gerekce: 'Fiş okunmuyor' }, 2);
    expect(rejected).toMatchObject([{ kullaniciId: 3, tur: 'reddedildi' }]);
    expect(rejected[0]?.mesaj).toContain('Gerekçe: Fiş okunmuyor');
    expect(planNotifications({ kind: 'odendi', form }, 8)).toMatchObject([{ kullaniciId: 3, tur: 'odendi' }]);
    expect(planNotifications({ kind: 'hatirlatma', form, onayciId: 2, saat: 24 }, null)).toMatchObject([{ kullaniciId: 2, tur: 'hatirlatma' }]);
  });

  it('never tells the actor of their own action', () => {
    // An accountant who approves last is not told the form waits for payment.
    expect(planNotifications({ kind: 'onaylandi', form, muhasebeIds: [8] }, 8).map((n) => n.kullaniciId)).toEqual([3]);
    expect(planNotifications({ kind: 'odendi', form }, 3)).toEqual([]);
    expect(planNotifications({ kind: 'devredildi', form, onayciId: 1, sira: 1, bekliyor: true }, 1)).toEqual([]);
  });

  it('mails only active users who want mail', () => {
    expect(wantsMail({ aktif: true, mailBildirim: true })).toBe(true);
    expect(wantsMail({ aktif: false, mailBildirim: true })).toBe(false);
    expect(wantsMail({ aktif: true, mailBildirim: false })).toBe(false);
  });
});

describe('mail templates', () => {
  const evil: FormRef = { ...form, baslik: '<script>alert("x")</script> & \'yemek\'\r\nBcc: kurban@firma.test', sahip: { id: 3, adSoyad: 'Ayşe <b>Kaya</b>' } };

  it('escapes every value in the HTML and keeps the plain text as it is', () => {
    const mail = renderNotificationMail({ alici: 'Mehmet <i>', baslik: 'Onayınızı bekleyen masraf', mesaj: 'Mesaj <img src=x onerror=alert(1)>', form: evil, appUrl: null });
    expect(mail.html).not.toMatch(/<script|<img|<b>|<i>/);
    expect(mail.html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;yemek&#39;');
    expect(mail.html).toContain('Ayşe &lt;b&gt;Kaya&lt;/b&gt;');
    expect(mail.metin).toContain('Mesaj <img src=x onerror=alert(1)>');
    expect(mail.metin).toContain('Tutar: 1.800,00 TRY');
    expect(mail.metin).toContain('Durum: Onayda');
  });

  it('keeps line breaks and control characters out of the subject', () => {
    const mail = renderNotificationMail({ alici: 'M', baslik: 'Onay\nbekliyor', mesaj: 'm', form: evil, appUrl: null });
    expect(mail.konu).not.toMatch(/[\r\n\u0000-\u001f]/);
    expect(mail.konu.startsWith('Masraf: Onay bekliyor - <script>')).toBe(true);
    expect(subjectLine(`a b\u0000c${'x'.repeat(300)}`)).toHaveLength(200);
  });

  it('links to the form only when UYGULAMA_ADRESI is set', () => {
    const without = renderNotificationMail({ alici: 'M', baslik: 'B', mesaj: 'm', form, appUrl: null });
    expect(without.html).not.toContain('<a ');
    expect(without.metin).not.toContain('http');
    const withLink = renderNotificationMail({ alici: 'M', baslik: 'B', mesaj: 'm', form, appUrl: 'http://192.168.1.10:4000' });
    expect(withLink.html).toContain('<a href="http://192.168.1.10:4000/#/masraflar/1001">');
    expect(withLink.metin).toContain('http://192.168.1.10:4000/#/masraflar/1001');
    expect(formLink(null, 1)).toBeNull();
    expect(renderTestMail(null).html).not.toContain('<a ');
  });

  it('escapes the five HTML characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});

describe('outbox rules', () => {
  it('waits 1, 5, 15 and 60 minutes after failed attempts, then 60', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => retryDelayMs(n) / 60_000)).toEqual([1, 5, 15, 60, 60, 60]);
  });

  it('writes a short, single-line error without the SMTP password', () => {
    const err = Object.assign(new Error('Invalid login: 535 user=masraf pass=S3cr3t!\r\n5.7.8 rejected'), { code: 'EAUTH', responseCode: 535 });
    const text = cleanError(err, ['S3cr3t!', null]);
    expect(text).toBe('EAUTH 535: Invalid login: 535 user=masraf pass=*** 5.7.8 rejected');
    expect(cleanError(new Error('x'.repeat(1000))).length).toBe(300);
    expect(cleanError('dize')).toBe('dize');
  });
});

describe('reminder schedule', () => {
  const settings = { waitHours: 24, hour: 9, minute: 30 };
  it('runs once a day after the configured local time, and never when turned off', () => {
    const before = new Date(2026, 10, 7, 9, 29);
    const after = new Date(2026, 10, 7, 9, 30);
    expect(reminderDue(before, settings, null)).toBe(false);
    expect(reminderDue(after, settings, null)).toBe(true);
    expect(reminderDue(after, settings, localDay(after))).toBe(false);
    expect(reminderDue(new Date(2026, 10, 8, 9, 31), settings, localDay(after))).toBe(true);
    expect(reminderDue(after, { ...settings, waitHours: 0 }, null)).toBe(false);
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});
