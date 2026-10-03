import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import type { PermissionKey } from '../../core/rbac/catalog.js';
import { toDate } from '../../core/time/local-date.js';
import { todayDate } from '../cells/cells.service.js';
import { isoDate } from '../people/people.service.js';
import { scopeOf, type Viewer } from '../people/people.scope.js';

// Discipulado / escuela bíblica: cursos con niveles ordenados e inscripciones de personas a cada
// nivel. Con alcance "propio", discipulado.ver e inscribir se limitan a los niveles que la persona
// del usuario enseña (maestro del nivel). Gestionar (cursos y niveles) es siempre de toda la iglesia.

// ───────────── Esquemas ─────────────

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const LevelFields = z.object({
  name: z.string().trim().min(1).max(100),
  description: optionalText(500),
  teacherPersonId: z.number().int().positive().nullable().optional(),
  minAttendancePct: z.number().int().min(1).max(100).nullable().optional(),
});

export const CreateCourseSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: optionalText(500),
    milestoneTypeId: z.number().int().positive().nullable().optional(),
    levels: z.array(LevelFields.strict()).max(20).default([]),
  })
  .strict();
export const UpdateCourseSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: optionalText(500),
    milestoneTypeId: z.number().int().positive().nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .strict();

export const CreateLevelSchema = LevelFields.strict();
export const UpdateLevelSchema = LevelFields.extend({ isActive: z.boolean() }).partial().strict();
export const ReorderSchema = z.object({ ids: z.array(z.number().int().positive()).min(1).max(20) }).strict();

export const ListQuery = z.object({ includeInactive: z.stringbool().default(false) });
export const ENROLLMENT_STATUSES = ['active', 'completed', 'dropped'] as const;
export const EnrollmentQuery = z.object({
  status: z.enum([...ENROLLMENT_STATUSES, 'all']).default('active'),
});

export const EnrollSchema = z
  .object({
    personIds: z.array(z.number().int().positive()).min(1).max(200),
    enrolledAt: isoDay.optional(),
  })
  .strict();
export const UpdateEnrollmentSchema = z
  .object({
    status: z.enum(ENROLLMENT_STATUSES),
    /** Fecha de la inscripción, de finalización o de baja según el estado (por defecto, hoy). */
    date: isoDay,
    notes: optionalText(500),
  })
  .partial()
  .strict();

// ───────────── Alcance ─────────────

/** Niveles (de cursos no borrados) sobre los que tiene el permiso, o null sin permiso. */
function levelWhereFor(viewer: Viewer, key: PermissionKey): Prisma.CourseLevelWhereInput | null {
  const scope = scopeOf(viewer, key);
  if (!scope) return null;
  const own = scope === 'all' ? {} : { teacherPersonId: viewer.personId ?? -1 };
  return { course: { deletedAt: null }, ...own };
}

async function levelInScope(viewer: Viewer, key: PermissionKey, levelId: number) {
  const where = levelWhereFor(viewer, key);
  return Boolean(where && (await tenantDb().courseLevel.count({ where: { AND: [{ id: levelId }, where] } })));
}

/** El nivel tiene que verse (si no, 404) y admitir la acción (si no, 403). */
export async function assertLevel(viewer: Viewer, levelId: number, key: PermissionKey) {
  if (!(await levelInScope(viewer, 'discipulado.ver', levelId)))
    throw AppError.notFound('COURSE_LEVEL_NOT_FOUND');
  if (key !== 'discipulado.ver' && !(await levelInScope(viewer, key, levelId))) {
    throw AppError.forbidden('COURSE_LEVEL_FORBIDDEN');
  }
}

// ───────────── Cursos y niveles ─────────────

const personRef = { id: true, firstName: true, lastName: true } as const;
const levelSelect = {
  id: true,
  name: true,
  description: true,
  sortOrder: true,
  minAttendancePct: true,
  isActive: true,
  teacher: { select: personRef },
} as const;

type LevelRow = Prisma.CourseLevelGetPayload<{ select: typeof levelSelect }>;

async function countsByLevel(levelIds: number[]) {
  const rows = levelIds.length
    ? await tenantDb().courseEnrollment.groupBy({
        by: ['levelId', 'status'],
        where: { levelId: { in: levelIds }, person: { deletedAt: null } },
        _count: { _all: true },
      })
    : [];
  const counts = new Map<number, Record<(typeof ENROLLMENT_STATUSES)[number], number>>();
  for (const r of rows) {
    const c = counts.get(r.levelId) ?? { active: 0, completed: 0, dropped: 0 };
    c[r.status as keyof typeof c] = r._count._all;
    counts.set(r.levelId, c);
  }
  return counts;
}

/** Cada nivel con sus contadores y qué puede hacer el usuario ahí. */
async function presentLevels(viewer: Viewer, levels: LevelRow[]) {
  const counts = await countsByLevel(levels.map((l) => l.id));
  const viewAll = scopeOf(viewer, 'discipulado.ver') === 'all';
  const enrollScope = scopeOf(viewer, 'discipulado.inscribir');
  const teaches = (l: LevelRow) => viewer.personId !== null && l.teacher?.id === viewer.personId;
  return levels.map((l) => ({
    ...l,
    teacher: l.teacher ? { id: l.teacher.id, name: `${l.teacher.firstName} ${l.teacher.lastName}` } : null,
    counts: viewAll || teaches(l) ? (counts.get(l.id) ?? { active: 0, completed: 0, dropped: 0 }) : null,
    canView: viewAll || teaches(l),
    canEnroll: enrollScope === 'all' || (enrollScope === 'own' && teaches(l)),
  }));
}

const courseSelect = {
  id: true,
  name: true,
  description: true,
  isActive: true,
  milestoneType: { select: { id: true, name: true, systemKey: true } },
  levels: { select: levelSelect, orderBy: { sortOrder: 'asc' } },
} as const;

/** Con alcance propio, solo los cursos donde enseña algún nivel. */
function courseWhereFor(viewer: Viewer): Prisma.CourseWhereInput {
  const level = levelWhereFor(viewer, 'discipulado.ver');
  if (!level) throw AppError.forbidden('PERMISSION_DENIED');
  return scopeOf(viewer, 'discipulado.ver') === 'all'
    ? { deletedAt: null }
    : { deletedAt: null, levels: { some: level } };
}

async function presentCourse(viewer: Viewer, row: Prisma.CourseGetPayload<{ select: typeof courseSelect }>) {
  return { ...row, levels: await presentLevels(viewer, row.levels) };
}

export async function listCourses(viewer: Viewer, q: z.infer<typeof ListQuery>) {
  const rows = await tenantDb().course.findMany({
    where: { AND: [courseWhereFor(viewer), q.includeInactive ? {} : { isActive: true }] },
    select: courseSelect,
    orderBy: { name: 'asc' },
  });
  return { items: await Promise.all(rows.map((r) => presentCourse(viewer, r))) };
}

export async function getCourse(viewer: Viewer, id: number) {
  const row = await tenantDb().course.findFirst({
    where: { AND: [{ id }, courseWhereFor(viewer)] },
    select: courseSelect,
  });
  if (!row) throw AppError.notFound('COURSE_NOT_FOUND');
  return presentCourse(viewer, row);
}

async function assertMilestone(id: number | null | undefined) {
  if (id && !(await tenantDb().catalogItem.count({ where: { id, type: 'milestone', isActive: true } }))) {
    throw AppError.badRequest('MILESTONE_INVALID');
  }
}

async function assertTeacher(personId: number | null | undefined) {
  if (personId && !(await tenantDb().person.count({ where: { id: personId, deletedAt: null } }))) {
    throw AppError.badRequest('PERSON_INVALID');
  }
}

export async function createCourse(viewer: Viewer, input: z.infer<typeof CreateCourseSchema>) {
  await assertMilestone(input.milestoneTypeId);
  for (const l of input.levels) await assertTeacher(l.teacherPersonId);
  const accountId = currentAccountId();
  const created = await tenantDb().course.create({
    data: {
      accountId,
      name: input.name,
      description: input.description ?? null,
      milestoneTypeId: input.milestoneTypeId ?? null,
      levels: {
        create: input.levels.map((l, i) => ({
          accountId,
          name: l.name,
          description: l.description ?? null,
          teacherPersonId: l.teacherPersonId ?? null,
          sortOrder: (i + 1) * 10,
        })),
      },
    },
    select: { id: true },
  });
  await audit({ action: 'courses.create', entity: 'Course', entityId: created.id, after: input });
  return getCourse(viewer, created.id);
}

async function existingCourse(id: number) {
  const course = await tenantDb().course.findFirst({ where: { id, deletedAt: null } });
  if (!course) throw AppError.notFound('COURSE_NOT_FOUND');
  return course;
}

export async function updateCourse(viewer: Viewer, id: number, input: z.infer<typeof UpdateCourseSchema>) {
  const before = await existingCourse(id);
  await assertMilestone(input.milestoneTypeId);
  const after = await tenantDb().course.update({ where: { id }, data: input });
  await audit({ action: 'courses.update', entity: 'Course', entityId: id, before, after });
  return getCourse(viewer, id);
}

export async function deleteCourse(id: number) {
  await existingCourse(id);
  await tenantDb().course.update({ where: { id }, data: { deletedAt: new Date() } });
  await audit({ action: 'courses.delete', entity: 'Course', entityId: id });
}

export async function addLevel(viewer: Viewer, courseId: number, input: z.infer<typeof CreateLevelSchema>) {
  await existingCourse(courseId);
  await assertTeacher(input.teacherPersonId);
  const db = tenantDb();
  const last = await db.courseLevel.aggregate({ where: { courseId }, _max: { sortOrder: true } });
  const level = await db.courseLevel.create({
    data: {
      accountId: currentAccountId(),
      courseId,
      name: input.name,
      description: input.description ?? null,
      teacherPersonId: input.teacherPersonId ?? null,
      minAttendancePct: input.minAttendancePct ?? null,
      sortOrder: (last._max.sortOrder ?? 0) + 10,
    },
  });
  await audit({ action: 'courses.level.create', entity: 'Course', entityId: courseId, after: level });
  return getCourse(viewer, courseId);
}

async function existingLevel(id: number) {
  const level = await tenantDb().courseLevel.findFirst({ where: { id, course: { deletedAt: null } } });
  if (!level) throw AppError.notFound('COURSE_LEVEL_NOT_FOUND');
  return level;
}

export async function updateLevel(viewer: Viewer, id: number, input: z.infer<typeof UpdateLevelSchema>) {
  const before = await existingLevel(id);
  await assertTeacher(input.teacherPersonId);
  const after = await tenantDb().courseLevel.update({ where: { id }, data: input });
  await audit({ action: 'courses.level.update', entity: 'Course', entityId: before.courseId, before, after });
  return getCourse(viewer, before.courseId);
}

export async function reorderLevels(viewer: Viewer, courseId: number, ids: number[]) {
  await existingCourse(courseId);
  const db = tenantDb();
  const levels = await db.courseLevel.findMany({ where: { courseId }, select: { id: true } });
  const current = new Set(levels.map((l) => l.id));
  if (ids.length !== current.size || new Set(ids).size !== ids.length || !ids.every((i) => current.has(i))) {
    throw AppError.badRequest('COURSE_LEVELS_MISMATCH');
  }
  await db.$transaction(
    ids.map((levelId, i) =>
      db.courseLevel.update({ where: { id: levelId }, data: { sortOrder: (i + 1) * 10 } }),
    ),
  );
  await audit({ action: 'courses.level.reorder', entity: 'Course', entityId: courseId, after: { ids } });
  return getCourse(viewer, courseId);
}

/** Solo un nivel sin inscripciones (con historial, se desactiva). */
export async function deleteLevel(id: number) {
  const level = await existingLevel(id);
  const db = tenantDb();
  if (
    (await db.courseEnrollment.count({ where: { levelId: id } })) ||
    (await db.courseSession.count({ where: { levelId: id } }))
  ) {
    throw AppError.conflict('COURSE_LEVEL_IN_USE');
  }
  await db.courseLevel.delete({ where: { id } });
  await audit({ action: 'courses.level.delete', entity: 'Course', entityId: level.courseId, before: level });
}

// ───────────── Inscripciones ─────────────

const enrollmentSelect = {
  id: true,
  levelId: true,
  status: true,
  enrolledAt: true,
  completedAt: true,
  droppedAt: true,
  notes: true,
  person: { select: { ...personRef, phone: true } },
} as const;

type EnrollmentRow = Prisma.CourseEnrollmentGetPayload<{ select: typeof enrollmentSelect }>;

const presentEnrollment = (e: EnrollmentRow) => ({
  ...e,
  enrolledAt: isoDate(e.enrolledAt),
  completedAt: isoDate(e.completedAt),
  droppedAt: isoDate(e.droppedAt),
});

export interface Progress {
  /** Clases en las que se le tomó asistencia. */
  sessions: number;
  attended: number;
  /** Porcentaje redondeado, o null si todavía no tuvo clases. */
  pct: number | null;
  /** Cumple la asistencia mínima del nivel (null: el nivel no la pide o no hubo clases). */
  meetsMinimum: boolean | null;
}

/** Avance de cada inscripción: asistencias sobre las clases en que se le tomó lista. */
export async function progressOf(
  enrollments: { id: number; minAttendancePct: number | null }[],
): Promise<Map<number, Progress>> {
  const ids = enrollments.map((e) => e.id);
  const rows = ids.length
    ? await tenantDb().courseAttendance.groupBy({
        by: ['enrollmentId', 'present'],
        where: { enrollmentId: { in: ids } },
        _count: { _all: true },
      })
    : [];
  const result = new Map<number, Progress>();
  for (const e of enrollments) {
    const mine = rows.filter((r) => r.enrollmentId === e.id);
    const sessions = mine.reduce((n, r) => n + r._count._all, 0);
    const attended = mine.find((r) => r.present)?._count._all ?? 0;
    const pct = sessions ? Math.round((attended / sessions) * 100) : null;
    result.set(e.id, {
      sessions,
      attended,
      pct,
      meetsMinimum: pct === null || e.minAttendancePct === null ? null : pct >= e.minAttendancePct,
    });
  }
  return result;
}

export async function listEnrollments(viewer: Viewer, levelId: number, q: z.infer<typeof EnrollmentQuery>) {
  await assertLevel(viewer, levelId, 'discipulado.ver');
  const db = tenantDb();
  const level = await db.courseLevel.findUniqueOrThrow({
    where: { id: levelId },
    select: { minAttendancePct: true },
  });
  const rows = await db.courseEnrollment.findMany({
    where: { levelId, person: { deletedAt: null }, ...(q.status === 'all' ? {} : { status: q.status }) },
    select: enrollmentSelect,
    orderBy: [{ person: { lastName: 'asc' } }, { person: { firstName: 'asc' } }],
    take: 500,
  });
  const progress = await progressOf(
    rows.map((r) => ({ id: r.id, minAttendancePct: level.minAttendancePct })),
  );
  return { items: rows.map((r) => ({ ...presentEnrollment(r), progress: progress.get(r.id)! })) };
}

/** Inscribe a varias personas; quien ya está activa en el nivel se saltea. */
export async function enroll(viewer: Viewer, levelId: number, input: z.infer<typeof EnrollSchema>) {
  await assertLevel(viewer, levelId, 'discipulado.inscribir');
  const db = tenantDb();
  const open = await db.courseLevel.count({
    where: { id: levelId, isActive: true, course: { isActive: true } },
  });
  if (!open) throw AppError.badRequest('COURSE_LEVEL_INACTIVE');
  const ids = [...new Set(input.personIds)];
  const people = await db.person.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true },
  });
  if (people.length !== ids.length) throw AppError.badRequest('PERSON_INVALID');
  const already = new Set(
    (
      await db.courseEnrollment.findMany({
        where: { levelId, personId: { in: ids }, status: 'active' },
        select: { personId: true },
      })
    ).map((e) => e.personId),
  );
  const toCreate = ids.filter((id) => !already.has(id));
  const enrolledAt = input.enrolledAt ? toDate(input.enrolledAt) : await todayDate();
  if (toCreate.length) {
    await db.courseEnrollment.createMany({
      data: toCreate.map((personId) => ({
        accountId: currentAccountId(),
        levelId,
        personId,
        enrolledAt,
        createdById: viewer.userId,
      })),
    });
    await audit({
      action: 'courses.enroll',
      entity: 'CourseLevel',
      entityId: levelId,
      after: { personIds: toCreate, enrolledAt: isoDate(enrolledAt) },
    });
  }
  return { created: toCreate.length, skipped: ids.length - toCreate.length };
}

/**
 * Cambia el estado (completada, baja o de nuevo activa) o las notas. Al completar el último nivel
 * activo del curso, si el curso tiene hito y la persona todavía no lo tiene, se lo carga. Devuelve
 * el siguiente nivel (si lo hay) para ofrecer inscribirla ahí.
 */
export async function updateEnrollment(
  viewer: Viewer,
  id: number,
  input: z.infer<typeof UpdateEnrollmentSchema>,
) {
  const db = tenantDb();
  const before = await db.courseEnrollment.findFirst({
    where: { id, level: { course: { deletedAt: null } } },
    include: { level: { include: { course: true } } },
  });
  if (!before) throw AppError.notFound('COURSE_ENROLLMENT_NOT_FOUND');
  await assertLevel(viewer, before.levelId, 'discipulado.inscribir');

  const status = input.status ?? before.status;
  const statusChanged = status !== before.status;
  if (
    status === 'active' &&
    statusChanged &&
    (await db.courseEnrollment.count({
      where: { levelId: before.levelId, personId: before.personId, status: 'active' },
    }))
  ) {
    throw AppError.conflict('COURSE_ALREADY_ENROLLED');
  }
  const date = input.date ? toDate(input.date) : statusChanged ? await todayDate() : null;
  const data: Prisma.CourseEnrollmentUncheckedUpdateInput = { notes: input.notes, status };
  if (status === 'active') {
    Object.assign(data, { completedAt: null, droppedAt: null }, input.date ? { enrolledAt: date } : {});
  } else if (status === 'completed') {
    Object.assign(data, { completedAt: date ?? before.completedAt, droppedAt: null });
  } else {
    Object.assign(data, { droppedAt: date ?? before.droppedAt, completedAt: null });
  }
  const finalEnrolled = (data.enrolledAt as Date | undefined) ?? before.enrolledAt;
  const finalDate = (data.completedAt ?? data.droppedAt) as Date | null;
  if (finalDate && finalDate < finalEnrolled) throw AppError.badRequest('COURSE_DATE_BEFORE_ENROLLMENT');

  const after = await db.courseEnrollment.update({ where: { id }, data, select: enrollmentSelect });
  await audit({
    action: 'courses.enrollment.update',
    entity: 'CourseEnrollment',
    entityId: id,
    before: { status: before.status, notes: before.notes },
    after: { status, notes: after.notes, date: isoDate(finalDate) },
  });

  let milestoneAdded = false;
  let nextLevel: { id: number; name: string } | null = null;
  if (status === 'completed' && statusChanged) {
    const levels = await db.courseLevel.findMany({
      where: { courseId: before.level.courseId, isActive: true },
      select: { id: true, name: true },
      orderBy: { sortOrder: 'asc' },
    });
    // Un nivel desactivado no tiene siguiente ni cierra el curso.
    const index = levels.findIndex((l) => l.id === before.levelId);
    const next = index >= 0 ? levels[index + 1] : undefined;
    const last = index >= 0 && index === levels.length - 1;
    nextLevel =
      next &&
      !(await db.courseEnrollment.count({
        where: { levelId: next.id, personId: before.personId, status: 'active' },
      }))
        ? next
        : null;
    const milestoneTypeId = before.level.course.milestoneTypeId;
    if (last && milestoneTypeId) {
      const has = await db.personMilestone.count({ where: { personId: before.personId, milestoneTypeId } });
      if (!has) {
        await db.personMilestone.create({
          data: {
            accountId: currentAccountId(),
            personId: before.personId,
            milestoneTypeId,
            date: after.completedAt!,
            notes: before.level.course.name.slice(0, 500),
          },
        });
        await audit({
          action: 'people.milestone.add',
          entity: 'Person',
          entityId: before.personId,
          after: { milestoneTypeId, source: 'course', courseId: before.level.courseId },
        });
        milestoneAdded = true;
      }
    }
  }
  return { enrollment: presentEnrollment(after), milestoneAdded, nextLevel };
}

/** Borra una inscripción cargada por error (una baja se registra con el estado "dropped"). */
export async function deleteEnrollment(viewer: Viewer, id: number) {
  const db = tenantDb();
  const row = await db.courseEnrollment.findFirst({ where: { id, level: { course: { deletedAt: null } } } });
  if (!row) throw AppError.notFound('COURSE_ENROLLMENT_NOT_FOUND');
  await assertLevel(viewer, row.levelId, 'discipulado.inscribir');
  await db.$transaction([
    db.courseAttendance.deleteMany({ where: { enrollmentId: id } }),
    db.courseEnrollment.delete({ where: { id } }),
  ]);
  await audit({ action: 'courses.enrollment.delete', entity: 'CourseEnrollment', entityId: id, before: row });
}

/** Formación de una persona (ficha): sus inscripciones en los niveles que el usuario puede ver. */
export async function personCourses(viewer: Viewer, personId: number) {
  const level = levelWhereFor(viewer, 'discipulado.ver');
  if (!level) throw AppError.forbidden('PERMISSION_DENIED');
  const rows = await tenantDb().courseEnrollment.findMany({
    where: { personId, level },
    select: {
      id: true,
      status: true,
      enrolledAt: true,
      completedAt: true,
      droppedAt: true,
      level: {
        select: {
          id: true,
          name: true,
          minAttendancePct: true,
          course: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { enrolledAt: 'desc' },
  });
  const progress = await progressOf(
    rows.map((r) => ({ id: r.id, minAttendancePct: r.level.minAttendancePct })),
  );
  return {
    items: rows.map(({ level: { minAttendancePct: _min, ...level }, ...r }) => ({
      ...r,
      level,
      enrolledAt: isoDate(r.enrolledAt),
      completedAt: isoDate(r.completedAt),
      droppedAt: isoDate(r.droppedAt),
      progress: progress.get(r.id)!,
    })),
  };
}
