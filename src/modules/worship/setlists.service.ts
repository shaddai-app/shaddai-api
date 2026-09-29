import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { dateToLocal, localToDate } from '../../core/time/local-date.js';
import { occurrenceInfo } from '../calendar/calendar.service.js';
import { alignOccurrence } from '../calendar/recurrence.js';
import { scopeOf, type Viewer } from '../people/people.scope.js';
import { KEY_PATTERN } from './songs.service.js';

// Listas de canciones por fecha de un evento (o una fecha suelta, ej. un ensayo). En borrador
// solo las ve quien arma las listas; publicadas, todo el equipo de alabanza.

const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const DAY = 86_400_000;
const MAX_RANGE_DAYS = 400;
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

export const CreateSetlistSchema = z
  .object({
    eventId: z.number().int().positive().nullable().optional(),
    occurrence: localDateTime,
    title: optionalText(150),
    notes: optionalText(1000),
  })
  .strict();

export const UpdateSetlistSchema = z
  .object({
    title: optionalText(150),
    notes: optionalText(1000),
    status: z.enum(['draft', 'published']).optional(),
  })
  .strict();

export const ItemsSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            songId: z.number().int().positive(),
            key: z.string().trim().regex(KEY_PATTERN).nullable().optional(),
            notes: optionalText(300),
          })
          .strict(),
      )
      .max(40),
  })
  .strict();

export const ListSetlistsQuery = z.object({ from: z.iso.date(), to: z.iso.date() });

const canEdit = (viewer: Viewer) => Boolean(scopeOf(viewer, 'alabanza.listas'));
/** Sin permiso para armar listas, solo las publicadas. */
const visibleWhere = (viewer: Viewer): Prisma.SetlistWhereInput =>
  canEdit(viewer) ? {} : { status: 'published' };

/** Fecha real (con el cambio de horario aplicado) y título del evento; null si se borró el evento. */
async function occurrenceOf(eventId: number | null, occurrenceStart: Date) {
  if (!eventId) return null;
  return occurrenceInfo(eventId, dateToLocal(occurrenceStart)).catch(() => null);
}

async function findSetlist(viewer: Viewer, id: number) {
  const setlist = await tenantDb().setlist.findFirst({ where: { AND: [{ id }, visibleWhere(viewer)] } });
  if (!setlist) throw AppError.notFound('SETLIST_NOT_FOUND');
  return setlist;
}

function assertEditor(viewer: Viewer) {
  if (!canEdit(viewer)) throw AppError.forbidden('SETLIST_EDIT_FORBIDDEN');
}

// ───────────── Listas ─────────────

export async function listSetlists(viewer: Viewer, q: z.infer<typeof ListSetlistsQuery>) {
  if (q.to < q.from) throw AppError.badRequest('DATE_RANGE_INVALID');
  const from = localToDate(`${q.from}T00:00`);
  const to = localToDate(`${q.to}T23:59`);
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY) {
    throw AppError.badRequest('SETLIST_RANGE_TOO_LONG', { days: MAX_RANGE_DAYS });
  }
  const rows = await tenantDb().setlist.findMany({
    where: { AND: [visibleWhere(viewer), { occurrenceStart: { gte: from, lte: to } }] },
    select: {
      id: true,
      eventId: true,
      occurrenceStart: true,
      title: true,
      status: true,
      event: { select: { title: true } },
      items: { select: { song: { select: { title: true } } }, orderBy: { position: 'asc' } },
    },
    orderBy: { occurrenceStart: 'asc' },
  });
  const items = [];
  for (const r of rows) {
    const o = await occurrenceOf(r.eventId, r.occurrenceStart);
    items.push({
      id: r.id,
      eventId: r.eventId,
      title: r.title ?? r.event?.title ?? null,
      eventTitle: r.event?.title ?? null,
      startsAt: dateToLocal(o?.start ?? r.occurrenceStart),
      cancelled: o?.cancelled ?? false,
      status: r.status,
      songs: r.items.map((i) => i.song.title),
    });
  }
  return { items, canEdit: canEdit(viewer) };
}

export async function getSetlist(viewer: Viewer, id: number) {
  const s = await findSetlist(viewer, id);
  const db = tenantDb();
  const [items, o] = await Promise.all([
    db.setlistItem.findMany({
      where: { setlistId: id },
      select: {
        id: true,
        position: true,
        key: true,
        notes: true,
        song: {
          select: {
            id: true,
            title: true,
            author: true,
            originalKey: true,
            bpm: true,
            timeSignature: true,
            deletedAt: true,
          },
        },
      },
      orderBy: { position: 'asc' },
    }),
    occurrenceOf(s.eventId, s.occurrenceStart),
  ]);
  // Los músicos: los turnos de los ministerios de alabanza en esa fecha.
  const musicians = s.eventId
    ? await db.serviceAssignment.findMany({
        where: { eventId: s.eventId, occurrenceStart: s.occurrenceStart, ministry: { kind: 'worship' } },
        select: {
          status: true,
          serviceRole: { select: { name: true, sortOrder: true } },
          ministry: { select: { id: true, name: true } },
          person: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: [{ serviceRole: { sortOrder: 'asc' } }, { id: 'asc' }],
      })
    : [];
  return {
    id: s.id,
    eventId: s.eventId,
    event: o ? { ...o.event } : null,
    occurrence: dateToLocal(s.occurrenceStart),
    startsAt: dateToLocal(o?.start ?? s.occurrenceStart),
    endsAt: o ? dateToLocal(o.end) : null,
    cancelled: o?.cancelled ?? false,
    title: s.title,
    notes: s.notes,
    status: s.status,
    updatedAt: s.updatedAt,
    items: items.map(({ song: { deletedAt, ...song }, ...i }) => ({
      ...i,
      song: { ...song, deleted: Boolean(deletedAt) },
    })),
    musicians: musicians.map((m) => ({
      status: m.status,
      role: m.serviceRole.name,
      ministry: m.ministry,
      person: m.person,
    })),
    canEdit: canEdit(viewer),
  };
}

export async function createSetlist(viewer: Viewer, input: z.infer<typeof CreateSetlistSchema>) {
  assertEditor(viewer);
  const db = tenantDb();
  let at = localToDate(input.occurrence);
  if (input.eventId) {
    const o = await occurrenceInfo(input.eventId, input.occurrence);
    if (o.cancelled) throw AppError.conflict('OCCURRENCE_CANCELLED');
    at = o.at;
    const existing = await db.setlist.findFirst({
      where: { eventId: input.eventId, occurrenceStart: at },
      select: { id: true },
    });
    // Una lista por fecha de evento.
    if (existing) throw AppError.conflict('SETLIST_EXISTS', { id: existing.id });
  } else if (!input.title) {
    throw AppError.badRequest('SETLIST_TITLE_REQUIRED');
  }
  const created = await db.setlist.create({
    data: {
      accountId: currentAccountId(),
      eventId: input.eventId ?? null,
      occurrenceStart: at,
      title: input.title ?? null,
      notes: input.notes ?? null,
      createdById: viewer.userId,
    },
    select: { id: true },
  });
  await audit({ action: 'setlists.create', entity: 'Setlist', entityId: created.id, after: input });
  return getSetlist(viewer, created.id);
}

export async function updateSetlist(viewer: Viewer, id: number, input: z.infer<typeof UpdateSetlistSchema>) {
  assertEditor(viewer);
  const before = await findSetlist(viewer, id);
  if (input.title === null && !before.eventId) throw AppError.badRequest('SETLIST_TITLE_REQUIRED');
  await tenantDb().setlist.update({ where: { id }, data: input });
  await audit({
    action: input.status && input.status !== before.status ? `setlists.${input.status}` : 'setlists.update',
    entity: 'Setlist',
    entityId: id,
    before: { status: before.status, title: before.title },
    after: input,
  });
  return getSetlist(viewer, id);
}

export async function deleteSetlist(viewer: Viewer, id: number) {
  assertEditor(viewer);
  await findSetlist(viewer, id);
  await tenantDb().setlist.delete({ where: { id } });
  await audit({ action: 'setlists.delete', entity: 'Setlist', entityId: id });
}

/** Reemplaza las canciones de la lista (el orden es el del arreglo). */
export async function setItems(viewer: Viewer, id: number, input: z.infer<typeof ItemsSchema>) {
  assertEditor(viewer);
  await findSetlist(viewer, id);
  const db = tenantDb();
  const ids = [...new Set(input.items.map((i) => i.songId))];
  const songs = await db.song.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true } });
  if (songs.length !== ids.length) throw AppError.badRequest('SONG_INVALID');
  await db.setlist.update({
    where: { id },
    data: {
      // Escritura anidada: los ítems son hijos de la lista.
      items: {
        deleteMany: {},
        create: input.items.map((i, index) => ({
          songId: i.songId,
          position: index + 1,
          key: i.key ?? null,
          notes: i.notes ?? null,
        })),
      },
    },
  });
  await audit({ action: 'setlists.items', entity: 'Setlist', entityId: id, after: { songs: ids } });
  return getSetlist(viewer, id);
}

// ───────────── Historial de uso de una canción ─────────────

export async function songUsage(viewer: Viewer, songId: number) {
  const db = tenantDb();
  if (!(await db.song.count({ where: { id: songId, deletedAt: null } })))
    throw AppError.notFound('SONG_NOT_FOUND');
  const where = { songId, setlist: visibleWhere(viewer) };
  const [rows, total] = await Promise.all([
    db.setlistItem.findMany({
      where,
      select: {
        key: true,
        setlist: {
          select: {
            id: true,
            eventId: true,
            occurrenceStart: true,
            title: true,
            status: true,
            event: { select: { title: true } },
          },
        },
      },
      orderBy: { setlist: { occurrenceStart: 'desc' } },
      take: 20,
    }),
    db.setlistItem.count({ where }),
  ]);
  return {
    total,
    items: rows.map((r) => ({
      setlistId: r.setlist.id,
      date: dateToLocal(r.setlist.occurrenceStart),
      title: r.setlist.title ?? r.setlist.event?.title ?? null,
      status: r.setlist.status,
      key: r.key,
    })),
  };
}

// ───────────── Cambios en el calendario ─────────────

/** Si cambió el horario de la serie, la lista pasa a la fecha del mismo día con el horario nuevo. */
export async function realignSetlists(eventId: number, rule: string | null, start: Date) {
  const db = tenantDb();
  const rows = await db.setlist.findMany({ where: { eventId }, select: { id: true, occurrenceStart: true } });
  const taken = new Set(rows.map((r) => r.occurrenceStart.getTime()));
  for (const r of rows) {
    const aligned = alignOccurrence(rule, start, r.occurrenceStart);
    if (!aligned || taken.has(aligned.getTime())) continue;
    taken.delete(r.occurrenceStart.getTime());
    taken.add(aligned.getTime());
    await db.setlist.update({ where: { id: r.id }, data: { occurrenceStart: aligned } });
  }
}
