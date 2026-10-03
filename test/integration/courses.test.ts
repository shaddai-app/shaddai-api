import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { actor, app, prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;
const get = (h: Headers, path: string) => request(app).get(api(path)).set(h);
const send = (h: Headers, method: 'post' | 'patch' | 'put' | 'delete', path: string, body?: object) =>
  request(app)[method](api(path)).set(h).send(body);

async function person(h: Headers, firstName: string) {
  const res = await send(h, 'post', '/people', { firstName, lastName: 'Test', allowDuplicate: true });
  return res.body.id as number;
}

/** Iglesia con un curso de tres niveles que da el hito "Escuela de líderes". */
async function setup() {
  const church = await provisionChurch();
  const h = church.headers;
  const milestone = await prisma.catalogItem.findFirstOrThrow({
    where: { accountId: church.accountId, type: 'milestone', systemKey: 'leaders_school' },
  });
  const res = await send(h, 'post', '/courses', {
    name: 'Escuela de líderes',
    milestoneTypeId: milestone.id,
    levels: [{ name: 'Nivel 1' }, { name: 'Nivel 2' }, { name: 'Nivel 3' }],
  });
  expect(res.status).toBe(201);
  const course = res.body as { id: number; levels: { id: number; name: string }[] };
  return { church, h, milestone, course, levels: course.levels.map((l) => l.id) as [number, number, number] };
}

describe('cursos y niveles', () => {
  it('crear, listar, reordenar, agregar y borrar niveles', async () => {
    const { h, course, levels } = await setup();
    expect(course.levels.map((l) => l.name)).toEqual(['Nivel 1', 'Nivel 2', 'Nivel 3']);
    const list = await get(h, '/courses');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      name: 'Escuela de líderes',
      milestoneType: { systemKey: 'leaders_school' },
    });
    expect(list.body.items[0].levels[0]).toMatchObject({
      counts: { active: 0, completed: 0, dropped: 0 },
      canView: true,
      canEnroll: true,
    });

    const reordered = await send(h, 'put', `/courses/${course.id}/levels/order`, {
      ids: [levels[2], levels[0], levels[1]],
    });
    expect(reordered.body.levels.map((l: { name: string }) => l.name)).toEqual([
      'Nivel 3',
      'Nivel 1',
      'Nivel 2',
    ]);
    expect((await send(h, 'put', `/courses/${course.id}/levels/order`, { ids: [levels[0]] })).status).toBe(
      400,
    );

    const added = await send(h, 'post', `/courses/${course.id}/levels`, { name: 'Taller' });
    expect(added.status).toBe(201);
    expect(added.body.levels.at(-1).name).toBe('Taller');

    const p = await person(h, 'Ana');
    await send(h, 'post', `/course-levels/${levels[0]}/enrollments`, { personIds: [p] });
    const inUse = await send(h, 'delete', `/course-levels/${levels[0]}`);
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.code).toBe('COURSE_LEVEL_IN_USE');
    expect((await send(h, 'delete', `/course-levels/${levels[1]}`)).status).toBe(204);

    const updated = await send(h, 'patch', `/courses/${course.id}`, { isActive: false });
    expect(updated.body.isActive).toBe(false);
    expect((await get(h, '/courses')).body.items).toHaveLength(0);
    expect((await get(h, '/courses?includeInactive=true')).body.items).toHaveLength(1);
    expect((await send(h, 'delete', `/courses/${course.id}`)).status).toBe(204);
    expect((await get(h, `/courses/${course.id}`)).status).toBe(404);
  });

  it('valida el hito y el maestro', async () => {
    const { h, course } = await setup();
    const status = await prisma.catalogItem.findFirstOrThrow({ where: { type: 'person_status' } });
    const bad = await send(h, 'patch', `/courses/${course.id}`, { milestoneTypeId: status.id });
    expect(bad.body.error.code).toBe('MILESTONE_INVALID');
    const badTeacher = await send(h, 'post', `/courses/${course.id}/levels`, {
      name: 'X',
      teacherPersonId: 999999,
    });
    expect(badTeacher.body.error.code).toBe('PERSON_INVALID');
  });
});

describe('inscripciones', () => {
  it('inscribe varias personas y saltea a quien ya está activa', async () => {
    const { h, levels } = await setup();
    const [a, b] = [await person(h, 'Ana'), await person(h, 'Beto')];
    const first = await send(h, 'post', `/course-levels/${levels[0]}/enrollments`, {
      personIds: [a, b],
      enrolledAt: '2026-03-01',
    });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ created: 2, skipped: 0 });
    expect(
      (await send(h, 'post', `/course-levels/${levels[0]}/enrollments`, { personIds: [a] })).body,
    ).toEqual({
      created: 0,
      skipped: 1,
    });
    const list = await get(h, `/course-levels/${levels[0]}/enrollments`);
    expect(list.body.items.map((e: { person: { firstName: string } }) => e.person.firstName)).toEqual([
      'Ana',
      'Beto',
    ]);
    expect(list.body.items[0]).toMatchObject({
      status: 'active',
      enrolledAt: '2026-03-01',
      completedAt: null,
    });

    expect(
      (await send(h, 'post', `/course-levels/${levels[0]}/enrollments`, { personIds: [999999] })).status,
    ).toBe(400);
    await send(h, 'patch', `/course-levels/${levels[1]}`, { isActive: false });
    const closed = await send(h, 'post', `/course-levels/${levels[1]}/enrollments`, { personIds: [a] });
    expect(closed.body.error.code).toBe('COURSE_LEVEL_INACTIVE');
  });

  it('completar: ofrece el siguiente nivel y el último carga el hito una sola vez', async () => {
    const { church, h, milestone, levels } = await setup();
    const a = await person(h, 'Ana');
    const enrollIn = async (level: number) => {
      await send(h, 'post', `/course-levels/${level}/enrollments`, {
        personIds: [a],
        enrolledAt: '2026-01-10',
      });
      return (await get(h, `/course-levels/${level}/enrollments`)).body.items[0].id as number;
    };

    const e1 = await enrollIn(levels[0]);
    const done1 = await send(h, 'patch', `/course-enrollments/${e1}`, {
      status: 'completed',
      date: '2026-04-01',
    });
    expect(done1.body).toMatchObject({
      enrollment: { status: 'completed', completedAt: '2026-04-01' },
      milestoneAdded: false,
      nextLevel: { id: levels[1], name: 'Nivel 2' },
    });

    const e2 = await enrollIn(levels[1]);
    await send(h, 'patch', `/course-enrollments/${e2}`, { status: 'completed' });
    const e3 = await enrollIn(levels[2]);
    const before = await send(h, 'patch', `/course-enrollments/${e3}`, {
      status: 'completed',
      date: '2026-01-01',
    });
    expect(before.body.error.code).toBe('COURSE_DATE_BEFORE_ENROLLMENT');
    const last = await send(h, 'patch', `/course-enrollments/${e3}`, {
      status: 'completed',
      date: '2026-09-30',
    });
    expect(last.body).toMatchObject({ milestoneAdded: true, nextLevel: null });
    const milestones = await prisma.personMilestone.findMany({ where: { personId: a } });
    expect(milestones).toHaveLength(1);
    expect(milestones[0]).toMatchObject({ milestoneTypeId: milestone.id, notes: 'Escuela de líderes' });
    expect(milestones[0]!.date.toISOString().slice(0, 10)).toBe('2026-09-30');

    // Reabrir y volver a completar no duplica el hito.
    await send(h, 'patch', `/course-enrollments/${e3}`, { status: 'active' });
    const again = await send(h, 'patch', `/course-enrollments/${e3}`, { status: 'completed' });
    expect(again.body.milestoneAdded).toBe(false);
    expect(await prisma.personMilestone.count({ where: { personId: a } })).toBe(1);

    // Ficha de la persona.
    const courses = await get(h, `/people/${a}/courses`);
    expect(courses.body.items).toHaveLength(3);
    expect(courses.body.items[0].level.course.name).toBe('Escuela de líderes');
    expect(church.accountId).toBeGreaterThan(0);
  });

  it('baja, reactivación sin duplicar y borrado', async () => {
    const { h, levels } = await setup();
    const a = await person(h, 'Ana');
    await send(h, 'post', `/course-levels/${levels[0]}/enrollments`, { personIds: [a] });
    const id = (await get(h, `/course-levels/${levels[0]}/enrollments`)).body.items[0].id;
    const dropped = await send(h, 'patch', `/course-enrollments/${id}`, {
      status: 'dropped',
      notes: 'Se mudó',
    });
    expect(dropped.body.enrollment).toMatchObject({ status: 'dropped', notes: 'Se mudó' });
    expect(dropped.body.enrollment.droppedAt).toBeTruthy();
    expect((await get(h, `/course-levels/${levels[0]}/enrollments`)).body.items).toHaveLength(0);
    expect((await get(h, `/course-levels/${levels[0]}/enrollments?status=dropped`)).body.items).toHaveLength(
      1,
    );

    // Se vuelve a inscribir: la baja queda como historial y no se puede reactivar encima.
    await send(h, 'post', `/course-levels/${levels[0]}/enrollments`, { personIds: [a] });
    const conflict = await send(h, 'patch', `/course-enrollments/${id}`, { status: 'active' });
    expect(conflict.status).toBe(409);
    expect((await send(h, 'delete', `/course-enrollments/${id}`)).status).toBe(204);
    expect((await get(h, `/course-levels/${levels[0]}/enrollments?status=all`)).body.items).toHaveLength(1);
  });

  it('maestro con alcance propio: ve e inscribe solo en los niveles que da', async () => {
    const { church, h, course, levels } = await setup();
    const teacher = await actor(
      { 'discipulado.ver': 'own', 'discipulado.inscribir': 'own' },
      church.accountId,
    );
    const teacherPerson = await person(h, 'Marta');
    await prisma.user.update({ where: { id: teacher.user.id }, data: { personId: teacherPerson } });
    await send(h, 'patch', `/course-levels/${levels[0]}`, { teacherPersonId: teacherPerson });
    await send(h, 'post', '/courses', { name: 'Bautismo', levels: [{ name: 'Clases' }] });

    const list = (await get(teacher.headers, '/courses')).body.items;
    expect(list.map((c: { name: string }) => c.name)).toEqual(['Escuela de líderes']);
    const [mine, other] = list[0].levels;
    expect(mine).toMatchObject({ canView: true, canEnroll: true, teacher: { id: teacherPerson } });
    expect(other).toMatchObject({ canView: false, canEnroll: false, counts: null });

    const a = await person(h, 'Ana');
    expect(
      (await send(teacher.headers, 'post', `/course-levels/${levels[0]}/enrollments`, { personIds: [a] }))
        .status,
    ).toBe(201);
    expect(
      (await send(teacher.headers, 'post', `/course-levels/${levels[1]}/enrollments`, { personIds: [a] }))
        .status,
    ).toBe(404);
    expect((await get(teacher.headers, `/course-levels/${levels[1]}/enrollments`)).status).toBe(404);
    expect((await send(teacher.headers, 'patch', `/courses/${course.id}`, { name: 'x' })).status).toBe(403);

    // Sin ficha vinculada no tiene niveles propios.
    const noPerson = await actor({ 'discipulado.ver': 'own' }, church.accountId);
    expect((await get(noPerson.headers, '/courses')).body.items).toEqual([]);
  });

  it('fusionar personas mueve las inscripciones sin duplicar la activa', async () => {
    const { h, levels } = await setup();
    const [a, b] = [await person(h, 'Ana'), await person(h, 'Ana')];
    await send(h, 'post', `/course-levels/${levels[0]}/enrollments`, { personIds: [a, b] });
    await send(h, 'post', `/course-levels/${levels[1]}/enrollments`, { personIds: [b] });
    expect((await send(h, 'post', `/people/${b}/merge`, { intoId: a })).status).toBe(200);
    const rows = await prisma.courseEnrollment.findMany({ where: { personId: { in: [a, b] } } });
    expect(rows.map((r) => [r.personId, r.levelId]).sort()).toEqual(
      [
        [a, levels[0]],
        [a, levels[1]],
      ].sort(),
    );
  });

  it('no se ven cursos de otra iglesia', async () => {
    const { course, levels } = await setup();
    const other = await provisionChurch();
    expect((await get(other.headers, '/courses')).body.items).toEqual([]);
    expect((await get(other.headers, `/courses/${course.id}`)).status).toBe(404);
    expect((await get(other.headers, `/course-levels/${levels[0]}/enrollments`)).status).toBe(404);
    expect((await send(other.headers, 'patch', `/course-levels/${levels[0]}`, { name: 'x' })).status).toBe(
      404,
    );
  });
});
