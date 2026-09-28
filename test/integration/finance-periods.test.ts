import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { todayIn } from '../../src/core/time/local-date.js';
import { actor, app, prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;
const today = () => todayIn('America/Argentina/Buenos_Aires');

/** Mes relativo al actual: { year, month, from, to, mid } */
function monthAgo(n: number) {
  const t = today();
  const d = new Date(Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1 - n, 1));
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const iso = (day: number) => new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  return {
    year,
    month,
    from: iso(1),
    mid: iso(15),
    to: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10),
  };
}
const path = (m: { year: number; month: number }) => `/finance/periods/${m.year}/${m.month}`;

async function post(headers: Headers, url: string, body: object = {}, status = 201) {
  const res = await request(app).post(api(url)).set(headers).send(body);
  if (res.status !== status) throw new Error(`${url}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
const get = async (headers: Headers, url: string) => (await request(app).get(api(url)).set(headers)).body;
const code = (res: request.Response) => res.body.error?.code;

async function category(headers: Headers, kind: string, systemKey: string) {
  const res = await get(headers, `/finance/categories?kind=${kind}`);
  return res.items.find((c: { systemKey: string }) => c.systemKey === systemKey).id as number;
}

/** Iglesia con dos cajas abiertas hace dos meses y movimientos en esos meses. */
async function setup() {
  const c = await provisionChurch();
  const m2 = monthAgo(2);
  const m1 = monthAgo(1);
  const a = (
    await post(c.headers, '/finance/accounts', {
      name: 'A',
      type: 'cash',
      openingBalance: 1000,
      openingDate: m2.from,
    })
  ).id;
  const b = (await post(c.headers, '/finance/accounts', { name: 'B', type: 'bank', openingDate: m2.from }))
    .id;
  const income = await category(c.headers, 'income', 'offering');
  const expense = await category(c.headers, 'expense', 'rent');
  const inM2 = await post(c.headers, '/finance/movements', {
    kind: 'income',
    financeAccountId: a,
    categoryId: income,
    date: m2.mid,
    amount: 500,
  });
  const inM1 = await post(c.headers, '/finance/movements', {
    kind: 'expense',
    financeAccountId: a,
    categoryId: expense,
    date: m1.mid,
    amount: 200,
  });
  await post(c.headers, '/finance/transfers', {
    fromAccountId: a,
    toAccountId: b,
    date: m1.mid,
    amount: 100,
  });
  return {
    ...c,
    m2,
    m1,
    m0: monthAgo(0),
    a,
    b,
    income,
    expense,
    inM2: inM2.id as number,
    inM1: inM1.id as number,
  };
}

describe('cierre mensual', () => {
  it('se cierra en orden, solo meses terminados, y guarda los saldos de cada caja', async () => {
    const s = await setup();
    const list = await get(s.headers, '/finance/periods');
    expect(
      list.items.map((i: { month: number; status: string; canClose: boolean }) => [
        i.month,
        i.status,
        i.canClose,
      ]),
    ).toEqual([
      [s.m0.month, 'open', false],
      [s.m1.month, 'open', false],
      [s.m2.month, 'open', true],
    ]);
    expect(
      code(
        await request(app)
          .post(api(`${path(s.m1)}/close`))
          .set(s.headers),
      ),
    ).toBe('PERIOD_PREVIOUS_OPEN');
    expect(
      code(
        await request(app)
          .post(api(`${path(s.m0)}/close`))
          .set(s.headers),
      ),
    ).toBe('PERIOD_NOT_ENDED');

    const first = await post(s.headers, `${path(s.m2)}/close`, { notes: 'Revisado' }, 200);
    expect(first).toMatchObject({ status: 'closed', notes: 'Revisado', canReopen: true });
    expect(first.balances).toEqual([
      expect.objectContaining({
        financeAccount: expect.objectContaining({ name: 'A' }),
        opening: 1000,
        income: 500,
        closing: 1500,
      }),
      expect.objectContaining({
        financeAccount: expect.objectContaining({ name: 'B' }),
        opening: 0,
        closing: 0,
      }),
    ]);
    const second = await post(s.headers, `${path(s.m1)}/close`, {}, 200);
    expect(second.balances).toEqual([
      expect.objectContaining({ opening: 1500, expense: 200, transfersOut: 100, closing: 1200 }),
      expect.objectContaining({ opening: 0, transfersIn: 100, closing: 100 }),
    ]);
    expect(second.totals).toEqual([
      { currency: 'ARS', opening: 1500, income: 0, expense: 200, closing: 1300 },
    ]);
    expect(
      code(
        await request(app)
          .post(api(`${path(s.m1)}/close`))
          .set(s.headers),
      ),
    ).toBe('PERIOD_ALREADY_CLOSED');
    expect((await get(s.headers, '/finance/summary')).closedUntil).toBe(s.m1.to);
    // El mes cerrado muestra la foto guardada aunque después cambie la historia de otras cajas.
    expect((await get(s.headers, path(s.m2))).balances[0].closing).toBe(1500);
  });

  it('un mes cerrado rechaza altas, ediciones, anulaciones y cambios de apertura (409)', async () => {
    const s = await setup();
    await post(s.headers, `${path(s.m2)}/close`, {}, 200);
    const closed = { year: s.m2.year, month: s.m2.month };

    const create = await request(app)
      .post(api('/finance/movements'))
      .set(s.headers)
      .send({ kind: 'income', financeAccountId: s.a, categoryId: s.income, date: s.m2.to, amount: 1 });
    expect(create.status).toBe(409);
    expect(create.body.error).toMatchObject({ code: 'PERIOD_CLOSED', details: closed });
    expect(
      code(
        await request(app)
          .patch(api(`/finance/movements/${s.inM2}`))
          .set(s.headers)
          .send({ amount: 1 }),
      ),
    ).toBe('PERIOD_CLOSED');
    // Mover un movimiento de un mes abierto a uno cerrado tampoco.
    expect(
      code(
        await request(app)
          .patch(api(`/finance/movements/${s.inM1}`))
          .set(s.headers)
          .send({ date: s.m2.mid }),
      ),
    ).toBe('PERIOD_CLOSED');
    expect(
      code(
        await request(app)
          .post(api(`/finance/movements/${s.inM2}/void`))
          .set(s.headers)
          .send({ reason: 'x' }),
      ),
    ).toBe('PERIOD_CLOSED');
    expect(
      code(
        await request(app)
          .post(api('/finance/transfers'))
          .set(s.headers)
          .send({ fromAccountId: s.a, toAccountId: s.b, date: s.m2.mid, amount: 1 }),
      ),
    ).toBe('PERIOD_CLOSED');
    // En el mes abierto sigue todo normal.
    await request(app)
      .patch(api(`/finance/movements/${s.inM1}`))
      .set(s.headers)
      .send({ amount: 250 })
      .expect(200);

    // Cajas: no se abre una caja ni se cambia una apertura dentro de lo cerrado.
    expect(
      code(
        await request(app)
          .post(api('/finance/accounts'))
          .set(s.headers)
          .send({ name: 'C', type: 'cash', openingDate: s.m2.mid }),
      ),
    ).toBe('PERIOD_CLOSED');
    expect(
      code(
        await request(app)
          .patch(api(`/finance/accounts/${s.a}`))
          .set(s.headers)
          .send({ openingBalance: 2000 }),
      ),
    ).toBe('PERIOD_CLOSED');
    await request(app)
      .patch(api(`/finance/accounts/${s.a}`))
      .set(s.headers)
      .send({ name: 'A2', openingBalance: 1000 })
      .expect(200);
    await post(s.headers, '/finance/accounts', { name: 'C', type: 'cash', openingDate: s.m1.from });

    // Pendientes y arqueos: se resuelven con fecha en un mes abierto.
    const pending = await prisma.financeMovement.create({
      data: {
        accountId: s.accountId,
        categoryId: s.income,
        kind: 'income',
        date: new Date(`${s.m2.mid}T00:00:00Z`),
        amount: 300,
        status: 'pending',
        createdById: s.ownerId,
      },
    });
    expect(
      code(
        await request(app)
          .post(api(`/finance/pending/${pending.id}/confirm`))
          .set(s.headers)
          .send({ financeAccountId: s.a }),
      ),
    ).toBe('PERIOD_CLOSED');
    await post(
      s.headers,
      `/finance/pending/${pending.id}/confirm`,
      { financeAccountId: s.a, date: s.m1.mid },
      200,
    );
    const [p1, p2] = [
      (await post(s.headers, '/people', { firstName: 'Uno', lastName: 'X', allowDuplicate: true })).id,
      (await post(s.headers, '/people', { firstName: 'Dos', lastName: 'X', allowDuplicate: true })).id,
    ];
    const count = await post(s.headers, '/finance/offering-counts', {
      date: s.m2.mid,
      financeAccountId: s.a,
      counter1PersonId: p1,
      counter2PersonId: p2,
      lines: [{ categoryId: s.income, paymentMethod: 'cash', amount: 10 }],
    });
    expect(
      code(
        await request(app)
          .post(api(`/finance/offering-counts/${count.id}/confirm`))
          .set(s.headers),
      ),
    ).toBe('PERIOD_CLOSED');
  });

  it('solo se reabre el último mes cerrado, con permiso y motivo, y queda auditado', async () => {
    const s = await setup();
    await post(s.headers, `${path(s.m2)}/close`, {}, 200);
    await post(s.headers, `${path(s.m1)}/close`, {}, 200);
    const treasurer = await actor({ 'finanzas.ver': 'all', 'finanzas.cierre': 'all' }, s.accountId);
    const pastor = await actor({ 'finanzas.ver': 'all' }, s.accountId);
    expect((await get(pastor.headers, '/finance/periods')).items).toHaveLength(3);
    await request(app)
      .post(api(`${path(s.m0)}/close`))
      .set(pastor.headers)
      .expect(403);
    await request(app)
      .post(api(`${path(s.m1)}/reopen`))
      .set(treasurer.headers)
      .send({ reason: 'x' })
      .expect(403);
    expect(
      code(
        await request(app)
          .post(api(`${path(s.m2)}/reopen`))
          .set(s.headers)
          .send({ reason: 'x' }),
      ),
    ).toBe('PERIOD_LATER_CLOSED');
    await request(app)
      .post(api(`${path(s.m1)}/reopen`))
      .set(s.headers)
      .send({})
      .expect(400); // sin motivo

    const reopened = await post(s.headers, `${path(s.m1)}/reopen`, { reason: 'Faltó un gasto' }, 200);
    expect(reopened).toMatchObject({ status: 'open', reopenReason: 'Faltó un gasto', canClose: true });
    expect(reopened.reopenedBy).toBeTruthy();
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'finance.period.reopen' } });
    expect(JSON.parse(log.after!)).toEqual({ reason: 'Faltó un gasto' });

    // Reabierto: se carga lo que faltaba y al volver a cerrar se recalculan los saldos.
    await post(s.headers, '/finance/movements', {
      kind: 'expense',
      financeAccountId: s.a,
      categoryId: s.expense,
      date: s.m1.to,
      amount: 50,
    });
    const again = await post(s.headers, `${path(s.m1)}/close`, {}, 200);
    expect(again.balances[0]).toMatchObject({ opening: 1500, expense: 250, closing: 1150 });
    expect(again.reopenReason).toBe('Faltó un gasto');
  });

  it('otra iglesia no ve ni cierra los meses ajenos', async () => {
    const s = await setup();
    await post(s.headers, `${path(s.m2)}/close`, {}, 200);
    const other = await provisionChurch();
    const theirs = await get(other.headers, '/finance/periods');
    expect(theirs.items.every((i: { status: string }) => i.status === 'open')).toBe(true);
    // Su propio mes del mismo número está abierto y puede cargar ahí.
    const box = (
      await post(other.headers, '/finance/accounts', { name: 'X', type: 'cash', openingDate: s.m2.from })
    ).id;
    const cat = await category(other.headers, 'income', 'offering');
    await post(other.headers, '/finance/movements', {
      kind: 'income',
      financeAccountId: box,
      categoryId: cat,
      date: s.m2.mid,
      amount: 1,
    });
  });
});
