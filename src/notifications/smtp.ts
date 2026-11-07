// The production mail transport: nodemailer over SMTP, built only when MAIL_GONDERIM=smtp.
import nodemailer from 'nodemailer';
import type { SmtpSettings } from '../config.ts';
import type { SendMail } from './outbox.ts';

export function smtpSender(s: SmtpSettings): SendMail {
  const transport = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.guvenlik === 'tls',
    requireTLS: s.guvenlik === 'starttls',
    ignoreTLS: s.guvenlik === 'yok',
    ...(s.kullanici !== null ? { auth: { user: s.kullanici, pass: s.sifre ?? '' } } : {}),
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 60_000,
    // Mails carry only what the service built; never read local files or URLs into them.
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return async (mail) => {
    await transport.sendMail({
      from: mail.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      ...(mail.attachments !== undefined ? { attachments: mail.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })) } : {}),
    });
  };
}
