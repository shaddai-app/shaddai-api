import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { toDate } from '../../core/time/local-date.js';
import { todayDate } from '../cells/cells.service.js';
import { isoDate } from '../people/people.service.js';
import type { Viewer } from '../people/people.scope.js';
import { assertLevel } from './courses.service.js';

// Clases de un nivel y su asistencia. La lista de una clase son las inscripciones que estaban
// vigentes ese día: inscriptas hasta esa fecha y que no habían completado ni dejado antes.

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const Attendance = z.array(
  z.object({ enrollmentId: z.number().int().positive(), present: z.boolean() }).strict(),
);

export const CreateSessionSchema = z
  .object({
    date: isoDay,
    topic: optionalText(200),
    notes: optionalText(1000),
    attendance: Attendance.max(500).default([]),
  })
  .strict();
export const UpdateSessionSchema = z
  .object({
    date: isoDay,
    topic: optionalText(200),
    notes: optionalText(1000),
    attendance: Attendance.max(500),
  })
  .partial()
  .strict();
export const RosterQuery = z.object({ date: isoDay });

const personRef = { id: true, firstName: true, lastName: true } as const;

/** Inscripciones del nivel vigentes en esa fecha (de personas no borradas). */
function rosterWhere(levelId: number, date: Date): Prisma.CourseEnrollmentWhereInput {
  return {
    levelId,
    person: { deletedAt: null },
    enrolledAt: { lte: date },
    OR: [{ status: 'active' }, { completedAt: { gte: date } }, { droppedAt: { gte: date } }],
  };
}

async function roster(levelId: number, date: Date, sessionId?: number) {
  const db = tenantDb();
  const rows = await db.courseEnrollment.findMany({
    where: sessionId
      ? { OR: [rosterWhere(levelId, date), { attendance: { some: { sessionId } } }] }
      : rosterWhere(levelId, date),
    select: {
      id: true,
      person: { select: personRef },
      attendance: sessionId ? { where: { sessionId }, select: { present: true } } : undefined,
    },
    orderBy: [{ person: { lastName: 'asc' } }, { person: { firstName: 'asc' } }],
  });
  return rows.map((r) => ({
    enrollmentId: r.id,
    person: r.person,
    /** null = todavía no se tomó para esta persona. */
    present: r.attendance?.[0]?.present ?? null,
  }));
}

/** Lista para tomar asistencia de una clase nueva en esa fecha. */
export async function rosterFor(viewer: Viewer, levelId: number, date: string) {
  await assertLevel(viewer, levelId, 'discipulado.ver');
  return { items: await roster(levelId, toDate(date)) };
}

export async function listSessions(viewer: Viewer, levelId: number) {
  await assertLevel(viewer, levelId, 'discipulado.ver');
  const db = tenantDb();
  const sessions = await db.courseSession.findMany({
    where: { levelId },
    select: { id: true, date: true, topic: true, notes: true },
    orderBy: { date: 'desc' },
    take: 200,
  });
  const counts = sessions.length
    ? await db.courseAttendance.groupBy({
        by: ['sessionId', 'present'],
        where: { sessionId: { in: sessions.map((s) => s.id) } },
        _count: { _all: true },
      })
    : [];
  return {
    items: sessions.map((s) => {
      const mine = counts.filter((c) => c.sessionId === s.id);
      return {
        ...s,
        date: isoDate(s.date),
        present: mine.find((c) => c.present)?._count._all ?? 0,
        total: mine.reduce((n, c) => n + c._count._all, 0),
      };
    }),
  };
}

async function existingSession(viewer: Viewer, id: number, key: 'discipulado.ver' | 'discipulado.inscribir') {
  const session = await tenantDb().courseSession.findFirst({
    where: { id, level: { course: { deletedAt: null } } },
  });
  if (!session) throw AppError.notFound('COURSE_SESSION_NOT_FOUND');
  await assertLevel(viewer, session.levelId, key);
  return session;
}

export async function getSession(viewer: Viewer, id: number) {
  const s = await existingSession(viewer, id, 'discipulado.ver');
  return {
    id: s.id,
    levelId: s.levelId,
    date: isoDate(s.date),
    topic: s.topic,
    notes: s.notes,
    roster: await roster(s.levelId, s.date, s.id),
  };
}

async function assertDate(date: string) {
  if (toDate(date) > (await todayDate())) throw AppError.badRequest('COURSE_SESSION_FUTURE');
}

/** Las inscripciones de la asistencia tienen que ser de este nivel. */
async function assertAttendance(levelId: number, attendance: { enrollmentId: number }[]) {
  const ids = [...new Set(attendance.map((a) => a.enrollmentId))];
  if (ids.length !== attendance.length) throw AppError.badRequest('COURSE_ATTENDANCE_INVALID');
  if (
    ids.length &&
    (await tenantDb().courseEnrollment.count({ where: { id: { in: ids }, levelId } })) !== ids.length
  ) {
    throw AppError.badRequest('COURSE_ATTENDANCE_INVALID');
  }
}

const isDuplicate = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

export async function createSession(
  viewer: Viewer,
  levelId: number,
  input: z.infer<typeof CreateSessionSchema>,
) {
  await assertLevel(viewer, levelId, 'discipulado.inscribir');
  await assertDate(input.date);
  await assertAttendance(levelId, input.attendance);
  let id: number;
  try {
    ({ id } = await tenantDb().courseSession.create({
      data: {
        accountId: currentAccountId(),
        levelId,
        date: toDate(input.date),
        topic: input.topic ?? null,
        notes: input.notes ?? null,
        createdById: viewer.userId,
        attendance: { create: input.attendance },
      },
      select: { id: true },
    }));
  } catch (err) {
    if (isDuplicate(err)) throw AppError.conflict('COURSE_SESSION_EXISTS');
    throw err;
  }
  await audit({
    action: 'courses.session.create',
    entity: 'CourseSession',
    entityId: id,
    after: { levelId, date: input.date, present: input.attendance.filter((a) => a.present).length },
  });
  return getSession(viewer, id);
}

/** Cambia fecha, tema o notas y actualiza la asistencia de las personas que vienen en la lista. */
export async function updateSession(viewer: Viewer, id: number, input: z.infer<typeof UpdateSessionSchema>) {
  const before = await existingSession(viewer, id, 'discipulado.inscribir');
  if (input.date) await assertDate(input.date);
  if (input.attendance) await assertAttendance(before.levelId, input.attendance);
  const db = tenantDb();
  const { attendance, date, ...fields } = input;
  try {
    await db.$transaction([
      db.courseSession.update({
        where: { id },
        data: { ...fields, ...(date ? { date: toDate(date) } : {}) },
      }),
      ...(attendance?.length
        ? [
            db.courseAttendance.deleteMany({
              where: { sessionId: id, enrollmentId: { in: attendance.map((a) => a.enrollmentId) } },
            }),
            db.courseAttendance.createMany({ data: attendance.map((a) => ({ ...a, sessionId: id })) }),
          ]
        : []),
    ]);
  } catch (err) {
    if (isDuplicate(err)) throw AppError.conflict('COURSE_SESSION_EXISTS');
    throw err;
  }
  await audit({
    action: 'courses.session.update',
    entity: 'CourseSession',
    entityId: id,
    before: { date: isoDate(before.date), topic: before.topic },
    after: {
      date: date ?? isoDate(before.date),
      topic: fields.topic,
      attendanceChanged: attendance?.length ?? 0,
    },
  });
  return getSession(viewer, id);
}

export async function deleteSession(viewer: Viewer, id: number) {
  const before = await existingSession(viewer, id, 'discipulado.inscribir');
  const db = tenantDb();
  await db.$transaction([
    db.courseAttendance.deleteMany({ where: { sessionId: id } }),
    db.courseSession.delete({ where: { id } }),
  ]);
  await audit({
    action: 'courses.session.delete',
    entity: 'CourseSession',
    entityId: id,
    before: { levelId: before.levelId, date: isoDate(before.date) },
  });
}
