import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, dayOfWeek, meetingDateInWeek, todayIn, weekStart } from '../../src/core/time/local-date.js';
import { actor, app, prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;
const TZ = 'America/Argentina/Buenos_Aires';
const today = () => todayIn(TZ);

async function person(headers: Headers, firstName: string, extra: object = {}) {
  const res = await request(app)
    .post(api('/people'))
    .set(headers)
    .send({ firstName, lastName: 'Test', allowDuplicate: true, ...extra });
  if (res.status !== 201) throw new Error(`persona: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as number;
}

async function post(headers: Headers, path: string, body: object) {
  const res = await request(app).post(api(path)).set(headers).send(body);
  if (res.status !== 201) throw new Error(`${path}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function setup() {
  const c = await provisionChurch();
  const network = await post(c.headers, '/networks', { name: 'Red' });
  const zoneA = await post(c.headers, '/zones', { name: 'Zona A', networkId: network.id });
  const zoneB = await post(c.headers, '/zones', { name: 'Zona B', networkId: network.id });
  const leaderA = await person(c.headers, 'LíderA');
  const leaderB = await person(c.headers, 'LíderB');
  const base = { meetingDay: 3, meetingTime: '20:00', address: 'Calle 1' };
  const cellA = await post(c.headers, '/cells', {
    ...base,
    name: 'Célula A',
    zoneId: zoneA.id,
    leaderPersonId: leaderA,
  });
  const cellB = await post(c.headers, '/cells', {
    ...base,
    name: 'Célula B',
    zoneId: zoneB.id,
    leaderPersonId: leaderB,
  });
  const m1 = await person(c.headers, 'Uno');
  const m2 = await person(c.headers, 'Dos');
  const m3 = await person(c.headers, 'Tres');
  for (const m of [m1, m2, m3]) await post(c.headers, `/cells/${cellA.id}/members`, { personId: m });
  const leader = await actor(
    {
      'personas.ver': 'own',
      'celulas.ver': 'own',
      'celulas.reportar': 'own',
      'celulas.ver_reportes': 'own',
      'celulas.multiplicar': 'own',
    },
    c.accountId,
  );
  await prisma.user.update({ where: { id: leader.user.id }, data: { personId: leaderA } });
  return { ...c, zoneA, zoneB, leaderA, leaderB, cellA, cellB, m1, m2, m3, leader };
}

describe('reporte semanal', () => {
  it('el líder carga asistencia, visitas con y sin ficha y visitas nuevas', async () => {
    const s = await setup();
    const known = await person(s.headers, 'Conocida', { phone: '11 4444 1111' });
    const res = await request(app)
      .post(api(`/cells/${s.cellA.id}/reports`))
      .set(s.leader.headers)
      .send({
        meetingDate: today(),
        held: true,
        topic: 'La oración',
        attendance: [s.leaderA, s.m1, s.m2],
        visitors: [known],
        newVisitors: [
          { firstName: 'Nueva', lastName: 'Visita', phone: '11 5555 2222' },
          // Mismo teléfono que una ficha existente: se reutiliza en lugar de duplicar.
          { firstName: 'Conocida', lastName: 'Test', phone: '1144441111' },
        ],
        anonymousVisitors: 2,
        childrenCount: 3,
        offeringAmount: 1500.5,
      });
    expect(res.status).toBe(201);
    expect(res.body.totals).toEqual({ members: 3, visitors: 4, children: 3, total: 10 });
    expect(res.body.offeringAmount).toBe(1500.5);
    expect(res.body.visitors).toHaveLength(2);
    expect(res.body.access.edit).toBe(true);
    const created = await prisma.person.findFirstOrThrow({ where: { firstName: 'Nueva' } });
    expect(created).toMatchObject({ source: 'cell', createdById: s.leader.user.id });
    expect(await prisma.person.count({ where: { firstName: 'Conocida' } })).toBe(1);

    const dup = await request(app)
      .post(api(`/cells/${s.cellA.id}/reports`))
      .set(s.leader.headers)
      .send({ meetingDate: today(), held: true, attendance: [s.m1] });
    expect(dup.body.error).toMatchObject({ code: 'REPORT_EXISTS', details: { reportId: res.body.id } });
  });

  it('validaciones: futuro, ventana de días, no realizada, asistencia ajena', async () => {
    const s = await setup();
    const send = (headers: Headers, body: object) =>
      request(app)
        .post(api(`/cells/${s.cellA.id}/reports`))
        .set(headers)
        .send(body);
    expect(
      (await send(s.leader.headers, { meetingDate: addDays(today(), 1), held: true })).body.error.code,
    ).toBe('DATE_IN_FUTURE');
    const old = addDays(today(), -8); // la ventana por defecto es de 7 días
    expect((await send(s.leader.headers, { meetingDate: old, held: true })).body.error.code).toBe(
      'REPORT_WINDOW_CLOSED',
    );
    // Con alcance total (admin) no hay ventana.
    expect((await send(s.headers, { meetingDate: old, held: true })).status).toBe(201);

    const d = addDays(today(), -1);
    expect((await send(s.leader.headers, { meetingDate: d, held: false })).body.error.code).toBe(
      'NOT_HELD_REASON_REQUIRED',
    );
    expect(
      (
        await send(s.leader.headers, {
          meetingDate: d,
          held: false,
          notHeldReason: 'Lluvia',
          attendance: [s.m1],
        })
      ).body.error.code,
    ).toBe('REPORT_NOT_HELD_WITH_ATTENDANCE');
    expect(
      (await send(s.leader.headers, { meetingDate: d, held: true, attendance: [s.leaderB] })).body.error.code,
    ).toBe('ATTENDANCE_INVALID');
    const notHeld = await send(s.leader.headers, { meetingDate: d, held: false, notHeldReason: 'Lluvia' });
    expect(notHeld.body).toMatchObject({ held: false, totals: { total: 0 } });
  });

  it('corrección dentro de la ventana y alcance: no reporta ni ve células ajenas', async () => {
    const s = await setup();
    const report = await post(s.leader.headers, `/cells/${s.cellA.id}/reports`, {
      meetingDate: today(),
      held: true,
      attendance: [s.m1],
    });
    const fixed = await request(app)
      .patch(api(`/cell-reports/${report.id}`))
      .set(s.leader.headers)
      .send({ attendance: [s.m1, s.m2, s.m3], topic: 'Fe' });
    expect(fixed.body).toMatchObject({ topic: 'Fe', totals: { members: 3 } });

    const other = await request(app)
      .post(api(`/cells/${s.cellB.id}/reports`))
      .set(s.leader.headers)
      .send({ meetingDate: today(), held: true });
    expect(other.status).toBe(404);
    const bReport = await post(s.headers, `/cells/${s.cellB.id}/reports`, {
      meetingDate: today(),
      held: true,
    });
    expect(
      (
        await request(app)
          .get(api(`/cell-reports/${bReport.id}`))
          .set(s.leader.headers)
      ).status,
    ).toBe(404);
    const list = await request(app).get(api('/cell-reports')).set(s.leader.headers);
    expect(list.body.items.map((r: { cellId: number }) => r.cellId)).toEqual([s.cellA.id]);

    // Fuera de la ventana el líder ya no lo puede corregir; el admin sí.
    await prisma.cellReport.update({
      where: { id: report.id },
      data: { meetingDate: new Date(`${addDays(today(), -10)}T00:00:00Z`) },
    });
    const late = await request(app)
      .patch(api(`/cell-reports/${report.id}`))
      .set(s.leader.headers)
      .send({ topic: 'x' });
    expect(late.body.error.code).toBe('REPORT_WINDOW_CLOSED');
    expect(
      (
        await request(app)
          .get(api(`/cell-reports/${report.id}`))
          .set(s.leader.headers)
      ).body.access.edit,
    ).toBe(false);
    expect(
      (
        await request(app)
          .patch(api(`/cell-reports/${report.id}`))
          .set(s.headers)
          .send({ topic: 'y' })
      ).status,
    ).toBe(200);
  });
});

describe('semáforo de cumplimiento', () => {
  it('reportadas en verde, faltantes en rojo, y la tasa de la semana', async () => {
    const s = await setup();
    // Semana de hace dos: todas las reuniones ya pasaron hace más de 2 días.
    const week = addDays(today(), -14);
    const start = weekStart(week, 1);
    const expected = meetingDateInWeek(start, 1, 3);
    await post(s.headers, `/cells/${s.cellA.id}/reports`, {
      meetingDate: expected,
      held: true,
      attendance: [s.m1, s.m2],
    });
    await prisma.cell.updateMany({ data: { startedAt: new Date(`${addDays(today(), -60)}T00:00:00Z`) } });

    const res = await request(app)
      .get(api(`/cell-reports/compliance?week=${week}`))
      .set(s.headers);
    expect(res.body.week).toEqual({ start, end: addDays(start, 6) });
    expect(res.body.summary).toMatchObject({ cells: 2, reported: 1, missing: 1, rate: 50, attendance: 2 });
    const byName = Object.fromEntries(
      res.body.items.map((i: { cell: { name: string }; status: string }) => [i.cell.name, i.status]),
    );
    expect(byName).toEqual({ 'Célula A': 'reported', 'Célula B': 'missing' });
    expect(res.body.items[0].expectedDate).toBe(expected);

    // El líder solo ve su célula.
    const mine = await request(app)
      .get(api(`/cell-reports/compliance?week=${week}`))
      .set(s.leader.headers);
    expect(mine.body.items.map((i: { cell: { id: number } }) => i.cell.id)).toEqual([s.cellA.id]);
  });

  it('pendiente (amarillo) dentro de los días de tolerancia', async () => {
    const s = await setup();
    // Célula que se reunió ayer: sin reporte todavía está "pending".
    const yesterday = addDays(today(), -1);
    await prisma.cell.update({ where: { id: s.cellB.id }, data: { meetingDay: dayOfWeek(yesterday) } });
    const res = await request(app)
      .get(api(`/cell-reports/compliance?week=${yesterday}`))
      .set(s.headers);
    const b = res.body.items.find((i: { cell: { id: number } }) => i.cell.id === s.cellB.id);
    expect(b).toMatchObject({ status: 'pending', expectedDate: yesterday });
  });
});

describe('multiplicación y genealogía', () => {
  it('crea la célula hija, mueve integrantes y registra la genealogía', async () => {
    const s = await setup();
    const res = await request(app)
      .post(api(`/cells/${s.cellA.id}/multiply`))
      .set(s.leader.headers)
      .send({
        name: 'Célula A2',
        meetingDay: 5,
        meetingTime: '19:00',
        address: 'Calle 2',
        leaderPersonId: s.m1,
        memberIds: [s.m2],
      });
    expect(res.status).toBe(201);
    // La hija la lidera otra persona: queda fuera del alcance del líder de la madre.
    expect(res.body).toMatchObject({ name: 'Célula A2', parentCellId: s.cellA.id, visible: false });
    expect(await prisma.cellMember.count({ where: { cellId: s.cellA.id, leftAt: null } })).toBe(2); // líder + m3
    expect(await prisma.cellMultiplication.count({ where: { motherCellId: s.cellA.id } })).toBe(1);

    const tree = await request(app).get(api('/cells/genealogy')).set(s.headers);
    const child = tree.body.items.find((c: { id: number }) => c.id === res.body.id);
    expect(child).toMatchObject({ parentCellId: s.cellA.id, memberCount: 2 });
    expect(child.multipliedAt).toBe(today());
    const mother = tree.body.items.find((c: { id: number }) => c.id === s.cellA.id);
    expect(mother.childCount).toBe(1);

    const mom = await request(app)
      .post(api(`/cells/${s.cellA.id}/multiply`))
      .set(s.headers)
      .send({ name: 'X', meetingDay: 1, meetingTime: '19:00', address: 'x', leaderPersonId: s.leaderA });
    expect(mom.body.error.code).toBe('CELL_LEADER_REQUIRED');
    const outsider = await request(app)
      .post(api(`/cells/${s.cellA.id}/multiply`))
      .set(s.headers)
      .send({
        name: 'X',
        meetingDay: 1,
        meetingTime: '19:00',
        address: 'x',
        leaderPersonId: s.m3,
        memberIds: [s.leaderB],
      });
    expect(outsider.body.error.code).toBe('ATTENDANCE_INVALID');
    // Con alcance propio no se multiplica hacia una zona ajena.
    const foreignZone = await request(app)
      .post(api(`/cells/${s.cellA.id}/multiply`))
      .set(s.leader.headers)
      .send({
        name: 'X',
        zoneId: s.zoneB.id,
        meetingDay: 1,
        meetingTime: '19:00',
        address: 'x',
        leaderPersonId: s.m3,
      });
    expect(foreignZone.body.error.code).toBe('ZONE_INVALID');
  });

  it('la ficha de célula muestra la meta de multiplicación y el último reporte', async () => {
    const s = await setup();
    await prisma.account.update({ where: { id: s.accountId }, data: { cellMultiplyTarget: 4 } });
    await post(s.leader.headers, `/cells/${s.cellA.id}/reports`, { meetingDate: today(), held: true });
    const detail = await request(app)
      .get(api(`/cells/${s.cellA.id}`))
      .set(s.leader.headers);
    expect(detail.body.multiplication).toEqual({ target: 4, members: 4, progress: 100, ready: true });
    expect(detail.body.lastReport).toMatchObject({ meetingDate: today(), held: true });
    expect(detail.body.reportEditDays).toBe(7);
  });

  it('fusionar personas une la asistencia sin duplicar', async () => {
    const s = await setup();
    const report = await post(s.headers, `/cells/${s.cellA.id}/reports`, {
      meetingDate: today(),
      held: true,
      attendance: [s.m1, s.m2],
    });
    await request(app)
      .post(api(`/people/${s.m1}/merge`))
      .set(s.headers)
      .send({ intoId: s.m2 });
    const rows = await prisma.cellReportAttendance.findMany({ where: { reportId: report.id } });
    expect(rows.map((r) => r.personId)).toEqual([s.m2]);
  });
});
