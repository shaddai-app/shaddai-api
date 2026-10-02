import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryOutbox } from '../../src/core/mail/mailer.js';
import { addDays, todayIn, toDate, weekStart } from '../../src/core/time/local-date.js';
import { localHour, tickDailyNotices } from '../../src/jobs/scheduler.js';
import { runDailyNotices } from '../../src/modules/notifications/daily.js';
import { emailsSettled } from '../../src/modules/notifications/notifications.service.js';
import { actor, app, prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;
const send = (headers: Headers, method: 'post' | 'patch', url: string, body?: object) =>
  request(app)[method](api(url)).set(headers).send(body);
const get = (headers: Headers, url: string) => request(app).get(api(url)).set(headers);
const TZ = 'America/Argentina/Buenos_Aires';
const today = () => todayIn(TZ);

async function person(headers: Headers, firstName: string) {
  const res = await send(headers, 'post', '/people', { firstName, lastName: 'Test', allowDuplicate: true });
  return res.body.id as number;
}
const inbox = async (headers: Headers) =>
  (await get(headers, '/notifications')).body.items as { type: string; params: Record<string, unknown> }[];

describe('aviso diario de vencidos', () => {
  it('préstamos vencidos: a quienes prestan, una sola vez por vencimiento', async () => {
    const c = await provisionChurch();
    const audio = (await prisma.catalogItem.findFirst({
      where: { accountId: c.accountId, type: 'inventory_category', systemKey: 'audio' },
    }))!.id;
    const item = (await send(c.headers, 'post', '/inventory/items', { name: 'Parlante', categoryId: audio }))
      .body;
    const borrower = await person(c.headers, 'Marta');
    const loan = (
      await send(c.headers, 'post', '/inventory/loans', {
        itemId: item.id,
        borrowerPersonId: borrower,
        borrowedAt: addDays(today(), -10),
        dueAt: addDays(today(), -2),
      })
    ).body;
    // Uno al día no se avisa.
    const mic = (await send(c.headers, 'post', '/inventory/items', { name: 'Micrófono', categoryId: audio }))
      .body;
    await send(c.headers, 'post', '/inventory/loans', {
      itemId: mic.id,
      borrowerPersonId: borrower,
      dueAt: addDays(today(), 3),
    });
    const lender = await actor({ 'inventario.prestamos': 'all' }, c.accountId);
    const viewer = await actor({ 'inventario.ver': 'all' }, c.accountId);
    memoryOutbox.length = 0;

    const first = await runDailyNotices(c.accountId);
    await emailsSettled();
    expect(first).toEqual({ today: today(), notices: 2 }); // dueño (admin) y quien presta
    expect(await inbox(lender.headers)).toEqual([
      expect.objectContaining({
        type: 'loan.overdue',
        params: { item: 'Parlante', code: item.code, person: 'Marta Test', dueAt: addDays(today(), -2) },
      }),
    ]);
    expect(await inbox(c.headers)).toHaveLength(1);
    expect(await inbox(viewer.headers)).toHaveLength(0);
    expect(memoryOutbox.map((m) => m.subject)).toEqual([
      'Préstamo vencido: Parlante',
      'Préstamo vencido: Parlante',
    ]);

    // El mismo día no vuelve a correr; forzado, no repite el aviso.
    expect(await runDailyNotices(c.accountId)).toBeNull();
    expect((await runDailyNotices(c.accountId, { force: true }))!.notices).toBe(0);
    const run = await prisma.dailyJobRun.findFirstOrThrow({ where: { accountId: c.accountId } });
    expect(run).toMatchObject({ job: 'daily-notices', notices: 2, error: null });
    expect(run.finishedAt).not.toBeNull();

    // Si se cambia el vencimiento y se vuelve a vencer, es otro aviso.
    await send(c.headers, 'patch', `/inventory/loans/${loan.id}`, { dueAt: addDays(today(), -1) });
    expect((await runDailyNotices(c.accountId, { force: true }))!.notices).toBe(2);
    // Devuelto: no se avisa más.
    await send(c.headers, 'post', `/inventory/loans/${loan.id}/return`, {});
    await prisma.notification.deleteMany();
    expect((await runDailyNotices(c.accountId, { force: true }))!.notices).toBe(0);

    // Quien apagó el aviso en la app recibe solo el mail, y tampoco se le repite.
    await prisma.inventoryLoan.update({ where: { id: loan.id }, data: { returnedAt: null } });
    await send(lender.headers, 'patch', '/me/notification-prefs', {
      prefs: [{ type: 'loan.overdue', inApp: false }],
    });
    memoryOutbox.length = 0;
    await runDailyNotices(c.accountId, { force: true });
    await runDailyNotices(c.accountId, { force: true });
    await emailsSettled();
    expect(memoryOutbox.filter((m) => m.to === lender.user.email)).toHaveLength(1);
    expect(await inbox(lender.headers)).toHaveLength(0);
  });

  it('consolidación vencida: al consolidador, o a quienes asignan si no tiene', async () => {
    const c = await provisionChurch();
    const consolidator = await actor(
      { 'consolidacion.ver': 'own', 'consolidacion.gestionar': 'own' },
      c.accountId,
    );
    const ana = await person(c.headers, 'Ana');
    const beto = await person(c.headers, 'Beto');
    const withConsolidator = (
      await send(c.headers, 'post', '/consolidation/cases', {
        personId: ana,
        consolidatorUserId: consolidator.user.id,
      })
    ).body;
    const unassigned = (await send(c.headers, 'post', '/consolidation/cases', { personId: beto })).body;
    // Paso actual vencido en los dos casos.
    for (const id of [withConsolidator.id, unassigned.id]) {
      const cs = await prisma.consolidationCase.findUniqueOrThrow({ where: { id } });
      await prisma.consolidationCaseStep.updateMany({
        where: { caseId: id, stepId: cs.currentStepId! },
        data: { dueAt: toDate(addDays(today(), -4)) },
      });
    }

    await runDailyNotices(c.accountId);
    expect(await inbox(consolidator.headers)).toEqual([
      expect.objectContaining({
        type: 'consolidation.overdue',
        params: { person: 'Ana Test', dueAt: addDays(today(), -4), unassigned: null },
      }),
    ]);
    // El dueño puede asignar: recibe el del caso sin consolidador.
    expect(await inbox(c.headers)).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ person: 'Beto Test', unassigned: 1 }) }),
    ]);
    const link = (await get(consolidator.headers, '/notifications')).body.items[0].link;
    expect(link).toBe(`/consolidacion/${withConsolidator.id}`);
  });

  it('células sin reporte: al líder, por cada reunión que pasó el margen', async () => {
    const c = await provisionChurch();
    const network = (await send(c.headers, 'post', '/networks', { name: 'Red' })).body;
    const zone = (await send(c.headers, 'post', '/zones', { name: 'Zona', networkId: network.id })).body;
    const leaderPerson = await person(c.headers, 'Lidia');
    const account = await prisma.account.findUniqueOrThrow({ where: { id: c.accountId } });
    // Se reúne el primer día de la semana: la reunión de la semana pasada siempre pasó el margen.
    const cell = (
      await send(c.headers, 'post', '/cells', {
        name: 'Célula Norte',
        zoneId: zone.id,
        leaderPersonId: leaderPerson,
        meetingDay: account.weekStartsOn,
        meetingTime: '20:00',
        address: 'Calle 1',
      })
    ).body;
    await prisma.cell.update({ where: { id: cell.id }, data: { startedAt: toDate(addDays(today(), -60)) } });
    const leader = await actor({ 'celulas.reportar': 'own' }, c.accountId);
    await prisma.user.update({ where: { id: leader.user.id }, data: { personId: leaderPerson } });
    const lastWeek = addDays(weekStart(today(), account.weekStartsOn), -7);

    const firstRun = await runDailyNotices(c.accountId, { force: true });
    const notices = await inbox(leader.headers);
    expect(notices.map((n) => n.params.date)).toContain(lastWeek);
    expect(notices.every((n) => n.type === 'cell.report_missing' && n.params.cell === 'Célula Norte')).toBe(
      true,
    );
    expect(firstRun!.notices).toBe(notices.length);
    // Con el reporte de la semana pasada cargado, ese ya no se avisa.
    await prisma.notification.deleteMany();
    await prisma.cellReport.create({
      data: {
        accountId: c.accountId,
        cellId: cell.id,
        meetingDate: toDate(lastWeek),
        held: false,
        submittedById: leader.user.id,
      },
    });
    await runDailyNotices(c.accountId, { force: true });
    expect((await inbox(leader.headers)).map((n) => n.params.date)).not.toContain(lastWeek);
  });

  it('programador: corre después de la hora local de cada iglesia, una vez por día', async () => {
    const c = await provisionChurch();
    // 10:00 UTC = 07:00 en Buenos Aires (antes de las 8): no corre.
    const early = new Date('2026-10-05T10:00:00Z');
    expect(localHour(TZ, early)).toBe(7);
    await tickDailyNotices(early);
    expect(await prisma.dailyJobRun.count({ where: { accountId: c.accountId } })).toBe(0);
    // 12:00 UTC = 09:00: corre una vez; la siguiente vuelta del mismo día no hace nada.
    const later = new Date('2026-10-05T12:00:00Z');
    await tickDailyNotices(later);
    await tickDailyNotices(new Date('2026-10-05T15:00:00Z'));
    const runs = await prisma.dailyJobRun.findMany({ where: { accountId: c.accountId } });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.runDate.toISOString().slice(0, 10)).toBe('2026-10-05');
    // Una cuenta suspendida no corre.
    await prisma.account.update({ where: { id: c.accountId }, data: { status: 'suspended' } });
    await tickDailyNotices(new Date('2026-10-06T12:00:00Z'));
    expect(await prisma.dailyJobRun.count({ where: { accountId: c.accountId } })).toBe(1);
  });
});
