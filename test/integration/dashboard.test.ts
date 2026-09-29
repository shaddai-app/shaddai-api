import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, todayIn } from '../../src/core/time/local-date.js';
import { actor, app, prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;
const today = () => todayIn('America/Argentina/Buenos_Aires');

async function send(headers: Headers, url: string, body: object) {
  const res = await request(app).post(api(url)).set(headers).send(body);
  if (res.status !== 201) throw new Error(`${url}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
const get = async (headers: Headers, query = '') =>
  (
    await request(app)
      .get(api(`/dashboard${query}`))
      .set(headers)
      .expect(200)
  ).body;

describe('dashboard', () => {
  it('con todos los permisos muestra cada bloque y compara con el período anterior', async () => {
    const c = await provisionChurch();
    await send(c.headers, '/people', { firstName: 'Ana', lastName: 'Paz', allowDuplicate: true });
    await send(c.headers, '/people', { firstName: 'Beto', lastName: 'Sol', allowDuplicate: true });
    const cash = (
      await send(c.headers, '/finance/accounts', {
        name: 'Banco',
        type: 'bank',
        currency: 'ARS',
        openingDate: addDays(today(), -60),
      })
    ).id;
    const cats = (await request(app).get(api('/finance/categories')).set(c.headers)).body.items;
    const tithe = cats.find((x: { systemKey: string }) => x.systemKey === 'tithe').id;
    const rent = cats.find((x: { systemKey: string }) => x.systemKey === 'rent').id;
    await send(c.headers, '/finance/movements', {
      kind: 'income',
      financeAccountId: cash,
      categoryId: tithe,
      amount: 1000,
      date: today(),
    });
    await send(c.headers, '/finance/movements', {
      kind: 'expense',
      financeAccountId: cash,
      categoryId: rent,
      amount: 300,
      date: addDays(today(), -40), // período anterior
    });
    const day = addDays(today(), 3);
    await send(c.headers, '/events', {
      type: 'special',
      title: 'Cena',
      startsAt: `${day}T20:00`,
      endsAt: `${day}T22:00`,
    });

    const d = await get(c.headers);
    expect(d.period).toBe('30d');
    expect(d.current).toEqual({ from: addDays(today(), -29), to: today() });
    expect(d.previous).toEqual({ from: addDays(today(), -59), to: addDays(today(), -30) });
    expect(d.people).toMatchObject({ total: 2, added: { current: 2, previous: 0 } });
    expect(d.newcomers).toEqual({ pending: 0 });
    expect(d.consolidation).toMatchObject({
      open: expect.any(Number),
      completed: { current: 0, previous: 0 },
    });
    expect(d.cells).toMatchObject({ active: 0, meetings: { held: { current: 0, previous: 0 } } });
    expect(d.attendance).toMatchObject({ avgInPerson: { current: null, previous: null }, pending: 0 });
    expect(d.finance.totals).toEqual([
      {
        currency: 'ARS',
        income: { current: 1000, previous: 0 },
        expense: { current: 0, previous: 300 },
        net: { current: 1000, previous: -300 },
      },
    ]);
    expect(d.upcoming.map((o: { title: string }) => o.title)).toEqual(['Cena']);

    const week = await get(c.headers, '?period=7d');
    expect(week.previous).toEqual({ from: addDays(today(), -13), to: addDays(today(), -7) });
    expect(week.finance.totals[0].expense).toEqual({ current: 0, previous: 0 });
    await request(app).get(api('/dashboard?period=1y')).set(c.headers).expect(400);
  });

  it('cada bloque depende del permiso del módulo y de su alcance', async () => {
    const c = await provisionChurch();
    await send(c.headers, '/people', { firstName: 'Ana', lastName: 'Paz', allowDuplicate: true });

    const bare = await actor({ 'dashboard.ver': 'all' }, c.accountId);
    const d = await get(bare.headers);
    for (const block of [
      'people',
      'newcomers',
      'consolidation',
      'cells',
      'attendance',
      'finance',
      'upcoming',
    ]) {
      expect(d[block], block).toBeNull();
    }

    // Alcance propio: solo las personas que cargó (ninguna) y sus células (sin ficha, ninguna).
    const own = await actor(
      { 'dashboard.ver': 'all', 'personas.ver': 'own', 'celulas.ver': 'own', 'finanzas.ver': 'all' },
      c.accountId,
    );
    const mine = await get(own.headers);
    expect(mine.people).toMatchObject({ total: 0 });
    expect(mine.cells).toEqual({ active: 0, meetings: null }); // sin ver reportes, sin reuniones
    expect(mine.finance).toMatchObject({ totals: [], pendingOfferings: 0 });
    expect(mine.consolidation).toBeNull();

    const nobody = await actor({ 'personas.ver': 'all' }, c.accountId);
    expect((await request(app).get(api('/dashboard')).set(nobody.headers)).status).toBe(403);
  });
});
