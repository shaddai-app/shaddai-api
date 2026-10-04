import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { audit } from '../../core/audit/audit.js';
import { decryptSecret } from '../../core/auth/totp.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { paged, PaginationQuery, toSkipTake } from '../../core/http/pagination.js';
import { sendMail } from '../../core/mail/mailer.js';
import { prayerMail, resolveMailLocale } from '../../core/mail/templates.js';
import { reportError } from '../../core/observability/sentry.js';
import { getPermissions } from '../../core/rbac/permission-cache.js';
import { notify } from '../notifications/notifications.service.js';

// Peticiones de oración. Cada una la ven su autor, quien tiene oracion.pastoral y, según la
// visibilidad, toda la iglesia (public) o el líder y colíder de la célula del autor (leader). Las
// "pastors" no las ve nadie más. El texto nunca va en avisos ni en la auditoría.
//
// Las del formulario público (source = form) no tienen autor con usuario: nacen "pastors" y quien
// pidió vuelve con su enlace privado (public-prayer.service.ts). Las respuestas escritas son privadas
// entre el autor y el equipo que la atiende: oracion.pastoral y, si es "leader", su líder.

export const VISIBILITIES = ['public', 'pastors', 'leader'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const CreatePrayerSchema = z
  .object({
    body: z.string().trim().min(1).max(1000),
    visibility: z.enum(VISIBILITIES),
    anonymous: z.boolean().default(false),
  })
  .strict();

export const UpdatePrayerSchema = z
  .object({
    body: z.string().trim().min(1).max(1000),
    visibility: z.enum(VISIBILITIES),
    anonymous: z.boolean(),
    status: z.enum(['open', 'answered']),
    testimony: z.string().trim().max(1000).nullable(),
  })
  .partial()
  .strict();

export const ReplySchema = z.object({ body: z.string().trim().min(1).max(1000) }).strict();

export const PrayerQuery = PaginationQuery.extend({
  tab: z.enum(['open', 'answered', 'mine', 'received']).default('open'),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

/** Quién mira: define qué peticiones ve y si ve el nombre de las anónimas. */
export interface Viewer {
  userId: number;
  personId: number | null;
  pastoral: boolean;
}

export async function viewerOf(userId: number): Promise<Viewer> {
  const user = await tenantDb().user.findUniqueOrThrow({ where: { id: userId }, select: { personId: true } });
  const permissions = await getPermissions(userId);
  return { userId, personId: user.personId, pastoral: Boolean(permissions['oracion.pastoral']) };
}

function visibleWhere(v: Viewer): Prisma.PrayerRequestWhereInput {
  if (v.pastoral) return { deletedAt: null };
  const or: Prisma.PrayerRequestWhereInput[] = [{ createdById: v.userId }, { visibility: 'public' }];
  if (v.personId) {
    const led = { OR: [{ leaderPersonId: v.personId }, { coLeaderPersonId: v.personId }] };
    or.push({
      visibility: 'leader',
      createdBy: {
        person: {
          cellMemberships: { some: { leftAt: null, cell: { status: { not: 'closed' }, ...led } } },
        },
      },
    });
  }
  return { deletedAt: null, OR: or };
}

const select = (viewerId: number) =>
  ({
    id: true,
    body: true,
    visibility: true,
    anonymous: true,
    status: true,
    answeredAt: true,
    testimony: true,
    createdAt: true,
    source: true,
    requesterName: true,
    requesterPhone: true,
    requesterEmail: true,
    wantsContact: true,
    wallShare: true,
    contactedAt: true,
    contactedBy: { select: { firstName: true, lastName: true } },
    createdBy: { select: { id: true, firstName: true, lastName: true } },
    prayers: { where: { userId: viewerId }, select: { userId: true } },
    _count: { select: { prayers: true, replies: true } },
  }) satisfies Prisma.PrayerRequestSelect;

type Row = Prisma.PrayerRequestGetPayload<{ select: ReturnType<typeof select> }>;

const fullName = (u: { firstName: string; lastName: string }) => `${u.firstName} ${u.lastName}`;

/**
 * El equipo que la atiende: quien tiene oracion.pastoral o, si es "para el líder", su líder. Si la
 * ve alguien que no es el autor ni pastor y es "leader", es porque lidera la célula del autor.
 */
const isTeam = (row: Pick<Row, 'visibility'>, v: Viewer, mine: boolean) =>
  v.pastoral || (row.visibility === 'leader' && !mine);

function present(row: Row, v: Viewer) {
  const {
    createdBy,
    prayers,
    _count,
    requesterName,
    requesterPhone,
    requesterEmail,
    wantsContact,
    wallShare,
    contactedAt,
    contactedBy,
    ...rest
  } = row;
  const mine = createdBy?.id === v.userId;
  const team = isTeam(row, v, mine);
  const name = createdBy ? fullName(createdBy) : requesterName;
  const hideAuthor = row.anonymous && !mine && !v.pastoral;
  return {
    ...rest,
    author: hideAuthor || !name ? null : { id: createdBy?.id ?? null, name },
    mine,
    prayerCount: _count.prayers,
    praying: prayers.length > 0,
    canReply: mine || team,
    replyCount: mine || team ? _count.replies : 0,
    // Datos de quien pidió por el formulario: solo para el equipo (nunca en el muro).
    requester:
      team && row.source === 'form'
        ? {
            name: requesterName,
            phone: requesterPhone,
            email: requesterEmail,
            wantsContact,
            wallShare,
            contactedAt,
            contactedBy: contactedBy ? fullName(contactedBy) : null,
          }
        : null,
  };
}

export async function list(v: Viewer, query: z.infer<typeof PrayerQuery>) {
  const where: Prisma.PrayerRequestWhereInput =
    query.tab === 'mine'
      ? { deletedAt: null, createdById: v.userId }
      : query.tab === 'received'
        ? { ...visibleWhere(v), source: 'form' }
        : { ...visibleWhere(v), status: query.tab };
  const db = tenantDb();
  const [rows, total] = await Promise.all([
    db.prayerRequest.findMany({
      where,
      select: select(v.userId),
      orderBy: query.tab === 'answered' ? { answeredAt: 'desc' } : { createdAt: 'desc' },
      ...toSkipTake(query),
    }),
    db.prayerRequest.count({ where }),
  ]);
  return paged(
    rows.map((r) => present(r, v)),
    total,
    query,
  );
}

async function findVisible(v: Viewer, id: number) {
  const row = await tenantDb().prayerRequest.findFirst({
    where: { ...visibleWhere(v), id },
    select: select(v.userId),
  });
  if (!row) throw AppError.notFound('PRAYER_NOT_FOUND');
  return row;
}

export async function get(v: Viewer, id: number) {
  return present(await findVisible(v, id), v);
}

/** Usuarios activos que lideran (o colideran) una célula activa del autor, sin contarlo a él. */
async function leadersOf(authorId: number) {
  const db = tenantDb();
  const author = await db.user.findUniqueOrThrow({ where: { id: authorId }, select: { personId: true } });
  if (!author.personId) return [];
  const cells = await db.cell.findMany({
    where: { status: { not: 'closed' }, members: { some: { personId: author.personId, leftAt: null } } },
    select: { leaderPersonId: true, coLeaderPersonId: true },
  });
  const personIds = cells
    .flatMap((c) => [c.leaderPersonId, c.coLeaderPersonId])
    .filter((p): p is number => p !== null && p !== author.personId);
  if (!personIds.length) return [];
  return db.user.findMany({
    where: { personId: { in: personIds }, isActive: true, deletedAt: null, id: { not: authorId } },
    select: { id: true, firstName: true, lastName: true },
    orderBy: { firstName: 'asc' },
  });
}

/** Lo que el front necesita para el formulario: a quién le llega "para mi líder" y si modera. */
export async function context(v: Viewer) {
  const leaders = await leadersOf(v.userId);
  return { leaders: leaders.map((l) => `${l.firstName} ${l.lastName}`), pastoral: v.pastoral };
}

export async function pastors(exceptId?: number) {
  const users = await tenantDb().user.findMany({
    where: { isActive: true, deletedAt: null, id: { not: exceptId } },
    select: { id: true },
  });
  const ids: number[] = [];
  for (const u of users) if ((await getPermissions(u.id))['oracion.pastoral']) ids.push(u.id);
  return ids;
}

/**
 * Avisa a quienes la reciben por su visibilidad (líderes o pastores; las públicas no avisan). Una
 * sola vez por usuario y petición: si cambia la visibilidad, solo le llega a quien no la tenía.
 */
async function notifyAudience(id: number, authorId: number, visibility: Visibility) {
  if (visibility === 'public') return;
  const userIds =
    visibility === 'leader' ? (await leadersOf(authorId)).map((u) => u.id) : await pastors(authorId);
  const author = await tenantDb().user.findUniqueOrThrow({
    where: { id: authorId },
    select: { firstName: true, lastName: true },
  });
  await notify({
    userIds,
    type: 'prayer.request',
    params: { author: `${author.firstName} ${author.lastName}`, visibility },
    link: `/oracion/${id}`,
    dedupeKey: `prayer:${id}`,
  });
}

async function assertLeader(authorId: number, visibility: Visibility) {
  if (visibility === 'leader' && !(await leadersOf(authorId)).length) {
    throw AppError.badRequest('PRAYER_NO_LEADER');
  }
}

export async function create(v: Viewer, input: z.infer<typeof CreatePrayerSchema>) {
  await assertLeader(v.userId, input.visibility);
  const created = await tenantDb().prayerRequest.create({
    data: {
      accountId: currentAccountId(),
      body: input.body,
      visibility: input.visibility,
      anonymous: input.visibility === 'public' && input.anonymous,
      createdById: v.userId,
    },
    select: { id: true },
  });
  await audit({ action: 'prayer.create', entity: 'PrayerRequest', entityId: created.id });
  await notifyAudience(created.id, v.userId, input.visibility);
  return get(v, created.id);
}

/** Solo el autor la edita, la marca respondida (con testimonio opcional) o la reabre. */
export async function update(v: Viewer, id: number, input: z.infer<typeof UpdatePrayerSchema>) {
  const before = await findVisible(v, id);
  if (before.createdBy?.id !== v.userId) throw AppError.forbidden('PRAYER_NOT_AUTHOR');
  const visibility = input.visibility ?? (before.visibility as Visibility);
  if (visibility !== before.visibility) await assertLeader(v.userId, visibility);
  const status = input.status ?? before.status;
  const answered = status === 'answered';
  await tenantDb().prayerRequest.update({
    where: { id },
    data: {
      body: input.body,
      visibility,
      anonymous: visibility === 'public' && (input.anonymous ?? before.anonymous),
      status,
      answeredAt: answered ? (before.answeredAt ?? new Date()) : null,
      testimony: answered
        ? input.testimony === undefined
          ? before.testimony
          : input.testimony || null
        : null,
    },
  });
  await audit({ action: 'prayer.update', entity: 'PrayerRequest', entityId: id });
  if (visibility !== before.visibility) await notifyAudience(id, v.userId, visibility);
  return get(v, id);
}

/** El autor o quien tiene oracion.pastoral (moderación del muro). */
export async function remove(v: Viewer, id: number) {
  const row = await findVisible(v, id);
  if (row.createdBy?.id !== v.userId && !v.pastoral) throw AppError.forbidden('PRAYER_NOT_AUTHOR');
  await tenantDb().prayerRequest.update({ where: { id }, data: { deletedAt: new Date() } });
  await audit({ action: 'prayer.delete', entity: 'PrayerRequest', entityId: id });
}

/** "Estoy orando" (idempotente). La primera vez de cada persona le avisa al autor. */
export async function startPraying(v: Viewer, id: number) {
  const row = await findVisible(v, id);
  try {
    await tenantDb().prayerRequestPrayer.create({ data: { requestId: id, userId: v.userId } });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
  }
  // Las del formulario no tienen a quién avisar: quien pidió ve el contador en su enlace.
  if (row.createdBy && row.createdBy.id !== v.userId) {
    const me = await tenantDb().user.findUniqueOrThrow({
      where: { id: v.userId },
      select: { firstName: true, lastName: true },
    });
    await notify({
      userIds: [row.createdBy.id],
      type: 'prayer.praying',
      params: { person: `${me.firstName} ${me.lastName}` },
      link: `/oracion/${id}`,
      dedupeKey: `prayer:${id}:praying:${v.userId}`,
    });
  }
  return prayerState(v, id);
}

export async function stopPraying(v: Viewer, id: number) {
  await findVisible(v, id);
  await tenantDb().prayerRequestPrayer.deleteMany({ where: { requestId: id, userId: v.userId } });
  return prayerState(v, id);
}

async function prayerState(v: Viewer, id: number) {
  const row = await findVisible(v, id);
  return { prayerCount: row._count.prayers, praying: row.prayers.length > 0 };
}

// ───────────── Respuestas escritas ─────────────

const replySelect = {
  id: true,
  body: true,
  createdAt: true,
  authorId: true,
  author: { select: { firstName: true, lastName: true } },
} satisfies Prisma.PrayerReplySelect;

type ReplyRow = Prisma.PrayerReplyGetPayload<{ select: typeof replySelect }>;

/** authorId null = quien pidió desde su enlace; el autor con usuario también cuenta como quien pidió. */
export function presentReply(
  r: ReplyRow,
  request: { createdById: number | null; requesterName: string | null },
  viewerId: number | null,
) {
  return {
    id: r.id,
    body: r.body,
    createdAt: r.createdAt,
    fromRequester: r.authorId === null || r.authorId === request.createdById,
    mine: viewerId !== null && r.authorId === viewerId,
    author: r.author ? fullName(r.author) : request.requesterName,
  };
}

export const repliesOf = (requestId: number) =>
  tenantDb().prayerReply.findMany({
    where: { requestId },
    select: replySelect,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

/** La petición, si quien mira es su autor o del equipo que la atiende (los demás no ven respuestas). */
async function findForReplies(v: Viewer, id: number) {
  const row = await findVisible(v, id);
  const mine = row.createdBy?.id === v.userId;
  if (!mine && !isTeam(row, v, mine)) throw AppError.forbidden('PRAYER_REPLY_FORBIDDEN');
  return { row, mine };
}

export async function listReplies(v: Viewer, id: number) {
  const { row } = await findForReplies(v, id);
  const request = { createdById: row.createdBy?.id ?? null, requesterName: row.requesterName };
  return (await repliesOf(id)).map((r) => presentReply(r, request, v.userId));
}

/**
 * Cuando contesta quien pidió: a los del equipo que ya respondieron y, si es "para el líder", a su
 * líder; si nadie respondió todavía, a los pastores.
 */
export async function notifyTeamOfReply(
  request: { id: number; visibility: string; createdById: number | null },
  person: string | null,
  replyId: number,
) {
  const prior = await tenantDb().prayerReply.findMany({
    where: { requestId: request.id, authorId: { not: null } },
    select: { authorId: true },
  });
  const ids = new Set(prior.map((r) => r.authorId!));
  if (request.visibility === 'leader' && request.createdById) {
    for (const leader of await leadersOf(request.createdById)) ids.add(leader.id);
  }
  if (request.createdById) ids.delete(request.createdById);
  const userIds = ids.size ? [...ids] : await pastors(request.createdById ?? undefined);
  await notify({
    userIds,
    type: 'prayer.reply',
    params: { person, mine: 0 },
    link: `/oracion/${request.id}`,
    dedupeKey: `prayer:${request.id}:reply:${replyId}`,
  });
}

/** El enlace privado de quien pidió por el formulario (el token se guarda cifrado para esto). */
async function requesterLink(id: number) {
  const row = await tenantDb().prayerRequest.findUniqueOrThrow({
    where: { id },
    select: { accessTokenEnc: true },
  });
  const account = await tenantDb().account.findUniqueOrThrow({
    where: { id: currentAccountId() },
    select: { slug: true },
  });
  return `${env.APP_URL}/orar/${account.slug}/${decryptSecret(row.accessTokenEnc!)}`;
}

/** Mail a quien pidió sin usuario (en la demo no sale: lo corta sendMail). Sin el texto. */
export async function mailRequester(
  request: {
    id: number;
    requesterEmail: string | null;
    requesterName: string | null;
    requesterLocale: string | null;
  },
  kind: 'link' | 'reply',
) {
  if (!request.requesterEmail) return;
  const account = await tenantDb().account.findUniqueOrThrow({
    where: { id: currentAccountId() },
    select: { name: true, defaultLocale: true },
  });
  const locale = resolveMailLocale(request.requesterLocale, account.defaultLocale);
  const url = await requesterLink(request.id);
  try {
    await sendMail({
      to: request.requesterEmail,
      ...prayerMail(locale, kind, { name: request.requesterName, church: account.name, url }),
    });
  } catch (err) {
    // Un mail que no sale no deshace la petición ni la respuesta.
    reportError(err, { where: 'prayer.mailRequester', requestId: request.id });
  }
}

export async function addReply(v: Viewer, id: number, input: z.infer<typeof ReplySchema>) {
  const { row, mine } = await findForReplies(v, id);
  const reply = await tenantDb().prayerReply.create({
    data: { accountId: currentAccountId(), requestId: id, body: input.body, authorId: v.userId },
    select: replySelect,
  });
  await audit({
    action: 'prayer.reply',
    entity: 'PrayerReply',
    entityId: reply.id,
    after: { requestId: id },
  });
  const request = { id, visibility: row.visibility, createdById: row.createdBy?.id ?? null };
  const me = reply.author ? fullName(reply.author) : null;
  if (mine) {
    await notifyTeamOfReply(request, me, reply.id);
  } else if (row.createdBy) {
    await notify({
      userIds: [row.createdBy.id],
      type: 'prayer.reply',
      params: { person: me, mine: 1 },
      link: `/oracion/${id}`,
      dedupeKey: `prayer:${id}:reply:${reply.id}`,
    });
  } else {
    const contact = await tenantDb().prayerRequest.findUniqueOrThrow({
      where: { id },
      select: { id: true, requesterEmail: true, requesterName: true, requesterLocale: true },
    });
    await mailRequester(contact, 'reply');
  }
  return presentReply(
    reply,
    { createdById: request.createdById, requesterName: row.requesterName },
    v.userId,
  );
}

/** "Contactado" en las del formulario que pidieron contacto: queda el primero que lo marcó. */
export async function setContacted(v: Viewer, id: number, contacted: boolean) {
  const row = await findVisible(v, id);
  if (row.source !== 'form') throw AppError.badRequest('PRAYER_NOT_FORM');
  // Condicionado: si dos lo marcan a la vez, el segundo no pisa al primero.
  const { count } = await tenantDb().prayerRequest.updateMany({
    where: { id, contactedAt: contacted ? null : { not: null } },
    data: contacted
      ? { contactedAt: new Date(), contactedById: v.userId }
      : { contactedAt: null, contactedById: null },
  });
  if (count) {
    await audit({ action: 'prayer.contacted', entity: 'PrayerRequest', entityId: id, after: { contacted } });
  }
  return get(v, id);
}
