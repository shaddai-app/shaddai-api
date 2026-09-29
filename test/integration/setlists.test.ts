import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, todayIn } from '../../src/core/time/local-date.js';
import { actor, app, prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;
const today = () => todayIn('America/Argentina/Buenos_Aires');
const code = (res: request.Response) => res.body.error?.code;
const send = (headers: Headers, method: 'post' | 'patch' | 'put' | 'delete', url: string, body?: object) =>
  request(app)[method](api(url)).set(headers).send(body);
const get = (headers: Headers, url: string) => request(app).get(api(url)).set(headers);

async function setup() {
  const c = await provisionChurch();
  const songA = (await send(c.headers, 'post', '/songs', { title: 'Canción A', originalKey: 'G' })).body;
  const songB = (await send(c.headers, 'post', '/songs', { title: 'Canción B', originalKey: 'D', bpm: 120 }))
    .body;
  const ana = (
    await send(c.headers, 'post', '/people', { firstName: 'Ana', lastName: 'Voz', allowDuplicate: true })
  ).body.id;
  const worship = (await send(c.headers, 'post', '/ministries', { name: 'Alabanza', kind: 'worship' })).body;
  await send(c.headers, 'post', `/ministries/${worship.id}/members`, { personId: ana });
  const first = addDays(today(), 1);
  const event = (
    await send(c.headers, 'post', '/events', {
      type: 'service',
      title: 'Culto',
      startsAt: `${first}T10:00`,
      endsAt: `${first}T12:00`,
      recurrence: { freq: 'weekly', interval: 1 },
    })
  ).body;
  const voz = worship.roles.find((r: { name: string }) => r.name === 'Voz').id;
  await send(c.headers, 'post', `/ministries/${worship.id}/assignments`, {
    eventId: event.id,
    occurrence: `${first}T10:00`,
    serviceRoleId: voz,
    personId: ana,
  });
  return { c, songA, songB, ana, event, first };
}

describe('listas de canciones', () => {
  it('por fecha de un evento: canciones, tonalidad, músicos, publicación e historial', async () => {
    const { c, songA, songB, ana, event, first } = await setup();
    const created = await send(c.headers, 'post', '/setlists', {
      eventId: event.id,
      occurrence: `${first}T10:00`,
    });
    expect(created.status).toBe(201);
    const s = created.body;
    expect(s).toMatchObject({
      status: 'draft',
      event: { title: 'Culto' },
      startsAt: `${first}T10:00`,
      items: [],
      musicians: [{ role: 'Voz', status: 'pending', person: { id: ana } }],
      canEdit: true,
    });
    const dup = await send(c.headers, 'post', '/setlists', {
      eventId: event.id,
      occurrence: `${first}T10:00`,
    });
    expect(dup.body.error).toMatchObject({ code: 'SETLIST_EXISTS', details: { id: s.id } });
    expect(code(await send(c.headers, 'post', '/setlists', { occurrence: `${first}T19:00` }))).toBe(
      'SETLIST_TITLE_REQUIRED',
    );
    const rehearsal = await send(c.headers, 'post', '/setlists', {
      occurrence: `${first}T19:00`,
      title: 'Ensayo',
    });
    expect(rehearsal.status).toBe(201);

    // Canciones: orden, tonalidad de esa vez y notas.
    const items = await send(c.headers, 'put', `/setlists/${s.id}/items`, {
      items: [
        { songId: songB.id, notes: 'Arranca la batería' },
        { songId: songA.id, key: 'A' },
      ],
    });
    expect(items.body.items).toMatchObject([
      { position: 1, key: null, notes: 'Arranca la batería', song: { title: 'Canción B', bpm: 120 } },
      { position: 2, key: 'A', song: { title: 'Canción A', originalKey: 'G', deleted: false } },
    ]);
    expect(
      (await send(c.headers, 'put', `/setlists/${s.id}/items`, { items: [{ songId: songA.id, key: 'H' }] }))
        .status,
    ).toBe(400);
    const other = await provisionChurch();
    const foreign = (await send(other.headers, 'post', '/songs', { title: 'Ajena' })).body;
    expect(
      code(await send(c.headers, 'put', `/setlists/${s.id}/items`, { items: [{ songId: foreign.id }] })),
    ).toBe('SONG_INVALID');

    const published = await send(c.headers, 'patch', `/setlists/${s.id}`, {
      status: 'published',
      notes: 'Día de la madre',
    });
    expect(published.body).toMatchObject({ status: 'published', notes: 'Día de la madre' });

    const list = (await get(c.headers, `/setlists?from=${today()}&to=${addDays(today(), 7)}`)).body;
    expect(list.items).toMatchObject([
      { id: s.id, title: 'Culto', status: 'published', songs: ['Canción B', 'Canción A'] },
      { id: rehearsal.body.id, title: 'Ensayo', status: 'draft', songs: [] },
    ]);

    const usage = (await get(c.headers, `/songs/${songA.id}/usage`)).body;
    expect(usage).toMatchObject({ total: 1, items: [{ setlistId: s.id, key: 'A', title: 'Culto' }] });
  });

  it('los borradores solo los ve quien arma las listas', async () => {
    const { c, songA, event, first } = await setup();
    const s = (
      await send(c.headers, 'post', '/setlists', { eventId: event.id, occurrence: `${first}T10:00` })
    ).body;
    await send(c.headers, 'put', `/setlists/${s.id}/items`, { items: [{ songId: songA.id }] });
    const musician = await actor({ 'alabanza.ver': 'all' }, c.accountId);
    const range = `from=${today()}&to=${addDays(today(), 7)}`;

    expect(code(await get(musician.headers, `/setlists/${s.id}`))).toBe('SETLIST_NOT_FOUND');
    expect((await get(musician.headers, `/setlists?${range}`)).body).toMatchObject({
      items: [],
      canEdit: false,
    });
    expect((await get(musician.headers, `/songs/${songA.id}/usage`)).body.total).toBe(0);

    await send(c.headers, 'patch', `/setlists/${s.id}`, { status: 'published' });
    expect((await get(musician.headers, `/setlists/${s.id}`)).body).toMatchObject({ canEdit: false });
    expect((await get(musician.headers, `/songs/${songA.id}/usage`)).body.total).toBe(1);
    expect((await send(musician.headers, 'patch', `/setlists/${s.id}`, { status: 'draft' })).status).toBe(
      403,
    );

    const other = await provisionChurch();
    expect(code(await get(other.headers, `/setlists/${s.id}`))).toBe('SETLIST_NOT_FOUND');
  });

  it('sigue a su fecha si cambia el horario, y se borra con sus canciones', async () => {
    const { c, songA, event, first } = await setup();
    const s = (
      await send(c.headers, 'post', '/setlists', { eventId: event.id, occurrence: `${first}T10:00` })
    ).body;
    await send(c.headers, 'put', `/setlists/${s.id}/items`, { items: [{ songId: songA.id }] });
    await send(c.headers, 'patch', `/events/${event.id}`, {
      startsAt: `${first}T11:00`,
      endsAt: `${first}T13:00`,
    });
    const moved = (await get(c.headers, `/setlists/${s.id}`)).body;
    expect(moved).toMatchObject({ occurrence: `${first}T11:00`, startsAt: `${first}T11:00` });
    // La fecha cancelada no admite una lista nueva.
    const next = `${addDays(first, 7)}T11:00`;
    await send(c.headers, 'put', `/events/${event.id}/exceptions`, { originalStart: next, cancelled: true });
    expect(code(await send(c.headers, 'post', '/setlists', { eventId: event.id, occurrence: next }))).toBe(
      'OCCURRENCE_CANCELLED',
    );

    await send(c.headers, 'delete', `/setlists/${s.id}`).expect(204);
    expect(await prisma.setlistItem.count()).toBe(0);
  });
});
