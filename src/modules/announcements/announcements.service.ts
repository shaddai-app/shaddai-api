import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { audit } from '../../core/audit/audit.js';
import { runInContext } from '../../core/context.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { paged, PaginationQuery, toSkipTake } from '../../core/http/pagination.js';
import { notify } from '../notifications/notifications.service.js';

// Anuncios de la iglesia: los ve quien está en su audiencia (o todos, si no tiene), entre la
// publicación y el vencimiento. Al publicarse, si se pidió, avisa en el centro de notificaciones.

export const AUDIENCE_KINDS = ['role', 'ministry', 'campus'] as const;
export type AudienceKind = (typeof AUDIENCE_KINDS)[number];

const Audience = z.object({ kind: z.enum(AUDIENCE_KINDS), refId: z.number().int().positive() });

const fields = {
  title: z.string().trim().min(1).max(150),
  body: z.string().trim().min(1).max(4000),
  publishAt: z.coerce.date().optional(), // sin fecha = ahora
  expiresAt: z.coerce.date().nullable().optional(),
  pinned: z.boolean().default(false),
  notify: z.boolean().default(true),
  audiences: z.array(Audience).max(50).default([]),
};

export const CreateAnnouncementSchema = z.object(fields).strict();
export const UpdateAnnouncementSchema = z
  .object({
    ...fields,
    pinned: fields.pinned.optional(),
    notify: fields.notify.optional(),
    audiences: fields.audiences.optional(),
  })
  .partial()
  .strict();

export const FeedQuery = PaginationQuery.extend({
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
});
export const ManageQuery = PaginationQuery.extend({
  status: z.enum(['current', 'scheduled', 'expired']).default('current'),
});

const select = {
  id: true,
  title: true,
  body: true,
  publishAt: true,
  expiresAt: true,
  pinned: true,
  notify: true,
  notifiedAt: true,
  createdAt: true,
  createdBy: { select: { id: true, firstName: true, lastName: true } },
  audiences: { select: { kind: true, refId: true } },
} as const;

type Row = Prisma.AnnouncementGetPayload<{ select: typeof select }>;

function present(row: Row, withAudiences: boolean) {
  const { createdBy, audiences, notify: notifyOnPublish, notifiedAt, ...rest } = row;
  return {
    ...rest,
    author: { id: createdBy.id, name: `${createdBy.firstName} ${createdBy.lastName}` },
    ...(withAudiences ? { audiences, notify: notifyOnPublish, notifiedAt } : {}),
  };
}

/** Roles, ministerios activos y sede del usuario: definen qué anuncios le corresponden. */
async function audienceOf(userId: number) {
  const db = tenantDb();
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      roles: { select: { roleId: true } },
      person: {
        select: {
          campusId: true,
          ministryMemberships: { where: { leftAt: null }, select: { ministryId: true } },
        },
      },
    },
  });
  return {
    roleIds: user.roles.map((r) => r.roleId),
    ministryIds: user.person?.ministryMemberships.map((m) => m.ministryId) ?? [],
    campusId: user.person?.campusId ?? null,
  };
}

/** Publicados, vigentes y para este usuario. */
async function visibleWhere(userId: number, now: Date): Promise<Prisma.AnnouncementWhereInput> {
  const a = await audienceOf(userId);
  const targets: Prisma.AnnouncementWhereInput[] = [{ audiences: { none: {} } }];
  if (a.roleIds.length) targets.push({ audiences: { some: { kind: 'role', refId: { in: a.roleIds } } } });
  if (a.ministryIds.length)
    targets.push({ audiences: { some: { kind: 'ministry', refId: { in: a.ministryIds } } } });
  if (a.campusId) targets.push({ audiences: { some: { kind: 'campus', refId: a.campusId } } });
  return {
    deletedAt: null,
    publishAt: { lte: now },
    AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, { OR: targets }],
  };
}

/** Lo que le toca ver al usuario: primero los fijados, después los más nuevos. */
export async function feed(userId: number, query: z.infer<typeof FeedQuery>) {
  const where = await visibleWhere(userId, new Date());
  const db = tenantDb();
  const [rows, total] = await Promise.all([
    db.announcement.findMany({
      where,
      select,
      orderBy: [{ pinned: 'desc' }, { publishAt: 'desc' }],
      ...toSkipTake(query),
    }),
    db.announcement.count({ where }),
  ]);
  return paged(
    rows.map((r) => present(r, false)),
    total,
    query,
  );
}

export async function getVisible(userId: number, id: number, canManage: boolean) {
  const where: Prisma.AnnouncementWhereInput = canManage
    ? { deletedAt: null }
    : await visibleWhere(userId, new Date());
  const row = await tenantDb().announcement.findFirst({ where: { ...where, id }, select });
  if (!row) throw AppError.notFound('ANNOUNCEMENT_NOT_FOUND');
  return present(row, canManage);
}

/** Para quien gestiona: vigentes, programados o vencidos, con su audiencia. */
export async function listForManagers(query: z.infer<typeof ManageQuery>) {
  const now = new Date();
  const byStatus: Record<typeof query.status, Prisma.AnnouncementWhereInput> = {
    current: { publishAt: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    scheduled: { publishAt: { gt: now } },
    expired: { expiresAt: { lte: now } },
  };
  const where = { deletedAt: null, ...byStatus[query.status] };
  const db = tenantDb();
  const [rows, total] = await Promise.all([
    db.announcement.findMany({
      where,
      select,
      orderBy:
        query.status === 'scheduled' ? { publishAt: 'asc' } : [{ pinned: 'desc' }, { publishAt: 'desc' }],
      ...toSkipTake(query),
    }),
    db.announcement.count({ where }),
  ]);
  return paged(
    rows.map((r) => present(r, true)),
    total,
    query,
  );
}

/** Roles, ministerios y sedes para elegir la audiencia. */
export async function audienceOptions() {
  const db = tenantDb();
  const [roles, ministries, campuses] = await Promise.all([
    db.role.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    db.ministry.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    db.campus.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);
  return { roles, ministries, campuses };
}

/** Cada audiencia tiene que ser un rol, ministerio o sede de esta iglesia (si no, 400). */
async function assertAudiences(audiences: { kind: AudienceKind; refId: number }[]) {
  const db = tenantDb();
  const ids = (kind: AudienceKind) => [
    ...new Set(audiences.filter((a) => a.kind === kind).map((a) => a.refId)),
  ];
  const [roles, ministries, campuses] = await Promise.all([
    db.role.count({ where: { id: { in: ids('role') } } }),
    db.ministry.count({ where: { id: { in: ids('ministry') }, deletedAt: null } }),
    db.campus.count({ where: { id: { in: ids('campus') } } }),
  ]);
  if (
    roles !== ids('role').length ||
    ministries !== ids('ministry').length ||
    campuses !== ids('campus').length
  ) {
    throw AppError.badRequest('ANNOUNCEMENT_AUDIENCE_INVALID');
  }
}

function assertDates(publishAt: Date, expiresAt: Date | null | undefined) {
  if (expiresAt && expiresAt <= publishAt) throw AppError.badRequest('ANNOUNCEMENT_EXPIRES_BEFORE_PUBLISH');
}

/** Usuarios activos a los que les corresponde el anuncio. */
async function recipients(audiences: { kind: string; refId: number }[]): Promise<number[]> {
  const db = tenantDb();
  const active = { isActive: true, deletedAt: null };
  if (!audiences.length) {
    return (await db.user.findMany({ where: active, select: { id: true } })).map((u) => u.id);
  }
  const ids = (kind: string) => audiences.filter((a) => a.kind === kind).map((a) => a.refId);
  const users = await db.user.findMany({
    where: {
      ...active,
      OR: [
        { roles: { some: { roleId: { in: ids('role') } } } },
        { person: { ministryMemberships: { some: { ministryId: { in: ids('ministry') }, leftAt: null } } } },
        { person: { campusId: { in: ids('campus') } } },
      ],
    },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

/**
 * Avisa la publicación a la audiencia, una sola vez: la marca notifiedAt se toma de forma atómica
 * (con varias instancias, solo una avisa) y el dedupeKey cubre un reintento.
 */
async function announce(id: number): Promise<number> {
  const db = tenantDb();
  const claimed = await db.announcement.updateMany({
    where: { id, notify: true, notifiedAt: null, deletedAt: null, publishAt: { lte: new Date() } },
    data: { notifiedAt: new Date() },
  });
  if (claimed.count !== 1) return 0;
  const row = await db.announcement.findUniqueOrThrow({ where: { id }, select });
  return notify({
    userIds: (await recipients(row.audiences)).filter((u) => u !== row.createdBy.id),
    type: 'announcement.published',
    params: { title: row.title, author: `${row.createdBy.firstName} ${row.createdBy.lastName}` },
    link: `/anuncios/${id}`,
    dedupeKey: `announcement:${id}`,
  });
}

export async function createAnnouncement(userId: number, input: z.infer<typeof CreateAnnouncementSchema>) {
  const publishAt = input.publishAt ?? new Date();
  assertDates(publishAt, input.expiresAt);
  await assertAudiences(input.audiences);
  const db = tenantDb();
  const created = await db.announcement.create({
    data: {
      accountId: currentAccountId(),
      title: input.title,
      body: input.body,
      publishAt,
      expiresAt: input.expiresAt ?? null,
      pinned: input.pinned,
      notify: input.notify,
      createdById: userId,
      audiences: { create: input.audiences },
    },
    select: { id: true },
  });
  await audit({ action: 'announcements.create', entity: 'Announcement', entityId: created.id });
  await announce(created.id); // si es para más adelante, lo publica el programador
  return getVisible(userId, created.id, true);
}

export async function updateAnnouncement(
  userId: number,
  id: number,
  input: z.infer<typeof UpdateAnnouncementSchema>,
) {
  const db = tenantDb();
  const before = await db.announcement.findFirst({ where: { id, deletedAt: null }, select });
  if (!before) throw AppError.notFound('ANNOUNCEMENT_NOT_FOUND');
  const publishAt = input.publishAt ?? before.publishAt;
  const expiresAt = input.expiresAt === undefined ? before.expiresAt : input.expiresAt;
  assertDates(publishAt, expiresAt);
  if (input.audiences) await assertAudiences(input.audiences);

  const { audiences, ...data } = input;
  await db.announcement.update({ where: { id }, data: { ...data, expiresAt } });
  if (audiences) {
    await db.announcementAudience.deleteMany({ where: { announcementId: id } });
    if (audiences.length) {
      await db.announcementAudience.createMany({
        data: audiences.map((a) => ({ ...a, announcementId: id })),
      });
    }
  }
  await audit({ action: 'announcements.update', entity: 'Announcement', entityId: id });
  // Un anuncio que pasa a publicarse ahora (o al que se le activa el aviso) avisa; uno ya avisado, no.
  await announce(id);
  return getVisible(userId, id, true);
}

export async function deleteAnnouncement(id: number) {
  const { count } = await tenantDb().announcement.updateMany({
    where: { id, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  if (!count) throw AppError.notFound('ANNOUNCEMENT_NOT_FOUND');
  await audit({ action: 'announcements.delete', entity: 'Announcement', entityId: id });
}

/** Programador: avisa los anuncios programados que ya llegaron a su fecha. */
export function publishDueAnnouncements(accountId: number, now = new Date()): Promise<number> {
  return runInContext({ requestId: `job-${randomUUID()}`, accountId }, async () => {
    const due = await tenantDb().announcement.findMany({
      where: {
        notify: true,
        notifiedAt: null,
        deletedAt: null,
        publishAt: { lte: now },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { id: true },
    });
    let sent = 0;
    for (const a of due) sent += await announce(a.id);
    return sent;
  });
}
