import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, todayIn } from '../../src/core/time/local-date.js';
import { actor, app, prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;
const today = () => todayIn('America/Argentina/Buenos_Aires');

async function post(headers: Headers, path: string, body: object, status = 201) {
  const res = await request(app).post(api(path)).set(headers).send(body);
  if (res.status !== status) throw new Error(`${path}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

const get = async (headers: Headers, path: string) => (await request(app).get(api(path)).set(headers)).body;
const patch = (headers: Headers, path: string, body: object) =>
  request(app).patch(api(path)).set(headers).send(body);

async function person(headers: Headers, firstName: string) {
  return (await post(headers, '/people', { firstName, lastName: 'Test', allowDuplicate: true })).id as number;
}

async function category(headers: Headers, systemKey: string) {
  const res = await get(headers, '/finance/categories?kind=income');
  return res.items.find((c: { systemKey: string }) => c.systemKey === systemKey).id as number;
}

async function cashBox(headers: Headers, body: object = {}) {
  const res = await post(headers, '/finance/accounts', {
    name: 'Caja culto',
    type: 'cash',
    openingDate: addDays(today(), -30),
    ...body,
  });
  return res.id as number;
}

const balanceOf = async (headers: Headers, id: number) =>
  (await get(headers, '/finance/accounts?includeInactive=true')).items.find(
    (a: { id: number }) => a.id === id,
  ).balance as number;

/** Iglesia con una célula y su líder (usuario con alcance "propio"). */
async function withCell() {
  const c = await provisionChurch();
  const network = await post(c.headers, '/networks', { name: 'Red' });
  const zone = await post(c.headers, '/zones', { name: 'Zona', networkId: network.id });
  const leaderPerson = await person(c.headers, 'Líder');
  const cell = await post(c.headers, '/cells', {
    name: 'Célula Norte',
    zoneId: zone.id,
    leaderPersonId: leaderPerson,
    meetingDay: 3,
    meetingTime: '20:00',
    address: 'Calle 1',
  });
  const leader = await actor(
    { 'celulas.ver': 'own', 'celulas.reportar': 'own', 'celulas.ver_reportes': 'own' },
    c.accountId,
  );
  await prisma.user.update({ where: { id: leader.user.id }, data: { personId: leaderPerson } });
  return { ...c, cell, leader };
}

describe('ofrendas de célula pendientes', () => {
  it('el reporte crea un pendiente que sigue al reporte hasta que tesorería lo confirma', async () => {
    const s = await withCell();
    const box = await cashBox(s.headers);
    const report = await post(s.leader.headers, `/cells/${s.cell.id}/reports`, {
      meetingDate: today(),
      held: true,
      offeringAmount: 1500,
    });
    expect(report.offeringStatus).toBe('pending');

    let pending = await get(s.headers, '/finance/pending');
    expect(pending.total).toBe(1);
    expect(pending.sum).toEqual({ currency: 'ARS', amount: 1500 });
    expect(pending.items[0]).toMatchObject({
      status: 'pending',
      amount: 1500,
      date: today(),
      financeAccount: null,
      category: { systemKey: 'offering' },
      cellReport: { id: report.id, meetingDate: today(), cell: { name: 'Célula Norte' } },
    });
    const pendingId = pending.items[0].id as number;
    // No suma a ningún saldo ni a los totales del mes.
    expect(await balanceOf(s.headers, box)).toBe(0);
    expect((await get(s.headers, '/finance/summary')).pending).toEqual({ movements: 1, counts: 0 });

    // El líder corrige el monto: se actualiza el mismo pendiente.
    await patch(s.leader.headers, `/cell-reports/${report.id}`, { offeringAmount: 2000 }).expect(200);
    pending = await get(s.headers, '/finance/pending');
    expect(pending.items).toMatchObject([{ id: pendingId, amount: 2000 }]);
    // Sin ofrenda se borra; con ofrenda otra vez, vuelve a aparecer.
    await patch(s.leader.headers, `/cell-reports/${report.id}`, { offeringAmount: null }).expect(200);
    expect((await get(s.headers, '/finance/pending')).total).toBe(0);
    await patch(s.leader.headers, `/cell-reports/${report.id}`, { offeringAmount: 1800 }).expect(200);
    pending = await get(s.headers, '/finance/pending');
    const id = pending.items[0].id as number;

    // Un pendiente no se edita ni se anula como un movimiento común.
    const edit = await patch(s.headers, `/finance/movements/${id}`, { amount: 1 });
    expect(edit.body.error.code).toBe('MOVEMENT_PENDING');
    const voided = await request(app)
      .post(api(`/finance/movements/${id}/void`))
      .set(s.headers)
      .send({ reason: 'x' });
    expect(voided.body.error.code).toBe('MOVEMENT_PENDING');

    // Tesorería confirma lo que realmente llegó (1750): suma a la caja elegida.
    const confirmed = await post(
      s.headers,
      `/finance/pending/${id}/confirm`,
      { financeAccountId: box, amount: 1750 },
      200,
    );
    expect(confirmed).toMatchObject({ status: 'confirmed', amount: 1750, financeAccount: { id: box } });
    expect(confirmed.confirmedAt).toBeTruthy();
    expect(await balanceOf(s.headers, box)).toBe(1750);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'finance.pending.confirm' } });
    expect(JSON.parse(log.after!)).toMatchObject({ difference: -50 });
    expect((await get(s.leader.headers, `/cell-reports/${report.id}`)).offeringStatus).toBe('confirmed');

    // Ya contabilizada: el líder no puede cambiar el monto ni borrar el reporte (sí el resto).
    const change = await patch(s.leader.headers, `/cell-reports/${report.id}`, { offeringAmount: 1 });
    expect(change.body.error.code).toBe('OFFERING_CONFIRMED');
    const drop = await request(app)
      .delete(api(`/cell-reports/${report.id}`))
      .set(s.leader.headers);
    expect(drop.body.error.code).toBe('OFFERING_CONFIRMED');
    await patch(s.leader.headers, `/cell-reports/${report.id}`, { topic: 'Fe' }).expect(200);
    const again = await request(app)
      .post(api(`/finance/pending/${id}/confirm`))
      .set(s.headers)
      .send({ financeAccountId: box });
    expect(again.body.error.code).toBe('MOVEMENT_NOT_PENDING');
  });

  it('rechazo con motivo, moneda de la iglesia y borrado del reporte', async () => {
    const s = await withCell();
    const usd = await cashBox(s.headers, { name: 'Dólares', currency: 'USD' });
    const report = await post(s.leader.headers, `/cells/${s.cell.id}/reports`, {
      meetingDate: today(),
      held: true,
      offeringAmount: 900,
    });
    const [pending] = (await get(s.headers, '/finance/pending')).items;
    const wrong = await request(app)
      .post(api(`/finance/pending/${pending.id}/confirm`))
      .set(s.headers)
      .send({ financeAccountId: usd });
    expect(wrong.body.error.code).toBe('FINANCE_CURRENCY_MISMATCH');

    const rejected = await post(
      s.headers,
      `/finance/pending/${pending.id}/reject`,
      { reason: 'No llegó el sobre' },
      200,
    );
    expect(rejected).toMatchObject({ status: 'rejected', voidReason: 'No llegó el sobre' });
    expect((await get(s.headers, '/finance/pending?status=rejected')).total).toBe(1);
    expect((await get(s.leader.headers, `/cell-reports/${report.id}`)).offeringStatus).toBe('rejected');
    // Tocar otra cosa no la reenvía; corregir el monto sí.
    await patch(s.leader.headers, `/cell-reports/${report.id}`, { topic: 'Paz' }).expect(200);
    expect((await get(s.headers, '/finance/pending')).total).toBe(0);
    await patch(s.leader.headers, `/cell-reports/${report.id}`, { offeringAmount: 950 }).expect(200);
    expect((await get(s.headers, '/finance/pending')).items).toMatchObject([{ amount: 950 }]);

    // Sin reunión no hay ofrenda; borrar el reporte se lleva pendientes y rechazos.
    await patch(s.leader.headers, `/cell-reports/${report.id}`, {
      held: false,
      notHeldReason: 'Lluvia',
    }).expect(200);
    expect((await get(s.headers, '/finance/pending')).total).toBe(0);
    await patch(s.leader.headers, `/cell-reports/${report.id}`, { held: true, offeringAmount: 500 }).expect(
      200,
    );
    await request(app)
      .delete(api(`/cell-reports/${report.id}`))
      .set(s.leader.headers)
      .expect(204);
    expect(await prisma.financeMovement.count({ where: { cellReportId: report.id } })).toBe(0);
  });
});

describe('arqueos de culto', () => {
  async function setup() {
    const c = await provisionChurch();
    const box = await cashBox(c.headers);
    const [ana, beto, giver] = [
      await person(c.headers, 'Ana'),
      await person(c.headers, 'Beto'),
      await person(c.headers, 'Diezmante'),
    ];
    const offering = await category(c.headers, 'offering');
    const tithe = await category(c.headers, 'tithe');
    const base = { date: today(), financeAccountId: box, counter1PersonId: ana, counter2PersonId: beto };
    return { ...c, box, ana, beto, giver, offering, tithe, base };
  }

  it('borrador → confirmado genera los ingresos; anular el arqueo los anula todos', async () => {
    const s = await setup();
    const same = await request(app)
      .post(api('/finance/offering-counts'))
      .set(s.headers)
      .send({ ...s.base, counter2PersonId: s.ana });
    expect(same.body.error.code).toBe('COUNTERS_SAME');
    const badDenomination = await request(app)
      .post(api('/finance/offering-counts'))
      .set(s.headers)
      .send({
        ...s.base,
        lines: [{ categoryId: s.offering, paymentMethod: 'transfer', denomination: 1000, quantity: 2 }],
      });
    expect(badDenomination.status).toBe(400);

    const draft = await post(s.headers, '/finance/offering-counts', {
      ...s.base,
      title: 'Culto domingo 10 h',
      lines: [{ categoryId: s.offering, paymentMethod: 'cash', denomination: 1000, quantity: 12 }],
    });
    expect(draft).toMatchObject({ status: 'draft', total: 12000, counter1: { id: s.ana } });
    expect(draft.lines[0]).toMatchObject({ denomination: 1000, quantity: 12, amount: 12000 });
    expect((await get(s.headers, '/finance/summary')).pending.counts).toBe(1);

    const lines = [
      { categoryId: s.offering, paymentMethod: 'cash', denomination: 1000, quantity: 12 },
      { categoryId: s.offering, paymentMethod: 'cash', denomination: 500, quantity: 7 },
      { categoryId: s.offering, paymentMethod: 'transfer', amount: 5000 },
      { categoryId: s.tithe, paymentMethod: 'cash', amount: 20000, personId: s.giver },
      { categoryId: s.tithe, paymentMethod: 'transfer', amount: 8000.5, personId: s.giver },
    ];
    const updated = await patch(s.headers, `/finance/offering-counts/${draft.id}`, { lines });
    expect(updated.status).toBe(200);
    expect(updated.body.total).toBe(48500.5);
    expect(updated.body.byPaymentMethod).toEqual([
      { paymentMethod: 'cash', amount: 35500 },
      { paymentMethod: 'transfer', amount: 13000.5 },
    ]);
    expect(await balanceOf(s.headers, s.box)).toBe(0); // el borrador no mueve la caja

    const confirmed = await post(s.headers, `/finance/offering-counts/${draft.id}/confirm`, {}, 200);
    expect(confirmed.status).toBe('confirmed');
    expect(
      confirmed.movements.map((m: { amount: number; paymentMethod: string; person?: { id: number } }) => [
        m.amount,
        m.paymentMethod,
        m.person?.id ?? null,
      ]),
    ).toEqual([
      [15500, 'cash', null],
      [5000, 'transfer', null],
      [20000, 'cash', s.giver],
      [8000.5, 'transfer', s.giver],
    ]);
    expect(confirmed.movements[0]).toMatchObject({
      description: 'Culto domingo 10 h',
      offeringCount: { id: draft.id },
    });
    expect(await balanceOf(s.headers, s.box)).toBe(48500.5);

    const twice = await request(app)
      .post(api(`/finance/offering-counts/${draft.id}/confirm`))
      .set(s.headers);
    expect(twice.body.error.code).toBe('COUNT_NOT_DRAFT');
    expect(
      (await patch(s.headers, `/finance/offering-counts/${draft.id}`, { notes: 'x' })).body.error.code,
    ).toBe('COUNT_NOT_DRAFT');
    const single = await request(app)
      .post(api(`/finance/movements/${confirmed.movements[0].id}/void`))
      .set(s.headers)
      .send({ reason: 'x' });
    expect(single.body.error.code).toBe('MOVEMENT_FROM_COUNT');

    const voided = await post(
      s.headers,
      `/finance/offering-counts/${draft.id}/void`,
      { reason: 'Se contó mal' },
      200,
    );
    expect(voided).toMatchObject({ status: 'voided', voidReason: 'Se contó mal' });
    expect(voided.movements.every((m: { status: string }) => m.status === 'voided')).toBe(true);
    expect(await balanceOf(s.headers, s.box)).toBe(0);
  });

  it('borradores vacíos, borrado y sobres nominales sin permiso', async () => {
    const s = await setup();
    const empty = await post(s.headers, '/finance/offering-counts', s.base);
    const confirm = await request(app)
      .post(api(`/finance/offering-counts/${empty.id}/confirm`))
      .set(s.headers);
    expect(confirm.body.error.code).toBe('COUNT_EMPTY');
    await request(app)
      .delete(api(`/finance/offering-counts/${empty.id}`))
      .set(s.headers)
      .expect(204);

    const count = await post(s.headers, '/finance/offering-counts', {
      ...s.base,
      lines: [
        { categoryId: s.offering, paymentMethod: 'cash', amount: 300 },
        { categoryId: s.tithe, paymentMethod: 'cash', amount: 700, personId: s.giver },
      ],
    });
    const helper = await actor({ 'finanzas.ver': 'all', 'finanzas.arqueo': 'all' }, s.accountId);
    const seen = await get(helper.headers, `/finance/offering-counts/${count.id}`);
    expect(seen.total).toBe(1000);
    expect(seen.lines[1]).toMatchObject({ nominal: true, amount: 700 });
    expect(seen.lines[1]).not.toHaveProperty('person');
    // No puede cargar sobres nominales ni reemplazar renglones que los tienen.
    const add = await request(app)
      .post(api('/finance/offering-counts'))
      .set(helper.headers)
      .send({
        ...s.base,
        lines: [{ categoryId: s.tithe, paymentMethod: 'cash', amount: 1, personId: s.giver }],
      });
    expect(add.body.error.code).toBe('CONTRIBUTIONS_FORBIDDEN');
    const replace = await patch(helper.headers, `/finance/offering-counts/${count.id}`, { lines: [] });
    expect(replace.body.error.code).toBe('CONTRIBUTIONS_FORBIDDEN');
    // Sí puede corregir los datos generales y confirmar.
    await patch(helper.headers, `/finance/offering-counts/${count.id}`, { notes: 'Ok' }).expect(200);
    await post(helper.headers, `/finance/offering-counts/${count.id}/confirm`, {}, 200);
    // Anular necesita finanzas.anular.
    await request(app)
      .post(api(`/finance/offering-counts/${count.id}/void`))
      .set(helper.headers)
      .send({ reason: 'x' })
      .expect(403);
    const drop = await request(app)
      .delete(api(`/finance/offering-counts/${count.id}`))
      .set(s.headers);
    expect(drop.body.error.code).toBe('COUNT_NOT_DRAFT');
  });

  it('aislamiento: otra iglesia no ve arqueos ni pendientes ajenos', async () => {
    const s = await setup();
    const count = await post(s.headers, '/finance/offering-counts', s.base);
    const other = await provisionChurch();
    await request(app)
      .get(api(`/finance/offering-counts/${count.id}`))
      .set(other.headers)
      .expect(404);
    expect((await get(other.headers, '/finance/offering-counts')).total).toBe(0);
    // Tampoco puede usar personas o cajas de la otra iglesia en un arqueo propio.
    const otherBox = await cashBox(other.headers);
    const foreign = await request(app)
      .post(api('/finance/offering-counts'))
      .set(other.headers)
      .send({ ...s.base, financeAccountId: otherBox });
    expect(foreign.body.error.code).toBe('PERSON_INVALID');
  });
});
