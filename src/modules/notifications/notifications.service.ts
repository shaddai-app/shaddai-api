import { z } from 'zod';
import { env } from '../../config/env.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { PaginationQuery, paged, toSkipTake } from '../../core/http/pagination.js';
import { logger } from '../../core/logger.js';
import { sendMail } from '../../core/mail/mailer.js';
import { actionMail, resolveMailLocale } from '../../core/mail/templates.js';
import {
  formatters,
  MAIL_FOOTER,
  NOTIFICATION_TYPE_KEYS,
  NOTIFICATION_TYPES,
  type NotificationParams,
  type NotificationType,
} from './types.js';

// Centro de notificaciones: cada aviso es para un usuario; respeta sus preferencias (en la app y
// por mail). Los mails salen después de guardar, sin frenar la respuesta: un SMTP lento o caído no
// rompe la acción que generó el aviso.

export interface TypePrefs {
  inApp: boolean;
  email: boolean;
}

type Prefs = Record<NotificationType, TypePrefs>;

export function parsePrefs(raw: string | null): Prefs {
  let stored: Record<string, Partial<TypePrefs>> = {};
  try {
    const value: unknown = raw ? JSON.parse(raw) : {};
    if (value && typeof value === 'object') stored = value as typeof stored;
  } catch {
    // preferencias corruptas: se usan los valores por defecto
  }
  return Object.fromEntries(
    NOTIFICATION_TYPE_KEYS.map((type) => {
      const s = stored[type] ?? {};
      return [
        type,
        {
          inApp: typeof s.inApp === 'boolean' ? s.inApp : true,
          email: typeof s.email === 'boolean' ? s.email : NOTIFICATION_TYPES[type].email,
        },
      ];
    }),
  ) as Prefs;
}

// ───────────── Envío ─────────────

/** Mails en curso (los tests esperan a que terminen con `emailsSettled`). */
const pending = new Set<Promise<void>>();
export const emailsSettled = () => Promise.allSettled([...pending]).then(() => undefined);

/**
 * Crea el aviso para cada usuario (activo, de la cuenta actual) según sus preferencias. Devuelve
 * cuántos se guardaron en la app. `link` es una ruta del front ("/mis-turnos").
 */
export async function notify(input: {
  userIds: number[];
  type: NotificationType;
  params: NotificationParams;
  link: string;
}): Promise<number> {
  const ids = [...new Set(input.userIds)];
  if (!ids.length) return 0;
  const accountId = currentAccountId();
  const db = tenantDb();
  const [users, account] = await Promise.all([
    db.user.findMany({
      where: { id: { in: ids }, isActive: true, deletedAt: null },
      select: { id: true, email: true, firstName: true, locale: true, notificationPrefs: true },
    }),
    db.account.findUniqueOrThrow({ where: { id: accountId }, select: { defaultLocale: true } }),
  ]);
  const params = JSON.stringify(input.params);
  let saved = 0;
  for (const user of users) {
    const prefs = parsePrefs(user.notificationPrefs)[input.type];
    const row = prefs.inApp
      ? await db.notification.create({
          data: { accountId, userId: user.id, type: input.type, params, link: input.link },
          select: { id: true },
        })
      : null;
    if (row) saved++;
    if (prefs.email) {
      const locale = resolveMailLocale(user.locale, account.defaultLocale);
      const job = deliver(row?.id ?? null, user.email, locale, input.type, input.params, input.link);
      pending.add(job);
      void job.finally(() => pending.delete(job));
    }
  }
  return saved;
}

async function deliver(
  notificationId: number | null,
  to: string,
  locale: ReturnType<typeof resolveMailLocale>,
  type: NotificationType,
  params: NotificationParams,
  link: string,
) {
  try {
    const copy = NOTIFICATION_TYPES[type].mail[locale];
    const f = formatters(locale);
    const subject = copy.subject(params, f);
    await sendMail({
      to,
      ...actionMail(subject, [...copy.body(params, f), MAIL_FOOTER[locale]], {
        label: copy.action,
        url: `${env.APP_URL}${link}`,
      }),
    });
    // La promesa nace en el request: conserva su contexto (cuenta) aunque termine después.
    if (notificationId) {
      await tenantDb().notification.update({
        where: { id: notificationId },
        data: { emailedAt: new Date() },
      });
    }
  } catch (err) {
    logger.error({ err, notificationId, type }, 'notification mail failed');
  }
}

// ───────────── Centro de notificaciones ─────────────

export const ListQuery = PaginationQuery.extend({
  unread: z.stringbool().default(false),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

const parseParams = (raw: string | null): NotificationParams => {
  try {
    return raw ? (JSON.parse(raw) as NotificationParams) : {};
  } catch {
    return {};
  }
};

export async function listNotifications(userId: number, q: z.infer<typeof ListQuery>) {
  const db = tenantDb();
  const where = { userId, ...(q.unread ? { readAt: null } : {}) };
  const [rows, total, unread] = await Promise.all([
    db.notification.findMany({
      where,
      select: { id: true, type: true, params: true, link: true, readAt: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...toSkipTake(q),
    }),
    db.notification.count({ where }),
    db.notification.count({ where: { userId, readAt: null } }),
  ]);
  const items = rows.map((r) => ({ ...r, params: parseParams(r.params) }));
  return { ...paged(items, total, q), unread };
}

export async function unreadCount(userId: number) {
  return { count: await tenantDb().notification.count({ where: { userId, readAt: null } }) };
}

export async function markRead(userId: number, id: number) {
  const db = tenantDb();
  const found = await db.notification.findFirst({ where: { id, userId }, select: { readAt: true } });
  if (!found) throw AppError.notFound('NOTIFICATION_NOT_FOUND');
  if (!found.readAt) await db.notification.update({ where: { id }, data: { readAt: new Date() } });
  return unreadCount(userId);
}

export async function markAllRead(userId: number) {
  await tenantDb().notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
  return { count: 0 };
}

// ───────────── Preferencias ─────────────

export const PrefsSchema = z
  .object({
    prefs: z
      .array(
        z
          .object({
            type: z.enum(NOTIFICATION_TYPE_KEYS as [NotificationType, ...NotificationType[]]),
            inApp: z.boolean().optional(),
            email: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

const prefsList = (prefs: Prefs) => NOTIFICATION_TYPE_KEYS.map((type) => ({ type, ...prefs[type] }));

export async function getPrefs(userId: number) {
  const user = await tenantDb().user.findUniqueOrThrow({
    where: { id: userId },
    select: { notificationPrefs: true },
  });
  return { items: prefsList(parsePrefs(user.notificationPrefs)) };
}

export async function setPrefs(userId: number, input: z.infer<typeof PrefsSchema>) {
  const user = await tenantDb().user.findUniqueOrThrow({
    where: { id: userId },
    select: { notificationPrefs: true },
  });
  const prefs = parsePrefs(user.notificationPrefs);
  for (const p of input.prefs) {
    if (p.inApp !== undefined) prefs[p.type].inApp = p.inApp;
    if (p.email !== undefined) prefs[p.type].email = p.email;
  }
  await tenantDb().user.update({ where: { id: userId }, data: { notificationPrefs: JSON.stringify(prefs) } });
  return { items: prefsList(prefs) };
}
