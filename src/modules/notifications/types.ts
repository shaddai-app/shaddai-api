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
  /** "2026-10-04" → "4 de octubre". */
  date: (iso: unknown) => string;
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
  // Proceso diario: a quienes prestan equipos, por cada préstamo vencido.
  'loan.overdue': {
    email: true,
    mail: {
      es: {
        subject: (p) => `Préstamo vencido: ${s(p.item)}`,
        body: (p, f) => [
          `El préstamo de ${s(p.item)} (${s(p.code)}) a ${s(p.person)} venció el ${f.date(p.dueAt)} y todavía no se devolvió.`,
          'Registrá la devolución o extendé el vencimiento.',
        ],
        action: 'Ver préstamos',
      },
      en: {
        subject: (p) => `Overdue loan: ${s(p.item)}`,
        body: (p, f) => [
          `The loan of ${s(p.item)} (${s(p.code)}) to ${s(p.person)} was due on ${f.date(p.dueAt)} and hasn’t been returned.`,
          'Record the return or extend the due date.',
        ],
        action: 'See loans',
      },
      pt: {
        subject: (p) => `Empréstimo vencido: ${s(p.item)}`,
        body: (p, f) => [
          `O empréstimo de ${s(p.item)} (${s(p.code)}) para ${s(p.person)} venceu em ${f.date(p.dueAt)} e ainda não foi devolvido.`,
          'Registre a devolução ou prorrogue o vencimento.',
        ],
        action: 'Ver empréstimos',
      },
    },
  },
  // Proceso diario: al consolidador del caso (o, sin consolidador, a quienes asignan casos).
  'consolidation.overdue': {
    email: true,
    mail: {
      es: {
        subject: (p) => `Seguimiento vencido: ${s(p.person)}`,
        body: (p, f) => [
          `El paso actual del seguimiento de ${s(p.person)} venció el ${f.date(p.dueAt)}.`,
          p.unassigned
            ? 'El caso no tiene consolidador: asigná a alguien para que lo acompañe.'
            : 'Contactala o contactalo y registrá cómo sigue.',
        ],
        action: 'Ver el caso',
      },
      en: {
        subject: (p) => `Overdue follow-up: ${s(p.person)}`,
        body: (p, f) => [
          `The current step of ${s(p.person)}’s follow-up was due on ${f.date(p.dueAt)}.`,
          p.unassigned
            ? 'The case has no consolidator: assign someone to walk with them.'
            : 'Get in touch and record how it’s going.',
        ],
        action: 'See the case',
      },
      pt: {
        subject: (p) => `Acompanhamento vencido: ${s(p.person)}`,
        body: (p, f) => [
          `A etapa atual do acompanhamento de ${s(p.person)} venceu em ${f.date(p.dueAt)}.`,
          p.unassigned
            ? 'O caso não tem consolidador: designe alguém para acompanhá-lo.'
            : 'Entre em contato e registre como está.',
        ],
        action: 'Ver o caso',
      },
    },
  },
  // Proceso diario: al líder de la célula que no cargó el reporte de su reunión.
  'cell.report_missing': {
    email: true,
    mail: {
      es: {
        subject: (p) => `Falta el reporte de ${s(p.cell)}`,
        body: (p, f) => [
          `Todavía no está cargado el reporte de la reunión de ${s(p.cell)} del ${f.date(p.date)}.`,
          'Cargalo desde «Mi célula», aunque no se haya hecho la reunión.',
        ],
        action: 'Cargar el reporte',
      },
      en: {
        subject: (p) => `Missing report: ${s(p.cell)}`,
        body: (p, f) => [
          `The report for ${s(p.cell)}’s meeting on ${f.date(p.date)} hasn’t been submitted yet.`,
          'Submit it from “My cell”, even if the meeting didn’t take place.',
        ],
        action: 'Submit the report',
      },
      pt: {
        subject: (p) => `Falta o relatório de ${s(p.cell)}`,
        body: (p, f) => [
          `O relatório da reunião de ${s(p.cell)} de ${f.date(p.date)} ainda não foi enviado.`,
          'Envie em «Minha célula», mesmo que a reunião não tenha acontecido.',
        ],
        action: 'Enviar o relatório',
      },
    },
  },
  // Anuncio publicado, a su audiencia. Por mail solo si el usuario lo pide en sus preferencias.
  'announcement.published': {
    email: false,
    mail: {
      es: {
        subject: (p) => `Anuncio: ${s(p.title)}`,
        body: (p) => [`${s(p.author)} publicó un anuncio: «${s(p.title)}».`],
        action: 'Leer el anuncio',
      },
      en: {
        subject: (p) => `Announcement: ${s(p.title)}`,
        body: (p) => [`${s(p.author)} posted an announcement: “${s(p.title)}”.`],
        action: 'Read the announcement',
      },
      pt: {
        subject: (p) => `Anúncio: ${s(p.title)}`,
        body: (p) => [`${s(p.author)} publicou um anúncio: «${s(p.title)}».`],
        action: 'Ler o anúncio',
      },
    },
  },
  // Petición de oración para el líder de célula del autor o para los pastores. El texto de la
  // petición no va en el aviso ni en el mail: se lee en Shaddai.
  'prayer.request': {
    email: true,
    mail: {
      es: {
        subject: (p) => `Petición de oración de ${s(p.author)}`,
        body: (p) => [
          p.visibility === 'leader'
            ? `${s(p.author)}, de tu célula, te compartió una petición de oración.`
            : `${s(p.author)} compartió una petición de oración con los pastores.`,
        ],
        action: 'Leer la petición',
      },
      en: {
        subject: (p) => `Prayer request from ${s(p.author)}`,
        body: (p) => [
          p.visibility === 'leader'
            ? `${s(p.author)}, from your cell, shared a prayer request with you.`
            : `${s(p.author)} shared a prayer request with the pastors.`,
        ],
        action: 'Read the request',
      },
      pt: {
        subject: (p) => `Pedido de oração de ${s(p.author)}`,
        body: (p) => [
          p.visibility === 'leader'
            ? `${s(p.author)}, da sua célula, compartilhou um pedido de oração com você.`
            : `${s(p.author)} compartilhou um pedido de oração com os pastores.`,
        ],
        action: 'Ler o pedido',
      },
    },
  },
  // A los dueños de la cuenta: venció el pago (más los días de gracia) y quedó en solo lectura.
  'billing.past_due': {
    email: true,
    mail: {
      es: {
        subject: () => 'Shaddai: venció el pago de tu iglesia',
        body: (p, f) => [
          `El servicio estaba pagado hasta el ${f.date(p.paidUntil)} y no registramos un pago nuevo.`,
          'La cuenta quedó en solo lectura: se puede consultar todo, pero no cargar ni editar. Al pagar, vuelve a funcionar enseguida.',
        ],
        action: 'Ver facturación',
      },
      en: {
        subject: () => 'Shaddai: your church’s payment is overdue',
        body: (p, f) => [
          `The service was paid until ${f.date(p.paidUntil)} and we haven’t received a new payment.`,
          'The account is now read-only: everything can be viewed but not added or edited. It works again as soon as you pay.',
        ],
        action: 'See billing',
      },
      pt: {
        subject: () => 'Shaddai: o pagamento da sua igreja venceu',
        body: (p, f) => [
          `O serviço estava pago até ${f.date(p.paidUntil)} e não registramos um novo pagamento.`,
          'A conta ficou somente leitura: dá para consultar tudo, mas não cadastrar nem editar. Ao pagar, volta a funcionar na hora.',
        ],
        action: 'Ver faturamento',
      },
    },
  },
  // Al autor, la primera vez que alguien marca "Estoy orando" en su petición.
  'prayer.praying': {
    email: false,
    mail: {
      es: {
        subject: (p) => `${s(p.person)} está orando por vos`,
        body: (p) => [`${s(p.person)} está orando por tu petición.`],
        action: 'Ver la petición',
      },
      en: {
        subject: (p) => `${s(p.person)} is praying for you`,
        body: (p) => [`${s(p.person)} is praying for your request.`],
        action: 'See the request',
      },
      pt: {
        subject: (p) => `${s(p.person)} está orando por você`,
        body: (p) => [`${s(p.person)} está orando pelo seu pedido.`],
        action: 'Ver o pedido',
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
  const dateFmt = new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
  });
  return {
    date: (iso) =>
      typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso)
        ? dateFmt.format(new Date(`${iso}T00:00:00Z`))
        : '',
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
