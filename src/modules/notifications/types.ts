import type { MailLocale } from '../../core/mail/templates.js';

// Catálogo de avisos. Cada tipo define si por defecto llega por mail (en la app llega siempre,
// salvo que el usuario lo apague) y el texto del mail en cada idioma. El front tiene su propia
// traducción para el centro de notificaciones (type + params).

export interface NotificationParams {
  [key: string]: string | number | null | undefined;
}

interface MailCopy {
  subject: (p: NotificationParams, f: Formatters) => string;
  body: (p: NotificationParams, f: Formatters) => string[];
  action: string;
}

interface Formatters {
  /** "2026-10-04T10:00" (hora local de la iglesia) → "domingo 4 de octubre, 10:00". */
  dateTime: (local: unknown) => string;
}

interface TypeDef {
  /** Valor por defecto de la preferencia de mail. */
  email: boolean;
  mail: Record<MailLocale, MailCopy>;
}

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

export const NOTIFICATION_TYPES = {
  // A la persona asignada a un turno.
  'assignment.created': {
    email: true,
    mail: {
      es: {
        subject: (p) => `Te asignaron: ${s(p.role)} en ${s(p.event)}`,
        body: (p, f) => [
          `Te asignaron como ${s(p.role)} (${s(p.ministry)}) para ${s(p.event)}, el ${f.dateTime(p.startsAt)}.`,
          'Confirmá o avisá si no podés desde «Mis turnos».',
        ],
        action: 'Ver mis turnos',
      },
      en: {
        subject: (p) => `You were scheduled: ${s(p.role)} at ${s(p.event)}`,
        body: (p, f) => [
          `You were scheduled as ${s(p.role)} (${s(p.ministry)}) for ${s(p.event)} on ${f.dateTime(p.startsAt)}.`,
          'Accept it or let us know if you can’t make it from “My schedule”.',
        ],
        action: 'See my schedule',
      },
      pt: {
        subject: (p) => `Você foi escalado: ${s(p.role)} em ${s(p.event)}`,
        body: (p, f) => [
          `Você foi escalado como ${s(p.role)} (${s(p.ministry)}) para ${s(p.event)}, em ${f.dateTime(p.startsAt)}.`,
          'Confirme ou avise se não puder em «Minhas escalas».',
        ],
        action: 'Ver minhas escalas',
      },
    },
  },
  // A quien asignó el turno y a los líderes del ministerio.
  'assignment.declined': {
    email: true,
    mail: {
      es: {
        subject: (p, f) => `${s(p.person)} no puede servir el ${f.dateTime(p.startsAt)}`,
        body: (p, f) => [
          `${s(p.person)} avisó que no puede servir como ${s(p.role)} (${s(p.ministry)}) en ${s(p.event)}, el ${f.dateTime(p.startsAt)}.`,
          ...(p.reason ? [`Motivo: ${s(p.reason)}`] : []),
          'Podés asignar a otra persona desde los turnos del ministerio.',
        ],
        action: 'Ver los turnos',
      },
      en: {
        subject: (p, f) => `${s(p.person)} can’t serve on ${f.dateTime(p.startsAt)}`,
        body: (p, f) => [
          `${s(p.person)} said they can’t serve as ${s(p.role)} (${s(p.ministry)}) at ${s(p.event)} on ${f.dateTime(p.startsAt)}.`,
          ...(p.reason ? [`Reason: ${s(p.reason)}`] : []),
          'You can schedule someone else from the ministry schedule.',
        ],
        action: 'See the schedule',
      },
      pt: {
        subject: (p, f) => `${s(p.person)} não pode servir em ${f.dateTime(p.startsAt)}`,
        body: (p, f) => [
          `${s(p.person)} avisou que não pode servir como ${s(p.role)} (${s(p.ministry)}) em ${s(p.event)}, em ${f.dateTime(p.startsAt)}.`,
          ...(p.reason ? [`Motivo: ${s(p.reason)}`] : []),
          'Você pode escalar outra pessoa nas escalas do ministério.',
        ],
        action: 'Ver as escalas',
      },
    },
  },
} satisfies Record<string, TypeDef>;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;
export const NOTIFICATION_TYPE_KEYS = Object.keys(NOTIFICATION_TYPES) as NotificationType[];

const intlLocale = (l: MailLocale) => ({ es: 'es-AR', en: 'en-US', pt: 'pt-BR' })[l];

export function formatters(locale: MailLocale): Formatters {
  const fmt = new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: 'UTC', // el valor ya es hora local de la iglesia
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
  return {
    dateTime: (local) => {
      const text = typeof local === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local) ? local : null;
      return text ? fmt.format(new Date(`${text}:00Z`)) : '';
    },
  };
}

export const MAIL_FOOTER: Record<MailLocale, string> = {
  es: 'Podés elegir qué avisos te llegan por mail en Configuración → Notificaciones.',
  en: 'You can choose which notices reach you by email in Settings → Notifications.',
  pt: 'Você pode escolher quais avisos chegam por e-mail em Configurações → Notificações.',
};
