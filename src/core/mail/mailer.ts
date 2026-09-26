import nodemailer from 'nodemailer';
import { env } from '../../config/env.js';
import { logger } from '../logger.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Bandeja en memoria para tests (MAIL_TRANSPORT=memory). */
export const memoryOutbox: MailMessage[] = [];

const smtp =
  env.MAIL_TRANSPORT === 'smtp'
    ? nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
      })
    : null;

export async function sendMail(message: MailMessage): Promise<void> {
  switch (env.MAIL_TRANSPORT) {
    case 'memory':
      memoryOutbox.push(message);
      return;
    case 'console':
      // Solo desarrollo: permite probar flujos de mail sin servidor SMTP.
      logger.info({ to: message.to, subject: message.subject }, `[mail]\n${message.text}`);
      return;
    case 'smtp':
      await smtp!.sendMail({ from: env.MAIL_FROM, ...message });
      return;
  }
}
