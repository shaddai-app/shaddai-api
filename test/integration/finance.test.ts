import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, todayIn } from '../../src/core/time/local-date.js';
import { actor, app, prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;
const today = () => todayIn('America/Argentina/Buenos_Aires');

async function category(headers: Headers, kind: 'income' | 'expense', systemKey: string) {
  const res = await request(app)
    .get(api(`/finance/categories?kind=${kind}`))
    .set(headers);
  const found = res.body.items.find((c: { systemKey: string }) => c.systemKey === systemKey);
  if (!found) throw new Error(`categoría ${systemKey}`);
  return found.id as number;
}

async function cashBox(headers: Headers, body: object = {}) {
  const res = await request(app)
    .post(api('/finance/accounts'))
    .set(headers)
    .send({ name: 'Banco', type: 'bank', openingDate: addDays(today(), -30), ...body });
  if (res.status !== 201) throw new Error(`caja: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as number;
}

async function move(headers: Headers, body: object) {
  const res = await request(app)
    .post(api('/finance/movements'))
    .set(headers)
    .send({ date: today(), ...body });
  if (res.status !== 201) throw new Error(`movimiento: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

const balanceOf = async (headers: Headers, id: number) => {
  const res = await request(app).get(api('/finance/accounts?includeInactive=true')).set(headers);
  return res.body.items.find((a: { id: number }) => a.id === id).balance as number;
};

async function person(headers: Headers, firstName: string) {
  const res = await request(app)
    .post(api('/people'))
    .set(headers)
    .send({ firstName, lastName: 'Aportante', allowDuplicate: true });
  return res.body.id as number;
}

describe('cajas y categorías', () => {
  it('cada iglesia arranca con categorías por defecto y una caja general en su moneda', async () => {
    const c = await provisionChurch();
    const cats = await request(app).get(api('/finance/categories')).set(c.headers);
    const keys = cats.body.items.map((x: { kind: string; systemKey: string }) => `${x.kind}:${x.systemKey}`);
    expect(keys).toContain('income:tithe');
    expect(keys).toContain('expense:rent');
    expect(cats.body.items).toHaveLength(14);
    const accounts = await request(app).get(api('/finance/accounts')).set(c.headers);
    expect(accounts.body.items).toMatchObject([
      { name: 'Caja general', type: 'cash', currency: 'ARS', balance: 0, openingDate: today() },
    ]);
  });

  it('categorías propias: se crean, renombran, ordenan; las del sistema y las usadas no se borran', async () => {
    const c = await provisionChurch();
    const created = await request(app)
      .post(api('/finance/categories'))
      .set(c.headers)
      .send({ kind: 'expense', name: 'Combustible' });
    expect(created.body).toMatchObject({ kind: 'expense', name: 'Combustible', systemKey: null });
    const tithe = await category(c.headers, 'income', 'tithe');
    expect(
      (
        await request(app)
          .delete(api(`/finance/categories/${tithe}`))
          .set(c.headers)
      ).body.error.code,
    ).toBe('CATALOG_SYSTEM_ITEM');
    const box = await cashBox(c.headers);
    await move(c.headers, {
      kind: 'expense',
      financeAccountId: box,
      categoryId: created.body.id,
      amount: 10,
    });
    expect(
      (
        await request(app)
          .delete(api(`/finance/categories/${created.body.id}`))
          .set(c.headers)
      ).body.error.code,
    ).toBe('CATALOG_IN_USE');
    const mixed = await request(app)
      .put(api('/finance/categories/order'))
      .set(c.headers)
      .send({ ids: [tithe, created.body.id] });
    expect(mixed.body.error.code).toBe('CATALOG_ITEM_INVALID'); // no se mezclan ingresos y egresos
  });

  it('con movimientos la moneda queda fija y la apertura no puede pasar al primer movimiento', async () => {
    const c = await provisionChurch();
    const box = await cashBox(c.headers, { currency: 'usd', openingBalance: 100 });
    const offering = await category(c.headers, 'income', 'offering');
    await move(c.headers, {
      kind: 'income',
      financeAccountId: box,
      categoryId: offering,
      amount: 5,
      date: addDays(today(), -20),
    });
    const currency = await request(app)
      .patch(api(`/finance/accounts/${box}`))
      .set(c.headers)
      .send({ currency: 'ARS' });
    expect(currency.body.error.code).toBe('FINANCE_CURRENCY_LOCKED');
    const opening = await request(app)
      .patch(api(`/finance/accounts/${box}`))
      .set(c.headers)
      .send({ openingDate: addDays(today(), -10) });
    expect(opening.body.error.code).toBe('FINANCE_OPENING_AFTER_MOVEMENTS');
    expect(
      (
        await request(app)
          .delete(api(`/finance/accounts/${box}`))
          .set(c.headers)
      ).body.error.code,
    ).toBe('FINANCE_ACCOUNT_IN_USE');
  });
});

describe('movimientos y saldos', () => {
  it('ingresos y egresos mueven el saldo; anular lo revierte; los totales van por moneda', async () => {
    const c = await provisionChurch();
    const box = await cashBox(c.headers, { openingBalance: 1000 });
    const tithe = await category(c.headers, 'income', 'tithe');
    const rent = await category(c.headers, 'expense', 'rent');
    await move(c.headers, { kind: 'income', financeAccountId: box, categoryId: tithe, amount: 500.25 });
    const expense = await move(c.headers, {
      kind: 'expense',
      financeAccountId: box,
      categoryId: rent,
      amount: 200.1,
      paymentMethod: 'transfer',
      reference: 'Factura 0001',
    });
    expect(await balanceOf(c.headers, box)).toBe(1300.15);

    const voided = await request(app)
      .post(api(`/finance/movements/${expense.id}/void`))
      .set(c.headers)
      .send({ reason: 'Cargado dos veces' });
    expect(voided.body).toMatchObject({ status: 'voided', voidReason: 'Cargado dos veces' });
    expect(await balanceOf(c.headers, box)).toBe(1500.25);
    const again = await request(app)
      .post(api(`/finance/movements/${expense.id}/void`))
      .set(c.headers)
      .send({ reason: 'x' });
    expect(again.body.error.code).toBe('MOVEMENT_VOIDED');
    const edit = await request(app)
      .patch(api(`/finance/movements/${expense.id}`))
      .set(c.headers)
      .send({ amount: 1 });
    expect(edit.body.error.code).toBe('MOVEMENT_VOIDED');

    const list = await request(app).get(api('/finance/movements')).set(c.headers);
    expect(list.body.total).toBe(1);
    expect(list.body.totals).toEqual([{ currency: 'ARS', income: 500.25, expense: 0, net: 500.25 }]);
    const withVoided = await request(app).get(api('/finance/movements?status=voided')).set(c.headers);
    expect(withVoided.body.items.map((m: { id: number }) => m.id)).toEqual([expense.id]);
  });

  it('propiedad: el saldo de cada caja coincide con la suma de sus movimientos', async () => {
    const c = await provisionChurch();
    const a = await cashBox(c.headers, { name: 'A', openingBalance: 250.5 });
    const b = await cashBox(c.headers, { name: 'B', openingBalance: 0 });
    const income = await category(c.headers, 'income', 'offering');
    const expense = await category(c.headers, 'expense', 'supplies');
    // Generador determinístico (sin dependencias) para que el test sea reproducible.
    let seed = 42;
    const rnd = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    const cents = new Map([
      [a, 25_050],
      [b, 0],
    ]);
    for (let i = 0; i < 30; i++) {
      const amountCents = 1 + Math.floor(rnd() * 100_000);
      const amount = amountCents / 100;
      const date = addDays(today(), -Math.floor(rnd() * 25));
      const roll = rnd();
      if (roll < 0.2) {
        const [from, to] = rnd() < 0.5 ? [a, b] : [b, a];
        await request(app)
          .post(api('/finance/transfers'))
          .set(c.headers)
          .send({ fromAccountId: from, toAccountId: to, amount, date })
          .expect(201);
        cents.set(from, cents.get(from)! - amountCents);
        cents.set(to, cents.get(to)! + amountCents);
      } else {
        const box = rnd() < 0.5 ? a : b;
        const kind = roll < 0.65 ? 'income' : 'expense';
        const m = await move(c.headers, {
          kind,
          financeAccountId: box,
          categoryId: kind === 'income' ? income : expense,
          amount,
          date,
        });
        const sign = kind === 'income' ? 1 : -1;
        if (rnd() < 0.15) {
          await request(app)
            .post(api(`/finance/movements/${m.id}/void`))
            .set(c.headers)
            .send({ reason: 'test' });
        } else {
          cents.set(box, cents.get(box)! + sign * amountCents);
        }
      }
    }
    expect(await balanceOf(c.headers, a)).toBe(cents.get(a)! / 100);
    expect(await balanceOf(c.headers, b)).toBe(cents.get(b)! / 100);
  });

  it('transferencias: dos patas enlazadas, misma moneda; anular una anula las dos', async () => {
    const c = await provisionChurch();
    const a = await cashBox(c.headers, { name: 'A', openingBalance: 100 });
    const b = await cashBox(c.headers, { name: 'B' });
    const usd = await cashBox(c.headers, { name: 'Dólares', currency: 'USD' });
    const res = await request(app)
      .post(api('/finance/transfers'))
      .set(c.headers)
      .send({ fromAccountId: a, toAccountId: b, amount: 40, date: today(), description: 'Depósito' });
    expect(res.body.out).toMatchObject({
      kind: 'transfer_out',
      transferPairId: res.body.in.id,
      category: null,
    });
    expect(res.body.in).toMatchObject({ kind: 'transfer_in', transferPairId: res.body.out.id });
    expect([await balanceOf(c.headers, a), await balanceOf(c.headers, b)]).toEqual([60, 40]);

    const mismatch = await request(app)
      .post(api('/finance/transfers'))
      .set(c.headers)
      .send({ fromAccountId: a, toAccountId: usd, amount: 1, date: today() });
    expect(mismatch.body.error.code).toBe('TRANSFER_CURRENCY_MISMATCH');
    const same = await request(app)
      .post(api('/finance/transfers'))
      .set(c.headers)
      .send({ fromAccountId: a, toAccountId: a, amount: 1, date: today() });
    expect(same.body.error.code).toBe('TRANSFER_SAME_ACCOUNT');
    const edit = await request(app)
      .patch(api(`/finance/movements/${res.body.in.id}`))
      .set(c.headers)
      .send({ amount: 1 });
    expect(edit.body.error.code).toBe('TRANSFER_EDIT_FORBIDDEN');

    await request(app)
      .post(api(`/finance/movements/${res.body.in.id}/void`))
      .set(c.headers)
      .send({ reason: 'Error' });
    expect([await balanceOf(c.headers, a), await balanceOf(c.headers, b)]).toEqual([100, 0]);
    const transfers = await request(app)
      .get(api('/finance/movements?kind=transfer&status=voided'))
      .set(c.headers);
    expect(transfers.body.total).toBe(2);
  });

  it('valida fecha, apertura, tipo de categoría, caja activa y montos', async () => {
    const c = await provisionChurch();
    const box = await cashBox(c.headers, { openingDate: addDays(today(), -10) });
    const tithe = await category(c.headers, 'income', 'tithe');
    const post = (body: object) =>
      request(app)
        .post(api('/finance/movements'))
        .set(c.headers)
        .send({
          kind: 'income',
          financeAccountId: box,
          categoryId: tithe,
          amount: 10,
          date: today(),
          ...body,
        });
    expect((await post({ date: addDays(today(), 1) })).body.error.code).toBe('DATE_IN_FUTURE');
    expect((await post({ date: addDays(today(), -11) })).body.error.code).toBe('MOVEMENT_BEFORE_OPENING');
    expect((await post({ kind: 'expense' })).body.error.code).toBe('CATEGORY_KIND_MISMATCH');
    expect((await post({ amount: 0 })).status).toBe(400);
    expect((await post({ amount: 10.001 })).status).toBe(400);
    await request(app)
      .patch(api(`/finance/accounts/${box}`))
      .set(c.headers)
      .send({ isActive: false });
    expect((await post({})).body.error.code).toBe('FINANCE_ACCOUNT_INACTIVE');
  });
});

describe('diezmos nominales', () => {
  it('el aportante solo lo ve y lo carga quien tiene finanzas.diezmos_nominales', async () => {
    const c = await provisionChurch();
    const box = await cashBox(c.headers);
    const tithe = await category(c.headers, 'income', 'tithe');
    const giver = await person(c.headers, 'Juan');
    const treasurer = await actor(
      { 'finanzas.ver': 'all', 'finanzas.registrar': 'all', 'finanzas.diezmos_nominales': 'all' },
      c.accountId,
    );
    const pastor = await actor({ 'finanzas.ver': 'all', 'finanzas.registrar': 'all' }, c.accountId);

    const m = await move(treasurer.headers, {
      kind: 'income',
      financeAccountId: box,
      categoryId: tithe,
      amount: 1200,
      personId: giver,
    });
    expect(m.person).toMatchObject({ id: giver, firstName: 'Juan' });

    const seen = await request(app)
      .get(api(`/finance/movements/${m.id}`))
      .set(pastor.headers);
    expect(seen.body.amount).toBe(1200);
    expect(seen.body).not.toHaveProperty('person');
    const list = await request(app).get(api('/finance/movements')).set(pastor.headers);
    expect(list.body.items[0]).not.toHaveProperty('person');
    expect(list.body.totals[0].income).toBe(1200); // los totales sí
    const filter = await request(app)
      .get(api(`/finance/movements?personId=${giver}`))
      .set(pastor.headers);
    expect(filter.body.error.code).toBe('CONTRIBUTIONS_FORBIDDEN');
    const create = await request(app).post(api('/finance/movements')).set(pastor.headers).send({
      kind: 'income',
      financeAccountId: box,
      categoryId: tithe,
      amount: 1,
      date: today(),
      personId: giver,
    });
    expect(create.body.error.code).toBe('CONTRIBUTIONS_FORBIDDEN');
    // Buscar por nombre del aportante tampoco lo expone.
    const byName = await request(app).get(api('/finance/movements?q=Juan')).set(pastor.headers);
    expect(byName.body.total).toBe(0);
    const byNameTreasurer = await request(app).get(api('/finance/movements?q=Juan')).set(treasurer.headers);
    expect(byNameTreasurer.body.total).toBe(1);
  });
});

describe('comprobantes', () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

  it('se adjuntan PDFs (e imágenes), se descargan con permiso y se quitan', async () => {
    const c = await provisionChurch();
    const box = await cashBox(c.headers);
    const rent = await category(c.headers, 'expense', 'rent');
    const m = await move(c.headers, { kind: 'expense', financeAccountId: box, categoryId: rent, amount: 50 });
    const up = await request(app)
      .post(api(`/finance/movements/${m.id}/attachments`))
      .set(c.headers)
      .attach('file', pdf, 'factura.pdf');
    expect(up.status).toBe(201);
    expect(up.body.attachments).toMatchObject([{ originalName: 'factura.pdf', mimeType: 'application/pdf' }]);
    const fileId = up.body.attachments[0].id;
    const bad = await request(app)
      .post(api(`/finance/movements/${m.id}/attachments`))
      .set(c.headers)
      .attach('file', Buffer.from('no soy un comprobante'), 'x.txt');
    expect(bad.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');

    expect(
      (
        await request(app)
          .get(api(`/files/${fileId}`))
          .set(c.headers)
      ).status,
    ).toBe(200);
    const outsider = await actor({ 'personas.ver': 'all' }, c.accountId);
    expect(
      (
        await request(app)
          .get(api(`/files/${fileId}`))
          .set(outsider.headers)
      ).status,
    ).toBe(404);

    await request(app)
      .delete(api(`/finance/movements/${m.id}/attachments/${fileId}`))
      .set(c.headers)
      .expect(204);
    const after = await request(app)
      .get(api(`/finance/movements/${m.id}`))
      .set(c.headers);
    expect(after.body).toMatchObject({ attachmentCount: 0, attachments: [] });
  });
});

describe('aislamiento entre iglesias', () => {
  it('cajas, categorías, personas, movimientos y comprobantes de otra cuenta no se ven ni se usan', async () => {
    const a = await provisionChurch();
    const b = await provisionChurch();
    const boxA = await cashBox(a.headers);
    const boxB = await cashBox(b.headers);
    const titheA = await category(a.headers, 'income', 'tithe');
    const titheB = await category(b.headers, 'income', 'tithe');
    const personA = await person(a.headers, 'DeA');
    const m = await move(a.headers, {
      kind: 'income',
      financeAccountId: boxA,
      categoryId: titheA,
      amount: 10,
    });
    const up = await request(app)
      .post(api(`/finance/movements/${m.id}/attachments`))
      .set(a.headers)
      .attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), 'a.pdf');
    const fileA = up.body.attachments[0].id;

    expect(
      (
        await request(app)
          .get(api(`/finance/movements/${m.id}`))
          .set(b.headers)
      ).status,
    ).toBe(404);
    expect((await request(app).get(api('/finance/movements')).set(b.headers)).body.total).toBe(0);
    expect(
      (await request(app).get(api('/finance/accounts')).set(b.headers)).body.items.map(
        (x: { id: number }) => x.id,
      ),
    ).not.toContain(boxA);
    expect(
      (
        await request(app)
          .get(api(`/files/${fileA}`))
          .set(b.headers)
      ).status,
    ).toBe(404);

    const post = (body: object) =>
      request(app)
        .post(api('/finance/movements'))
        .set(b.headers)
        .send({
          kind: 'income',
          financeAccountId: boxB,
          categoryId: titheB,
          amount: 1,
          date: today(),
          ...body,
        });
    expect((await post({ financeAccountId: boxA })).body.error.code).toBe('FINANCE_ACCOUNT_INVALID');
    expect((await post({ categoryId: titheA })).body.error.code).toBe('CATEGORY_INVALID');
    expect((await post({ personId: personA })).body.error.code).toBe('PERSON_INVALID');
    const transfer = await request(app)
      .post(api('/finance/transfers'))
      .set(b.headers)
      .send({ fromAccountId: boxB, toAccountId: boxA, amount: 1, date: today() });
    expect(transfer.body.error.code).toBe('FINANCE_ACCOUNT_INVALID');

    const writes = await Promise.all([
      request(app)
        .patch(api(`/finance/movements/${m.id}`))
        .set(b.headers)
        .send({ amount: 999 }),
      request(app)
        .post(api(`/finance/movements/${m.id}/void`))
        .set(b.headers)
        .send({ reason: 'x' }),
      request(app)
        .patch(api(`/finance/accounts/${boxA}`))
        .set(b.headers)
        .send({ name: 'hackeada' }),
      request(app)
        .patch(api(`/finance/categories/${titheA}`))
        .set(b.headers)
        .send({ name: 'x' }),
      request(app)
        .delete(api(`/finance/movements/${m.id}/attachments/${fileA}`))
        .set(b.headers),
    ]);
    for (const res of writes) expect(res.status).toBe(404);
    expect(await balanceOf(a.headers, boxA)).toBe(10);
  });
});
