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

/** Nivel con asistencia mínima del 75% y tres inscriptos desde el 1/3. */
async function setup() {
  const church = await provisionChurch();
  const h = church.headers;
  const course = (await send(h, 'post', '/courses', { name: 'Escuela', levels: [{ name: 'Nivel 1' }] })).body;
  const levelId = course.levels[0].id as number;
  await send(h, 'patch', `/course-levels/${levelId}`, { minAttendancePct: 75 });
  const people = [await person(h, 'Ana'), await person(h, 'Beto'), await person(h, 'Ceci')];
  await send(h, 'post', `/course-levels/${levelId}/enrollments`, {
    personIds: people,
    enrolledAt: '2026-03-01',
  });
  const enrollments = (await get(h, `/course-levels/${levelId}/enrollments`)).body.items as {
    id: number;
    person: { firstName: string };
  }[];
  const id = (name: string) => enrollments.find((e) => e.person.firstName === name)!.id;
  return { church, h, levelId, ana: id('Ana'), beto: id('Beto'), ceci: id('Ceci') };
}

describe('clases y asistencia', () => {
  it('toma asistencia, lista clases con presentes y calcula el avance', async () => {
    const { h, levelId, ana, beto, ceci } = await setup();
    const roster = await get(h, `/course-levels/${levelId}/roster?date=2026-03-07`);
    expect(roster.body.items).toHaveLength(3);
    expect(roster.body.items[0]).toMatchObject({ present: null, person: { firstName: 'Ana' } });

    const dates = ['2026-03-07', '2026-03-14', '2026-03-21', '2026-03-28'];
    for (const [i, date] of dates.entries()) {
      const res = await send(h, 'post', `/course-levels/${levelId}/sessions`, {
        date,
        topic: `Clase ${i + 1}`,
        attendance: [
          { enrollmentId: ana, present: true },
          { enrollmentId: beto, present: i % 2 === 0 },
          { enrollmentId: ceci, present: i === 0 },
        ],
      });
      expect(res.status).toBe(201);
    }
    const list = await get(h, `/course-levels/${levelId}/sessions`);
    expect(list.body.items.map((s: { date: string }) => s.date)).toEqual([...dates].reverse());
    expect(list.body.items[3]).toMatchObject({ topic: 'Clase 1', present: 3, total: 3 });

    const enrollments = (await get(h, `/course-levels/${levelId}/enrollments`)).body.items;
    const progress = (name: string) =>
      enrollments.find((e: { person: { firstName: string } }) => e.person.firstName === name).progress;
    expect(progress('Ana')).toEqual({ sessions: 4, attended: 4, pct: 100, meetsMinimum: true });
    expect(progress('Beto')).toEqual({ sessions: 4, attended: 2, pct: 50, meetsMinimum: false });
    expect(progress('Ceci')).toMatchObject({ attended: 1, pct: 25 });

    // Ficha de la persona.
    const anaPerson = (await prisma.courseEnrollment.findUniqueOrThrow({ where: { id: ana } })).personId;
    expect((await get(h, `/people/${anaPerson}/courses`)).body.items[0].progress.pct).toBe(100);
  });

  it('una clase por día; no se cargan clases futuras ni inscripciones de otro nivel', async () => {
    const { h, levelId, ana } = await setup();
    const body = { date: '2026-03-07', attendance: [{ enrollmentId: ana, present: true }] };
    expect((await send(h, 'post', `/course-levels/${levelId}/sessions`, body)).status).toBe(201);
    const dup = await send(h, 'post', `/course-levels/${levelId}/sessions`, body);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('COURSE_SESSION_EXISTS');

    const future = await send(h, 'post', `/course-levels/${levelId}/sessions`, { date: '2099-01-01' });
    expect(future.body.error.code).toBe('COURSE_SESSION_FUTURE');

    const other = (await send(h, 'post', '/courses', { name: 'Otro', levels: [{ name: 'N' }] })).body
      .levels[0].id;
    const wrong = await send(h, 'post', `/course-levels/${other}/sessions`, {
      date: '2026-03-08',
      attendance: [{ enrollmentId: ana, present: true }],
    });
    expect(wrong.body.error.code).toBe('COURSE_ATTENDANCE_INVALID');
  });

  it('la lista de una clase: quien se inscribió después o ya había terminado no aparece', async () => {
    const { h, levelId, beto } = await setup();
    await send(h, 'patch', `/course-enrollments/${beto}`, { status: 'dropped', date: '2026-03-10' });
    const late = await person(h, 'Dani');
    await send(h, 'post', `/course-levels/${levelId}/enrollments`, {
      personIds: [late],
      enrolledAt: '2026-03-20',
    });
    const names = async (date: string) =>
      (await get(h, `/course-levels/${levelId}/roster?date=${date}`)).body.items.map(
        (r: { person: { firstName: string } }) => r.person.firstName,
      );
    expect(await names('2026-03-07')).toEqual(['Ana', 'Beto', 'Ceci']);
    expect(await names('2026-03-14')).toEqual(['Ana', 'Ceci']);
    expect(await names('2026-03-21')).toEqual(['Ana', 'Ceci', 'Dani']);
  });

  it('editar la asistencia y la fecha; borrar la clase', async () => {
    const { h, levelId, ana, beto } = await setup();
    const created = await send(h, 'post', `/course-levels/${levelId}/sessions`, {
      date: '2026-03-07',
      attendance: [
        { enrollmentId: ana, present: false },
        { enrollmentId: beto, present: true },
      ],
    });
    const id = created.body.id;
    expect(created.body.roster.find((r: { enrollmentId: number }) => r.enrollmentId === ana).present).toBe(
      false,
    );
    const updated = await send(h, 'patch', `/course-sessions/${id}`, {
      date: '2026-03-08',
      topic: 'La oración',
      attendance: [{ enrollmentId: ana, present: true }],
    });
    expect(updated.body).toMatchObject({ date: '2026-03-08', topic: 'La oración' });
    const present = (eid: number) =>
      updated.body.roster.find((r: { enrollmentId: number }) => r.enrollmentId === eid).present;
    expect(present(ana)).toBe(true);
    expect(present(beto)).toBe(true);

    expect((await send(h, 'delete', `/course-sessions/${id}`)).status).toBe(204);
    expect(await prisma.courseAttendance.count()).toBe(0);
    expect((await get(h, `/course-sessions/${id}`)).status).toBe(404);
  });

  it('borrar una inscripción borra su asistencia; un nivel con clases no se borra', async () => {
    const { h, levelId, ana } = await setup();
    await send(h, 'post', `/course-levels/${levelId}/sessions`, {
      date: '2026-03-07',
      attendance: [{ enrollmentId: ana, present: true }],
    });
    expect((await send(h, 'delete', `/course-enrollments/${ana}`)).status).toBe(204);
    expect(await prisma.courseAttendance.count()).toBe(0);
    expect((await send(h, 'delete', `/course-levels/${levelId}`)).body.error.code).toBe(
      'COURSE_LEVEL_IN_USE',
    );
  });

  it('maestro con alcance propio toma asistencia solo en su nivel; otra iglesia no ve nada', async () => {
    const { church, h, levelId, ana } = await setup();
    const teacher = await actor(
      { 'discipulado.ver': 'own', 'discipulado.inscribir': 'own' },
      church.accountId,
    );
    const body = { date: '2026-03-07', attendance: [{ enrollmentId: ana, present: true }] };
    expect((await send(teacher.headers, 'post', `/course-levels/${levelId}/sessions`, body)).status).toBe(
      404,
    );
    const teacherPerson = await person(h, 'Marta');
    await prisma.user.update({ where: { id: teacher.user.id }, data: { personId: teacherPerson } });
    await send(h, 'patch', `/course-levels/${levelId}`, { teacherPersonId: teacherPerson });
    const created = await send(teacher.headers, 'post', `/course-levels/${levelId}/sessions`, body);
    expect(created.status).toBe(201);

    const viewer = await actor({ 'discipulado.ver': 'all' }, church.accountId);
    expect((await send(viewer.headers, 'delete', `/course-sessions/${created.body.id}`)).status).toBe(403);

    const other = await provisionChurch();
    expect((await get(other.headers, `/course-sessions/${created.body.id}`)).status).toBe(404);
    expect((await get(other.headers, `/course-levels/${levelId}/sessions`)).status).toBe(404);
  });
});
