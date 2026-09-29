import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { actor, app, prisma, provisionChurch, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;
const code = (res: request.Response) => res.body.error?.code;
const send = (headers: Headers, method: 'post' | 'patch' | 'delete', url: string, body?: object) =>
  request(app)[method](api(url)).set(headers).send(body);
const get = (headers: Headers, url: string) => request(app).get(api(url)).set(headers);

const CHORDPRO =
  '{title: Canción de prueba}\n{key: G}\n\n{start_of_verse}\n[G]Una línea [D/F#]de prueba\n{end_of_verse}\n';

describe('canciones', () => {
  it('alta, búsqueda sin acentos, etiquetas, enlaces, edición y borrado', async () => {
    const c = await provisionChurch();
    const created = await send(c.headers, 'post', '/songs', {
      title: 'Canción de Prueba',
      author: 'José Núñez',
      ccliNumber: '1234567',
      originalKey: 'G',
      bpm: 72,
      timeSignature: '6/8',
      chordPro: CHORDPRO.replace(/\n/g, '\r\n'),
      tags: ['Adoración', 'Lenta', 'adoración'],
      links: [{ type: 'youtube', url: 'https://www.youtube.com/watch?v=abc', label: 'Versión en vivo' }],
    });
    expect(created.status).toBe(201);
    const song = created.body;
    expect(song).toMatchObject({
      title: 'Canción de Prueba',
      originalKey: 'G',
      bpm: 72,
      tags: ['Adoración', 'Lenta'],
      links: [{ type: 'youtube', label: 'Versión en vivo' }],
    });
    expect(song.chordPro).toBe(CHORDPRO); // se normalizan los saltos de línea
    await send(c.headers, 'post', '/songs', { title: 'Himno de alegría', tags: ['Rápida'] }).expect(201);
    await send(c.headers, 'post', '/songs', { title: 'Paz', tags: ['Paz interior'] }).expect(201);

    // Búsqueda sin acentos ni mayúsculas, por título, autor o CCLI.
    const titles = async (q: string) =>
      (await get(c.headers, `/songs?${q}`)).body.items.map((s: { title: string }) => s.title);
    expect(await titles('q=cancion')).toEqual(['Canción de Prueba']);
    expect(await titles('q=nunez')).toEqual(['Canción de Prueba']);
    expect(await titles('q=1234567')).toEqual(['Canción de Prueba']);
    expect(await titles('')).toEqual(['Canción de Prueba', 'Himno de alegría', 'Paz']);
    // Etiqueta exacta (sin coincidencias parciales).
    expect(await titles('tag=lenta')).toEqual(['Canción de Prueba']);
    expect(await titles('tag=Paz')).toEqual([]);
    const list = (await get(c.headers, '/songs')).body;
    expect(list).toMatchObject({ total: 3, tags: ['Adoración', 'Lenta', 'Paz interior', 'Rápida'] });

    // Edición: cambia el título (y la búsqueda) y reemplaza los enlaces.
    const updated = await send(c.headers, 'patch', `/songs/${song.id}`, {
      title: 'Nueva canción',
      originalKey: 'Bbm',
      links: [
        { type: 'spotify', url: 'https://open.spotify.com/track/x' },
        { type: 'sheet', url: 'https://example.com/partitura.pdf' },
      ],
    });
    expect(updated.body).toMatchObject({ title: 'Nueva canción', originalKey: 'Bbm', author: 'José Núñez' });
    expect(updated.body.links.map((l: { type: string }) => l.type)).toEqual(['spotify', 'sheet']);
    expect(await prisma.songLink.count()).toBe(2);
    expect(await titles('q=nueva nunez')).toEqual(['Nueva canción']);

    // Inactivas y borradas.
    await send(c.headers, 'patch', `/songs/${song.id}`, { isActive: false }).expect(200);
    expect(await titles('')).toEqual(['Himno de alegría', 'Paz']);
    expect(await titles('includeInactive=true')).toContain('Nueva canción');
    await send(c.headers, 'delete', `/songs/${song.id}`).expect(204);
    expect(code(await get(c.headers, `/songs/${song.id}`))).toBe('SONG_NOT_FOUND');
    expect(await titles('includeInactive=true')).toEqual(['Himno de alegría', 'Paz']);
  });

  it('valida los datos', async () => {
    const c = await provisionChurch();
    const bad = async (body: object) =>
      (await send(c.headers, 'post', '/songs', { title: 'X', ...body })).status;
    expect(await bad({ originalKey: 'H' })).toBe(400);
    expect(await bad({ originalKey: 'C#mm' })).toBe(400);
    expect(await bad({ bpm: 5 })).toBe(400);
    expect(await bad({ timeSignature: '4-4' })).toBe(400);
    expect(await bad({ ccliNumber: 'abc' })).toBe(400);
    expect(await bad({ links: [{ type: 'youtube', url: 'javascript:alert(1)' }] })).toBe(400);
    expect(await bad({ links: [{ type: 'tiktok', url: 'https://x.com' }] })).toBe(400);
    expect(await bad({ originalKey: '', timeSignature: '' })).toBe(201);
  });

  it('permisos y aislamiento entre iglesias', async () => {
    const c = await provisionChurch();
    const song = (await send(c.headers, 'post', '/songs', { title: 'Nuestra' })).body;
    const viewer = await actor({ 'alabanza.ver': 'all' }, c.accountId);
    await get(viewer.headers, `/songs/${song.id}`).expect(200);
    expect((await send(viewer.headers, 'post', '/songs', { title: 'Y' })).status).toBe(403);
    expect((await send(viewer.headers, 'patch', `/songs/${song.id}`, { title: 'Y' })).status).toBe(403);
    const nobody = await actor({ 'eventos.ver': 'all' }, c.accountId);
    expect((await get(nobody.headers, '/songs')).status).toBe(403);

    const other = await provisionChurch();
    expect(code(await get(other.headers, `/songs/${song.id}`))).toBe('SONG_NOT_FOUND');
    expect(code(await send(other.headers, 'patch', `/songs/${song.id}`, { title: 'Ajena' }))).toBe(
      'SONG_NOT_FOUND',
    );
    expect((await get(other.headers, '/songs')).body.total).toBe(0);
  });
});
