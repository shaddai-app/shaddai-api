import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { paged, PaginationQuery, toSkipTake } from '../../core/http/pagination.js';
import { getPermissions } from '../../core/rbac/permission-cache.js';
import { notify } from '../notifications/notifications.service.js';

// Peticiones de oración. Cada una la ven su autor, quien tiene oracion.pastoral y, según la
// visibilidad, toda la iglesia (public) o el líder y colíder de la célula del autor (leader). Las
// "pastors" no las ve nadie más. El texto nunca va en avisos ni en la auditoría.

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

export const PrayerQuery = PaginationQuery.extend({
  tab: z.enum(['open', 'answered', 'mine']).default('open'),
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
    createdBy: { select: { id: true, firstName: true, lastName: true } },
    prayers: { where: { userId: viewerId }, select: { userId: true } },
    _count: { select: { prayers: true } },
  }) satisfies Prisma.PrayerRequestSelect;

type Row = Prisma.PrayerRequestGetPayload<{ select: ReturnType<typeof select> }>;

function present(row: Row, v: Viewer) {
  const { createdBy, prayers, _count, ...rest } = row;
  const mine = createdBy.id === v.userId;
  const hideAuthor = row.anonymous && !mine && !v.pastoral;
  return {
    ...rest,
    author: hideAuthor ? null : { id: createdBy.id, name: `${createdBy.firstName} ${createdBy.lastName}` },
    mine,
    prayerCount: _count.prayers,
    praying: prayers.length > 0,
  };
}

export async function list(v: Viewer, query: z.infer<typeof PrayerQuery>) {
  const where: Prisma.PrayerRequestWhereInput =
    query.tab === 'mine'
      ? { deletedAt: null, createdById: v.userId }
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

async function pastors(exceptId: number) {
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
  if (before.createdBy.id !== v.userId) throw AppError.forbidden('PRAYER_NOT_AUTHOR');
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
  if (row.createdBy.id !== v.userId && !v.pastoral) throw AppError.forbidden('PRAYER_NOT_AUTHOR');
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
  if (row.createdBy.id !== v.userId) {
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
