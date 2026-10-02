import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, todayIn } from '../../src/core/time/local-date.js';
import { actor, app, prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;
const code = (res: request.Response) => res.body.error?.code;
const send = (headers: Headers, method: 'post' | 'patch' | 'delete', url: string, body?: object) =>
  request(app)[method](api(url)).set(headers).send(body);
const get = (headers: Headers, url: string) => request(app).get(api(url)).set(headers);
const today = () => todayIn('America/Argentina/Buenos_Aires');

async function setup() {
  const c = await provisionChurch();
  const audio = (await prisma.catalogItem.findFirst({
    where: { accountId: c.accountId, type: 'inventory_category', systemKey: 'audio' },
  }))!.id;
  const item = (
    await send(c.headers, 'post', '/inventory/items', { name: 'Parlante activo', categoryId: audio })
  ).body;
  const mic = (await send(c.headers, 'post', '/inventory/items', { name: 'Micrófono', categoryId: audio }))
    .body;
  const person = (
    await send(c.headers, 'post', '/people', { firstName: 'Martín', lastName: 'Gómez', allowDuplicate: true })
  ).body;
  return { c, audio, item, mic, person };
}

describe('préstamos de inventario', () => {
  it('prestar, vencer, extender, devolver y volver a prestar', async () => {
    const { c, audio, item, mic, person } = await setup();

    const loan = await send(c.headers, 'post', '/inventory/loans', {
      itemId: item.id,
      borrowerPersonId: person.id,
      dueAt: addDays(today(), 7),
      conditionOut: 'Con cable de alimentación',
    });
    expect(loan.status).toBe(201);
    expect(loan.body).toMatchObject({
      borrowedAt: today(),
      dueAt: addDays(today(), 7),
      returnedAt: null,
      overdue: false,
      daysOverdue: 0,
      conditionOut: 'Con cable de alimentación',
      item: { id: item.id, name: 'Parlante activo' },
      borrower: { id: person.id, firstName: 'Martín' },
    });

    // El equipo figura prestado; no se puede prestar de nuevo ni eliminar.
    expect((await get(c.headers, `/inventory/items/${item.id}`)).body.loan).toEqual({
      dueAt: addDays(today(), 7),
      overdue: false,
    });
    const onLoan = (await get(c.headers, '/inventory/items?onLoan=true')).body;
    expect(onLoan.items.map((i: { id: number }) => i.id)).toEqual([item.id]);
    expect(onLoan.counts.onLoan).toBe(1);
    const again = await send(c.headers, 'post', '/inventory/loans', {
      itemId: item.id,
      borrowerPersonId: person.id,
      dueAt: addDays(today(), 3),
    });
    expect(again.body.error).toMatchObject({ code: 'INVENTORY_ITEM_ON_LOAN', details: { id: loan.body.id } });
    expect(code(await send(c.headers, 'delete', `/inventory/items/${item.id}`))).toBe(
      'INVENTORY_ITEM_ON_LOAN',
    );

    // Validaciones de fechas, persona y estado del equipo.
    const base = { itemId: mic.id, borrowerPersonId: person.id };
    expect(
      code(
        await send(c.headers, 'post', '/inventory/loans', {
          ...base,
          borrowedAt: today(),
          dueAt: addDays(today(), -1),
        }),
      ),
    ).toBe('LOAN_DUE_INVALID');
    expect(
      code(
        await send(c.headers, 'post', '/inventory/loans', {
          ...base,
          borrowedAt: addDays(today(), 1),
          dueAt: addDays(today(), 2),
        }),
      ),
    ).toBe('LOAN_DATE_INVALID');
    const other = await provisionChurch();
    const stranger = (
      await send(other.headers, 'post', '/people', {
        firstName: 'Otra',
        lastName: 'Iglesia',
        allowDuplicate: true,
      })
    ).body;
    expect(
      code(
        await send(c.headers, 'post', '/inventory/loans', {
          ...base,
          borrowerPersonId: stranger.id,
          dueAt: today(),
        }),
      ),
    ).toBe('PERSON_INVALID');
    const retired = (
      await send(c.headers, 'post', '/inventory/items', {
        name: 'Viejo',
        categoryId: audio,
        status: 'retired',
      })
    ).body;
    expect(
      code(
        await send(c.headers, 'post', '/inventory/loans', {
          itemId: retired.id,
          borrowerPersonId: person.id,
          dueAt: today(),
        }),
      ),
    ).toBe('INVENTORY_ITEM_UNAVAILABLE');

    // Vencido: prestado hace 10 días, vencía hace 3.
    const late = await send(c.headers, 'post', '/inventory/loans', {
      ...base,
      borrowedAt: addDays(today(), -10),
      dueAt: addDays(today(), -3),
    });
    expect(late.body).toMatchObject({ overdue: true, daysOverdue: 3 });
    const open = (await get(c.headers, '/inventory/loans')).body;
    expect(open.items.map((l: { id: number }) => l.id)).toEqual([late.body.id, loan.body.id]); // vence antes
    expect(open.counts).toEqual({ open: 2, overdue: 1 });
    const overdue = (await get(c.headers, '/inventory/loans?state=overdue')).body;
    expect(overdue.items.map((l: { id: number }) => l.id)).toEqual([late.body.id]);
    // Búsqueda por persona (sin acentos) o por equipo.
    expect((await get(c.headers, '/inventory/loans?q=martin gomez')).body.total).toBe(2);
    expect((await get(c.headers, '/inventory/loans?q=microfono')).body.total).toBe(1);
    expect((await get(c.headers, `/inventory/loans?personId=${person.id}`)).body.total).toBe(2);

    // Extender el vencimiento.
    const extended = await send(c.headers, 'patch', `/inventory/loans/${late.body.id}`, {
      dueAt: addDays(today(), 2),
      notes: 'Lo usa en el retiro',
    });
    expect(extended.body).toMatchObject({ overdue: false, notes: 'Lo usa en el retiro' });
    expect(
      code(
        await send(c.headers, 'patch', `/inventory/loans/${late.body.id}`, { dueAt: addDays(today(), -11) }),
      ),
    ).toBe('LOAN_DUE_INVALID');

    // Devolución: el equipo vuelve con falla.
    const back = await send(c.headers, 'post', `/inventory/loans/${loan.body.id}/return`, {
      conditionIn: 'Un parlante no suena',
      status: 'faulty',
    });
    expect(back.status).toBe(200);
    expect(back.body.returnedAt).not.toBeNull();
    expect(back.body).toMatchObject({ conditionIn: 'Un parlante no suena', overdue: false });
    const afterReturn = (await get(c.headers, `/inventory/items/${item.id}`)).body;
    expect(afterReturn).toMatchObject({ status: 'faulty', loan: null });
    expect(code(await send(c.headers, 'post', `/inventory/loans/${loan.body.id}/return`, {}))).toBe(
      'LOAN_ALREADY_RETURNED',
    );
    expect(
      code(
        await send(c.headers, 'patch', `/inventory/loans/${loan.body.id}`, { dueAt: addDays(today(), 9) }),
      ),
    ).toBe('LOAN_ALREADY_RETURNED');
    expect((await get(c.headers, '/inventory/loans?state=returned')).body.items[0].id).toBe(loan.body.id);
    expect((await get(c.headers, `/inventory/loans?itemId=${item.id}&state=all`)).body.total).toBe(1);

    // Devuelto: se puede prestar de nuevo; un préstamo cargado por error se elimina.
    const second = await send(c.headers, 'post', '/inventory/loans', {
      itemId: item.id,
      borrowerPersonId: person.id,
      dueAt: today(),
    });
    expect(second.status).toBe(201);
    expect((await send(c.headers, 'delete', `/inventory/loans/${second.body.id}`)).status).toBe(204);
    expect(code(await get(c.headers, `/inventory/loans/${second.body.id}`))).toBe('LOAN_NOT_FOUND');
  });

  it('permisos, otra iglesia y fusión de personas', async () => {
    const { c, item, person } = await setup();
    const loan = (
      await send(c.headers, 'post', '/inventory/loans', {
        itemId: item.id,
        borrowerPersonId: person.id,
        dueAt: addDays(today(), 5),
      })
    ).body;

    const other = await provisionChurch();

    // Con inventario.ver se ve que está prestado, pero no a quién.
    const viewer = await actor({ 'inventario.ver': 'all' }, c.accountId);
    const seen = (await get(viewer.headers, `/inventory/items/${item.id}`)).body;
    expect(seen.loan).toEqual({ dueAt: addDays(today(), 5), overdue: false });
    expect(JSON.stringify(seen)).not.toContain('Martín');
    expect((await get(viewer.headers, '/inventory/loans')).status).toBe(403);
    expect(
      (
        await send(viewer.headers, 'post', '/inventory/loans', {
          itemId: item.id,
          borrowerPersonId: person.id,
        })
      ).status,
    ).toBe(403);

    const lender = await actor({ 'inventario.prestamos': 'all' }, c.accountId);
    expect((await get(lender.headers, '/inventory/loans')).body.total).toBe(1);
    // Quien presta busca personas aunque no tenga personas.ver (solo nombre y teléfono).
    const borrowers = (await get(lender.headers, '/inventory/borrowers?q=martin')).body.items;
    expect(borrowers).toEqual([{ id: person.id, firstName: 'Martín', lastName: 'Gómez', phone: null }]);
    expect((await get(lender.headers, '/people?q=martin')).status).toBe(403);
    expect((await get(viewer.headers, '/inventory/borrowers?q=martin')).status).toBe(403);
    expect((await get(other.headers, '/inventory/borrowers?q=martin')).body.items).toEqual([]);

    expect(code(await get(other.headers, `/inventory/loans/${loan.id}`))).toBe('LOAN_NOT_FOUND');
    expect((await get(other.headers, '/inventory/loans')).body.total).toBe(0);
    expect(code(await send(other.headers, 'post', `/inventory/loans/${loan.id}/return`, {}))).toBe(
      'LOAN_NOT_FOUND',
    );

    // Al fusionar a la persona con su duplicado, el préstamo pasa a la que queda.
    const dup = (
      await send(c.headers, 'post', '/people', {
        firstName: 'Martin',
        lastName: 'Gomez',
        allowDuplicate: true,
      })
    ).body;
    expect((await send(c.headers, 'post', `/people/${person.id}/merge`, { intoId: dup.id })).status).toBe(
      200,
    );
    expect((await get(c.headers, `/inventory/loans/${loan.id}`)).body.borrower.id).toBe(dup.id);
  });
});
